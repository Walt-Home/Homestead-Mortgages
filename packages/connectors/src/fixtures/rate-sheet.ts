/**
 * The fixture rate sheet — what a pricing vendor would publish this morning.
 *
 * Kept beside `personas.ts` and `public-records.ts` for the reason they are
 * kept apart from each other: this describes neither a borrower's financial
 * life nor a fact a county holds about a building, but a price list a lender
 * publishes about itself. It is not keyed by persona, and it must never
 * become so — a sheet that changed with whose file was open would be a
 * credit-priced rate wearing a base rate's label.
 *
 * ⚠ These rates are FIXTURE DATA, exactly as the personas' balances are. The
 * 6.25% on the 30-year is the number `DEFAULT_NOTE_RATE` held before this
 * sheet existed, carried over deliberately so that replacing the environment
 * variable with a port changed where a rate comes from and not what any file
 * was quoted.
 *
 * What is NOT here is a price adjustment of any kind. There is no FICO tier,
 * no LTV band, no occupancy hit and no lock-extension spread, because every
 * one of those is a published matrix this repository does not hold, and a
 * plausible-looking invention is the wrong kind of wrong: believable enough to
 * be quoted. `creditTierApplied` on every quote off this sheet is false, and
 * that is the sheet telling the truth about itself rather than a gap.
 */

/** One product on the sheet, before anything is adjusted. */
export interface RateSheetProduct {
  readonly productCode: string;
  readonly productName: string;
  readonly termMonths: number;
  readonly amortization: "fixed" | "arm";
  /** Base note rate, in percent. */
  readonly baseRate: number;
}

/**
 * The one lock period this sheet is quoted for.
 *
 * A real sheet carries a column per period and the spread between them is
 * published. Quoting a 60-day request off the 30-day column would be inventing
 * that spread, so a scenario asking for any other period gets no products —
 * which is an answer, and a truthful one: this sheet has no such column.
 */
export const SHEET_LOCK_DAYS = 30;

/**
 * One product, and one is deliberate.
 *
 * A 15-year row sat here at 5.50% for a while, and nothing could say where
 * that number came from. The 6.25% above has a provenance sentence because it
 * has a provenance; a 75bp term spread nobody published has none, and it was
 * reachable — `QUOTED_PRODUCT_CODE=CONF-15-FIXED` would have quoted every
 * borrower on that deployment a rate this repository invented, into
 * `loan_files.note_rate` and every ratio computed from it. One product is
 * enough to prove a port. A second base rate with no source behind it is the
 * one number on this sheet that somebody could be quoted and nobody could
 * account for.
 */
export const RATE_SHEET: readonly RateSheetProduct[] = [
  {
    productCode: "CONF-30-FIXED",
    productName: "Conforming 30-year fixed",
    termMonths: 360,
    amortization: "fixed",
    baseRate: 6.25,
  },
];

/**
 * When the sheet was published and when it stops standing.
 *
 * A rate sheet is a daily document, so the window is the day it was published
 * and not a fortnight either side. Deriving both from the reference date is
 * what lets a fixture-served quote carry an expiry a screen could honor — and
 * what stops a quote read back a week later from still looking current.
 */
export function sheetWindow(ref: Date): { effectiveAt: string; expiresAt: string } {
  const start = new Date(
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), 0, 0, 0, 0),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60_000 - 1);
  return { effectiveAt: start.toISOString(), expiresAt: end.toISOString() };
}
