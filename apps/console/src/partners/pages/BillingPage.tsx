/**
 * What the servicer's book is billed, as their own team reads it: this
 * month so far, and an invoice for every month already closed. An invoice
 * is the month's statement — the lines the price sheet charges and the
 * loans under them — kept once the month has ended and never recomputed.
 * Read-only: the pool and the close are Supermortgage's to set.
 */

import { useCallback, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Page, Section } from "../../components/Page.js";
import { Table, type Column } from "../../components/Table.js";
import { StatementLines, StatementLoans } from "../../components/StatementTables.js";
import { Button, Notice, Pill, Rows, Stat, type Tone } from "../../components/ui.js";
import { Loading } from "../../components/Loading.js";
import { useToast } from "../../components/Toast.js";
import { fmtDate, money, plural } from "../../lib/format.js";
import {
  monthLabel,
  openInvoicePage,
  tokensWord,
  type InvoiceLink,
  type StatementStanding,
} from "../../lib/billing.js";
import {
  portal,
  PortalError,
  type PortalBilling,
  type PortalInvoice,
  type PortalStatement,
} from "../api.js";

const STANDING_WORDS: Record<StatementStanding, { word: string; tone: Tone }> = {
  closed: { word: "Invoiced", tone: "ok" },
  open: { word: "Being finalized", tone: "warn" },
  running: { word: "Running", tone: "info" },
};

/** Where an issued invoice stands, in the servicer's words. */
const ISSUED_WORDS: Record<
  NonNullable<PortalInvoice["issued"]>["standing"],
  { word: string; tone: Tone }
> = {
  open: { word: "Issued", tone: "info" },
  sent: { word: "Awaiting payment", tone: "info" },
  past_due: { word: "Past due", tone: "danger" },
  paid: { word: "Paid", tone: "ok" },
  uncollectible: { word: "Overdue", tone: "danger" },
};

/** How a loan on the book is charged, in the servicer's terms. */
const BASIS =
  "A loan is billed from the day its tape is loaded, on the interest-bearing unpaid principal the newest tape on or before the month's end reported. A loan-month is pro-rated by calendar day and stops the day a tape reports the loan paid off, transferred, charged off or matured. A token is a cent.";

function StatementStats({ answer }: { answer: PortalStatement }) {
  const s = answer.statement;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label={answer.standing === "running" ? "Charge so far" : "Charge"}
        value={money(s.cents)}
        hint={tokensWord(s.tokens)}
      />
      <Stat
        label="Loans billed"
        value={s.loansBilled.toLocaleString()}
        hint={`of ${plural(s.loansOnBook, "loan")} on the book`}
      />
      <Stat
        label="Loan-months"
        value={s.loanMonths}
        hint={`${s.loanDays.toLocaleString()} loan-days of ${s.daysInMonth}`}
      />
      <Stat
        label="UPB billed on"
        value={money(s.balanceCents, { compact: true })}
        hint="interest-bearing UPB, summed"
      />
    </div>
  );
}

