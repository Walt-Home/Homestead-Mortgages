/**
 * An escrow-analysis task: one escrowed loan's annual analysis under RESPA
 * (Reg X §1024.17), the servicing app's §3.2.
 *
 * The model gets what the analyst has on the run date: the account's escrow
 * lines (each tax, insurance or mortgage-insurance item, with the bills the
 * payee has issued or last year's figures), the escrow ledger's balance and
 * what is still scheduled to post before the new year starts, the cushion
 * the policy, the security instrument and the state allow, the loan's
 * delinquency, and the escrow payment it pays today. It must project the new
 * year, find the low point, set the cushion, compare the target with the
 * balance the account will actually start with, decide what to do with the
 * difference, and say what the new payment is and when it starts.
 */

import type { Cents } from "@hm/kernel/money";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";
import type { EscrowLineInput } from "./ported/analysis.js";

export const ESCROW_ENVIRONMENT_NAME = "escrow-analysis";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const ESCROW_ENVIRONMENT_VERSION = "1.0.0";

/** A posting the ledger has scheduled: a deposit (a payment's escrow share) or a disbursement. */
export interface LedgerItem {
  readonly on: PlainDate;
  readonly amount_cents: Cents;
  readonly description: string;
}

export interface EscrowTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  /** The day the analysis is run. */
  readonly as_of: PlainDate;
  /** The first payment due date of the new computation year, a month's first day. */
  readonly year_start: PlainDate;
  readonly statement_sent_on: PlainDate;
  readonly lines: readonly EscrowLineInput[];
  /** The CPI-U annual change, a percent, for tax lines estimated from last year. */
  readonly cpi_change_pct: string;
  readonly cushion: {
    readonly policy_months: number;
    readonly instrument_months: number | null;
    readonly state_max_months: number | null;
  };
  readonly ledger: {
    readonly balance_cents: Cents;
    readonly deposits: readonly LedgerItem[];
    readonly disbursements: readonly LedgerItem[];
  };
  readonly regx_days_delinquent: number;
  readonly workout: boolean;
  readonly borrower_election_months: number | null;
  readonly instrument_shortage_max_months: number | null;
  readonly current_escrow_payment_cents: Cents;
}

export function escrowPayload(task: EscrowTask): Record<string, unknown> {
  return plain({
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
  }) as Record<string, unknown>;
}

export function renderEscrowTask(task: EscrowTask): string {
  return [
    `Run this loan's annual escrow analysis on ${task.as_of}, for the computation year starting ${task.year_start}.`,
    "",
    PAYLOAD_START,
    JSON.stringify(escrowPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure and date, and finish by calling submit_analysis.",
  ].join("\n");
}
