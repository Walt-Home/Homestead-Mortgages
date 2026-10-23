/**
 * A catchup-posting task: one receipt on a loan that fell behind, the moment
 * a borrower sends money to catch up after a missed installment, drawn from
 * a ten-year history the life generator wrote.
 *
 * The model gets the loan as the servicing system shows it on the day the
 * receipt arrives, after that morning's late-charge run: the note's
 * late-charge terms beside the terms the system boarded (which may have lost
 * the note's dollar cap, D-03), the cash state, the installments, every late
 * charge assessed since the first payment with what was collected on it, and
 * the last twelve months of payments and month-ends. It holds every late
 * charge to the note, posts the receipt through the waterfall, states what
 * is owed back to the borrower, and says whether the loan is current after
 * posting.
 */

import type { Cents } from "@hm/kernel/money";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";

export const CATCHUP_ENVIRONMENT_NAME = "catchup-posting";
/** Bump on any change to the rulebook, the tools, the rendering or the generator, or to the life generator's draws. */
export const CATCHUP_ENVIRONMENT_VERSION = "1.0.0";

export interface LateChargeTerms {
  /** A percent of the installment's P&I: "5" is 5 %. */
  readonly pct: string;
  readonly grace_days: number;
  /** The most one charge may be, or null for no dollar cap. */
  readonly cap_cents: Cents | null;
  readonly basis: "pi";
}

export interface Installment {
  readonly due_date: PlainDate;
  readonly pi_cents: Cents;
  readonly escrow_cents: Cents;
  readonly status: "due" | "satisfied" | "prepaid";
  readonly satisfied_on: PlainDate | null;
}

/** One late charge as the system recorded it, with the P&I of the installment it was charged on. */
export interface LateChargeRow {
  readonly installment_due_date: PlainDate;
  readonly assessed_on: PlainDate;
  readonly amount_cents: Cents;
  readonly collected_cents: Cents;
  readonly state: "assessed" | "collected";
  readonly installment_pi_cents: Cents;
}

export interface PastReceipt {
  readonly payment_id: string;
  readonly received_on: PlainDate;
  readonly amount_cents: Cents;
  readonly outcome: string;
  readonly installments_paid: readonly PlainDate[];
  readonly late_charge_cents: Cents;
  readonly curtailment_cents: Cents;
  readonly to_suspense_cents: Cents;
}

export interface PastMonthEnd {
  readonly month: string;
  readonly upb_cents: Cents;
  readonly next_due: PlainDate | null;
  readonly days_delinquent: number;
  readonly late_charges_due_cents: Cents;
  readonly suspense_cents: Cents;
}

export interface CatchupTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly receipt: {
    readonly payment_id: string;
    readonly amount_cents: Cents;
    /** Received and credited the same day. */
    readonly received_on: PlainDate;
  };
  readonly loan_number: string;
  readonly borrowers: readonly string[];
  readonly property_state: string;
  readonly note: {
    readonly note_date: PlainDate;
    readonly first_payment_due: PlainDate;
    readonly maturity: PlainDate;
    readonly original_balance_cents: Cents;
    readonly late_charge: LateChargeTerms;
  };
  /** What the servicing system wrote when it boarded the loan: from the note, or from a transfer's tape. */
  readonly servicing: {
    readonly boarded_on: PlainDate;
    readonly transfer_in_on: PlainDate | null;
    readonly late_charge: LateChargeTerms;
  };
  /** The cash state on the receipt's day, after that morning's late-charge run, as the system holds it. */
  readonly loan: {
    readonly instrument_date: PlainDate;
    readonly lien: "first";
    readonly escrowed: boolean;
    /** The note rate the open installments are charged at. */
    readonly note_rate_pct: string;
    readonly upb_cents: Cents;
    readonly lpi_date: PlainDate | null;
    readonly suspense_cents: Cents;
    readonly late_charges_due_cents: Cents;
    readonly partial_count_12m: number;
    readonly installments: readonly Installment[];
  };
  readonly late_charges: readonly LateChargeRow[];
  readonly history: {
    readonly receipts: readonly PastReceipt[];
    readonly month_ends: readonly PastMonthEnd[];
  };
}

export function catchupPayload(task: CatchupTask): Record<string, unknown> {
  return plain({
    receipt: task.receipt,
    loan_number: task.loan_number,
    borrowers: task.borrowers,
    property_state: task.property_state,
    note: task.note,
    servicing: task.servicing,
    loan: task.loan,
    late_charges: task.late_charges,
    history: task.history,
  }) as Record<string, unknown>;
}

export function renderCatchupTask(task: CatchupTask): string {
  return [
    `Post payment ${task.receipt.payment_id}, received on ${task.receipt.received_on} on loan ${task.loan_number}, which fell behind.`,
    "",
    PAYLOAD_START,
    JSON.stringify(catchupPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure, and finish by calling submit_posting.",
  ].join("\n");
}
