/**
 * What this lender charges to close a loan, itemized, dated, and classified.
 *
 * Three different totals come out of one list, and the reason this is a list
 * rather than three numbers is that the three are DIFFERENT SUBSETS of the same
 * fees and nothing about a dollar figure says which subsets it belongs to:
 *
 *   - the **closing cost total** is every line, and it is what the net tangible
 *     benefit test (APP-019) divides by the monthly saving to get a recoup;
 *   - **points and fees** is Regulation Z §1026.32(b)(1) — broadly what the
 *     lender keeps or an affiliate is paid — and it is what the QM cap
 *     (UW-007) and the HOEPA fee trigger (UW-009) are measured against;
 *   - **prepaid finance charges** is §1026.4 — what the borrower pays for the
 *     privilege of the credit — and it is the only one of the three that
 *     changes the APR.
 *
 * They overlap and none contains another, so a schedule that carried one total
 * per line could not answer all three. An appraisal is a closing cost, is not
 * points and fees, and is not a finance charge. Discount points are all three.
 * Get a line's flags wrong in either direction and a legal test moves: a fee
 * wrongly excluded from points and fees understates the QM ratio, and one
 * wrongly included in the finance charge overstates the APR that HPML and
 * HOEPA are decided on. Each line therefore carries the reason for its own two
 * flags, and those reasons are this lender's classification of this lender's
 * charges rather than advice anybody may rely on.
 *
 * **It is versioned and dated because the number it produces lands in a legal
 * test.** A decision recomputed a year later against today's schedule would
 * quietly answer the QM question on fees that loan was never charged, and
 * nothing on the stored decision would say so. Every derivation that reads this
 * records `fee_schedule`, so a stored decision names the schedule it was priced
 * against.
 *
 * ⚠ What is NOT here is anything that varies by state or by property. Transfer
 * and mortgage recording taxes are set by the state and the county and are a
 * large share of a real closing; title premiums are filed rates in most states
 * and negotiated in the rest. None of them can be a lender-wide constant, and
 * inventing one would put a made-up number into the recoup a borrower is told.
 * They are absent, the totals below are therefore a lender's own charges rather
 * than a Loan Estimate, and the derivations say so in their formula.
 */

import { round } from "./derive.js";

/** Who ends up holding the money, which is most of what decides the flags. */
export type FeePayee = "lender" | "affiliate" | "third_party" | "government";

export interface FeeLine {
  /** Borrower-facing label, in the words a Loan Estimate would use. */
  readonly name: string;
  readonly payee: FeePayee;
  /** A flat dollar charge, or a percentage of the loan amount. */
  readonly basis: "fixed" | "percent_of_loan_amount";
  readonly amount: number;
  /**
   * A finance charge under §1026.4, and therefore part of the APR.
   *
   * Every line in this schedule is paid at or before closing, so a line that
   * is a finance charge is a PREPAID finance charge — it comes out of the
   * amount financed rather than being spread across the payments.
   */
  readonly financeCharge: boolean;
  /** Counted in points and fees under §1026.32(b)(1). */
  readonly pointsAndFees: boolean;
  /** Why the two flags above are what they are. */
  readonly basisNote: string;
}

export interface FeeSchedule {
  /** Recorded onto every derivation that reads a total from this schedule. */
  readonly version: string;
  /** When this schedule took effect, as an ISO date. */
  readonly effectiveFrom: string;
  readonly lines: readonly FeeLine[];
}

/**
 * The schedule in force.
 *
 * Replacing it means adding a new one and pointing the engine at it, not
 * editing these lines: a decision computed last month was computed against what
 * was charged last month, and an edit here rewrites that history silently.
 */
