/**
 * What a pricing vendor is asked, and what two different kinds of vendor
 * answer.
 *
 * Every file in this product is quoted the same rate because the rate is a
 * number in the environment. Replacing that with a port means deciding, once,
 * what a quote IS — and there are two live candidate shapes that disagree
 * about the answer rather than about the request:
 *
 *   - a **product and pricing engine** returns eligible products carrying a
 *     borrower-facing note rate, with the adjustments already applied;
 *   - an **investor execution API** returns a price for a loan an investor
 *     would buy at a stated note rate, which is not the rate we quote anybody
 *     until a grid and a margin have been applied to it.
 *
 * `PriceQuote` is a union on `basis` for exactly that reason. A shape that fit
 * only the first would carry a `noteRate` an execution API never sends, and
 * whoever wired that vendor would fill it in by inventing the margin — which
 * is a pricing-policy decision with fair-lending consequences and not an
 * engineering one. So the second arm has no note rate to fill in, and
 * `borrowerNoteRate` returns null rather than deriving one.
 *
 * **Only the ANSWER is a union. The REQUEST is a pricing engine's, and says
 * so.** `PricingScenario` below asks what a loan of this size on this kind of
 * property costs, which is the whole of what a product and pricing engine
 * needs. An execution API is asked something else: a coupon ladder to price
 * against, a delivery type, whether servicing is retained or released, and —
 * because best execution means comparing buyers — which investors to ask. None
 * of the four is here, and `InvestorPriceQuote` carries no investor identity
 * either, so two investors' quotes for one product code are indistinguishable.
 * Writing that adapter means adding those fields to this file FIRST. It is not
 * work an adapter can do inside itself, because every one of those values
 * invented in an adapter is the invention this union exists to prevent, moved
 * one layer down where nothing above can see it.
 */

import type { LoanPurpose, OccupancyType, PropertyType, StateCode } from "./loan.js";

/**
 * The loan a quote is asked about.
 *
 * Deliberately names no person and carries no credit score. That is the same
 * split `PropertyDataConnector` draws between an address and a borrower, and
 * it is in the type rather than in a comment: a scenario can be priced on
 * screen 1, before APP-005 exists, because nothing in it is about anybody. The
 * credit-priced call takes a score as a separate argument alongside a
 * `PurposeToken`, and there is no way to smuggle one through here.
 *
 * A real sheet also prices on CLTV, on the number of units, on a subordinate
 * community second and on whether the borrower is buying their first home.
 * None of those are here yet; each is a field a vendor's request schema will
 * name, and adding one is a change to this interface rather than a value
 * quietly assumed inside an adapter.
 *
 * That list is a pricing engine's list, and it is the only kind of vendor this
 * request fits. An execution API additionally needs the coupon ladder, the
 * delivery type and the servicing option named in this file's header. The
 * asymmetry is deliberate and is written down rather than discovered: the
 * answer is a union today, the request is not, and the day somebody wires an
 * investor the interface changes before the adapter does.
 */
export interface PricingScenario {
  readonly purpose: LoanPurpose;
  readonly occupancy: OccupancyType;
  readonly propertyType: PropertyType;
  /** Pricing varies by state, and so do the fees behind an APR. */
  readonly state: StateCode;
  readonly loanAmount: number;
  /** Purchase price, or the estimated value on a refinance. */
  readonly propertyValue: number;
  /**
   * The lock period the sheet is quoted for, in days.
   *
   * Nothing in this product locks a rate, and this is not a lock request — it
   * is the column of the rate sheet being read. Every quote carries it back so
   * that a figure taken off the 30-day column cannot later be read as though
   * it came off the 60-day one.
   */
  readonly lockDays: number;
}

/** One line of the price stack, and what caused it. */
export interface PriceAdjustment {
  readonly reason: string;
  /**
   * Basis points. On a `borrower_rate` quote they are basis points of rate; on
   * an `investor_price` quote they are basis points of price. The two are not
   * interchangeable and nothing may sum across a mixed list.
   */
  readonly bps: number;
}

interface QuoteBase {
  readonly productCode: string;
  readonly productName: string;
  readonly termMonths: number;
  readonly amortization: "fixed" | "arm";
  readonly lockDays: number;
  /** When the sheet this came off was published, per the vendor. */
  readonly effectiveAt: string;
  /** When the vendor stops standing behind it. Not a lock — see `locked`. */
  readonly expiresAt: string;
  readonly adjustments: readonly PriceAdjustment[];
  /**
   * Whether the vendor priced this borrower's credit.
   *
   * False is the honest answer for a quote taken off a base sheet with no
   * score in the request, and it has to be a field rather than an inference
   * from an empty `adjustments` list: "we applied no adjustments because none
   * apply to this borrower" and "we never looked at a borrower" are different
   * statements, and only the first one is a rate anybody may be shown as
   * theirs.
   */
  readonly creditTierApplied: boolean;
  /**
   * Whether the rate is committed to. Nothing in this repository can lock a
   * rate — there is no lock desk, no lock record and no expiry enforcement —
   * so nothing here sets it true, and a screen may not say "locked",
   * "guaranteed" or "your rate" while it is false.
   */
  readonly locked: boolean;
}

/**
 * A product and pricing engine's answer: a rate a borrower could be quoted.
 *
 * `pricePercentOfPar` is optional here because many engines return the rate
 * and the price together and some return only the rate. Where it is present
 * and below par it implies discount points, which are part of the QM
 * points-and-fees total — one input to that total, and nowhere near all of it.
 */
export interface BorrowerRateQuote extends QuoteBase {
  readonly basis: "borrower_rate";
  readonly noteRate: number;
  readonly pricePercentOfPar: number | null;
}

/**
 * An investor execution API's answer: what a buyer would pay for this loan.
 *
 * `pricedNoteRate` is the coupon the investor was asked to price, NOT a rate
 * anybody may be shown. Turning a stack of prices into the one rate a borrower
 * is offered means choosing a margin and a grid, and that choice is a pricing
 * policy with fair-lending consequences — it decides what every borrower pays
 * above what the loan is worth. It belongs to whoever owns pricing, is
 * documented and tested as a policy, and is not a default anybody may put in
 * an adapter.
 *
 * There is no investor named on it, and that is a gap rather than a decision:
 * best execution is a comparison across buyers, and this shape cannot express
 * one. See the header — the request has to grow before this arm is reachable
 * at all.
 */
export interface InvestorPriceQuote extends QuoteBase {
  readonly basis: "investor_price";
  readonly pricePercentOfPar: number;
  readonly pricedNoteRate: number;
}

export type PriceQuote = BorrowerRateQuote | InvestorPriceQuote;

/**
 * The note rate this quote supports, or null when it does not support one.
 *
 * One function rather than a field access at each call site, so that the
 * refusal to turn a price into a rate is written once. A caller that gets null
 * must record `blocked` and say what it is waiting for; it must not fall back
 * to a configured number, because a rate nobody quoted is the failure this
 * port exists to end.
 */
export function borrowerNoteRate(quote: PriceQuote): number | null {
  return quote.basis === "borrower_rate" ? quote.noteRate : null;
}
