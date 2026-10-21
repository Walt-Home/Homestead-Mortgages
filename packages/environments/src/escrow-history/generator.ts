/**
 * Ledgers, written from escrow-analysis's accounts.
 *
 * Each history starts from the account escrow-analysis would draw under its
 * own name and writes it out as thirteen months of ledger:
 *   - the balance the account was opened at;
 *   - each month's escrow deposit;
 *   - every line's payments last year, on the dates and in the amounts that
 *     add to its prior-year figures;
 *   - an older payment or two from the year before, which is not last year;
 *   - the account's one-off postings, tagged with no line;
 *   - what is still scheduled after the run date, the new year's included.
 *
 * Last year's payments still to come after the run date are scheduled, and
 * they come out of the projected starting balance like any other. So the
 * opening balance is set last, to keep that projected balance exactly the
 * original's: the account read back out of the history then concludes
 * exactly what the original did, and a test holds that.
 */

import { addDays, addMonths, parts, ymd, type PlainDate } from "@hm/kernel/calendar";
import { rngFor, type Rng } from "../rng.js";
import type { Split } from "../refi/task.js";
import { drawEscrowTask } from "../escrow/generator.js";
import { projectedActual } from "../escrow/grader.js";
import type { EscrowTask } from "../escrow/task.js";
import {
  HISTORY_ENVIRONMENT_NAME,
  HISTORY_ENVIRONMENT_VERSION,
  type EscrowHistoryTask,
  type HistoryLine,
  type Posting,
} from "./task.js";

export const historyTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${HISTORY_ENVIRONMENT_NAME}/${HISTORY_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

const LABEL: Readonly<Record<string, string>> = {
  tax_county: "county tax",
  tax_city: "city tax",
  tax_school: "school tax",
  hazard: "hazard insurance",
  flood: "flood insurance",
  mi_borrower_paid: "mortgage insurance",
};
const byDate = (a: Posting, b: Posting) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0);

/** One account written as its ledger, drawing the ledger's own variety from `r`. */
export function historyOf(t: EscrowTask, r: Rng): EscrowHistoryTask {
  const opened = addMonths(t.year_start, -13);
  const postings: Posting[] = [];

  // Each line's payments last year, adding to its prior-year figure.
  for (const l of t.lines) {
    const dates = [...l.prior_disbursed_on].sort();
    const n = BigInt(dates.length);
    if (n === 0n) continue;
    const per = l.prior_year_annual_cents / n;
    dates.forEach((on, k) =>
      postings.push({
        on,
        type: "disbursement",
        line_type: l.line_type,
        amount_cents: k === dates.length - 1 ? l.prior_year_annual_cents - per * (n - 1n) : per,
        description: `${LABEL[l.line_type] ?? l.line_type}${dates.length > 1 ? `, installment ${k + 1} of ${dates.length}` : ""}`,
      }),
    );
  }
  // A payment from the year before last year, which the window must leave out.
  const older = t.lines.filter((l) => l.prior_disbursed_on.length > 0);
  for (const l of older.slice(0, r.int(1, Math.min(2, older.length)))) {
    const { y, m } = parts(opened);
    postings.push({
      on: ymd(y, m, r.int(2, 28)),
      type: "disbursement",
      line_type: l.line_type,
      amount_cents:
        (l.prior_year_annual_cents * BigInt(r.int(85, 105))) /
        100n /
        BigInt(l.prior_disbursed_on.length),
      description: `${LABEL[l.line_type] ?? l.line_type}, prior year`,
    });
  }
  // Each month's escrow deposit through the run date.
  for (let due = addMonths(opened, 1); due <= t.as_of; due = addMonths(due, 1)) {
    postings.push({
      on: due,
      type: "deposit",
      line_type: null,
      amount_cents: t.current_escrow_payment_cents,
      description: "payment received, escrow share",
    });
  }
  // The account's own scheduled postings, and its one-offs, tagged with no line.
  for (const d of t.ledger.deposits) {
    if (d.on > t.as_of)
      postings.push({
        on: d.on,
        type: "deposit",
        line_type: null,
        amount_cents: d.amount_cents,
        description: d.description,
      });
  }
  for (const d of t.ledger.disbursements) {
    if (d.on > t.as_of)
      postings.push({
        on: d.on,
        type: "disbursement",
        line_type: null,
        amount_cents: d.amount_cents,
        description:
          d.on < t.year_start ? "supplemental tax bill (one-off)" : `${d.description}, new year`,
      });
  }
  if (r.chance(0.3)) {
    postings.push({
      on: addDays(t.as_of, -r.int(20, 200)),
      type: "disbursement",
      line_type: null,
      amount_cents: BigInt(r.int(40, 400)) * 100n,
      description: "supplemental tax bill (one-off)",
    });
  }

  const posted = postings.filter((p) => p.on <= t.as_of && p.on > opened).sort(byDate);
  const scheduled = postings.filter((p) => p.on > t.as_of).sort(byDate);

  // The opening balance, set last so the projected starting balance is the original's.
  const inWindow = (p: Posting) => p.on > t.as_of && p.on < t.year_start;
  const net = (xs: readonly Posting[]) =>
    xs.reduce((s, p) => s + (p.type === "deposit" ? p.amount_cents : -p.amount_cents), 0n);
  const balanceOnRunDate = projectedActual(t) - net(scheduled.filter(inWindow));
  const openingBalance = balanceOnRunDate - net(posted);

  const lines: HistoryLine[] = t.lines.map((l) => {
    const { prior_year_annual_cents: _a, prior_disbursed_on: _d, ...rest } = l;
    void _a;
    void _d;
    return rest;
  });
  return {
    id: t.id,
    split: t.split,
    suite_seed: t.suite_seed,
    index: t.index,
    as_of: t.as_of,
    year_start: t.year_start,
    statement_sent_on: t.statement_sent_on,
    lines,
    cpi_change_pct: t.cpi_change_pct,
    cushion: t.cushion,
    ledger: { opened: { on: opened, balance_cents: openingBalance }, posted, scheduled },
    regx_days_delinquent: t.regx_days_delinquent,
    workout: t.workout,
    borrower_election_months: t.borrower_election_months,
    instrument_shortage_max_months: t.instrument_shortage_max_months,
    current_escrow_payment_cents: t.current_escrow_payment_cents,
  };
}

/** One task, rebuilt from its coordinates alone, with the account it was written from. */
export function drawHistoryTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: EscrowHistoryTask; account: EscrowTask } {
  const id = historyTaskId(split, suiteSeed, index);
  const account = drawEscrowTask(rngFor(id), id, split, suiteSeed, index);
  return { task: historyOf(account, rngFor(`${id}/ledger`)), account };
}

export const generateHistoryTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
) => drawHistoryTask(split, suiteSeed, index).task;

export function generateHistorySuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): EscrowHistoryTask[] {
  return Array.from({ length: n }, (_, i) => generateHistoryTask(split, suiteSeed, i));
}

export const HISTORY_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };
