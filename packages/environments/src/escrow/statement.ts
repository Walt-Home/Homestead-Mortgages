/**
 * Why the escrow payment changed, in the annual escrow statement's own words.
 *
 * Reg X §1024.17(i)(1)(viii) has the annual statement give the reasons the
 * account's low balance was not the one last year's projection set, "as
 * indicated by noting differences between the most recent account history
 * and last year's projection" (the servicing app's spec §3.3, rule 3). The
 * servicing app's statement engine writes those lines
 * (`lowPointExplanation`, ported byte for byte in ./ported/statement.ts):
 * a bill paid at another amount than projected, a bill nobody projected, and
 * the low balance against the projected one. They are what the statement
 * tells a borrower about the bills that moved and the cushion, beside the
 * shortage the analysis found.
 *
 * The engine takes its history lines already paired. The servicing app pairs
 * them in its escrow agent, not in code (spec §3.3, "AI agent design"), so
 * the pairing here is ours, and it is the whole of what this module adds:
 *
 * - the computation year is the twelve months from the analysis's year start,
 *   the first of a month, and every posting given must fall inside it;
 * - a projected bill and a paid one are one line when they share a line type
 *   and a calendar month, summed when the month holds more than one;
 * - a bill paid in a month its projection did not name is "not projected",
 *   and a projected bill nothing was paid against in its month was paid
 *   $0.00. The engine has two templates, and that is how a bill that moved
 *   reads in them: once where it left, once where it arrived;
 * - the lines run month by month; within a month the paid ones in the order
 *   they posted, then the projected ones nothing was paid against;
 * - the actual low is the lowest month-end balance, from the opening balance
 *   and each month's deposits and disbursements, as the servicing app's
 *   statement assembly computes it (`buildHistory` and
 *   `assembleAnnualStatement`, apps/servicing/src/domain/escrow/ops.ts); the
 *   projected low is the projection's lowest target, as §3.3's worked
 *   example reads it. That is the cushion, unless the trial balance never
 *   falls to zero in the year; then it is the cushion plus the trial
 *   balance's lowest point. The projection must be monthly, twelve targets,
 *   as the history is.
 *
 * The engine prints a negative amount wrongly (escrow-4 in
 * docs/servicing-engine-defects.md), and an account overdrawn during the year
 * has a negative low, so `statementScopeIssues` names that and
 * `statementExplanation` refuses it rather than return a garbled line.
 */

import type { Cents } from "@hm/kernel/money";
import { addDays, addMonths, startOfMonth, type PlainDate } from "@hm/kernel/calendar";
import type { Projection } from "./ported/analysis.js";
import { lowPointExplanation, type HistoryLine } from "./ported/statement.js";

/** The analysis that set the year's payment, as the escrow port computed it. */
export interface StatementAnalysis {
  /** The computation year's first day: the first of a month, the analysis's `year_start`. */
  readonly year_start: PlainDate;
  /** `project()`'s result for that year: the bills it put in the year and its targets. */
  readonly projection: Pick<Projection, "items" | "targets">;
}

/** A posting to the escrow account. */
export interface StatementPosting {
  readonly on: PlainDate;
  readonly amount_cents: Cents;
}

/** A disbursement, named by the escrow line it paid. */
export interface StatementDisbursement extends StatementPosting {
  readonly line_type: string;
}

/** The computation year as the escrow ledger has it. */
export interface StatementLedger {
  /** The balance on the year's first day, before anything in the year posts. */
  readonly opening_balance_cents: Cents;
  readonly deposits: readonly StatementPosting[];
  readonly disbursements: readonly StatementDisbursement[];
}

/** One month of the account history: what went in, what went out, and the balance at its end. */
export interface StatementMonth {
  readonly month: PlainDate;
  readonly deposits_cents: Cents;
  readonly disbursements_cents: Cents;
  readonly balance_cents: Cents;
}

/** The history the explanation is drawn from, and the engine's inputs. */
export interface StatementHistory {
  /** The twelve months of the computation year. */
  readonly months: readonly StatementMonth[];
  /** The engine's history lines: every line type in every month that paid or projected a bill. */
  readonly lines: readonly HistoryLine[];
  readonly actual_low_cents: Cents;
  readonly projected_low_cents: Cents;
  readonly ending_balance_cents: Cents;
}

/**
 * The statement's history for one computation year: last year's projection
 * beside what the ledger paid. `labels` names a line type the way the
 * statement prints it ("County tax" for `tax_county`); a line type with no
 * label is printed as it is.
 */
