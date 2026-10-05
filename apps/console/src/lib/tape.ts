/**
 * The tape desk's wire: what our API answers about a tape, and the calls
 * the desk makes. The shapes are `services/tape-desk.ts` in `apps/api`,
 * spelled here once for the screen.
 */

import { hm, type Call, stream } from "./api.js";

export type PreviewChange = "created" | "updated" | "unchanged";

/** The daily review's word on a loan, as `@hm/refi-review` spells it. */
export type Verdict = "candidate" | "watching" | "not_now" | "excluded";
export type VerdictCounts = Record<Verdict, number>;

export interface RowException {
  readonly row: number;
  readonly code: string;
  readonly detail?: string;
  readonly message?: string;
  readonly [k: string]: unknown;
}

export interface PreviewRow {
  readonly row: number;
  readonly number: string;
  readonly borrower: string | null;
  readonly property: string | null;
  readonly balanceCents: string | null;
  readonly ratePct: string | null;
  readonly standing: string | null;
  readonly change: PreviewChange;
  readonly loanState: string | null;
  readonly claimed: boolean;
  readonly email: string | null;
  /** The newest review of the loan, when the book has been reviewed. */
  readonly review: { readonly verdict: Verdict; readonly asOf: string } | null;
  readonly exceptions: readonly RowException[];
}

export interface TapePreview {
  readonly profile: string;
  readonly asOf: string;
  readonly servicer: {
    readonly slug: string;
    readonly displayName: string;
    readonly exists: boolean;
  };
  readonly headers: {
    readonly matched: boolean;
    readonly required: number;
    readonly missing: readonly string[];
  };
  readonly rejected: boolean;
  readonly alreadyLoaded: { readonly importId: string; readonly loadedAt: string } | null;
  readonly rowsTotal: number;
  readonly rowsReadable: number;
  readonly rowsRefused: number;
  readonly counts: {
    readonly created: number;
    readonly updated: number;
    readonly unchanged: number;
  };
  readonly claimed: number;
  readonly supplement: {
    readonly rows: number;
    readonly matched: number;
    readonly withEmail: number;
    readonly ignoredColumns: readonly string[];
  } | null;
  readonly gaps: Record<string, number>;
  readonly rows: readonly PreviewRow[];
  /** The first few hundred row exceptions; `exceptionsTotal` is the count. */
  readonly exceptions: readonly RowException[];
  readonly exceptionsTotal: number;
  readonly exceptionSummary: readonly {
    readonly code: string;
    readonly column: string | null;
    readonly rows: number;
  }[];
}

export interface DeskServicer {
  readonly slug: string;
  readonly displayName: string;
  readonly integrationDepth: string;
  /** Who on their side can see the book: signed in, and invited but not yet in. */
  readonly team: { readonly active: number; readonly invited: number };
  readonly book: {
    readonly imports: number;
    readonly lastAsOf: string | null;
    readonly loans: {
      readonly total: number;
      readonly byState: Record<string, number | undefined>;
    };
    /** The newest day the book was reviewed, and how the verdicts fell. */
    readonly analysis: { readonly asOf: string; readonly verdicts: VerdictCounts } | null;
  };
}

/** The book's first review, as the desk asks for it after a load. */
export interface BookReview {
  readonly asOf: string;
  readonly unclaimed: number;
  readonly reviewed: number;
  readonly alreadyReviewed: number;
  readonly skipped: number;
  readonly offersOpened: number;
  readonly offersAwaitingClaim: number;
  readonly counts: VerdictCounts;
  readonly verdicts: Record<string, Verdict>;
}

export interface DeskImport {
  readonly id: string;
  readonly asOf: string;
  readonly profile: string;
  readonly rowsTotal: number;
  readonly rowsLoaded: number;
  readonly rowsRejected: number;
  readonly loansCreated: number;
  readonly loansUpdated: number;
  readonly loansUnchanged: number;
  readonly partiesCreated: number;
  readonly createdAt: string;
}

