/**
 * A generated loan's escrow computation years, as the annual escrow
 * statement's explanation takes them (escrow/statement.ts,
 * `statementExplanation`): the analysis that set the year's payment, with its
 * projection's bills and targets, and the year's ledger.
 *
 * A year is the twelve months from an analysis's `year_start`, and it is
 * read only when the history holds it whole on one servicer's books: every
 * month-end in it, the month-end before it (the opening balance), no
 * transfer in or out and no payoff inside it, and the escrow account open
 * throughout. The ledger is the generator's own flows into and out of the
 * account, so its month-end balances are the history's:
 *
 * - deposits: the escrow share of every receipt posted in the year, on the
 *   day it posted, and money a payee returned (a V-01 county's excess);
 * - disbursements: every bill by its line, and a surplus refund to the
 *   borrower as a line of its own, `refund`, which the engine prints as a
 *   bill nobody projected.
 *
 * A year the account is overdrawn in has a negative low, which the engine
 * prints wrongly (escrow-4); `statementScopeIssues` names it.
 *
 * `statementYearOf` reads the year as the statement mailed with an analysis
 * has it instead: the history through the analysis's run date and what the
 * analysis counted on after it (below, "the statement an analysis goes out
 * with"). That is the year a call about the statement is answered from.
 */

import { addDays, addMonths, startOfMonth, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import { decide, newPayment, type Decision, type Projection } from "../escrow/ported/analysis.js";
import { exemption } from "../escrow/ported/statement.js";
import {
  statementReading,
  type StatementAnalysis,
  type StatementDisbursement,
  type StatementLedger,
  type StatementPosting,
  type StatementReading,
} from "../escrow/statement.js";
import type { AnalysisRow, LoanLife } from "./simulate.js";

export interface EscrowYear {
  /** The analysis that set the year's payment. */
  readonly row: AnalysisRow;
  readonly analysis: StatementAnalysis;
  readonly ledger: StatementLedger;
  /** The history's own month-end escrow balances over the year, which the ledger's month-ends equal. */
  readonly month_end_balances: readonly Cents[];
}

/** Every computation year the history holds whole, oldest first. */
export function escrowYears(loan: LoanLife): EscrowYear[] {
  const byMonth = new Map(loan.months.map((m) => [m.month, m]));
  const out: EscrowYear[] = [];
  for (const row of loan.analyses) {
    const start = row.year_start;
    const end = addMonths(start, 12);
    const before = byMonth.get(addMonths(start, -1).slice(0, 7));
    const months = Array.from({ length: 12 }, (_, k) =>
      byMonth.get(addMonths(start, k).slice(0, 7)),
    );
    if (!before || months.some((m) => !m)) continue;
    const ours = months.map((m) => m!.servicer);
    if (ours.some((x) => x !== before.servicer)) continue;
    if (months.some((m) => m!.status === "paid_off" || m!.status === "transferred")) continue;
    if (loan.transfer_in_on !== null && loan.transfer_in_on > start && loan.transfer_in_on < end)
      continue;
    // The escrow account runs through the year: a boarding that drops it (D-31) runs no analysis after it.
    if (!loan.boarded.terms.escrowed && loan.boarded.on < end) continue;
    const within = (on: PlainDate) => on >= start && on < end;
    const deposits: StatementPosting[] = [];
    for (const r of loan.receipts) {
      if (!within(r.on)) continue;
      const escrow = r.installments.reduce((s, x) => s + x.escrow, 0n);
      if (escrow > 0n) deposits.push({ on: r.on, amount_cents: escrow });
    }
    const disbursements: StatementDisbursement[] = [];
    for (const d of loan.disbursements) {
      if (!within(d.on)) continue;
      if (d.kind === "returned") deposits.push({ on: d.on, amount_cents: -d.amount });
      else
        disbursements.push({
          on: d.on,
          line_type: d.kind === "bill" ? d.line : d.kind,
          amount_cents: d.amount,
        });
    }
    out.push({
      row,
      analysis: { year_start: start, projection: row.projection },
      ledger: {
        opening_balance_cents: before.escrow_balance,
        deposits: deposits.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0)),
        disbursements,
      },
      month_end_balances: months.map((m) => m!.escrow_balance),
    });
  }
  return out;
}

/* ── the statement an analysis goes out with ─────────────────────────────── */