export const FEE_SCHEDULE: FeeSchedule = {
  version: "hm-2026-01",
  effectiveFrom: "2026-01-01",
  lines: [
    {
      name: "Origination fee",
      payee: "lender",
      basis: "percent_of_loan_amount",
      amount: 0.5,
      financeCharge: true,
      pointsAndFees: true,
      basisNote:
        "Retained by the lender for making the loan, so a finance charge under " +
        "§1026.4(a) — and inside points and fees because §1026.32(b)(1)(i) counts " +
        "the finance charge itself.",
    },
    {
      name: "Underwriting fee",
      payee: "lender",
      basis: "fixed",
      amount: 1_095,
      financeCharge: true,
      pointsAndFees: true,
      basisNote:
        "A lender charge incident to the extension of credit: §1026.4(a), and " +
        "therefore §1026.32(b)(1)(i).",
    },
    {
      name: "Processing fee",
      payee: "lender",
      basis: "fixed",
      amount: 495,
      financeCharge: true,
      pointsAndFees: true,
      basisNote:
        "A lender charge incident to the extension of credit: §1026.4(a), and " +
        "therefore §1026.32(b)(1)(i).",
    },
    {
      name: "Appraisal fee",
      payee: "third_party",
      basis: "fixed",
      amount: 650,
      financeCharge: false,
      pointsAndFees: false,
      basisNote:
        "A bona fide and reasonable appraisal fee paid to an unaffiliated party: one " +
        "of the real-estate-related charges §1026.4(c)(7) excludes from the finance " +
        "charge, and excluded from points and fees by §1026.32(b)(1)(iii) on the same " +
        "three conditions. Ordered from an affiliate it is inside both, which is why " +
        "the payee is on the line.",
    },
    {
      name: "Credit report fee",
      payee: "third_party",
      basis: "fixed",
      amount: 75,
      financeCharge: false,
      pointsAndFees: false,
      basisNote:
        "A bona fide credit report charge, excluded by §1026.4(c)(7) and by " +
        "§1026.32(b)(1)(iii).",
    },
    {
      name: "Flood determination fee",
      payee: "third_party",
      basis: "fixed",
      amount: 15,
      financeCharge: false,
      pointsAndFees: false,
      basisNote:
        "A bona fide third-party determination taken at closing, classified with the " +
        "other §1026.4(c)(7) items. A life-of-loan tracking fee charged by the lender " +
        "is not this line and would not carry these flags.",
    },
    {
      name: "Settlement or closing fee",
      payee: "third_party",
      basis: "fixed",
      amount: 850,
      financeCharge: false,
      pointsAndFees: false,
      basisNote:
        "Paid to an unaffiliated settlement agent for the document preparation and " +
        "closing §1026.4(c)(7) describes, and outside points and fees under " +
        "§1026.32(b)(1)(iii) while the agent is unaffiliated and the charge is " +
        "reasonable.",
    },
    {
      name: "Lender's title insurance",
      payee: "third_party",
      basis: "fixed",
      amount: 1_100,
      financeCharge: false,
      pointsAndFees: false,
      basisNote:
        "A bona fide title premium to an unaffiliated insurer: §1026.4(c)(7) names " +
        "title insurance first. This amount is a national placeholder — title premiums " +
        "are filed rates in most states, and the filed rate is what a real schedule " +
        "would carry.",
    },
    {
      name: "Recording fees",
      payee: "government",
      basis: "fixed",
      amount: 145,
      financeCharge: false,
      pointsAndFees: false,
      basisNote:
        "Paid to a public official to perfect the security interest, which " +
        "§1026.4(e)(1) excludes from the finance charge. Transfer and mortgage taxes " +
        "are NOT this line and are not in this schedule at all, because they are set " +
        "per state and county.",
    },
  ],
};

/** What one schedule costs a loan of this size, in the three subsets that matter. */
export interface ClosingCosts {
  /** Every line. What the net tangible benefit test recoups. */
  readonly total: number;
  /** §1026.32(b)(1). What the QM cap and the HOEPA fee trigger measure. */
  readonly pointsAndFees: number;
  /** §1026.4, paid at closing. What comes out of the amount financed for the APR. */
  readonly prepaidFinanceCharges: number;
  readonly version: string;
}

/**
 * Price one schedule against one loan amount.
 *
 * A negative or zero loan amount has no priced schedule rather than a schedule
 * of fixed fees: the percentage lines would come out at zero and the total
 * would look like a real quote for a loan nobody asked for.
 */
export function closingCosts(schedule: FeeSchedule, loanAmount: number): ClosingCosts | null {
  if (!Number.isFinite(loanAmount) || loanAmount <= 0) return null;

  let total = 0;
  let pointsAndFees = 0;
  let prepaidFinanceCharges = 0;
  for (const line of schedule.lines) {
    const amount =
      line.basis === "fixed" ? line.amount : round((loanAmount * line.amount) / 100, 2);
    total += amount;
    if (line.pointsAndFees) pointsAndFees += amount;
    if (line.financeCharge) prepaidFinanceCharges += amount;
  }
  return {
    total: round(total, 2),
    pointsAndFees: round(pointsAndFees, 2),
    prepaidFinanceCharges: round(prepaidFinanceCharges, 2),
    version: schedule.version,
  };
}