export interface TapeLoad {
  readonly servicer: {
    readonly slug: string;
    readonly displayName: string;
    readonly id: string;
    readonly created: boolean;
  };
  readonly result:
    | { readonly status: "rejected"; readonly missing_headers: string[] }
    | { readonly status: "already_loaded"; readonly importId: string }
    | {
        readonly status: "loaded";
        readonly importId: string;
        readonly counts: {
          readonly rows_total: number;
          readonly rows_loaded: number;
          readonly rows_rejected: number;
          readonly loans_created: number;
          readonly loans_updated: number;
          readonly loans_unchanged: number;
          readonly parties_created: number;
        };
        readonly report: {
          readonly loans?: readonly {
            readonly servicer_loan_number: string;
            readonly change: string;
            readonly state: string;
          }[];
        } & Record<string, unknown>;
      };
  readonly loadedBy: string;
}

export type InvitationOutcome =
  | {
      readonly number: string;
      readonly status: "sent";
      readonly to: string;
      readonly expiresAt: string;
    }
  | {
      readonly number: string;
      readonly status: "not_delivered";
      readonly to: string;
      readonly reason: string;
      readonly link: string;
      readonly expiresAt: string;
    }
  | {
      readonly number: string;
      readonly status: "no_address";
      readonly link: string;
      readonly expiresAt: string;
    }
  | { readonly number: string; readonly status: "not_claimable"; readonly reason: string };

/** A file on the wire: its name and its bytes, base64, gzipped first when the browser could. */
export interface WireFile {
  readonly filename: string;
  readonly base64: string;
  readonly encoding?: "identity" | "gzip";
}

export interface TapeFiles {
  readonly servicer: { readonly slug: string; readonly displayName: string };
  readonly profile: string;
  readonly asOf?: string;
  readonly tape: WireFile;
  readonly supplement?: WireFile;
}

export const MAX_FILE_BYTES = 30 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Gzip in the browser, where it can. A CSV book of fourteen thousand rows
 * is ten megabytes and goes up three times — the review, the load, the
 * servicing app's copy — and the front door closes a slow upload; gzipped
 * it is one megabyte. An .xlsx is already a zip and barely shrinks, so it
 * goes as it is, and a browser without CompressionStream sends everything
 * as it is.
 */
async function gzipIfWorthIt(file: File): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  if (/\.xlsx?$/i.test(file.name)) return null;
  try {
    const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    return packed.length < file.size ? packed : null;
  } catch {
    return null;
  }
}