export function statementHistory(
  analysis: StatementAnalysis,
  ledger: StatementLedger,
  labels: Readonly<Record<string, string>> = {},
): StatementHistory {
  const start = analysis.year_start;
  if (startOfMonth(start) !== start)
    throw new RangeError(`a computation year starts on the first of a month, not ${start}`);
  const end = addMonths(start, 12);
  const inYear = (what: string, p: { on: PlainDate; amount_cents: Cents }) => {
    if (p.on < start || p.on >= end)
      throw new RangeError(
        `${what} on ${p.on} is outside the computation year ${start} to ${addDays(end, -1)}`,
      );
    if (p.amount_cents < 0n) throw new RangeError(`${what} on ${p.on} is negative`);
  };
  for (const d of ledger.deposits) inYear("a deposit", d);
  for (const d of ledger.disbursements) inYear(`a ${d.line_type} disbursement`, d);
  for (const i of analysis.projection.items)
    inYear(`a projected ${i.line_type} bill`, { on: i.disburse_on, amount_cents: i.amount_cents });
  // The history is twelve month-ends, so the low it is held to must be a monthly projection's.
  if (analysis.projection.targets.length !== 12)
    throw new RangeError(
      `a monthly projection has twelve targets, not ${analysis.projection.targets.length}`,
    );

  // Paid and projected, each summed by month and line type, each in the order it first appears.
  const byDate = <T>(xs: readonly T[], on: (x: T) => PlainDate) =>
    [...xs].sort((a, b) => (on(a) < on(b) ? -1 : on(a) > on(b) ? 1 : 0));
  const sum = (
    rows: readonly { month: PlainDate; line_type: string; amount_cents: Cents }[],
  ): Map<string, { month: PlainDate; line_type: string; cents: Cents }> => {
    const out = new Map<string, { month: PlainDate; line_type: string; cents: Cents }>();
    for (const r of rows) {
      const key = `${r.month} ${r.line_type}`;
      const had = out.get(key);
      out.set(key, {
        month: r.month,
        line_type: r.line_type,
        cents: (had?.cents ?? 0n) + r.amount_cents,
      });
    }
    return out;
  };
  const paid = sum(
    byDate(ledger.disbursements, (d) => d.on).map((d) => ({
      month: startOfMonth(d.on),
      line_type: d.line_type,
      amount_cents: d.amount_cents,
    })),
  );
  const projected = sum(
    byDate(analysis.projection.items, (i) => i.disburse_on).map((i) => ({
      month: startOfMonth(i.disburse_on),
      line_type: i.line_type,
      amount_cents: i.amount_cents,
    })),
  );

  const months: StatementMonth[] = [];
  const lines: HistoryLine[] = [];
  let balance = ledger.opening_balance_cents;
  for (let k = 0; k < 12; k++) {
    const month = addMonths(start, k);
    const next = addMonths(start, k + 1);
    const within = (p: StatementPosting) => p.on >= month && p.on < next;
    const deposits = ledger.deposits.filter(within).reduce((s, d) => s + d.amount_cents, 0n);
    const out = ledger.disbursements.filter(within).reduce((s, d) => s + d.amount_cents, 0n);
    balance += deposits - out;
    months.push({
      month,
      deposits_cents: deposits,
      disbursements_cents: out,
      balance_cents: balance,
    });
    const keys = [
      ...[...paid.values()].filter((p) => p.month === month),
      ...[...projected.values()].filter(
        (p) => p.month === month && !paid.has(`${month} ${p.line_type}`),
      ),
    ];
    for (const { line_type } of keys) {
      const key = `${month} ${line_type}`;
      lines.push({
        month,
        line_type: labels[line_type] ?? line_type,
        projected_cents: projected.get(key)?.cents ?? null,
        actual_cents: paid.get(key)?.cents ?? 0n,
      });
    }
  }

  const lowest = (xs: readonly Cents[]) => xs.reduce((m, x) => (x < m ? x : m));
  return {
    months,
    lines,
    actual_low_cents: lowest(months.map((m) => m.balance_cents)),
    projected_low_cents: lowest(analysis.projection.targets),
    ending_balance_cents: balance,
  };
}

/**
 * What would make the engine's lines wrong for this history. Today one
 * thing: a negative low, which the engine prints with the sign inside the
 * cents, or not at all under a dollar (escrow-4).
 */
export function statementScopeIssues(history: StatementHistory): string[] {
  const issues: string[] = [];
  if (history.actual_low_cents < 0n)
    issues.push(
      `escrow-4: the low balance is negative (${history.actual_low_cents} cents), which the engine cannot print`,
    );
  return issues;
}

/**
 * The statement's item (viii) for one computation year, as the servicing
 * app's engine writes it: each bill that differed from last year's
 * projection, then the low balance against the projected low when the two
 * differ. Empty when the year went as projected. Throws on a history the
 * engine would print wrongly (`statementScopeIssues`).
 */
