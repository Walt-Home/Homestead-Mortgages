/**
 * What screen 2 has to survive a trip to the identity vendor.
 *
 * A hosted check navigates the whole document away to Stripe and back, so
 * every piece of React state is gone on return. The borrower does not
 * experience that as "a redirect" — they experience it as the form they were
 * filling in being wiped, which is the classic way this integration is
 * annoying enough that people abandon it.
 *
 * `sessionStorage`, not `localStorage`: this is a single sitting. A draft that
 * outlives the tab and reappears days later, half-filled, is worse than an
 * empty form — and unlike the Plaid attempt record, there is nothing here that
 * needs picking up tomorrow.
 *
 * The SSN is deliberately NOT stored. It is the one field on this screen that
 * must never sit in browser storage, and retyping it is a small price.
 */

export interface IdentityDraft {
  readonly phone: string;
  readonly citizenship: string;
  readonly maritalStatus: string;
  readonly authorized: boolean;
  readonly econsent: boolean;
  readonly smsConsent: boolean;
  /** Carried on router state from screen 1, and lost to the redirect too. */
  readonly statedIncome: number;
}

const KEY = "hm.identity.draft.v1.";

export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): DraftStore {
  try {
    if (typeof sessionStorage !== "undefined") return sessionStorage;
  } catch {
    // Safari in private mode throws on access rather than returning null.
  }
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

export function saveDraft(
  fileId: string,
  draft: IdentityDraft,
  store: DraftStore = defaultStore(),
): void {
  try {
    store.setItem(KEY + fileId, JSON.stringify(draft));
  } catch {
    // A full or disabled store costs the borrower a retype, not correctness.
  }
}

export function readDraft(
  fileId: string,
  store: DraftStore = defaultStore(),
): IdentityDraft | null {
  const raw = store.getItem(KEY + fileId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IdentityDraft;
  } catch {
    store.removeItem(KEY + fileId);
    return null;
  }
}

export function clearDraft(fileId: string, store: DraftStore = defaultStore()): void {
  store.removeItem(KEY + fileId);
}
