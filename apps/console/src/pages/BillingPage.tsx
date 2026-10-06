/**
 * Billing: what each servicer's book consumes, by the price sheet.
 *
 * The list is every servicer we hold a book for and what its loans are
 * consuming this month; the page behind each row is the servicer's
 * statement for a month — the lines the sheet prices, the loans under
 * them, and the annual pool the charge draws on. A month that has ended is
 * closed once, by the job on the first or by hand here, and from then on
 * the statement is the row and nothing recomputes it.
 */

import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Page, Section } from "../components/Page.js";
import { Table, type Column } from "../components/Table.js";
import { StatementLines, StatementLoans } from "../components/StatementTables.js";
import { ChargeExplainer, tokenPriceWords } from "../components/ChargeExplainer.js";
import { AchPayments } from "../components/AchPayments.js";
import { BillingProfileForm } from "../components/BillingProfileForm.js";
import { INVOICE_WORDS, InvoicePanel } from "../components/InvoicePanel.js";
import { useToast } from "../components/Toast.js";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  Pill,
  Rows,
  Select,
  Stat,
  type Tone,
} from "../components/ui.js";
import { Loading } from "../components/Loading.js";
import { useAct } from "../lib/act.js";
import { fmtDate, fmtDateTime, money, plural } from "../lib/format.js";
import {
  billing,
  daysThrough,
  firstOfNextMonth,
  monthLabel,
  monthOf,
  monthsSince,
  openInvoicePage,
  paymentMethodWord,
  stripeDashboardUrl,
  tokensWord,
  type BillingList,
  type BillingServicerCard,
  type BillingServicerPage as ServicerBilling,
  type CloseReport,
  type InvoiceLink,
  type InvoiceView,
  type Statement,
  type StatementAnswer,
  type StatementStanding,
} from "../lib/billing.js";

/** The month still running, in a sentence that is true on its first day too. */
function runningWords(s: Statement): string {
  const days = daysThrough(s.from, s.through);
  const span =
    s.from === s.through
      ? `${fmtDate(s.from)} only`
      : `${fmtDate(s.from)} through ${fmtDate(s.through)}`;
  return `${monthLabel(s.month)} so far: ${span}, ${plural(days, "day")} of ${s.daysInMonth}. It closes on ${fmtDate(firstOfNextMonth(s.to))} and is drafted and sent from here after that.`;
}

const STANDING_WORDS: Record<StatementStanding, { word: string; tone: Tone }> = {
  closed: { word: "Closed", tone: "ok" },
  open: { word: "Ended, not yet closed", tone: "warn" },
  running: { word: "Running", tone: "info" },
};

/** The sheet's own sentence for what a monitored book consumes, said once on both pages. */
const BASIS =
  "A monitored loan on a partner's book consumes the self-improving mortgage row and offer touches from the day it is loaded; the servicing rows start the day the loan boards. Balances are the interest-bearing UPB the newest tape on or before the month's end reported, and a loan-month is pro-rated by calendar day.";

export function BillingPage() {
  const list = useQuery({
    queryKey: ["billing-servicers"],
    queryFn: () => billing<BillingList>("/servicers"),
  });
  const columns = useMemo<Column<BillingServicerCard>[]>(
    () => [
      {
        key: "name",
        header: "Servicer",
        primary: true,
        render: (s) => (
          <Link to={`/billing/${s.slug}`} className="font-medium text-fg hover:underline">
            {s.displayName}
          </Link>
        ),
      },
      {
        key: "loans",
        header: "Loans on the book",
        align: "right",
        render: (s) => <span className="tabular-nums">{s.loansOnBook.toLocaleString()}</span>,
      },
      {
        key: "balance",
        header: "UPB billed on",
        align: "right",
        render: (s) => (
          <span className="flex flex-col items-end">
            <span className="tabular-nums">{money(s.running.balanceCents, { compact: true })}</span>
            <span className="text-xs text-fg-3">interest-bearing UPB, summed</span>
          </span>
        ),
      },
      {
        key: "month",
        header: "This month so far",
        align: "right",
        render: (s) => (
          <span className="flex flex-col items-end">
            <span className="tabular-nums font-medium text-fg">{money(s.running.cents)}</span>
            <span className="text-xs text-fg-3">{tokensWord(s.running.tokens)}</span>
          </span>
        ),
      },
      {
        key: "last",
        header: "Last statement",
        align: "right",
        render: (s) =>
          s.lastClosed ? (
            <span className="flex flex-col items-end">
              <span className="tabular-nums">{money(s.lastClosed.cents)}</span>
              <span className="text-xs text-fg-3">{monthLabel(s.lastClosed.month)}</span>
            </span>
          ) : (
            <span className="text-fg-3">None closed</span>
          ),
      },
      {
        key: "pool",
        header: "Annual pool",
        align: "right",
        render: (s) =>
          s.annualTokenPool ? (
            <span className="flex flex-col items-end">
              <span className="tabular-nums">{tokensWord(s.annualTokenPool)}</span>
              <span className="text-xs text-fg-3">
                {tokensWord(s.yearToDate.tokens)} closed in {s.yearToDate.year}
              </span>
            </span>
          ) : (
            <span className="text-fg-3">Not set</span>
          ),
      },
    ],
    [],
  );

  return (
    <Page
      title="Billing"
      description="What each servicer's book consumes, by the price sheet, off the tape they loaded."
      meta={
        list.data
          ? `Price sheet ${list.data.sheet.version} of ${fmtDate(list.data.sheet.date)} · a token is a cent · through ${fmtDate(list.data.today)}`
          : null
      }
    >
      {list.isPending ? (
        <Loading what="Reading the servicers" />
      ) : list.isError ? (
        <Notice tone="danger">Billing could not be read.</Notice>
      ) : list.data.servicers.length === 0 ? (
        <EmptyState icon="receipt" title="No servicer yet">
          A servicer appears here the first time a tape of theirs is loaded at the desk.
        </EmptyState>
      ) : (
        <Table columns={columns} rows={list.data.servicers} rowKey={(s) => s.slug} />
      )}
      <Notice tone="neutral" className="mt-6">
        {BASIS}
      </Notice>
    </Page>
  );
}

