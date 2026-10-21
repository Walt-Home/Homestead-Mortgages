/**
 * A metro2-furnishing task: one loan's monthly Metro 2 Base records, as the
 * servicing app's credit reporting furnishes them (its spec §8.1), for three
 * to six consecutive month-ends.
 *
 * The model gets the servicer's reporting policy, the note's terms, the
 * consumers on the loan, its installments and every receipt from the first
 * listed installment on, the last record furnished before the first month
 * (ours, a prior servicer's hand-off, or none), and for each month what the
 * servicer's books hold at its end and what is in force then: a
 * forbearance, repayment or trial plan, a modification or payment deferral,
 * a foreclosure referral, or the loan's closing. It must furnish each
 * month's Base record in order, each carrying the one before it.
 */

import type { Cents } from "@hm/kernel/money";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";
import type { AccountStatus, CreditConsumer, CreditPolicy } from "./ported/types.js";

export const METRO2_ENVIRONMENT_NAME = "metro2-furnishing";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const METRO2_ENVIRONMENT_VERSION = "1.0.0";

/** What is in force at a month-end. A month has at most one plan, workout or closing, and may also have a referral. */
export type InForce =
  | {
      readonly kind: "forbearance_plan";
      /** Always a 1st in v1. */
      readonly effective_on: PlainDate;
      /** 0 when payments are suspended. */
      readonly plan_payment_cents: Cents;
    }
  | {
      readonly kind: "repayment_plan";
      readonly plan_payment_cents: Cents;
      /** The plan's arrears still to be repaid at the month-end, from the servicer's books. */
      readonly remaining_arrears_cents: Cents;
    }
  | { readonly kind: "trial_plan"; readonly trial_payment_cents: Cents }
  | {
      readonly kind: "modification";
      readonly effective_on: PlainDate;
      readonly new_term_months: number;
      readonly new_piti_cents: Cents;
    }
  | { readonly kind: "payment_deferral"; readonly completed_on: PlainDate }
  | {
      readonly kind: "payoff";
      readonly closed_on: PlainDate;
      readonly by_refinance: boolean;
      /** The payoff funds the borrower sent, received on the closing date. They are not a receipt in the ledger. */
      readonly payoff_funds_cents: Cents;
    }
  | { readonly kind: "short_sale"; readonly closed_on: PlainDate }
  | {
      readonly kind: "foreclosure_sale";
      readonly closed_on: PlainDate;
      readonly deficiency_pursued: boolean;
    }
  | {
      readonly kind: "deed_in_lieu";
      readonly closed_on: PlainDate;
      readonly deficiency_pursued: boolean;
    }
  | { readonly kind: "foreclosure_referral"; readonly referred_on: PlainDate };

export type InForceKind = InForce["kind"];
export const CLOSINGS: readonly InForceKind[] = [
  "payoff",
  "short_sale",
  "foreclosure_sale",
  "deed_in_lieu",
];

/** What the servicer's books hold at a month-end. */
export interface MonthBooks {
  readonly upb_cents: Cents;
  readonly deferred_principal_cents: Cents;
  readonly forborne_principal_cents: Cents;
  readonly remaining_term_months: number;
  readonly maturity_date: PlainDate;
  readonly fnma_loan_number: string;
  /** The MERS MIN; null when the books have none. */
  readonly min: string | null;
}

export interface Metro2Month {
  /** YYYY-MM. */
  readonly month: string;
  readonly books: MonthBooks;
  readonly in_force: readonly InForce[];
}

/** The last Base record furnished before the first month, as it was furnished. */
export interface LastRecord {
  /** YYYY-MM: the month before the first month. */
  readonly month: string;
  readonly furnished_by: "us" | "prior_servicer";
  readonly account_status: AccountStatus;
  readonly special_comment: string;
  /** Up to 24 characters; a prior servicer's may be shorter. */
  readonly payment_history_profile: string;
  /** MMDDYYYY, or 00000000. */
  readonly date_of_first_delinquency: string;
}

export interface Metro2Task {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly policy: CreditPolicy;
  readonly loan: {
    readonly loan_id: string;
    readonly note_date: PlainDate;
    readonly original_amount_cents: Cents;
    readonly original_term_months: number;
    readonly note_rate_pct: string;
    readonly pi_cents: Cents;
    readonly escrow_cents: Cents;
    readonly interest_type: "F";
  };
  readonly consumers: readonly CreditConsumer[];
  /** Every installment from the first the ledger lists, each P&I + escrow, due on the 1st. */
  readonly installments: readonly { readonly due_date: PlainDate; readonly amount_cents: Cents }[];
  /** Every borrower receipt from the first listed installment through the last month's end, in the order received. */
  readonly receipts: readonly { readonly received_on: PlainDate; readonly amount_cents: Cents }[];
  readonly last_record: LastRecord | null;
  readonly months: readonly Metro2Month[];
}

export function metro2Payload(task: Metro2Task): Record<string, unknown> {
  return plain({
    policy: task.policy,
    loan: task.loan,
    consumers: task.consumers,
    installments: task.installments,
    receipts: task.receipts,
    last_record: task.last_record,
    months: task.months,
  }) as Record<string, unknown>;
}

export function renderMetro2Task(task: Metro2Task): string {
  const first = task.months[0]!.month;
  const last = task.months[task.months.length - 1]!.month;
  return [
    `Furnish this loan's Metro 2 Base record for each month from ${first} through ${last}.`,
    "",
    PAYLOAD_START,
    JSON.stringify(metro2Payload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure and date, and finish by calling submit_records.",
  ].join("\n");
}
