/**
 * What the servicer's book is billed, as their own team reads it: this
 * month so far, and an invoice for every month already closed. An invoice
 * is the month's statement — the lines the price sheet charges and the
 * loans under them — kept once the month has ended and never recomputed.
 * Read-only: the pool and the close are Supermortgage's to set.
 */

import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Page, Section } from "../../components/Page.js";
import { Table, type Column } from "../../components/Table.js";
import { StatementLines, StatementLoans } from "../../components/StatementTables.js";
import { ChargeExplainer, tokenPriceWords } from "../../components/ChargeExplainer.js";
import { Button, Notice, Pill, Rows, Stat, type Tone } from "../../components/ui.js";
import { Sheet } from "../../components/Sheet.js";
import { Loading } from "../../components/Loading.js";
import { useToast } from "../../components/Toast.js";
import { fmtDate, money, plural } from "../../lib/format.js";
import {
  daysThrough,
  firstOfNextMonth,
  monthLabel,
  openInvoicePage,
  tokensWord,
  type MeterTerms,
  type InvoiceLink,
  type Statement,
  type StatementStanding,
} from "../../lib/billing.js";
import {
  portal,
  PortalError,
  type PortalBankAccount,
  type PortalBilling,
  type PortalCreditNote,
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

/** The month still running, in a sentence that is true on its first day too. */
function runningWords(s: Statement): string {
  const days = daysThrough(s.from, s.through);
  const span =
    s.from === s.through
      ? `${fmtDate(s.from)} only`
      : `${fmtDate(s.from)} through ${fmtDate(s.through)}`;
  return `${span}, ${plural(days, "day")} of ${s.daysInMonth} so far. The month is invoiced after it closes on ${fmtDate(firstOfNextMonth(s.to))}.`;
}

/**
 * How the servicer pays: ACH debit from a bank account on file with the
 * provider, set up on the provider's own page. Cards are not accepted.
 */
function PortalAch() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const outcome = params.get("ach");
  // Coming back with ?ach=done is a new question to the provider, not a cached answer.
  const accounts = useQuery({
    queryKey: ["portal-ach", outcome ?? ""],
    queryFn: () =>
      portal<{ accounts: PortalBankAccount[] }>("/billing/ach").then((r) => r.accounts),
  });
  const [busy, setBusy] = useState(false);
  const setUp = async () => {
    setBusy(true);
    try {
      const { url } = await portal<{ url: string }>("/billing/ach/setup-link", {
        method: "POST",
        body: {},
      });
      window.location.assign(url);
    } catch (err) {
      setBusy(false);
      toast({
        tone: "danger",
        title: "The setup page could not be opened",
        body: (err as Error).message,
      });
    }
  };
  const dismiss = () => {
    params.delete("ach");
    setParams(params, { replace: true });
  };
  return (
    <div className="space-y-4 rounded-lg border border-line-2 bg-surface p-4">
      {outcome === "done" ? (
        <Notice tone="ok" title="Thank you — the bank account is on file">
          Invoices are paid from it on the invoice page.{" "}
          <button type="button" className="underline" onClick={dismiss}>
            Dismiss
          </button>
        </Notice>
      ) : outcome === "left" ? (
        <Notice tone="neutral" title="Nothing was added">
          Come back to it any time.{" "}
          <button type="button" className="underline" onClick={dismiss}>
            Dismiss
          </button>
        </Notice>
      ) : null}
      <p className="text-sm text-fg-2">
        Invoices are paid by ACH debit from a bank account you put on file. Cards are not accepted.
        The account is entered and verified on our payment provider's page, by signing in to the
        bank or confirming two small deposits; the number never reaches us.
      </p>
      {accounts.isPending ? (
        <Loading what="Reading what is on file" />
      ) : accounts.isError || !accounts.data ? (
        <Notice tone="danger">What is on file could not be read.</Notice>
      ) : accounts.data.length === 0 ? (
        <Notice tone="warn" title="No bank account on file yet">
          Add one now and the first invoice can be paid in a click.
        </Notice>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line-2">
          {accounts.data.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="flex flex-col">
                <span className="font-medium text-fg">
                  {a.bankName ?? "Bank account"}
                  {a.last4 ? <span className="ml-2 font-mono text-fg-2">····{a.last4}</span> : null}
                </span>
                <span className="text-xs text-fg-3">
                  {a.accountType ?? ""}
                  {a.addedAt ? ` · added ${fmtDate(a.addedAt)}` : ""}
                </span>
              </span>
              {a.isDefault ? <Pill tone="ok">Invoices are paid from this</Pill> : null}
            </li>
          ))}
        </ul>
      )}
      <Button
        variant={accounts.data && accounts.data.length > 0 ? "secondary" : "primary"}
        loading={busy}
        onClick={() => void setUp()}
      >
        {accounts.data && accounts.data.length > 0
          ? "Add another bank account"
          : "Set up ACH payments"}
      </Button>
    </div>
  );
}

/** How a loan on the book is charged, in the servicer's terms. */
const BASIS =
  "A loan is billed from the day its tape is loaded, on the interest-bearing unpaid principal the newest tape on or before the month's end reported. A loan-month is pro-rated by calendar day and stops the day a tape reports the loan paid off, transferred, charged off or matured. A token is a cent.";

function StatementStats({ answer, terms }: { answer: PortalStatement; terms?: MeterTerms }) {
  const s = answer.statement;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label={answer.standing === "running" ? "Charge so far" : "Charge"}
        value={money(s.cents)}
        hint={terms ? `${tokensWord(s.tokens)}; ${tokenPriceWords(terms)}` : tokensWord(s.tokens)}
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

/** The credit notes issued against one invoice, each with its PDF. */
function PortalCreditNotes({ invoice, onClose }: { invoice: PortalInvoice; onClose: () => void }) {
  const toast = useToast();
  const notes = useQuery({
    queryKey: ["portal-credit-notes", invoice.issued?.id ?? ""],
    queryFn: () =>
      portal<{ creditNotes: PortalCreditNote[] }>(
        `/billing/invoices/${invoice.issued!.id}/credit-notes`,
      ).then((r) => r.creditNotes),
  });
  const openPdf = async (id: string) => {
    const tab = window.open("", "_blank", "noopener");
    try {
      const { pdfUrl } = await portal<{ pdfUrl: string }>(`/billing/credit-notes/${id}/link`);
      if (tab) tab.location.href = pdfUrl;
      else window.location.assign(pdfUrl);
    } catch (err) {
      tab?.close();
      toast({ tone: "danger", title: "The PDF could not be opened", body: (err as Error).message });
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Credits on ${monthLabel(invoice.month)}`}
      subtitle={invoice.issued?.number ?? undefined}
    >
      {notes.isPending ? (
        <Loading what="Reading the credit notes" />
      ) : notes.isError || !notes.data ? (
        <Notice tone="danger">The credit notes could not be read.</Notice>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line-2">
          {notes.data.map((n) => (
            <li key={n.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-fg">
                  {money(n.amountCents)}
                  {n.number ? (
                    <span className="ml-2 font-mono text-xs text-fg-3">{n.number}</span>
                  ) : null}
                </span>
                <span className="text-xs text-fg-3">
                  {n.memo}
                  {n.issuedAt ? ` · ${fmtDate(n.issuedAt)}` : ""}
                </span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => void openPdf(n.id)}>
                PDF
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

export function PortalBillingPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [credits, setCredits] = useState<PortalInvoice | null>(null);
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
        render: (i) => (
          <span className="flex flex-col items-end">
            <span className="tabular-nums font-medium text-fg">{money(i.cents)}</span>
            {i.issued && BigInt(i.issued.creditedCents) > 0n ? (
              <button
                type="button"
                className="text-xs text-fg-2 underline hover:text-fg"
                onClick={(e) => {
                  e.stopPropagation();
                  setCredits(i);
                }}
              >
                {money(i.issued.creditedCents)} credited
              </button>
            ) : null}
          </span>
        ),
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
  const { servicer, sheet, today, current, invoices, terms, cadence } = page.data;
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
        <StatementStats answer={current} terms={terms} />
        <ChargeExplainer terms={terms} cadence={cadence} running={current.standing === "running"} />
        <p className="mt-3 text-sm text-fg-3">{runningWords(s)}</p>
      </Section>

      <Section title="Paying">
        <PortalAch />
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
      {credits ? <PortalCreditNotes invoice={credits} onClose={() => setCredits(null)} /> : null}
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
          <span>{runningWords(s)}</span>
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
