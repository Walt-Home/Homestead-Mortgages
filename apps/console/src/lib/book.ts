/**
 * The book we hold for a servicer, as the console reads it: our own loans
 * database, at our own door, `/console/hm/tape/servicers/:slug/*`. The tape
 * desk writes it, and this is where it is read back — the loans a page at a
 * time, one loan whole, and the reconciliation of every tape that built it.
 *
 * The servicing app's partner book is another database, which a servicer's
 * tape never fills; nothing here asks it anything.
 */

import { hm, type Call } from "./api.js";
import { fmtDate, plural, words } from "./format.js";
import type { PortalLoan, PortalLoanDetail } from "../partners/api.js";

/** One loan on the book: the row the partner portal reads, `servicerBookLoans` in `apps/api`. */
export type BookLoan = PortalLoan;
/** One loan whole: what `servicerBookLoan` answers the portal. */
export type BookLoanDetail = PortalLoanDetail;

export const BOOK_PAGE = 100;

const servicerPath = (slug: string) => `/servicers/${encodeURIComponent(slug)}`;

export const bookLoans = (
  slug: string,
  opts: { readonly q?: string; readonly offset?: number; readonly limit?: number } = {},
  init: Call = {},
) =>
  hm<{ total: number; rows: BookLoan[] }>(`${servicerPath(slug)}/loans`, {
    ...init,
    query: { q: opts.q, offset: opts.offset ?? 0, limit: opts.limit ?? BOOK_PAGE },
  });

/** The portal's route answers `{ loan }`; a bare loan is read the same. */
export const bookLoan = (slug: string, loanId: string, init: Call = {}) =>
  hm<{ loan: BookLoanDetail } | BookLoanDetail>(
    `${servicerPath(slug)}/loans/${encodeURIComponent(loanId)}`,
    init,
  ).then((r) => ("loan" in r ? r.loan : r));

/* ── the reconciliation ────────────────────────────────────────────────────── */

/** A row the tape carried and the load refused, and why. */
export interface TapeRefusal {
  readonly row: number;
  readonly number: string | null;
  readonly code: string;
  readonly column: string | null;
}

/** A refused row no tape has since carried onto the book, and the tape it came from. */
export interface OutstandingRow extends TapeRefusal {
  readonly tapeId: string;
  readonly tapeAsOf: string;
  readonly tapeFilename: string | null;
}

/** One tape loaded onto the book, and what of it is still there. */
export interface ReconciledTape {
  readonly id: string;
  readonly filename: string | null;
  readonly asOf: string;
  readonly loadedAt: string;
  /** The day the loans this tape created are billed from; null when they differ, or it created none. */
  readonly billedFrom: string | null;
  readonly rowsTotal: number;
  readonly rowsLoaded: number;
  readonly rowsRefused: number;
  readonly loansCreated: number;
  readonly loansUpdated: number;
  readonly loansUnchanged: number;
  /** The loans this tape created that are on the book today. */
  readonly loansStillOnBook: number;
  /** The principal balances this tape reported, summed, in cents. */
  readonly balanceCents: string;
  readonly refused: readonly TapeRefusal[];
  /** Loans this tape created whose number, spelled plainly, is a loan another tape created first. */
  readonly duplicates: number;
  readonly duplicatesOf: readonly { readonly tapeId: string; readonly loans: number }[];
  readonly removable: { readonly ok: boolean; readonly reasons: readonly string[] };
  /**
   * What taking this tape back deletes. `loans` is the loans only this tape
   * carries — no other tape on the book has observed them — and is the
   * count a removal is confirmed with; it is not `loansStillOnBook`, which
   * counts what the tape created whether or not a later tape carries it
   * too. `observations` is every observation the tape wrote, of those loans
   * and of the ones that stay.
   */
  readonly removes: {
    readonly loans: number;
    readonly observations: number;
    readonly reviews: number;
  };
}

/** A tape taken off the book: what went, why, and who did it. */
export interface TapeRemoval {
  readonly id: string;
  readonly tapeId: string;
  readonly filename: string | null;
  readonly asOf: string;
  readonly loansRemoved: number;
  readonly observationsRemoved: number;
  readonly balanceCents: string;
  readonly reason: string;
  readonly removedBy: string | null;
  readonly removedByName: string | null;
  readonly removedAt: string;
}

