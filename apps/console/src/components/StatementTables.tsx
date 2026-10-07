/**
 * A month's statement, drawn: the lines the price sheet charges with their
 * total, and the loans under them. One drawing, used in two places — the
 * console's billing page for a servicer, and the servicer's own billing
 * page in the portal — so an invoice reads the same on both sides of it.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Button } from "./ui.js";
import { Table, type Column } from "./Table.js";
import { fmtDate, money, plural } from "../lib/format.js";
import { tokensWord, type LoanCharge, type Statement, type StatementLine } from "../lib/billing.js";

const rateWord = (l: StatementLine): string =>
  l.basis === "per_100k"
    ? `${l.tokensEach.toLocaleString("en-US")} tokens per $100,000 per ${
        l.cadence === "loan_year" ? "loan-year, a twelfth each month" : "loan-month"
      }`
    : `${l.tokensEach.toLocaleString("en-US")} tokens ${l.fires}`;

function quantityWord(l: StatementLine): string {
  const q = l.quantity;
  if (q.kind === "events") return plural(q.count, "touch", "touches");
  return `${q.loanMonths} loan-months on ${money(q.balanceCents)} across ${plural(q.loans, "loan")}`;
}

/** The lines the sheet prices, and the month's total under them. */
export function StatementLines({ statement: s }: { statement: Statement }) {
  const columns = useMemo<Column<StatementLine>[]>(
    () => [
      {
        key: "action",
        header: "Action",
        primary: true,
        render: (l) => (
          <span className="flex flex-col gap-0.5">
            <span className="text-fg">{l.action}</span>
            <span className="text-xs text-fg-3">{rateWord(l)}</span>
          </span>
        ),
      },
      { key: "quantity", header: "This month", render: (l) => quantityWord(l) },
      {
        key: "tokens",
        header: "Tokens",
        align: "right",
        render: (l) => (
          <span className="tabular-nums">{Number(l.tokens).toLocaleString("en-US")}</span>
        ),
      },
      {
        key: "cents",
        header: "Charge",
        align: "right",
        render: (l) => <span className="tabular-nums font-medium text-fg">{money(l.cents)}</span>,
      },
    ],
    [],
  );
  return (
    <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
      <Table columns={columns} rows={s.lines} rowKey={(l) => l.code} dense />
      <div className="flex items-center justify-between border-t border-line-2 px-4 py-3 text-base">
        <span className="font-medium text-fg">Total</span>
        <span className="flex items-baseline gap-4">
          <span className="text-sm text-fg-3">{tokensWord(s.tokens)}</span>
          <span className="tabular-nums font-semibold text-fg">{money(s.cents)}</span>
        </span>
      </div>
    </div>
  );
}

/** Every loan that consumed something in the month, and what it consumed. */
export function StatementLoans({
  statement: s,
  loanNumber,
  pageSize = 10,
}: {
  statement: Statement;
  /** How a loan's number is drawn: a link to its page, where there is one. */
  loanNumber?: (charge: LoanCharge) => ReactNode;
  /** A book is thousands of loans; a page is ten of them. */
  pageSize?: number;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(s.loans.length / pageSize));
  const at = Math.min(page, pages - 1);
  const rows = useMemo(
    () => s.loans.slice(at * pageSize, (at + 1) * pageSize),
    [s.loans, at, pageSize],
  );
  const columns = useMemo<Column<LoanCharge>[]>(
    () => [
      {
        key: "number",
        header: "Loan",
        primary: true,
        mono: true,
        render: (c) => (loanNumber ? loanNumber(c) : c.number),
      },
      { key: "from", header: "Watched from", render: (c) => fmtDate(c.watchedFrom) },
      {
        key: "days",
        header: "Days",
        align: "right",
        render: (c) => (
          <span className="tabular-nums">
            {c.days}
            {c.endedOn ? (
              <span className="ml-1 text-xs text-fg-3">ended {fmtDate(c.endedOn)}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: "balance",
        header: "Balance",
        align: "right",
        render: (c) =>
          c.basis ? (
            <span className="flex flex-col items-end">
              <span className="tabular-nums">{money(c.basis.principalBalanceCents)}</span>
              <span className="text-xs text-fg-3">as of {fmtDate(c.basis.asOf)}</span>
            </span>
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
      {
        key: "tokens",
        header: "Tokens",
        align: "right",
        render: (c) => (
          <span className="tabular-nums">
            {(Number(c.tokens) + Number(c.touchTokens)).toLocaleString("en-US")}
          </span>
        ),
      },
      {
        key: "cents",
        header: "Charge",
        align: "right",
        render: (c) => (
          <span className="tabular-nums font-medium text-fg">
            {money(String(Number(c.tokens) + Number(c.touchTokens)))}
          </span>
        ),
      },
    ],
    [loanNumber],
  );
  return (
    <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
      <Table
        columns={columns}
        rows={rows}
        rowKey={(c) => c.loanId}
        dense
        empty={{
          icon: "receipt",
          title: "Nothing consumed this month",
          body: "No loan on the book was watched during it.",
        }}
      />
      {s.loans.length > pageSize ? (
        <div className="flex items-center justify-between border-t border-line-2 px-4 py-2 text-sm text-fg-2">
          <span>
            Loans {(at * pageSize + 1).toLocaleString()}–
            {Math.min((at + 1) * pageSize, s.loans.length).toLocaleString()} of{" "}
            {s.loans.length.toLocaleString()}
          </span>
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={at === 0}
              onClick={() => setPage(at - 1)}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={at >= pages - 1}
              onClick={() => setPage(at + 1)}
            >
              Next
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
