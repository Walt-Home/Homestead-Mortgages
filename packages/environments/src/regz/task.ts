/**
 * A Reg Z price-test task: one quoted loan, tested the way the shadow AUS
 * tests it before a decision — Regulation Z's General QM price and
 * points-and-fees tests (§1026.43), the higher-priced mortgage test
 * (§1026.35), the high-cost (HOEPA) triggers (§1026.32), and a refinance's
 * net tangible benefit.
 *
 * The model gets the quote as the file holds it: the loan and its product,
 * the property, the lender's itemized fees with who is paid each one, when
 * the rate was set (an instant, in UTC), whether ability to repay was
 * documented, and on a refinance the loan being paid off. Every figure the
 * tests turn on — the fee totals, the APR, the APOR for the week, the
 * thresholds for the loan's size — it must derive itself.
 */

import { PAYLOAD_START, plain, type Split } from "../refi/task.js";

export const REGZ_ENVIRONMENT_NAME = "regz-price-tests";
/**
 * Bump on any change to the rulebook, the tools, the rendering or the generator.
 *
 * 1.1.0 (21 Oct 2026): the engine prices a percentage fee in exact cents, half
 * up, so the quotes 1.0.0 redrew for landing on a half cent are fair and kept.
 */
export const REGZ_ENVIRONMENT_VERSION = "1.1.0";

export type Payee = "lender" | "affiliate" | "third_party" | "government";

export interface FeeLine {
  readonly name: string;
  readonly payee: Payee;
  /** A flat charge in cents, or a percent of the loan amount. */
  readonly amount_cents?: number;
  readonly percent_of_loan_amount?: string;
}

export interface RegzTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  /** When the rate was set: an instant, in UTC. */
  readonly rate_quoted_at: string;
  readonly loan: {
    readonly purpose: "purchase" | "rate_term_refinance";
    readonly amount_cents: number;
    readonly note_rate_pct: string;
    readonly term_months: number;
    readonly amortization: "Fixed" | "AdjustableRate";
    readonly prepayment_penalty: boolean;
  };
  readonly property: {
    readonly value_cents: number;
    readonly property_type:
      "single_family" | "condo" | "townhouse" | "two_to_four_unit" | "manufactured";
    readonly occupancy: "primary_residence" | "second_home" | "investment";
  };
  readonly fees: readonly FeeLine[];
  readonly atr_documented: boolean;
  /** On a refinance, the loan being paid off. */
  readonly existing_loan: {
    readonly monthly_payment_cents: number;
    readonly payment_basis: "principal_and_interest" | "scheduled_payment";
    readonly rate_pct: string | null;
  } | null;
}

export function regzPayload(task: RegzTask): Record<string, unknown> {
  return plain({
    rate_quoted_at: task.rate_quoted_at,
    loan: task.loan,
    property: task.property,
    fees: task.fees,
    atr_documented: task.atr_documented,
    existing_loan: task.existing_loan,
  }) as Record<string, unknown>;
}

export function renderRegzTask(task: RegzTask): string {
  return [
    "Run Regulation Z's price tests on this quoted loan.",
    "",
    PAYLOAD_START,
    JSON.stringify(regzPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure, and finish by calling submit_tests.",
  ].join("\n");
}