export interface TapeReconciliation {
  readonly servicer: { readonly slug: string; readonly displayName: string };
  readonly loansOnBook: number;
  /** Oldest first. */
  readonly tapes: readonly ReconciledTape[];
  readonly removals: readonly TapeRemoval[];
  /**
   * The loans the book is missing: a row some tape refused whose number is
   * still not on the book, or that carried no readable number at all. The
   * per-tape refusals are what one delivery could not read; this is what is
   * still true, and it stays until a tape carries the loan. A loan that
   * never reaches the book never reaches a statement.
   */
  readonly outstanding: readonly OutstandingRow[];
  /** Every loan a tape created, less every loan a removal took, is the book. */
  readonly check: {
    readonly created: number;
    readonly removed: number;
    readonly loansOnBook: number;
    readonly adds: boolean;
  };
}

export const tapeReconciliation = (slug: string, init: Call = {}) =>
  hm<TapeReconciliation>(`${servicerPath(slug)}/tapes`, init);

/** Where a tape is taken off the book. The body is `{ confirmLoans, reason }`. */
export const removeTapePath = (slug: string, tapeId: string) =>
  `${servicerPath(slug)}/tapes/${encodeURIComponent(tapeId)}/remove`;

export interface RemovedTape {
  readonly removal: TapeRemoval;
  readonly loansOnBook: number;
}

/** A tape by the name it arrived under, or by its date when it came with none. */
export const tapeName = (t: { readonly filename: string | null; readonly asOf: string }): string =>
  t.filename ?? `Tape of ${fmtDate(t.asOf)}`;

/** The loans a tape found already on the book: the ones it changed and the ones it did not. */
export const alreadyOnBook = (t: ReconciledTape): number => t.loansUpdated + t.loansUnchanged;

/**
 * The loans a tape observed that stay when it is taken back, because
 * another tape carries them too: every observation it wrote, less the ones
 * of loans only it carries. Each tape observes a loan once.
 */
export const keptOnRemoval = (t: ReconciledTape): number =>
  Math.max(0, t.removes.observations - t.removes.loans);

/** Why a row was refused, in the words an analyst reads. */
export function refusalWords(code: string, column: string | null = null): string {
  switch (code) {
    case "no_loan_number":
      return "No loan number";
    case "no_term":
      return "No term";
    case "no_state":
      return "No state";
    case "no_balance_or_rate":
      return "No balance or rate";
    case "unreadable_cell":
      return column ? `${column} unreadable` : "A cell unreadable";
    case "loan_number_scientific":
      return "Loan number in scientific notation";
    case "loan_number_not_exact":
      return "Loan number too long to read exactly";
    default:
      return words(code);
  }
}

export interface BookSum {
  /** Every tape the book was built from, those since removed included. */
  readonly tapes: number;
  readonly created: number;
  readonly removed: number;
  readonly onBook: number;
  readonly adds: boolean;
}

/**
 * The reconciliation's footer: what the tapes created, less what was
 * removed, against what the book holds. It adds up only when the server
 * says so and the arithmetic agrees.
 */
export function bookSum(r: Pick<TapeReconciliation, "tapes" | "removals" | "check">): BookSum {
  const tapes = new Set([...r.tapes.map((t) => t.id), ...r.removals.map((x) => x.tapeId)]).size;
  const { created, removed, loansOnBook } = r.check;
  return {
    tapes,
    created,
    removed,
    onBook: loansOnBook,
    adds: r.check.adds && created - removed === loansOnBook,
  };
}

/** "1,866 new loans across 6 tapes − 245 removed = 1,621 on the book". */
export function bookSumWords(s: BookSum): string {
  return `${plural(s.created, "new loan")} across ${plural(s.tapes, "tape")} − ${s.removed.toLocaleString()} removed = ${s.onBook.toLocaleString()} on the book`;
}

/** When the sum does not hold, the gap in a sentence. */
export function bookGapWords(s: BookSum): string {
  const expected = s.created - s.removed;
  return `${plural(s.created, "new loan")} across ${plural(s.tapes, "tape")}, less ${s.removed.toLocaleString()} removed, is ${expected.toLocaleString()}; the book holds ${plural(s.onBook, "loan")}.`;
}

/** The tape a duplicate repeats, by name, wherever it is listed. */
export function repeatedTapeName(
  tapeId: string,
  r: Pick<TapeReconciliation, "tapes" | "removals">,
): string {
  const t = r.tapes.find((x) => x.id === tapeId) ?? r.removals.find((x) => x.tapeId === tapeId);
  return t ? tapeName(t) : "another tape";
}

/** A typed confirmation matches when it is the number, with or without its commas. */
export const confirmsNumber = (typed: string, n: number): boolean =>
  typed.trim().replace(/[,\s]/g, "") === String(n);