/**
 * The computation year the annual statement mailed with an analysis explains,
 * as that statement has it.
 *
 * The analysis runs 45 to 75 days before the year it sets, so the year it
 * closes, the one the previous analysis set, is not over when it runs. The
 * servicing app's statement assembly marks the months after the approval as
 * assumed (`assembleAnnualStatement`, apps/servicing/src/domain/escrow/ops.ts:
 * `assumed: late ? false : r.month > f.approved_on`), so the statement reads
 * the history through the run date and, after it, what the analysis itself
 * counted on: the escrow share of each installment still due before the year
 * at its due date, and each bill still to be paid at its amount. The ledger
 * then ends at the analysis's projected actual balance, which a test holds on
 * every year. What the statement says is known the day it is mailed, so a call
 * after it can read it whatever the history did next; `escrowYears` is the
 * year as it turned out.
 */
export interface StatementYear {
  /** The analysis the statement went out with. */
  readonly with: AnalysisRow;
  /** The analysis that set the explained year's payment, whose projection the year is held to. */
  readonly row: AnalysisRow;
  readonly analysis: StatementAnalysis;
  readonly ledger: StatementLedger;
  /** The run date: the ledger is the history's through it, and the analysis's own assumptions after it. */
  readonly through: PlainDate;
  /** The postings after the run date, which the statement shows as assumed. */
  readonly assumed: {
    readonly deposits: readonly StatementPosting[];
    readonly disbursements: readonly StatementDisbursement[];
  };
}

const byOn = <T extends { on: PlainDate }>(a: T, b: T) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0);

function statementYearOrWhy(
  loan: LoanLife,
  analysis: AnalysisRow,
): { year: StatementYear } | { why: string } {
  const through = analysis.as_of;
  // §1024.17(i)(2): no annual statement while the borrower is more than 30 days delinquent at the analysis. A case
  // in bankruptcy is not suppressed, the servicing app's default (its 3.3 open question 1).
  const bankrupt = loan.bankruptcy !== undefined && loan.bankruptcy.filed_on <= through;
  const exempt = exemption({
    regx_days_delinquent: analysis.regx_days_delinquent,
    foreclosure_first_legal_filed: false,
    bankruptcy_open: bankrupt,
    bk_suppress: false,
  });
  if (exempt) return { why: `exempt (${exempt}): no annual statement goes out` };
  const end = analysis.year_start;
  const start = addMonths(end, -12);
  const row = loan.analyses.find((a) => a.year_start === start);
  if (!row)
    return { why: "the year's payment was set by no analysis the history holds: nothing to hold it to" };
  const byMonth = new Map(loan.months.map((m) => [m.month, m]));
  const before = byMonth.get(addMonths(start, -1).slice(0, 7));
  if (!before) return { why: "the history has no month-end before the year" };
  for (let m = start; m < startOfMonth(through); m = addMonths(m, 1)) {
    const me = byMonth.get(m.slice(0, 7));
    if (!me) return { why: `the history has no month-end for ${m.slice(0, 7)}` };
    if (me.servicer !== before.servicer) return { why: "the year is on two servicers' books" };
  }
  if (analysis.servicer !== before.servicer)
    return { why: "the analysis is another servicer's than the year's" };
  if (loan.transfer_in_on !== null && loan.transfer_in_on > start && loan.transfer_in_on <= through)
    return { why: "a transfer inside the year" };
  const sofar = (on: PlainDate) => on >= start && on <= through;
  const deposits: StatementPosting[] = [];
  for (const r of loan.receipts) {
    if (!sofar(r.on)) continue;
    const escrow = r.installments.reduce((s, x) => s + x.escrow, 0n);
    if (escrow > 0n) deposits.push({ on: r.on, amount_cents: escrow });
  }
  const disbursements: StatementDisbursement[] = [];
  for (const d of loan.disbursements) {
    if (!sofar(d.on)) continue;
    if (d.kind === "returned") deposits.push({ on: d.on, amount_cents: -d.amount });
    else
      disbursements.push({
        on: d.on,
        line_type: d.kind === "bill" ? d.line : d.kind,
        amount_cents: d.amount,
      });
  }
  // What the analysis counted on after its run date, as simulate.ts's onAnalysis counts it for the projected actual:
  // the escrow share of each installment due in the three months before the year, after the run date and not yet
  // paid, at its due date; and each bill on a line still to be paid before the year, the mortgage insurance's only
  // while it runs (its sweep runs before an analysis the same day).
  const assumedDeposits: StatementPosting[] = [];
  for (let due = addMonths(end, -3); due < end; due = addMonths(due, 1)) {
    if (due <= through) continue;
    const inst = loan.installments.find((i) => i.due === due);
    if (!inst) return { why: "the history ends before an installment the analysis counted on" };
    if (inst.satisfied_on === null || inst.satisfied_on > through)
      assumedDeposits.push({ on: due, amount_cents: inst.escrow });
  }
  const miOff =
    loan.pmi.find((p) => p.status === "terminated" && p.on <= through)?.effective_on ?? null;
  const assumedBills: StatementDisbursement[] = [];
  for (const l of loan.lines)
    for (const b of l.bills)
      if (b.on > through && b.on < end && !(l.basis === "mi" && miOff && b.on >= miOff))
        assumedBills.push({ on: b.on, line_type: l.line_type, amount_cents: b.amount });
  const ledger: StatementLedger = {
    opening_balance_cents: before.escrow_balance,
    deposits: [...deposits, ...assumedDeposits].sort(byOn),
    disbursements: [...disbursements, ...assumedBills.sort(byOn)],
  };
  // The statement's year ends where the analysis said it would: its projected actual balance. A test holds this on
  // every year of every kind of book; a history it failed on would be explained by a statement nobody mailed.
  const ending =
    ledger.opening_balance_cents +
    ledger.deposits.reduce((s, d) => s + d.amount_cents, 0n) -
    ledger.disbursements.reduce((s, d) => s + d.amount_cents, 0n);
  if (ending !== analysis.projected_actual)
    return {
      why: `the statement's year ends at ${ending}, not the analysis's projected actual ${analysis.projected_actual}`,
    };
  return {
    year: {
      with: analysis,
      row,
      analysis: { year_start: start, projection: row.projection },
      ledger,
      through,
      assumed: { deposits: assumedDeposits, disbursements: assumedBills.sort(byOn) },
    },
  };
}