function PoolEditor({ slug, pool }: { slug: string; pool: string | null }) {
  const act = useAct({
    invalidate: [["billing-servicer", slug], ["billing-servicers"]],
    done: "Saved",
  });
  const [value, setValue] = useState(pool ?? "");
  const save = async (tokens: string | null) => {
    await act.run(`/servicers/${slug}/pool`, {
      method: "PUT",
      body: { annualTokenPool: tokens },
      door: "billing",
    });
  };
  const digits = value.trim().replace(/,/g, "");
  const valid = /^\d{1,18}$/.test(digits);
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <Field
        label="Annual token pool"
        htmlFor="pool"
        hint="What they committed to for the year, in tokens. A token is a cent."
        className="flex-1"
      >
        <Input
          id="pool"
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="2,500,000"
        />
      </Field>
      <div className="flex gap-2">
        <Button
          variant="primary"
          loading={act.busy}
          disabled={!valid || digits === (pool ?? "")}
          onClick={() => void save(digits)}
        >
          Save
        </Button>
        {pool ? (
          <Button variant="secondary" disabled={act.busy} onClick={() => void save(null)}>
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function BillingServicerPage() {
  const { slug = "" } = useParams();
  const page = useQuery({
    queryKey: ["billing-servicer", slug],
    queryFn: () => billing<ServicerBilling>(`/servicers/${slug}`),
    enabled: slug !== "",
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const month = chosen ?? (page.data ? monthOf(page.data.today) : null);
  const statement = useQuery({
    queryKey: ["billing-statement", slug, month],
    queryFn: () => billing<StatementAnswer>(`/servicers/${slug}/statements/${month}`),
    enabled: month !== null,
  });
  const close = useAct({
    invalidate: [["billing-servicer", slug], ["billing-statement", slug], ["billing-servicers"]],
    done: "Closed",
  });
  const toast = useToast();

  if (page.isPending) return <Loading what="Reading the servicer" />;
  if (page.isError || !page.data) {
    return (
      <Page title="No such servicer" back={{ to: "/billing", label: "Billing" }}>
        <EmptyState icon="receipt" title="Nothing here by that name">
          It may have been loaded under a different slug.
        </EmptyState>
      </Page>
    );
  }
  const {
    servicer,
    today,
    sheet,
    statements,
    profile,
    profileGaps,
    invoices,
    invoicing,
    runRate,
    terms,
    cadence,
  } = page.data;
  const running = page.data.current.statement;
  const months = monthsSince(servicer.since, today);
  // The month's invoice: the live one if there is one, else the last voided.
  const invoiceFor = (m: string): InvoiceView | null => {
    const mine = invoices.filter((i) => i.month === m);
    return mine.find((i) => i.standing !== "void") ?? mine[0] ?? null;
  };
  const answer = statement.data ?? null;
  const s = answer?.statement ?? null;
  const standing = answer ? STANDING_WORDS[answer.standing] : null;
  const year = today.slice(0, 4);
  const closedThisYear = statements
    .filter((c) => c.month.startsWith(year))
    .reduce((n, c) => n + Number(c.tokens), 0);

  return (
    <Page
      title={servicer.displayName}
      back={{ to: "/billing", label: "Billing" }}
      description="Billed off the tape they loaded, by the price sheet."
      meta={`Price sheet ${sheet.version} of ${fmtDate(sheet.date)} · ${
        servicer.since ? `watched since ${fmtDate(servicer.since)}` : "no book yet"
      } · invoiced through ${invoicing.provider}, payable by ${invoicing.paymentMethods
        .map(paymentMethodWord)
        .join(" or ")}`}
      actions={
        <>
          <Select
            aria-label="Month"
            value={month ?? ""}
            onChange={(e) => setChosen(e.target.value)}
            className="h-10"
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
                {statements.some((c) => c.month === m)
                  ? " · closed"
                  : m === monthOf(today)
                    ? " · running"
                    : ""}
              </option>
            ))}
          </Select>
          {answer?.standing === "open" && month ? (
            <Button
              variant="primary"
              loading={close.busy}
              onClick={() =>
                void close.run<CloseReport>("/close", { body: { month }, door: "billing" })
              }
            >
              Close {monthLabel(month)}
            </Button>
          ) : null}
        </>
      }
    >
      {/* The run rate: what the book would consume in a whole month at the newest balances, and twelve of them. */}
      <Section title="Run rate" className="mb-8">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="MRR estimate"
            value={money(runRate.monthlyCents)}
            hint={`a whole month at the newest tape's balances; ${plural(runRate.loans, "loan")}, no offer touches`}
            tone="accent"
          />
          <Stat
            label="ARR estimate"
            value={money(runRate.annualCents)}
            hint="MRR × 12 at today's balances; principal amortizes, so a year runs lower"
          />
          <Stat
            label="UPB in the rate"
            value={money(runRate.balanceCents, { compact: true })}
            hint={`of ${plural(runRate.loansOnBook, "loan")} on the book: those loaded, with a balance, not ended`}
          />
          <Stat
            label="Tokens a month"
            value={Number(runRate.monthlyTokens).toLocaleString("en-US")}
            hint={`${terms.tokensPer100kPerLoanMonth.toLocaleString("en-US")} per $100,000 of UPB per loan-month; ${tokenPriceWords(terms)}`}
          />
        </div>
      </Section>

      {statement.isPending || !s || !answer || !standing ? (
        statement.isError ? (
          <Notice tone="danger">The statement could not be read.</Notice>
        ) : (
          <Loading what="Metering the month" />
        )
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-2">
            <Pill tone={standing.tone}>{standing.word}</Pill>
            {answer.standing === "closed" && answer.closed ? (
              <span>
                {fmtDateTime(answer.closed.closedAt)} by{" "}
                {answer.closed.closedBy === "job" ? "the month-close job" : "staff"}
              </span>
            ) : answer.standing === "running" ? (
              <span>{runningWords(s)}</span>
            ) : (
              <span>
                {fmtDate(s.from)} through {fmtDate(s.to)}, computed now; close it to keep it.
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label={answer.standing === "running" ? "Charge so far" : "Charge"}
              value={money(s.cents)}
              hint={`${tokensWord(s.tokens)}; ${tokenPriceWords(terms)}`}
              tone="accent"
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
              hint={
                s.loansBilled > 0
                  ? `interest-bearing UPB, summed; ${money(
                      BigInt(s.balanceCents) / BigInt(s.loansBilled),
                      { compact: true },
                    )} a loan on average`
                  : "interest-bearing UPB, summed"
              }
            />
          </div>
          <ChargeExplainer
            terms={terms}
            cadence={cadence}
            running={answer.standing === "running"}
          />

          {answer.standing === "closed" && month ? (
            <Section title="Invoice" className="mt-8">
              <InvoicePanel
                slug={slug}
                month={month}
                statement={s}
                invoice={invoiceFor(month)}
                profile={profile}
                gaps={profileGaps}
                invoicing={invoicing}
              />
            </Section>
          ) : null}

          <Section title={`Statement for ${monthLabel(s.month)}`} className="mt-8">
            <StatementLines statement={s} />
          </Section>

          <Section
            title="By loan"
            aside={
              <span className="text-sm text-fg-3">
                {plural(s.loans.length, "loan")} consumed something
              </span>
            }
            className="mt-8"
          >
            <StatementLoans statement={s} />
          </Section>
        </>
      )}

      <Section
        title="Invoices"
        className="mt-8"
        aside={
          <span className="text-sm text-fg-3">
            {statements.length ? plural(statements.length, "past invoice") : "none past yet"}
          </span>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-line-2 bg-surface p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-3">
                  Upcoming
                </div>
                <div className="mt-1 text-base font-medium text-fg">
                  {monthLabel(running.month)}
                </div>
                <div className="mt-1 max-w-prose text-sm text-fg-2">{runningWords(running)}</div>
              </div>
              <div className="text-right">
                <div className="text-xl font-semibold tabular-nums text-fg">
                  {money(running.cents)}
                </div>
                <div className="text-xs text-fg-3">so far · {tokensWord(running.tokens)}</div>
              </div>
            </div>
          </div>
          {statements.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
              <Table
                dense
                columns={[
                  {
                    key: "month",
                    header: "Past",
                    primary: true,
                    render: (c) => (
                      <button
                        type="button"
                        className="font-medium text-fg hover:underline"
                        onClick={() => setChosen(c.month)}
                      >
                        {monthLabel(c.month)}
                      </button>
                    ),
                  },
                  {
                    key: "amount",
                    header: "Amount",
                    align: "right",
                    render: (c) => <span className="font-medium text-fg">{money(c.cents)}</span>,
                  },
                  {
                    key: "invoice",
                    header: "Invoice",
                    render: (c) => {
                      const i = invoiceFor(c.month);
                      if (!i) return <span className="text-fg-3">Not drafted</span>;
                      const at = stripeDashboardUrl(
                        "invoices",
                        i.providerInvoiceId,
                        i.provider,
                        i.livemode,
                      );
                      return (
                        <span className="flex flex-wrap items-center gap-2">
                          <Pill tone={INVOICE_WORDS[i.standing].tone}>
                            {INVOICE_WORDS[i.standing].word}
                          </Pill>
                          {i.number ? (
                            at ? (
                              <a
                                href={at}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-xs text-fg-2 hover:underline"
                              >
                                {i.number}
                              </a>
                            ) : (
                              <span className="font-mono text-xs text-fg-2">{i.number}</span>
                            )
                          ) : null}
                          {i.attempt > 1 ? (
                            <span className="text-xs text-fg-3">attempt {i.attempt}</span>
                          ) : null}
                        </span>
                      );
                    },
                  },
                  {
                    key: "due",
                    header: "Due",
                    render: (c) => {
                      const i = invoiceFor(c.month);
                      return i?.dueAt ? fmtDate(i.dueAt) : "—";
                    },
                  },
                  {
                    key: "paid",
                    header: "Paid",
                    render: (c) => {
                      const i = invoiceFor(c.month);
                      return i?.paidAt
                        ? `${fmtDate(i.paidAt)}${i.paidOutOfBand ? " · outside" : ""}`
                        : "—";
                    },
                  },
                  {
                    key: "open",
                    header: "",
                    align: "right",
                    render: (c) => {
                      const i = invoiceFor(c.month);
                      return i &&
                        ["sent", "open", "past_due", "paid", "uncollectible"].includes(
                          i.standing,
                        ) ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            void openInvoicePage(() =>
                              billing<InvoiceLink>(`/invoices/${i.id}/link`),
                            ).catch((err: Error) =>
                              toast({
                                tone: "danger",
                                title: "The page could not be opened",
                                body: err.message,
                              }),
                            )
                          }
                        >
                          {i.standing === "paid" ? "Receipt" : "Invoice page"}
                        </Button>
                      ) : null;
                    },
                  },
                ]}
                rows={statements}
                rowKey={(c) => c.id}
              />
            </div>
          ) : (
            <Notice tone="neutral">
              No month has closed yet. The first past invoice appears after{" "}
              {monthLabel(running.month)} closes on {fmtDate(firstOfNextMonth(running.to))}.
            </Notice>
          )}
        </div>
      </Section>

      <Section title="ACH payments" className="mt-8">
        <AchPayments slug={slug} gaps={profileGaps} invoicing={invoicing} />
      </Section>

      <Section title="Billing profile" className="mt-8">
        <BillingProfileForm
          key={profile.updatedAt ?? "new"}
          slug={slug}
          profile={profile}
          gaps={profileGaps}
        />
      </Section>

      <Section title="Annual token pool" className="mt-8">
        <div className="space-y-4 rounded-lg border border-line-2 bg-surface p-4">
          <Rows
            rows={[
              {
                label: "Committed",
                value: servicer.annualTokenPool
                  ? `${tokensWord(servicer.annualTokenPool)} · ${money(servicer.annualTokenPool)}`
                  : "Not set",
              },
              {
                label: `Closed in ${year}`,
                value: `${tokensWord(closedThisYear)} · ${money(String(closedThisYear))}`,
              },
              ...(servicer.annualTokenPool
                ? [
                    {
                      label: "Remaining",
                      value: `${tokensWord(Math.max(0, Number(servicer.annualTokenPool) - closedThisYear))}`,
                    },
                  ]
                : []),
            ]}
          />
          <PoolEditor
            key={servicer.annualTokenPool ?? "none"}
            slug={slug}
            pool={servicer.annualTokenPool}
          />
        </div>
      </Section>

      <Notice tone="neutral" className="mt-8">
        {BASIS}
      </Notice>
    </Page>
  );
}
