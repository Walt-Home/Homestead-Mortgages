/**
 * The partner book (his 34.3): each partner's tape and clock, the loans on
 * it with the review's verdict, the imports, and the day's reviews.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Page, Section } from "../components/Page.js";
import { Table, type Column } from "../components/Table.js";
import { Sheet } from "../components/Sheet.js";
import { Notice, Pill, Rows, Segmented, Select, Stat, type Tone } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { fmtDate, fmtDateTime, fmtRelative, money, parseTs, pct, words } from "../lib/format.js";

interface Partner {
  partner_party_id: string;
  legal_name: string;
  loans_monitored: number;
  on_hold: number;
  imports: number;
  last_as_of_date: string | null;
  next_expected: string | null;
  clock_status: "armed" | "breached" | "none";
  late: boolean;
}
interface BookLoan {
  loan_id: string;
  servicer_loan_number: string;
  partner_party_id: string;
  partner_legal_name: string;
  status: string;
  state: string | null;
  city: string | null;
  homeowner: {
    party_id: string | null;
    legal_name: string | null;
    email_masked: string | null;
  } | null;
  facts_as_of: string | null;
  upb_cents: string | number | null;
  note_rate_pct: string | number | null;
  pi_cents: string | number | null;
  next_due_date: string | null;
  servicing_status: string | null;
  account_activated: boolean;
  latest_review: {
    verdict?: string;
    as_of_date?: string;
    reasons?: string[];
    verdict_words?: string;
    reasons_in_words?: string[];
  } | null;
  latest_readiness: { ready?: boolean; missing?: string[]; as_of_date?: string } | null;
  on_hold: boolean;
}
interface Import {
  import_id: string;
  partner_party_id: string;
  as_of_date: string;
  profile: string;
  status: string;
  created_at: string;
  rows_total: number;
  rows_loaded: number;
  rows_exception: number;
  loans_created: number;
  loans_updated: number;
  loans_unchanged: number;
  on_hold: number;
}
interface Day {
  as_of_date: string;
  reviews: {
    count: number;
    by_verdict: Record<string, number>;
    on_hold: number;
    lines: {
      loan_id: string;
      servicer_loan_number?: string;
      verdict: string;
      reasons?: string[];
      verdict_words?: string;
      reasons_in_words?: string[];
    }[];
  };
  readiness: {
    checked: number;
    ready: number;
    not_ready: number;
    by_missing_item: Record<string, number>;
  };
}

const verdictTone = (v?: string): Tone =>
  v === "candidate"
    ? "ok"
    : v === "watching"
      ? "info"
      : v === "not_now"
        ? "warn"
        : v === "excluded"
          ? "neutral"
          : "neutral";

export function PartnerBookPage() {
  const { role } = useAuth();
  const [partner, setPartner] = useState<string>("");
  const [tab, setTab] = useState<"loans" | "imports" | "today">("loans");
  const [verdict, setVerdict] = useState("all");
  const [selected, setSelected] = useState<BookLoan | null>(null);

  const partners = useQuery({
    queryKey: ["partners", role],
    queryFn: () => api<{ partners: Partner[] }>("/partner-book/partners"),
  });
  const loans = useQuery({
    queryKey: ["book-loans", role, partner, verdict],
    queryFn: () =>
      api<{
        loans: BookLoan[];
        counts: {
          loans: number;
          on_hold: number;
          by_verdict: Record<string, number>;
          ready: number;
        };
      }>("/partner-book/loans", {
        query: { partner: partner || undefined, verdict: verdict === "all" ? undefined : verdict },
      }),
    enabled: tab === "loans",
  });
  const imports = useQuery({
    queryKey: ["book-imports", role, partner],
    queryFn: () =>
      api<{ imports: Import[] }>("/partner-book/imports", {
        query: { partner: partner || undefined, lines: "false" },
      }),
    enabled: tab === "imports",
  });
  const day = useQuery({
    queryKey: ["book-day", role, partner],
    queryFn: () => api<Day>("/partner-book/reviews", { query: { partner: partner || undefined } }),
    enabled: tab === "today",
  });

  const loanColumns = useMemo<Column<BookLoan>[]>(
    () => [
      {
        key: "loan",
        header: "Loan",
        primary: true,
        render: (r) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-base font-medium text-fg">
              {r.servicer_loan_number}
            </span>
            <span className="text-sm text-fg-2">
              {r.homeowner?.legal_name ?? "—"}
              {r.city ? ` · ${r.city}, ${r.state ?? ""}` : ""}
            </span>
          </div>
        ),
      },
      {
        key: "upb",
        header: "Balance",
        align: "right",
        mono: true,
        render: (r) => <span className="text-fg">{money(r.upb_cents)}</span>,
      },
      {
        key: "rate",
        header: "Rate",
        align: "right",
        mono: true,
        render: (r) => <span className="text-fg">{pct(r.note_rate_pct)}</span>,
      },
      {
        key: "pi",
        header: "P&I",
        align: "right",
        mono: true,
        render: (r) => <span className="text-fg-2">{money(r.pi_cents)}</span>,
      },
      {
        key: "verdict",
        header: "Review",
        render: (r) =>
          r.latest_review?.verdict ? (
            <Pill tone={verdictTone(r.latest_review.verdict)}>
              {words(r.latest_review.verdict)}
            </Pill>
          ) : (
            <span className="text-fg-3">Unreviewed</span>
          ),
      },
      {
        key: "ready",
        header: "Ready",
        render: (r) =>
          r.latest_readiness ? (
            <Pill tone={r.latest_readiness.ready ? "ok" : "neutral"}>
              {r.latest_readiness.ready
                ? "Ready"
                : `${r.latest_readiness.missing?.length ?? "?"} missing`}
            </Pill>
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
      {
        key: "status",
        header: "Status",
        render: (r) => (
          <span className="text-fg-2">
            {words(r.status)}
            {r.on_hold ? " · on hold" : ""}
          </span>
        ),
      },
    ],
    [],
  );

  const p = partners.data?.partners ?? [];
  const chosen = p.find((x) => x.partner_party_id === partner);

  return (
    <Page
      title="Partner book"
      description="The loans partners send on tape, the reviews run over them, and what each is waiting on."
      actions={
        p.length > 1 ? (
          <Select
            value={partner}
            onChange={(e) => setPartner(e.target.value)}
            aria-label="Partner"
            className="w-56"
          >
            <option value="">Every partner</option>
            {p.map((x) => (
              <option key={x.partner_party_id} value={x.partner_party_id}>
                {x.legal_name}
              </option>
            ))}
          </Select>
        ) : undefined
      }
      wide
    >
      {partners.error ? <Notice tone="danger">{(partners.error as Error).message}</Notice> : null}
      {p.length ? (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(chosen ? [chosen] : p).slice(0, 4).map((x) => (
            <Stat
              key={x.partner_party_id}
              label={x.legal_name}
              value={x.loans_monitored.toLocaleString()}
              tone={x.late ? "danger" : undefined}
              hint={
                x.clock_status === "breached" || x.late
                  ? `Tape late · expected ${fmtDate(x.next_expected)}`
                  : x.next_expected && (parseTs(x.next_expected)?.getTime() ?? 0) < Date.now()
                    ? `Tape expected ${fmtDate(x.next_expected)} · ${x.on_hold} on hold`
                    : x.next_expected
                      ? `Next tape ${fmtRelative(x.next_expected)} · ${x.on_hold} on hold`
                      : `${x.imports} imports`
              }
              onClick={() => setPartner(chosen ? "" : x.partner_party_id)}
            />
          ))}
        </div>
      ) : null}

      <Section>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Segmented
            label="View"
            value={tab}
            onChange={setTab}
            options={[
              { value: "loans", label: "Loans" },
              { value: "imports", label: "Imports" },
              { value: "today", label: "Today's review" },
            ]}
          />
          {tab === "loans" ? (
            <Segmented
              label="Verdict"
              value={verdict}
              onChange={setVerdict}
              options={[
                { value: "all", label: "All", count: loans.data?.counts.loans },
                {
                  value: "candidate",
                  label: "Candidates",
                  count: loans.data?.counts.by_verdict?.candidate,
                },
                {
                  value: "watching",
                  label: "Watching",
                  count: loans.data?.counts.by_verdict?.watching,
                },
                {
                  value: "not_now",
                  label: "Not now",
                  count: loans.data?.counts.by_verdict?.not_now,
                },
                {
                  value: "excluded",
                  label: "Excluded",
                  count: loans.data?.counts.by_verdict?.excluded,
                },
              ]}
            />
          ) : null}
        </div>
        <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
          {tab === "loans" ? (
            <Table
              columns={loanColumns}
              rows={loans.data?.loans}
              rowKey={(r) => r.loan_id}
              onRowClick={setSelected}
              loading={loans.isLoading}
              empty={{ icon: "book", title: "No loans on the book" }}
            />
          ) : null}
          {tab === "imports" ? (
            <Table
              columns={[
                {
                  key: "asof",
                  header: "As of",
                  primary: true,
                  render: (i) => (
                    <span className="font-medium text-fg">{fmtDate(i.as_of_date)}</span>
                  ),
                },
                {
                  key: "status",
                  header: "Status",
                  render: (i) => (
                    <Pill
                      tone={
                        i.status === "loaded"
                          ? "ok"
                          : i.status === "rejected"
                            ? "danger"
                            : "neutral"
                      }
                    >
                      {words(i.status)}
                    </Pill>
                  ),
                },
                {
                  key: "rows",
                  header: "Rows",
                  align: "right",
                  render: (i) => (
                    <span className="text-fg-2">
                      {i.rows_loaded.toLocaleString()} / {i.rows_total.toLocaleString()}
                    </span>
                  ),
                },
                {
                  key: "changes",
                  header: "Created · updated · unchanged",
                  align: "right",
                  render: (i) => (
                    <span className="text-fg-2">
                      {i.loans_created} · {i.loans_updated} · {i.loans_unchanged}
                    </span>
                  ),
                },
                {
                  key: "exceptions",
                  header: "Exceptions",
                  align: "right",
                  render: (i) => (
                    <span className={i.rows_exception ? "text-warn" : "text-fg-3"}>
                      {i.rows_exception}
                    </span>
                  ),
                },
                {
                  key: "when",
                  header: "Loaded",
                  render: (i) => <span className="text-fg-2">{fmtDateTime(i.created_at)}</span>,
                },
              ]}
              rows={imports.data?.imports}
              rowKey={(i) => i.import_id}
              loading={imports.isLoading}
              empty={{ icon: "book", title: "No tapes loaded" }}
            />
          ) : null}
          {tab === "today" ? (
            <div className="p-4">
              {day.data ? (
                <>
                  <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Stat
                      label="Reviewed"
                      value={day.data.reviews.count}
                      hint={`as of ${fmtDate(day.data.as_of_date)}`}
                    />
                    <Stat
                      label="Candidates"
                      value={day.data.reviews.by_verdict?.candidate ?? 0}
                      tone="ok"
                    />
                    <Stat label="Watching" value={day.data.reviews.by_verdict?.watching ?? 0} />
                    <Stat
                      label="Ready to proceed"
                      value={`${day.data.readiness.ready} / ${day.data.readiness.checked}`}
                    />
                  </div>
                  <Table
                    columns={[
                      {
                        key: "loan",
                        header: "Loan",
                        primary: true,
                        render: (l) => (
                          <span className="font-mono text-fg">
                            {l.servicer_loan_number ?? l.loan_id}
                          </span>
                        ),
                      },
                      {
                        key: "verdict",
                        header: "Verdict",
                        render: (l) => (
                          <Pill tone={verdictTone(l.verdict)}>{words(l.verdict)}</Pill>
                        ),
                      },
                      {
                        key: "why",
                        header: "Why",
                        render: (l) => (
                          <span className="text-fg-2">
                            {(l.reasons_in_words ?? l.reasons ?? []).join("; ")}
                          </span>
                        ),
                      },
                    ]}
                    rows={day.data.reviews.lines}
                    rowKey={(l) => l.loan_id}
                    empty={{ title: "No reviews today" }}
                  />
                </>
              ) : day.error ? (
                <Notice tone="danger">{(day.error as Error).message}</Notice>
              ) : null}
            </div>
          ) : null}
        </div>
        {loans.error || imports.error ? (
          <Notice tone="danger" className="mt-3">
            {((loans.error ?? imports.error) as Error).message}
          </Notice>
        ) : null}
      </Section>
      {selected ? <BookLoanSheet loan={selected} onClose={() => setSelected(null)} /> : null}
    </Page>
  );
}

function BookLoanSheet({ loan, onClose }: { loan: BookLoan; onClose: () => void }) {
  const { role } = useAuth();
  const detail = useQuery({
    queryKey: ["book-loan", role, loan.loan_id],
    queryFn: () =>
      api<{
        loan: Record<string, unknown>;
        reviews: {
          as_of_date: string;
          verdict: string;
          verdict_words?: string;
          reasons_in_words?: string[];
          reasons?: string[];
        }[];
        readiness: { as_of_date: string; ready: boolean; missing: string[] }[];
        offers: { opportunity_id: string; status: string; offer_valid_until: string | null }[];
      }>(`/partner-book/loans/${loan.loan_id}`),
  });
  const d = detail.data;
  const review = loan.latest_review;
  return (
    <Sheet
      open
      onClose={onClose}
      title={loan.servicer_loan_number}
      subtitle={`${loan.partner_legal_name} · ${words(loan.status)}`}
      wide
    >
      <Rows
        rows={[
          { label: "Homeowner", value: loan.homeowner?.legal_name ?? "—" },
          { label: "Balance", value: money(loan.upb_cents), mono: true },
          { label: "Rate", value: pct(loan.note_rate_pct), mono: true },
          { label: "P&I", value: money(loan.pi_cents), mono: true },
          { label: "Next due", value: fmtDate(loan.next_due_date) },
          { label: "Tape as of", value: fmtDate(loan.facts_as_of) },
          { label: "Account", value: loan.account_activated ? "Activated" : "Not activated" },
        ]}
      />
      {review ? (
        <div className="mt-5">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-fg">
            Latest review <Pill tone={verdictTone(review.verdict)}>{words(review.verdict)}</Pill>
            <span className="text-xs font-normal text-fg-3">{fmtDate(review.as_of_date)}</span>
          </div>
          <ul className="list-disc space-y-1 pl-5 text-base text-fg-2">
            {(review.reasons_in_words ?? review.reasons ?? []).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {d?.readiness?.[0] ? (
        <div className="mt-5">
          <div className="mb-2 text-sm font-medium text-fg">Readiness</div>
          {d.readiness[0].ready ? (
            <Notice tone="ok">Ready as of {fmtDate(d.readiness[0].as_of_date)}.</Notice>
          ) : (
            <Notice tone="neutral" title={`Missing ${d.readiness[0].missing.length}`}>
              {d.readiness[0].missing.map(words).join(", ")}
            </Notice>
          )}
        </div>
      ) : null}
      {d?.offers?.length ? (
        <div className="mt-5">
          <div className="mb-2 text-sm font-medium text-fg">Offers</div>
          <Rows
            rows={d.offers.map((o) => ({
              label: words(o.status),
              value: o.offer_valid_until ? `open until ${fmtDate(o.offer_valid_until)}` : "—",
            }))}
          />
        </div>
      ) : null}
      {d?.reviews && d.reviews.length > 1 ? (
        <div className="mt-5">
          <div className="mb-2 text-sm font-medium text-fg">Earlier reviews</div>
          <Rows
            rows={d.reviews.slice(1, 8).map((r) => ({
              label: fmtDate(r.as_of_date),
              value: <Pill tone={verdictTone(r.verdict)}>{words(r.verdict)}</Pill>,
            }))}
          />
        </div>
      ) : null}
    </Sheet>
  );
}