/** A file as the desk sends it: its name and its bytes, base64. */
export async function fileToWire(file: File): Promise<WireFile> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is larger than the desk takes (30 MB).`);
  }
  const packed = await gzipIfWorthIt(file);
  if (packed) return { filename: file.name, base64: toBase64(packed), encoding: "gzip" };
  return { filename: file.name, base64: toBase64(new Uint8Array(await file.arrayBuffer())) };
}

/** "Northlight Mortgage Servicing (sample partner)" → "northlight-mortgage-servicing-sample-partner". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export const todayEt = (): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

export const deskServicers = (init: Call = {}) =>
  hm<{ servicers: DeskServicer[] }>("/servicers", init).then((r) => r.servicers);

/** Stand a servicer up before its first tape; the desk's load then finds it by its slug. */
export const createServicer = (servicer: { slug: string; displayName: string }, init: Call = {}) =>
  hm<{ servicer: { slug: string; displayName: string } }>("/servicers", {
    ...init,
    body: servicer,
  }).then((r) => r.servicer);

export const deskImports = (slug: string, init: Call = {}) =>
  hm<{ imports: DeskImport[] }>("/imports", { ...init, query: { servicer: slug } }).then(
    (r) => r.imports,
  );

export const previewTape = (files: TapeFiles, init: Call = {}) =>
  hm<TapePreview>("/preview", { ...init, body: files });

export const loadTape = (files: TapeFiles, init: Call = {}) =>
  hm<TapeLoad>("/imports", { ...init, body: files });

export const reviewBook = (servicerSlug: string, init: Call = {}) =>
  hm<BookReview>("/review", { ...init, body: { servicerSlug } });

/* ── a long write, told as it goes ─────────────────────────────────────────── */

/** The stages the load and the first review report, in the order they come. */
export type ProgressStage =
  "reading" | "people" | "loans" | "facts" | "observations" | "reviewing" | "verdicts";

export interface Progress {
  readonly stage: ProgressStage;
  readonly done: number;
  readonly total: number;
}

/** What the meter says under each stage, and what it counts. */
export const STAGE_WORDS: Record<ProgressStage, { doing: string; noun: string }> = {
  reading: { doing: "Reading the tape", noun: "rows" },
  people: { doing: "Writing the people", noun: "people" },
  loans: { doing: "Writing the loans", noun: "loans" },
  facts: { doing: "Writing what the tape says about each person", noun: "facts" },
  observations: { doing: "Recording each loan's balance and standing", noun: "loans" },
  reviewing: { doing: "Reviewing each loan against today's rate", noun: "loans" },
  verdicts: { doing: "Writing the verdicts", noun: "verdicts" },
};

/**
 * How far along the whole write is, as one number that only ever grows.
 * The stages differ in size, so the bar is weighted by roughly how long
 * each takes on a big book; the exact count is in the words beside it.
 */
const LOAD_WEIGHTS: Record<ProgressStage, number> = {
  reading: 5,
  people: 15,
  loans: 25,
  facts: 35,
  observations: 20,
  reviewing: 80,
  verdicts: 20,
};
const LOAD_ORDER: ProgressStage[] = ["reading", "people", "loans", "facts", "observations"];
const REVIEW_ORDER: ProgressStage[] = ["reviewing", "verdicts"];

export function progressPercent(p: Progress): number {
  const order = REVIEW_ORDER.includes(p.stage) ? REVIEW_ORDER : LOAD_ORDER;
  const at = order.indexOf(p.stage);
  const before = order.slice(0, at).reduce((n, st) => n + LOAD_WEIGHTS[st], 0);
  const within = p.total > 0 ? Math.min(1, p.done / p.total) : 0;
  const all = order.reduce((n, st) => n + LOAD_WEIGHTS[st], 0);
  return Math.round(((before + LOAD_WEIGHTS[p.stage] * within) / all) * 100);
}

export const loadTapeWithProgress = (files: TapeFiles, onProgress: (p: Progress) => void) =>
  stream<TapeLoad, Progress>("/imports/stream", files, onProgress);

export const reviewBookWithProgress = (servicerSlug: string, onProgress: (p: Progress) => void) =>
  stream<BookReview, Progress>("/review/stream", { servicerSlug }, onProgress);

/** Candidates first, then the rest in the engine's order; a loan never analyzed last. */
export const VERDICT_RANK: Record<Verdict, number> = {
  candidate: 0,
  watching: 1,
  not_now: 2,
  excluded: 3,
};

/** A verdict as a filter, plus the loans the review has not reached. */
export type VerdictFilter = Verdict | "none";
/** In the engine's order, the unreviewed last — the order the pills read in. */
export const VERDICT_FILTERS: readonly VerdictFilter[] = [
  "candidate",
  "watching",
  "not_now",
  "excluded",
  "none",
];

export const countVerdicts = <Row>(
  rows: readonly Row[],
  verdictOf: (r: Row) => Verdict | null,
): Record<VerdictFilter, number> => {
  const out: Record<VerdictFilter, number> = {
    candidate: 0,
    watching: 0,
    not_now: 0,
    excluded: 0,
    none: 0,
  };
  for (const r of rows) out[verdictOf(r) ?? "none"] += 1;
  return out;
};

export const verdictWord = (v: Verdict): string =>
  v === "candidate"
    ? "Candidate"
    : v === "watching"
      ? "Watching"
      : v === "not_now"
        ? "Not now"
        : "Excluded";

export const verdictTone = (v: Verdict): "ok" | "info" | "neutral" | "warn" =>
  v === "candidate" ? "ok" : v === "watching" ? "info" : v === "not_now" ? "warn" : "neutral";

/** Invitations go in batches: the door takes 5,000 and a mailer is slow. */
export const INVITE_BATCH = 500;

/**
 * E-mail the homeowners in a batch their claim links. The server takes the
 * number of them the person confirmed and refuses a request whose count is
 * not the count of addresses it holds, so this states it, batch by batch.
 */
export const inviteToClaim = (
  body: { servicerSlug: string; invitations: { number: string; email: string | null }[] },
  init: Call = {},
) =>
  hm<{ outcomes: InvitationOutcome[] }>("/claims", {
    ...init,
    body: {
      ...body,
      confirm: { homeownersToEmail: body.invitations.filter((i) => i.email !== null).length },
    },
  }).then((r) => r.outcomes);

/** What this deployment lets the desk do. */
export interface DeskSettings {
  /** Whether homeowners may be e-mailed from the desk at all. */
  readonly homeownerMail: "on" | "off";
}
export const deskSettings = (init: Call = {}) => hm<DeskSettings>("/settings", init);

export const changeTone = (c: PreviewChange): "ok" | "info" | "neutral" =>
  c === "created" ? "ok" : c === "updated" ? "info" : "neutral";

export const changeWord = (c: PreviewChange): string =>
  c === "created" ? "New" : c === "updated" ? "Changed" : "Unchanged";

/* ── the servicer's team ───────────────────────────────────────────────────── */

export type TeamStanding = "invited" | "active" | "disabled" | "expired";
export interface TeamMember {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly standing: TeamStanding;
  readonly invitedAt: string;
  readonly inviteExpiresAt: string | null;
  readonly inviteDeliveredAt: string | null;
  readonly acceptedAt: string | null;
  readonly lastSignedInAt: string | null;
}
export type TeamInvitationOutcome =
  | { readonly email: string; readonly status: "sent"; readonly expiresAt: string }
  | {
      readonly email: string;
      readonly status: "not_delivered";
      readonly reason: string;
      readonly link: string;
      readonly expiresAt: string;
    }
  | { readonly email: string; readonly status: "already_member" }
  | { readonly email: string; readonly status: "on_another_team" }
  | { readonly email: string; readonly status: "invalid" };

export const deskTeam = (servicerSlug: string, init: Call = {}) =>
  hm<{ team: TeamMember[] }>("/team", { ...init, query: { servicer: servicerSlug } }).then(
    (r) => r.team,
  );

export const inviteTeam = (
  body: { servicerSlug: string; invitations: { email: string; name?: string | null }[] },
  init: Call = {},
) => hm<{ outcomes: TeamInvitationOutcome[] }>("/team", { ...init, body }).then((r) => r.outcomes);

/** Take somebody off a servicer's team: their sign-in stops, an untaken link dies. */
export const removeFromTeam = (servicerSlug: string, memberId: string, init: Call = {}) =>
  hm<unknown>(`/team/${memberId}`, {
    ...init,
    method: "DELETE",
    query: { servicer: servicerSlug },
  });

/**
 * One person per line, as people paste them: `Name <address>`, `address,
 * Name`, `Name, address`, or a bare address. Blank lines are skipped;
 * what has no address at all is kept so the desk can say so.
 */
export function parseTeamLines(text: string): { email: string; name: string | null }[] {
  const out: { email: string; name: string | null }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const angled = line.match(/^(.*?)\s*<([^>]+)>\s*$/);
    if (angled) {
      out.push({ email: angled[2]!.trim(), name: angled[1]!.trim() || null });
      continue;
    }
    const parts = line
      .split(/[,;\t]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1) {
      const email = parts.find((p) => p.includes("@"));
      const name = parts.filter((p) => p !== email).join(" ") || null;
      out.push({ email: email ?? parts[0]!, name });
      continue;
    }
    out.push({ email: line, name: null });
  }
  return out;
}
