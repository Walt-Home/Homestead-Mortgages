/**
 * The rate this file is quoted, and the one place that asks for it.
 *
 * It used to be `Number(process.env.DEFAULT_NOTE_RATE ?? "6.25")` read
 * straight out of `config` at four call sites — screen 1's affordability gate,
 * the file the gate lets through, and two places in the persona seed. Four
 * readers of one variable is four chances for a rate to be quoted that nobody
 * asked a vendor for, and it is why the note rate was the only figure on a
 * decision with no retrieval behind it.
 *
 * So the product is now two halves that come from two places. WHICH product we
 * offer is ours — `config.quotedProductCode`, a commercial decision — and
 * everything about it, the rate and the term included, comes off the quote.
 * Holding a second copy of the term in configuration is how a 30-year product
 * comes to be amortized over 180 months on one screen.
 *
 * **Nothing here falls back.** A quote that did not happen raises, and the
 * caller's request fails, because the alternative is a rate no vendor stood
 * behind sitting in `loan_files.note_rate` and reaching every ratio computed
 * from it. That is the same rule the decision engine keeps with
 * `DerivationLog.blocked`, applied one layer earlier: "we could not price
 * this" and "we priced it at 6.25%" must never collapse into the same number.
 *
 * **And nothing here resolves an ambiguity.** A quote that did not happen is
 * the easy case. The three below are the ones that arrive looking like prices:
 * several quotes under one product code, which is a rate/point stack and a
 * choice this file may not make; a quote off a lock column nobody asked for;
 * and a rate no vendor could have meant, which `requireQuotableQuote` refuses
 * on the way out the way `requireQuotableScenario` refuses on the way in.
 * Each of them used to reach `loan_files.note_rate`, and not one of them would
 * have looked wrong on the decision.
 */

import type {
  LoanPurpose,
  OccupancyType,
  PricingScenario,
  PropertyType,
  StateCode,
} from "@hm/shared";
import { borrowerNoteRate } from "@hm/shared";
import type { PricingConnector } from "@hm/connectors";
import { requireQuotableQuote } from "@hm/connectors";
import { config } from "../config.js";
import { AppError } from "../middleware/error-handler.js";

/**
 * What a borrower is told when a rate does not arrive, whatever stopped it.
 *
 * One sentence for four codes, because the four differences are an operator's
 * and none of them is anything a borrower could act on: nobody offered this
 * product, several quotes came back for it, the sheet was the wrong lock
 * column, or the answer was a price rather than a rate. The code is what a log
 * is read on; the sentence is what a screen shows.
 */
const NO_RATE =
  "We could not get a rate for this loan just now, so there is nothing to quote it against.";

/**
 * The lock column every quote in this flow is read off.
 *
 * Not a lock request. Nothing in this product locks a rate — there is no desk,
 * no lock record and nothing that expires — so this names which column of the
 * sheet is being read and no more. Whoever builds locking replaces the
 * constant with the borrower's chosen period and has to answer what happens
 * when the quote's `expiresAt` passes, which nothing does today.
 */
export const QUOTED_LOCK_DAYS = 30;

/** The loan a quote is about, as screen 1 states it. */
export interface SubjectLoan {
  readonly purpose: LoanPurpose;
  readonly occupancy: OccupancyType;
  readonly propertyType: PropertyType;
  readonly state: StateCode;
  readonly loanAmount: number;
  readonly propertyValue: number;
}

export function pricingScenarioFor(loan: SubjectLoan): PricingScenario {
  return {
    purpose: loan.purpose,
    occupancy: loan.occupancy,
    propertyType: loan.propertyType,
    state: loan.state.toUpperCase(),
    loanAmount: loan.loanAmount,
    propertyValue: loan.propertyValue,
    lockDays: QUOTED_LOCK_DAYS,
  };
}

