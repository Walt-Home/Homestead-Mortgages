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
 */

import { addMonths, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import type {
  StatementAnalysis,
  StatementDisbursement,
  StatementLedger,
  StatementPosting,
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
