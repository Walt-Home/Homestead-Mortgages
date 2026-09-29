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
  monthLabel,
  monthOf,
  monthsSince,
  tokensWord,
  type BillingList,
  type BillingServicerCard,
  type BillingServicerPage as ServicerBilling,
  type CloseReport,
  type LoanCharge,
  type StatementAnswer,
  type StatementLine,
  type StatementStanding,
} from "../lib/billing.js";

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
        header: "Balance on the meter",
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

const rateWord = (l: StatementLine): string =>
  l.basis === "per_100k"
    ? `${l.tokensEach.toLocaleString("en-US")} tokens per $100,000 per loan-month`
    : `${l.tokensEach.toLocaleString("en-US")} tokens ${l.fires}`;

function quantityWord(l: StatementLine): string {
  const q = l.quantity;
  if (q.kind === "events") return plural(q.count, "touch", "touches");
  return `${q.loanMonths} loan-months on ${money(q.balanceCents)} across ${plural(q.loans, "loan")}`;
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

  const lineColumns = useMemo<Column<StatementLine>[]>(
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

  const loanColumns = useMemo<Column<LoanCharge>[]>(
    () => [
      { key: "number", header: "Loan", primary: true, mono: true, render: (c) => c.number },
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
    [],
  );

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
  const { servicer, today, sheet, statements } = page.data;
  const months = monthsSince(servicer.since, today);
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
      }`}
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
              <span>
                {fmtDate(s.from)} through {fmtDate(s.through)}; the month closes on the first.
              </span>
            ) : (
              <span>
                {fmtDate(s.from)} through {fmtDate(s.to)}, computed now; close it to keep it.
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Charge" value={money(s.cents)} hint={tokensWord(s.tokens)} tone="accent" />
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
              label="Balance on the meter"
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

          <Section title={`Statement for ${monthLabel(s.month)}`} className="mt-8">
            <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
              <Table columns={lineColumns} rows={s.lines} rowKey={(l) => l.code} dense />
              <div className="flex items-center justify-between border-t border-line-2 px-4 py-3 text-base">
                <span className="font-medium text-fg">Total</span>
                <span className="flex items-baseline gap-4">
                  <span className="text-sm text-fg-3">{tokensWord(s.tokens)}</span>
                  <span className="tabular-nums font-semibold text-fg">{money(s.cents)}</span>
                </span>
              </div>
            </div>
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
            <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
              <Table
                columns={loanColumns}
                rows={s.loans}
                rowKey={(c) => c.loanId}
                dense
                empty={{
                  icon: "receipt",
                  title: "Nothing consumed this month",
                  body: "No loan on the book was watched during it.",
                }}
              />
            </div>
          </Section>
        </>
      )}

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

      {statements.length > 0 ? (
        <Section title="Closed statements" className="mt-8">
          <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
            <Table
              dense
              columns={[
                {
                  key: "month",
                  header: "Month",
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
                  key: "loans",
                  header: "Loans",
                  align: "right",
                  render: (c) => c.loansBilled.toLocaleString(),
                },
                { key: "lm", header: "Loan-months", align: "right", render: (c) => c.loanMonths },
                {
                  key: "tokens",
                  header: "Tokens",
                  align: "right",
                  render: (c) => Number(c.tokens).toLocaleString("en-US"),
                },
                {
                  key: "cents",
                  header: "Charge",
                  align: "right",
                  render: (c) => <span className="font-medium text-fg">{money(c.cents)}</span>,
                },
                {
                  key: "closed",
                  header: "Closed",
                  render: (c) =>
                    `${fmtDateTime(c.closedAt)} · ${c.closedBy === "job" ? "job" : "by hand"}`,
                },
              ]}
              rows={statements}
              rowKey={(c) => c.id}
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
