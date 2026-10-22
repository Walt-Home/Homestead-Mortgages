/**
 * A pmi-termination task: one loan's borrower-paid mortgage insurance on an
 * evaluation date, under the Homeowners Protection Act as the servicing app
 * administers it (its spec §10.1 borrower-requested cancellation, §10.2
 * automatic termination at 78%, §10.3 final termination at the midpoint,
 * §10.5 the unearned-premium refund).
 *
 * The model gets the note as originated, any rate changes and modification
 * since, the mortgage insurance, the payment ledger, and on a request the
 * borrower's written request with its balances and valuation. It must build
 * what it needs of the MI amortization schedule with the tools, find the 78%
 * date, the midpoint and the trigger, and then decide what the evaluation
 * date calls for: the request, or the automatic termination at the trigger
 * with its cure; and, where the insurance ends, the effective date, the
 * clocks that run from it and the unearned premium.
 */

import type { Cents } from "@hm/kernel/money";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";

export const PMI_ENVIRONMENT_NAME = "pmi-termination";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const PMI_ENVIRONMENT_VERSION = "1.1.0";

export type Occupancy = "principal" | "second_home" | "investment";

export interface PmiLoan {
  /** The property's state, two letters. */
  readonly state: string;
  readonly consummation: PlainDate;
  readonly is_refinance: boolean;
  /** The contract price; null on a refinance. */
  readonly sales_price_cents: Cents | null;
  /** The appraised value relied on at consummation. */
  readonly appraised_value_cents: Cents;
  readonly units: number;
  readonly occupancy_at_origination: Occupancy;
  readonly original_principal_cents: Cents;
  readonly note_rate_pct: string;
  /** Always the 1st of a month. */
  readonly first_payment_due: PlainDate;
  /** Interest-only payments before amortization begins: 0 or 120. */
  readonly io_months: number;
  /** The amortizing term after any interest-only months. */
  readonly amortizing_term_months: number;
}

export interface RateChange {
  /** The payment the new rate first applies to, counted from the note's first payment as 1. */
  readonly payment_number: number;
  readonly new_rate_pct: string;
}

export interface Modification {
  readonly first_modified_due: PlainDate;
  readonly ib_upb_cents: Cents;
  readonly rate_pct: string;
  readonly term_months: number;
  readonly forborne_principal_cents: Cents;
}

export type MiPlan = "monthly" | "annual" | "single" | "lender_paid";

export interface Mi {
  readonly plan: MiPlan;
  /** The monthly premium, the annual premium, the single premium, or (lender-paid) what the lender pays monthly. */
  readonly premium_cents: Cents;
  /** The certificate's effective date: annual premiums renew on its anniversaries. */
  readonly coverage_start: PlainDate;
  /** A single premium's refund schedule: the percentage refunded once this many whole months are in force. */
  readonly refund_schedule?: readonly {
    readonly months_in_force_from: number;
    readonly refund_pct: string;
  }[];
}

export interface Ledger {
  /** The first due date listed. Every installment due before it was paid on its due date, and no funds are carried into it. */
  readonly from: PlainDate;
  readonly installments: readonly { readonly due_date: PlainDate; readonly amount_cents: Cents }[];
  /** Every receipt from `from` through the evaluation date, in the order received. */
  readonly receipts: readonly { readonly received_on: PlainDate; readonly amount_cents: Cents }[];
}

export interface CancellationRequestFacts {
  readonly received_on: PlainDate;
  readonly path: "original_value" | "current_value";
  /** Borrower-made improvements documented and accepted (the current-value path). */
  readonly improvements_accepted: boolean;
  /** The AVM Fannie Mae's servicing system returned for the request, or null when it returned none. */
  readonly avm_cents: Cents | null;
  /** A valuation the borrower paid for, ordered through Fannie Mae's servicing system, or null. */
  readonly valuation: { readonly value_cents: Cents; readonly delivered_on: PlainDate } | null;
  /** The date the borrower satisfied the holder's evidence requirement, or null when none was asked. */
  readonly evidence_satisfied_on: PlainDate | null;
  /** Installments whose lateness is attributable to a disaster under a plan the borrower kept. */
  readonly disaster_excluded: readonly PlainDate[];
  readonly balance: {
    /** The interest-bearing balance on the day the request was received. */
    readonly upb_on_receipt_cents: Cents;
    /** Every posting after that day through the evaluation date, each with the interest-bearing balance it left. */
    readonly postings: readonly {
      readonly posted_on: PlainDate;
      readonly upb_after_cents: Cents;
    }[];
    readonly deferred_principal_cents: Cents;
    readonly forborne_principal_cents: Cents;
  };
}

export interface PmiTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  /** The evaluation date: the sweep's date, or the day a request is decided. */
  readonly as_of: PlainDate;
  readonly loan: PmiLoan;
  /** ARM rate changes in effect by the evaluation date, in order. */
  readonly rate_changes: readonly RateChange[];
  readonly modification: Modification | null;
  readonly mi: Mi;
  readonly ledger: Ledger;
  readonly request: CancellationRequestFacts | null;
}

export function pmiPayload(task: PmiTask): Record<string, unknown> {
  return plain({
    as_of: task.as_of,
    loan: task.loan,
    rate_changes: task.rate_changes,
    modification: task.modification,
    mi: task.mi,
    ledger: task.ledger,
    request: task.request,
  }) as Record<string, unknown>;
}

export function renderPmiTask(task: PmiTask): string {
  return [
    task.request
      ? `Decide this borrower's written request to cancel mortgage insurance on ${task.as_of}, and state the loan's MI position.`
      : `Review this loan's mortgage insurance on ${task.as_of}.`,
    "",
    PAYLOAD_START,
    JSON.stringify(pmiPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure and date, and finish by calling submit_mi_review.",
  ].join("\n");
}