export function PortalBillingPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const page = useQuery({
    queryKey: ["portal-billing"],
    queryFn: () => portal<PortalBilling>("/billing"),
  });
  // The page is opened fresh each time: the link expires, so none is kept.
  const pay = useCallback(
    (id: string) =>
      openInvoicePage(() => portal<InvoiceLink>(`/billing/invoices/${id}/link`)).catch(
        (err: Error) =>
          toast({ tone: "danger", title: "The invoice could not be opened", body: err.message }),
      ),
    [toast],
  );

  const columns = useMemo<Column<PortalInvoice>[]>(
    () => [
      {
        key: "month",
        header: "Invoice",
        primary: true,
        render: (i) => (
          <span className="flex flex-col">
            <span className="font-medium text-fg">{monthLabel(i.month)}</span>
            {i.issued?.number ? (
              <span className="font-mono text-xs text-fg-3">{i.issued.number}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (i) =>
          i.issued ? (
            <span className="flex flex-col gap-0.5">
              <Pill tone={ISSUED_WORDS[i.issued.standing].tone}>
                {ISSUED_WORDS[i.issued.standing].word}
              </Pill>
              <span className="text-xs text-fg-3">
                {i.issued.standing === "paid" && i.issued.paidAt
                  ? `paid ${fmtDate(i.issued.paidAt)}`
                  : i.issued.dueAt
                    ? `due ${fmtDate(i.issued.dueAt)}`
                    : ""}
              </span>
            </span>
          ) : (
            <span className="text-fg-3">Being prepared</span>
          ),
      },
      {
        key: "loans",
        header: "Loans billed",
        align: "right",
        render: (i) => <span className="tabular-nums">{i.loansBilled.toLocaleString()}</span>,
      },
      {
        key: "lm",
        header: "Loan-months",
        align: "right",
        render: (i) => <span className="tabular-nums">{i.loanMonths}</span>,
      },
      {
        key: "upb",
        header: "UPB billed on",
        align: "right",
        render: (i) => (
          <span className="tabular-nums">{money(i.balanceCents, { compact: true })}</span>
        ),
      },
      {
        key: "tokens",
        header: "Tokens",
        align: "right",
        render: (i) => (
          <span className="tabular-nums">{Number(i.tokens).toLocaleString("en-US")}</span>
        ),
      },
      {
        key: "cents",
        header: "Amount",
        align: "right",
        render: (i) => <span className="tabular-nums font-medium text-fg">{money(i.cents)}</span>,
      },
      { key: "closed", header: "Closed", render: (i) => fmtDate(i.closedAt) },
      {
        key: "pay",
        header: "",
        align: "right",
        hideOnCard: false,
        render: (i) =>
          i.issued ? (
            <Button
              size="sm"
              variant={i.issued.standing === "paid" ? "secondary" : "primary"}
              onClick={(e) => {
                e.stopPropagation();
                void pay(i.issued!.id);
              }}
            >
              {i.issued.standing === "paid" ? "View invoice" : "Pay"}
            </Button>
          ) : null,
      },
    ],
    [pay],
  );

  if (page.isPending) return <Loading what="Opening billing" />;
  if (page.isError || !page.data) {
    return (
      <Page title="Billing">
        <Notice tone="danger" title="Billing could not be read">
          Try again in a moment.
        </Notice>
      </Page>
    );
  }
  const { servicer, sheet, today, current, invoices } = page.data;
  const s = current.statement;
  const year = today.slice(0, 4);
  const invoicedThisYear = invoices
    .filter((i) => i.month.startsWith(year))
    .reduce((n, i) => n + Number(i.tokens), 0);

  return (
    <Page
      title="Billing"
      description={`What ${servicer.displayName}'s book is charged, by the price sheet.`}
      meta={`Price sheet ${sheet.version} of ${fmtDate(sheet.date)}${
        servicer.since ? ` · on the book since ${fmtDate(servicer.since)}` : ""
      }`}
    >
      <Section
        title={`${monthLabel(s.month)} so far`}
        aside={
          <Link to={`/portal/billing/${s.month}`} className="text-fg-2 underline hover:text-fg">
            See the month by loan
          </Link>
        }
      >
        <StatementStats answer={current} />
        <p className="mt-3 text-sm text-fg-3">
          {fmtDate(s.from)} through {fmtDate(s.through)}. The month is invoiced on the first of the
          next.
        </p>
      </Section>

      <Section
        title="Invoices"
        aside={invoices.length ? plural(invoices.length, "invoice") : undefined}
      >
        {invoices.length ? (
          <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
            <Table
              columns={columns}
              rows={invoices}
              rowKey={(i) => i.id}
              onRowClick={(i) => navigate(`/portal/billing/${i.month}`)}
            />
          </div>
        ) : (
          <Notice tone="neutral" title="No invoice yet">
            The first one is issued when {monthLabel(s.month)} ends.
          </Notice>
        )}
      </Section>

      {servicer.annualTokenPool ? (
        <Section title="Annual token pool">
          <div className="rounded-lg border border-line-2 bg-surface px-4">
            <Rows
              rows={[
                {
                  label: "Committed",
                  value: `${tokensWord(servicer.annualTokenPool)} · ${money(servicer.annualTokenPool)}`,
                },
                {
                  label: `Invoiced in ${year}`,
                  value: `${tokensWord(invoicedThisYear)} · ${money(String(invoicedThisYear))}`,
                },
                {
                  label: "Remaining",
                  value: tokensWord(
                    Math.max(0, Number(servicer.annualTokenPool) - invoicedThisYear),
                  ),
                },
              ]}
            />
          </div>
        </Section>
      ) : null}

      <Notice tone="neutral" className="mt-8">
        {BASIS}
      </Notice>
    </Page>
  );
}

/** One month: the invoice once it is closed, the meter so far before that. */
export function PortalInvoicePage() {
  const { month = "" } = useParams();
  const answer = useQuery({
    queryKey: ["portal-statement", month],
    queryFn: () => portal<PortalStatement>(`/billing/statements/${month}`),
    enabled: month !== "",
    retry: (count, err) => !(err instanceof PortalError && err.status === 400) && count < 2,
  });

  if (answer.isPending) return <Loading what="Reading the month" />;
  if (answer.isError || !answer.data) {
    const refused = answer.error instanceof PortalError && answer.error.status === 400;
    return (
      <Page title="Billing" back={{ to: "/portal/billing", label: "Billing" }}>
        <Notice
          tone={refused ? "neutral" : "danger"}
          title={refused ? "No statement for that month" : "The month could not be read"}
        >
          {refused ? "It has not started, or it is not a month." : "Try again in a moment."}
        </Notice>
      </Page>
    );
  }
  const s = answer.data.statement;
  const standing = STANDING_WORDS[answer.data.standing];
  const closed = answer.data.standing === "closed";

  return (
    <Page
      title={closed ? `Invoice for ${monthLabel(s.month)}` : monthLabel(s.month)}
      back={{ to: "/portal/billing", label: "Billing" }}
      meta={`Price sheet ${s.sheet.version} of ${fmtDate(s.sheet.date)}`}
    >
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-2">
        <Pill tone={standing.tone}>{standing.word}</Pill>
        {closed ? (
          <span>
            {fmtDate(s.from)} through {fmtDate(s.to)}
            {answer.data.closedAt ? `, issued ${fmtDate(answer.data.closedAt)}` : ""}.
          </span>
        ) : answer.data.standing === "running" ? (
          <span>
            {fmtDate(s.from)} through {fmtDate(s.through)}; the month is invoiced on the first of
            the next.
          </span>
        ) : (
          <span>
            {fmtDate(s.from)} through {fmtDate(s.to)}; the month has ended and its invoice is on its
            way.
          </span>
        )}
      </div>

      <StatementStats answer={answer.data} />

      <Section title="Charges" className="mt-8">
        <StatementLines statement={s} />
      </Section>

      <Section title="By loan" aside={`${plural(s.loans.length, "loan")} billed`} className="mt-8">
        <StatementLoans
          statement={s}
          loanNumber={(c) => (
            <Link to={`/portal/loans/${c.loanId}`} className="text-fg underline hover:no-underline">
              {c.number}
            </Link>
          )}
        />
      </Section>

      <Notice tone="neutral" className="mt-8">
        {BASIS}
      </Notice>
    </Page>
  );
}