const years = new WeakMap<AnalysisRow, StatementYear | null>();

/** The year the statement mailed with `analysis` explains, or null when no statement explains one. */
export function statementYearOf(loan: LoanLife, analysis: AnalysisRow): StatementYear | null {
  if (years.has(analysis)) return years.get(analysis)!;
  const got = statementYearOrWhy(loan, analysis);
  const y = "year" in got ? got.year : null;
  years.set(analysis, y);
  return y;
}

/** Why no statement explains a year for `analysis`, or null when one does. */
export function noStatementWhy(loan: LoanLife, analysis: AnalysisRow): string | null {
  const got = statementYearOrWhy(loan, analysis);
  return "why" in got ? got.why : null;
}

/** Every analysis's statement year, oldest first: the analyses with none are left out. */
export const statementYears = (loan: LoanLife): StatementYear[] =>
  loan.analyses.flatMap((a) => statementYearOf(loan, a) ?? []);

/**
 * The analysis's decision, decided again by the escrow port from the row's own figures (`decide`, `newPayment`): the
 * shortage's or deficiency's level installment and months, a refund's date, a credit's monthly amount. The row
 * records the decision's kind and amounts; these are the rest of what the statement's items (vi) and (vii) say. It
 * throws when the port decides otherwise than the row, which would mean the row is not the engine's.
 */
export function analysisDecision(a: AnalysisRow): Decision {
  const projection = {
    target_at_start_cents: a.target_at_start,
    base_payment_cents: a.base_payment,
  } as Projection;
  const d = decide({
    projection,
    projected_actual_cents: a.projected_actual,
    as_of: a.as_of,
    regx_days_delinquent: a.regx_days_delinquent,
    workout: false,
    borrower_election_months: null,
    instrument_shortage_max_months: null,
  });
  const pay = newPayment(projection, d);
  if (d.kind !== a.decision || pay.payment_cents !== a.new_payment)
    throw new RangeError(
      `the escrow port decides ${d.kind} at ${pay.payment_cents} on the analysis of ${a.as_of}, which recorded ${a.decision} at ${a.new_payment}`,
    );
  return d;
}

/** The statement's item (viii) for an analysis's year, labeled, or null when no statement explains one. */
export function statementReadingOf(
  loan: LoanLife,
  analysis: AnalysisRow,
  labels: Readonly<Record<string, string>> = {},
): StatementReading | null {
  const y = statementYearOf(loan, analysis);
  return y ? statementReading(y.analysis, y.ledger, labels) : null;
}

/** The last day of a statement year's computation year. */
export const statementYearEnd = (y: StatementYear): PlainDate => addDays(y.with.year_start, -1);
