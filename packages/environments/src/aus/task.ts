/**
 * An aus-decision task: one loan file, decided the way the shadow AUS
 * (`underwrite` in `@hm/underwriting`) decides it.
 *
 * The model gets the file as an underwriter holds it: one or two borrowers,
 * each with their own credit report (scores, tradelines, public records),
 * asset report and tax transcripts, or none; the household's income sources;
 * the property; the loan and, on a refinance, the loan it pays off; the
 * product and the instant its rate was set; and the instant the decision is
 * made. Two figures the engine computes from placeholders (an escrow
 * assumption, a mortgage-insurance estimate, a national title premium) are
 * given as the lender's estimates and never asked for: the monthly housing
 * payment and the closing cost total. Everything else it must work out,
 * from the scores to the outcome.
 */

import { PAYLOAD_START, plain, type Split } from "../refi/task.js";

export const AUS_ENVIRONMENT_NAME = "aus-decision";
/** Bump on any change to the rulebook, the tools, the rendering, the generator or the frozen APOR table. */
export const AUS_ENVIRONMENT_VERSION = "1.0.0";

export type Bureau = "equifax" | "experian" | "transunion";
export type TradelineType = "mortgage" | "revolving" | "installment" | "auto" | "student" | "heloc";
export type DtiExclusion = "paid_by_another_party" | "fewer_than_ten_payments_left";
export type PublicRecordType = "bankruptcy" | "foreclosure" | "short_sale" | "deed_in_lieu";
export type AccountType = "checking" | "savings" | "money_market" | "brokerage" | "retirement";
export type IncomeType =
  | "base_wage"
  | "overtime"
  | "bonus"
  | "commission"
  | "self_employment"
  | "rental"
  | "social_security"
  | "pension";
export type PropertyType =
  "single_family" | "condo" | "townhouse" | "two_to_four_unit" | "manufactured";
export type Occupancy = "primary_residence" | "second_home" | "investment";

export interface Tradeline {
  readonly creditor: string;
  readonly type: TradelineType;
  readonly opened_on: string;
  readonly balance_cents: number;
  /** A revolving line's or a HELOC's limit; null on an installment debt. */
  readonly credit_limit_cents: number | null;
  readonly monthly_payment_cents: number;
  /** Why the payment is left out of the debt-to-income ratio, or null when it counts. */
  readonly dti_exclusion: DtiExclusion | null;
}

export interface PublicRecord {
  readonly type: PublicRecordType;
  /** The filing date of a bankruptcy; the date of a foreclosure, short sale or deed in lieu. */
  readonly date: string;
  /** A bankruptcy's chapter, where the report gives one; null otherwise. */
  readonly chapter: "7" | "11" | "13" | null;
  /** A bankruptcy's discharge date, where it has one; null otherwise. */
  readonly discharged_on: string | null;
}

export interface CreditReport {
  readonly scores: readonly { readonly bureau: Bureau; readonly score: number }[];
  readonly tradelines: readonly Tradeline[];
  readonly public_records: readonly PublicRecord[];
}

export interface Account {
  readonly institution: string;
  readonly type: AccountType;
  /** The account number's last four digits. */
  readonly mask: string;
  readonly balance_cents: number;
  /** A retirement account's vested balance; null on any other account. */
  readonly vested_balance_cents: number | null;
  /** Whether the account may be counted toward reserves. */
  readonly used_to_qualify: boolean;
}

export interface AusBorrower {
  readonly name: string;
  /** Whether this borrower will live in the home as their primary residence. */
  readonly occupies_property: boolean;
  /** Null: no credit report has been pulled for this borrower. */
  readonly credit: CreditReport | null;
  /** Null: this borrower has connected no bank. */
  readonly assets: { readonly accounts: readonly Account[] } | null;
  readonly transcripts: readonly { readonly tax_year: number; readonly wages_cents: number }[];
}

export interface IncomeSource {
  readonly type: IncomeType;
  readonly monthly_cents: number;
  /** Whether the income is established to continue: true, false, or null while it is still under review. */
  readonly continuance_established: boolean | null;
}

export interface ExistingLoan {
  readonly balance_cents: number;
  /** The old note rate, or null where no source on the file carries it. */
  readonly rate_pct: string | null;
  readonly monthly_payment_cents: number;
  /** What the payment is: principal and interest only, or a scheduled payment that may include escrow. */
  readonly payment_basis: "principal_and_interest" | "scheduled_payment";
}

export interface AusTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  /** The instant the decision is made, in UTC. */
  readonly decided_at: string;
  readonly borrowers: readonly AusBorrower[];
  readonly income_sources: readonly IncomeSource[];
  readonly property: {
    readonly type: PropertyType;
    readonly occupancy: Occupancy;
    /** The purchase price, or the value on a refinance. */
    readonly value_cents: number;
    /** Financed properties the borrowers will own, this one included. */
    readonly financed_properties: number;
  };
  readonly loan: {
    readonly purpose: "purchase" | "rate_term_refinance";
    readonly amount_cents: number;
    readonly junior_lien_balance_cents: number;
    readonly junior_lien_credit_limit_cents: number;
    /** Seller and other interested-party credits toward the borrower's costs. */
    readonly interested_party_contributions_cents: number;
    /** On a refinance, the loan being paid off; null on a purchase. */
    readonly existing_loan: ExistingLoan | null;
  };
  readonly product: {
    readonly term_months: number;
    readonly amortization: "Fixed" | "AdjustableRate";
    readonly note_rate_pct: string;
    readonly prepayment_penalty: boolean;
    /** The instant the rate was set, in UTC. */
    readonly rate_set_at: string;
  };
  /** The lender's own estimates, given: never asked for. */
  readonly lender_estimates: {
    /** The monthly housing payment: principal and interest, taxes, insurance and any mortgage insurance. */
    readonly housing_payment_cents: number;
    /** Every closing cost on the lender's fee schedule for this loan. */
    readonly closing_costs_cents: number;
  };
}

export function ausPayload(task: AusTask): Record<string, unknown> {
  return plain({
    decided_at: task.decided_at,
    borrowers: task.borrowers,
    income_sources: task.income_sources,
    property: task.property,
    loan: task.loan,
    product: task.product,
    lender_estimates: task.lender_estimates,
  }) as Record<string, unknown>;
}

export function renderAusTask(task: AusTask): string {
  const who = task.borrowers.map((b) => b.name).join(" and ");
  return [
    `Decide this loan file for ${who}, as the automated underwriting system decides it, at ${task.decided_at}.`,
    "",
    PAYLOAD_START,
    JSON.stringify(ausPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure, and finish by calling submit_decision.",
  ].join("\n");
}