export function statementExplanation(
  analysis: StatementAnalysis,
  ledger: StatementLedger,
  labels: Readonly<Record<string, string>> = {},
): string[] {
  const h = statementHistory(analysis, ledger, labels);
  const issues = statementScopeIssues(h);
  if (issues.length > 0) throw new RangeError(issues.join("; "));
  return lowPointExplanation(h.lines, h.actual_low_cents, h.projected_low_cents);
}

/** One of item (viii)'s bill lines, read back out of the engine's text. */
export interface StatementBillLine {
  /** `not_projected`: "a … bill of $X was paid MM/YYYY (not projected)"; `differs`: "… paid MM/YYYY was $X vs $Y projected". */
  readonly kind: "not_projected" | "differs";
  /** The first of the month the engine names. */
  readonly month: PlainDate;
  /** The line as the statement prints it: its label, or its line type when it has none. */
  readonly label: string;
  readonly actual_cents: Cents;
  /** Null on a bill nobody projected. */
  readonly projected_cents: Cents | null;
  /** The engine's own sentence. */
  readonly text: string;
}

/** Item (viii) for one computation year, as a reader of the statement needs it. */
export interface StatementReading {
  readonly history: StatementHistory;
  /** What the engine writes, in its order: the bill lines, then the low line unless it is left out. */
  readonly engine: readonly string[];
  readonly bills: readonly StatementBillLine[];
  /** The low-point line, or null when the low was the projected low or the engine cannot print it. */
  readonly low: {
    readonly actual_cents: Cents;
    readonly projected_cents: Cents;
    readonly text: string;
  } | null;
  /** Why the low-point line is left out (escrow-4); [] when it is not. */
  readonly refused: readonly string[];
}

const DOLLARS = String.raw`\$(\d+)\.(\d{2})`;
const NOT_PROJECTED = new RegExp(
  String.raw`^a (.+) bill of ${DOLLARS} was paid (\d{2})\/(\d{4}) \(not projected\)$`,
);
const DIFFERS = new RegExp(
  String.raw`^(.+) paid (\d{2})\/(\d{4}) was ${DOLLARS} vs ${DOLLARS} projected$`,
);
const LOW = new RegExp(String.raw`^low balance ${DOLLARS} vs ${DOLLARS} projected$`);
const centsOf = (dollars: string, cents: string): Cents => BigInt(dollars) * 100n + BigInt(cents);

/**
 * Item (viii) for one computation year, read off the engine's own lines: the
 * engine writes them, and every figure here is parsed back out of its text, so
 * a reader that says these figures says the engine's.
 *
 * A year the engine cannot print whole (`statementScopeIssues`: an account
 * overdrawn during the year, escrow-4) keeps its bill lines and loses the low
 * line alone. The engine writes no low line when the two lows it is handed are
 * equal, so it is handed the same low twice for the bills, and `refused` says
 * why the low is missing. A line in a shape none of the engine's three
 * templates writes throws.
 */
export function statementReading(
  analysis: StatementAnalysis,
  ledger: StatementLedger,
  labels: Readonly<Record<string, string>> = {},
): StatementReading {
  const h = statementHistory(analysis, ledger, labels);
  const refused = statementScopeIssues(h);
  const engine =
    refused.length > 0
      ? lowPointExplanation(h.lines, 0n, 0n)
      : lowPointExplanation(h.lines, h.actual_low_cents, h.projected_low_cents);
  const bills: StatementBillLine[] = [];
  let low: StatementReading["low"] = null;
  for (const text of engine) {
    const np = NOT_PROJECTED.exec(text);
    const df = DIFFERS.exec(text);
    const lo = LOW.exec(text);
    if (np)
      bills.push({
        kind: "not_projected",
        month: `${np[5]}-${np[4]}-01` as PlainDate,
        label: np[1]!,
        actual_cents: centsOf(np[2]!, np[3]!),
        projected_cents: null,
        text,
      });
    else if (df)
      bills.push({
        kind: "differs",
        month: `${df[3]}-${df[2]}-01` as PlainDate,
        label: df[1]!,
        actual_cents: centsOf(df[4]!, df[5]!),
        projected_cents: centsOf(df[6]!, df[7]!),
        text,
      });
    else if (lo && low === null && bills.length + 1 === engine.length)
      low = {
        actual_cents: centsOf(lo[1]!, lo[2]!),
        projected_cents: centsOf(lo[3]!, lo[4]!),
        text,
      };
    else throw new RangeError(`the engine wrote a line in no shape of its own: ${text}`);
  }
  // The figures read back are the history's: a parse that drifted from the engine is a bug, not a reading.
  if (
    low &&
    (low.actual_cents !== h.actual_low_cents || low.projected_cents !== h.projected_low_cents)
  )
    throw new RangeError(`the low line reads ${low.text}, not the history's lows`);
  return { history: h, engine, bills, low, refused };
}
