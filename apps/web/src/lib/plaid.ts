/**
 * Plaid Link, loaded the way this app already loads a vendor script.
 *
 * No npm package. `react-plaid-link` does not remove the CDN dependency — it
 * injects the same `link-initialize.js` from cdn.plaid.com, which Plaid
 * requires and forbids you to bundle. What it adds is script loading, a ready
 * flag and unmount teardown, and `loadGsi` in SignInPage.tsx is already this
 * repo's proven pattern for exactly that. It also freezes its callbacks: the
 * hook's effect does not list them as dependencies, so an `onSuccess` closing
 * over state reads whatever was current at mount. Writing the ~60 lines here
 * makes that structurally impossible rather than something to work around.
 *
 * Lazy on purpose, like the GIS loader: a borrower who never presses the
 * button never talks to Plaid.
 */

/* ── The vendor surface, typed to what we actually call ─────────────────── */

export interface PlaidLinkError {
  readonly error_type?: string;
  readonly error_code?: string;
  /** Developer-facing. Never render this. */
  readonly error_message?: string;
  /** The only field Plaid intends for a person to read. */
  readonly display_message?: string;
}

export interface PlaidExitMetadata {
  readonly status?: string;
  readonly institution?: { name?: string };
}

export interface PlaidHandler {
  open(): void;
  exit(options?: { force?: boolean }, done?: () => void): void;
  destroy(): void;
}

export interface PlaidCreateOptions {
  token: string;
  /** Set only when resuming after an OAuth bank sent the browser away. */
  receivedRedirectUri?: string;
  onSuccess(publicToken: string | null, metadata: unknown): void;
  onExit(error: PlaidLinkError | null, metadata: PlaidExitMetadata): void;
  onEvent(eventName: string, metadata: unknown): void;
}

declare global {
  interface Window {
    Plaid?: { create(options: PlaidCreateOptions): PlaidHandler };
  }
}

const PLAID_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

export function loadPlaid(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_SRC}"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("plaid failed")));
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PLAID_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("plaid failed"));
    document.head.appendChild(script);
  });
}

/* ── What the server answered ───────────────────────────────────────────── */

/**
 * The bank route answers three shapes, and the client must never guess which.
 *
 * `requiresClientHandoff` exists because the answer depends on which adapter
 * is configured — the fixture returns a report from the first POST, an
 * aggregator cannot. Inferring it wrong means either a widget that never opens
 * or a fetch against a bank nobody has signed into.
 */
export type BankResponse =
  | { kind: "handoff"; linkToken: string; sessionId: string; expiresAt: string }
  | { kind: "pending"; retryAfterMs: number }
  | { kind: "ready"; body: Record<string, unknown> };

export function classifyBankResponse(body: Record<string, unknown>): BankResponse {
  if (body.requiresClientHandoff === true && typeof body.linkToken === "string") {
    return {
      kind: "handoff",
      linkToken: body.linkToken,
      sessionId: String(body.sessionId ?? ""),
      expiresAt: String(body.expiresAt ?? ""),
    };
  }
  if (body.pending === true) {
    return { kind: "pending", retryAfterMs: Number(body.retryAfterMs) || 4000 };
  }
  return { kind: "ready", body };
}

/* ── The attempt record ─────────────────────────────────────────────────── */

/**
 * What has to survive a page that goes away.
 *
 * An OAuth bank navigates the whole document to the bank and back, so every
 * piece of React state is gone by the time the borrower returns — and the
 * resumed Link must use the SAME link token, or Plaid rejects the handoff.
 * `localStorage` rather than `sessionStorage`: a borrower who closes the tab
 * while a twelve-month report assembles and comes back later should find it,
 * and sessionStorage does not survive that.
 *
 * Keyed per file and versioned. A single global key meant two loan files open
 * in two tabs overwrote each other, and the version segment means a later
 * shape change cannot resurrect a record the new reader misparses.
 */
export interface BankAttempt {
  readonly fileId: string;
  readonly linkToken: string;
  readonly sessionId: string;
  /** From the server, ISO. When the link token stops being usable. */
  readonly expiresAt: string;
  readonly phase: "linking" | "assembling";
  /**
   * What Link handed back, when it did so on the OAuth return page.
   *
   * Screen 3 is the only component that talks to the bank route, so the
   * return page leaves the token here rather than POSTing it itself. Absent
   * on the non-OAuth path, where onSuccess fires with screen 3 still mounted.
   */
  readonly publicToken?: string;
  /** Epoch ms. The polling budget is measured against this, not a ref. */
  readonly startedAt: number;
}

const PREFIX = "hm.plaid.attempt.v1.";

/**
 * Treat a token with under five minutes left as already dead.
 *
 * A token that expires while the borrower is on their bank's login page
 * surfaces to them as their bank refusing them, which is both alarming and
 * the wrong explanation.
 */
export const LINK_TOKEN_GRACE_MS = 5 * 60_000;

/** After this, an assembling report is not worth resuming into silently. */
const ASSEMBLY_MAX_MS = 30 * 60_000;

/** When the wait stops being ordinary and the borrower is offered a way out. */
export const SLOW_AFTER_MS = 3 * 60_000;

export type AttemptStore = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

/**
 * Injectable so the storage rules are testable without a DOM.
 *
 * The alternative was skipping those tests under vitest's node environment,
 * and the expiry rules are the part most worth testing.
 */
function memoryStore(): AttemptStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

let fallback: AttemptStore | undefined;

export function defaultStore(): AttemptStore {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Safari in private mode throws on access rather than returning null.
  }
  return (fallback ??= memoryStore());
}

function isLive(rec: BankAttempt, now: number): boolean {
  if (rec.phase === "linking") {
    const expiry = Date.parse(rec.expiresAt);
    // An unparseable expiry is treated as live: the token itself is the
    // authority, and Link reports an expired one through onExit. Throwing a
    // usable token away on a formatting quirk is the worse error.
    return Number.isNaN(expiry) || expiry - LINK_TOKEN_GRACE_MS > now;
  }
  return now - rec.startedAt < ASSEMBLY_MAX_MS;
}

export function readAttempt(
  fileId: string,
  store: AttemptStore = defaultStore(),
  now: number = Date.now(),
): BankAttempt | null {
  const raw = store.getItem(PREFIX + fileId);
  if (!raw) return null;
  let rec: BankAttempt;
  try {
    rec = JSON.parse(raw) as BankAttempt;
  } catch {
    store.removeItem(PREFIX + fileId);
    return null;
  }
  // The key already scopes this, but a mismatched fileId means something
  // wrote the wrong record and acting on it would attach one borrower's
  // bank handoff to another borrower's file.
  if (rec.fileId !== fileId || !rec.linkToken || !isLive(rec, now)) {
    store.removeItem(PREFIX + fileId);
    return null;
  }
  return rec;
}

export function writeAttempt(rec: BankAttempt, store: AttemptStore = defaultStore()): void {
  try {
    store.setItem(PREFIX + rec.fileId, JSON.stringify(rec));
  } catch {
    // A full or disabled store costs resumability, not correctness. The flow
    // still completes in this tab; it just cannot be picked up in another.
  }
}

export function clearAttempt(fileId: string, store: AttemptStore = defaultStore()): void {
  store.removeItem(PREFIX + fileId);
}

/**
 * The newest live attempt, for the one caller that has no file id.
 *
 * `/plaid/return` is reached by a redirect from the bank. Plaid forbids query
 * parameters on the redirect URI, so the file id cannot be carried in the URL
 * and has to be recovered from the record itself.
 */
export function findResumableAttempt(
  store: AttemptStore = defaultStore(),
  now: number = Date.now(),
): BankAttempt | null {
  // Snapshot the keys before reading any of them. `readAttempt` deletes an
  // expired record, and deleting during an index walk shifts everything after
  // it down — so one dead attempt would hide the live one behind it.
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }

  let best: BankAttempt | null = null;
  for (const key of keys) {
    const rec = readAttempt(key.slice(PREFIX.length), store, now);
    if (rec && (!best || rec.startedAt > best.startedAt)) best = rec;
  }
  return best;
}