/**
 * What a file is written with, once a vendor has answered.
 *
 * The window and the lock column are on it because a rate with neither cannot
 * be told apart from a current one. A quote carries `effectiveAt`, `expiresAt`
 * and `lockDays` precisely so that a figure read back next week is readable as
 * stale and so that a number taken off the 30-day column cannot later be read
 * as though it came off the 60-day one — and for a while this type dropped all
 * three at the only call site, which left those fields as decoration on a
 * shape nothing downstream could see. They are written with the file.
 */
export interface QuotedProduct {
  readonly productCode: string;
  readonly termMonths: number;
  readonly amortization: "fixed" | "arm";
  readonly noteRate: number;
  /** The sheet column this came off, in days. Not a lock. */
  readonly lockDays: number;
  /** When the sheet was published, per the vendor. */
  readonly effectiveAt: Date;
  /** When the vendor stops standing behind it. */
  readonly expiresAt: Date;
}

/**
 * The product this deployment offers, priced for this loan.
 *
 * The unguarded call, so this runs on screen 1 before APP-005 exists: a
 * `PricingScenario` names a loan and nobody. The credit-priced call is
 * `quoteForBorrower`, it takes a `PurposeToken` and a representative FICO, and
 * nothing calls it yet — there is no screen that re-quotes after the credit
 * pull, and adding one means deciding what a borrower is told when the second
 * quote is worse than the first.
 */
export async function quoteSubjectProduct(
  pricing: PricingConnector,
  loan: SubjectLoan,
): Promise<QuotedProduct> {
  const scenario = pricingScenarioFor(loan);
  const quotes = await pricing.quoteProducts(scenario);
  const matches = quotes.filter((q) => q.productCode === config.quotedProductCode);
  if (matches.length === 0) {
    throw new AppError(503, NO_RATE, "NO_RATE_QUOTED");
  }
  /**
   * More than one quote under one product code is a rate/point stack, and
   * picking one of them is the pricing policy this file says it does not own.
   *
   * A pricing engine returns the same 30-year fixed several times over — at
   * 6.875 for 101.5, at 6.25 for par, at 5.75 for 98.25 — and `find` would
   * have taken whichever the vendor serialized first. That is 112 basis points
   * of somebody's rate decided by array order, and it would not look like a
   * decision anywhere: it would look like a rate. Whether a borrower is
   * offered par pricing or is buying the rate down is a policy with a
   * disclosure attached, so this stops rather than resolves it. The fixture
   * sheet returns one row per product, so nothing reaches here today; the
   * first vendor that returns a stack does, and stops.
   */
  if (matches.length > 1) {
    throw new AppError(503, NO_RATE, "AMBIGUOUS_RATE_QUOTED");
  }
  const quote = matches[0]!;
  /**
   * The column we asked for is the column we were answered off.
   *
   * The scenario names a lock period so that a figure taken off the 30-day
   * column cannot later be read as though it came off the 60-day one, and
   * nothing checked the answer against the question. A vendor quoting a
   * 90-day sheet to a 30-day request is a spread this product did not ask for
   * and would not disclose.
   */
  if (quote.lockDays !== scenario.lockDays) {
    throw new AppError(503, NO_RATE, "WRONG_LOCK_COLUMN");
  }
  // A vendor's answer is checked before it is believed. A rate of zero, of
  // 999, or of a field that was never sent is a mapping bug that reads as a
  // number all the way to the decision — see `requireQuotableQuote`.
  requireQuotableQuote(quote);
  // An execution API prices a coupon rather than quoting a rate, and turning
  // one into the other needs a margin nobody here may choose. Null is refused
  // rather than filled in.
  const noteRate = borrowerNoteRate(quote);
  if (noteRate === null) {
    throw new AppError(503, NO_RATE, "NO_RATE_QUOTED");
  }
  return {
    productCode: quote.productCode,
    termMonths: quote.termMonths,
    amortization: quote.amortization,
    noteRate,
    lockDays: quote.lockDays,
    effectiveAt: new Date(quote.effectiveAt),
    expiresAt: new Date(quote.expiresAt),
  };
}
