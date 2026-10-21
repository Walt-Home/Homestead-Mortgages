/**
 * An escrow-history task: escrow-analysis's annual analysis, starting from
 * the account's ledger rather than from figures already read off it.
 *
 * escrow-analysis hands the model each line's prior-year total and payment
 * dates, and the ledger's balance on the run date. An analyst has neither:
 * they have the ledger. Here the model gets the balance the account was
 * opened at, every deposit and disbursement posted since, and what is still
 * scheduled, each disbursement tagged with the line it paid. Last year's
 * figures for each line, and the balance on the run date, are its to read —
 * inside the right twelve months, and leaving out what belongs to another
 * year.
 *
 * Every history is written from an escrow-analysis account and keeps its
 * projected starting balance, so the account the rules read back out of it
 * concludes exactly what the original did.
 */

import type { Cents } from "@hm/kernel/money";
import { addMonths, type PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";
import type { EscrowLineInput } from "../escrow/ported/analysis.js";
import type { EscrowTask, LedgerItem } from "../escrow/task.js";

export const HISTORY_ENVIRONMENT_NAME = "escrow-history";
/** Bump on any change to the rulebook, the tools, the rendering or the generator, or to anything escrow-analysis's version covers. */
export const HISTORY_ENVIRONMENT_VERSION = "1.0.0";

export interface Posting {
  readonly on: PlainDate;
  readonly type: "deposit" | "disbursement";
  /** The escrow line a disbursement paid; null for a deposit or a one-off. */
  readonly line_type: string | null;
  readonly amount_cents: Cents;
  readonly description: string;
}

/** A line as the history gives it: without last year's total or dates, which the ledger holds. */
export type HistoryLine = Omit<EscrowLineInput, "prior_year_annual_cents" | "prior_disbursed_on">;

export interface EscrowHistoryTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly as_of: PlainDate;
  readonly year_start: PlainDate;
  readonly statement_sent_on: PlainDate;
  readonly lines: readonly HistoryLine[];
  readonly cpi_change_pct: string;
  readonly cushion: EscrowTask["cushion"];
  readonly ledger: {
    readonly opened: { readonly on: PlainDate; readonly balance_cents: Cents };
    /** Everything posted after the account was opened, through the run date. */
    readonly posted: readonly Posting[];
    /** Everything scheduled after the run date. */
    readonly scheduled: readonly Posting[];
  };
  readonly regx_days_delinquent: number;
  readonly workout: boolean;
  readonly borrower_election_months: number | null;
  readonly instrument_shortage_max_months: number | null;
  readonly current_escrow_payment_cents: Cents;
}

/**
 * The account the rules read out of a history: each line's prior-year total
 * and dates from its disbursements in the twelve months before year_start,
 * the balance on the run date from the opening balance and what has posted,
 * and the scheduled postings as the ledger's window. This is the whole of
 * what the rulebook's Step 0 says, and the grader's reading of the task.
 */
export function readHistory(h: EscrowHistoryTask): EscrowTask {
  const from = addMonths(h.year_start, -12);
  const all = [...h.ledger.posted, ...h.ledger.scheduled];
  const lines: EscrowLineInput[] = h.lines.map((l) => {
    const paid = all
      .filter(
        (p) =>
          p.type === "disbursement" &&
          p.line_type === l.line_type &&
          p.on >= from &&
          p.on < h.year_start,
      )
      .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
    return {
      ...l,
      prior_year_annual_cents: paid.reduce((s, p) => s + p.amount_cents, 0n),
      prior_disbursed_on: paid.map((p) => p.on),
    };
  });
  const sum = (xs: readonly Posting[], type: Posting["type"]) =>
    xs.filter((p) => p.type === type).reduce((s, p) => s + p.amount_cents, 0n);
  const balance_cents =
    h.ledger.opened.balance_cents +
    sum(h.ledger.posted, "deposit") -
    sum(h.ledger.posted, "disbursement");
  const window = (type: Posting["type"]): LedgerItem[] =>
    h.ledger.scheduled
      .filter((p) => p.type === type)
      .map((p) => ({ on: p.on, amount_cents: p.amount_cents, description: p.description }));
  return {
    id: h.id,
    split: h.split,
    suite_seed: h.suite_seed,
    index: h.index,
    as_of: h.as_of,
    year_start: h.year_start,
    statement_sent_on: h.statement_sent_on,
    lines,
    cpi_change_pct: h.cpi_change_pct,
    cushion: h.cushion,
    ledger: { balance_cents, deposits: window("deposit"), disbursements: window("disbursement") },
    regx_days_delinquent: h.regx_days_delinquent,
    workout: h.workout,
    borrower_election_months: h.borrower_election_months,
    instrument_shortage_max_months: h.instrument_shortage_max_months,
    current_escrow_payment_cents: h.current_escrow_payment_cents,
  };
}

export function historyPayload(task: EscrowHistoryTask): Record<string, unknown> {
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

export function renderHistoryTask(task: EscrowHistoryTask): string {
  return [
    `Run this loan's annual escrow analysis on ${task.as_of}, for the computation year starting ${task.year_start}, from the account's ledger.`,
    "",
    PAYLOAD_START,
    JSON.stringify(historyPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure and date, and finish by calling submit_analysis.",
  ].join("\n");
}
