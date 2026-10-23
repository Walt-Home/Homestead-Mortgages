/**
 * An escrow-review task: one loan's annual escrow analysis on its run date,
 * drawn from a ten-year history the life generator wrote, as the analyst
 * reviews it before it is approved.
 *
 * The servicing app holds an analysis for anomaly review when the new
 * payment moves by more than a quarter or $150, when a bill moves more than
 * 20 % against last year, and on a few other triggers (its spec §3.2 R10;
 * `anomalies`, apps/servicing/src/domain/escrow/analysis.ts:101-107). Most of
 * the analyses here come from a history in which the county reassessed the
 * property or the hazard premium rose at renewal; the rest are ordinary
 * years. The model gets escrow-analysis's inputs exactly (the lines, the
 * ledger's balance and what is still scheduled, the cushion, the delinquency
 * and today's escrow payment) and the account's recent history beside them:
 * the analyses before this one, the disbursements of the last two years and
 * the last twelve month-ends. It works out the shortage or surplus, the new
 * payment, its effective date and the months a shortage is spread over, and
 * says whether the flag stands.
 */

import type { Cents } from "@hm/kernel/money";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain } from "../refi/task.js";
import type { EscrowTask } from "../escrow/task.js";

export const REVIEW_ENVIRONMENT_NAME = "escrow-review";
/** Bump on any change to the rulebook, the tools, the rendering or the generator, to anything escrow-analysis's version covers, or to the life generator's draws. */
export const REVIEW_ENVIRONMENT_VERSION = "1.0.0";

export interface PastAnalysis {
  readonly as_of: PlainDate;
  readonly year_start: PlainDate;
  readonly decision: string;
  readonly surplus_cents: Cents | null;
  readonly shortage_cents: Cents | null;
  readonly new_payment_cents: Cents;
  readonly effective_on: PlainDate;
}

export interface PastDisbursement {
  readonly on: PlainDate;
  readonly line_type: string;
  readonly amount_cents: Cents;
}

export interface PastEscrowMonth {
  readonly month: string;
  readonly escrow_balance_cents: Cents;
  readonly escrow_payment_cents: Cents;
  readonly days_delinquent: number;
}

/** escrow-analysis's task, and the loan and its history around it. */
export type EscrowReviewTask = EscrowTask & {
  readonly loan_number: string;
  readonly borrowers: readonly string[];
  readonly property_state: string;
  readonly history: {
    readonly analyses: readonly PastAnalysis[];
    readonly disbursements: readonly PastDisbursement[];
    readonly month_ends: readonly PastEscrowMonth[];
  };
};

/** The analysis inputs alone, as escrow-analysis's engine run takes them. */
export const analysisOf = (task: EscrowReviewTask): EscrowTask => ({
  id: task.id,
  split: task.split,
  suite_seed: task.suite_seed,
  index: task.index,
  as_of: task.as_of,
  year_start: task.year_start,
  statement_sent_on: task.statement_sent_on,
  lines: task.lines,
  cpi_change_pct: task.cpi_change_pct,
  cushion: task.cushion,
  ledger: task.ledger,
  regx_days_delinquent: task.regx_days_delinquent,
  workout: task.workout,
  borrower_election_months: task.borrower_election_months,
  instrument_shortage_max_months: task.instrument_shortage_max_months,
  current_escrow_payment_cents: task.current_escrow_payment_cents,
});

export function reviewPayload(task: EscrowReviewTask): Record<string, unknown> {
  const a = analysisOf(task);
  return plain({
    loan_number: task.loan_number,
    borrowers: task.borrowers,
    property_state: task.property_state,
    as_of: a.as_of,
    year_start: a.year_start,
    statement_sent_on: a.statement_sent_on,
    lines: a.lines,
    cpi_change_pct: a.cpi_change_pct,
    cushion: a.cushion,
    ledger: a.ledger,
    regx_days_delinquent: a.regx_days_delinquent,
    workout: a.workout,
    borrower_election_months: a.borrower_election_months,
    instrument_shortage_max_months: a.instrument_shortage_max_months,
    current_escrow_payment_cents: a.current_escrow_payment_cents,
    history: task.history,
  }) as Record<string, unknown>;
}

export function renderReviewTask(task: EscrowReviewTask): string {
  return [
    `Review loan ${task.loan_number}'s annual escrow analysis, run on ${task.as_of} for the computation year starting ${task.year_start}, before it is approved.`,
    "",
    PAYLOAD_START,
    JSON.stringify(reviewPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure and date, and finish by calling submit_review.",
  ].join("\n");
}
