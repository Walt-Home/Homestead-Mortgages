/**
 * One loan: what it is, what it holds, and everything that has happened to
 * it — events, the ledger, the clocks, the decisions, the notices, and
 * whatever is open on it in the queue.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Page, Section } from "../components/Page.js";
import { Table, type Column } from "../components/Table.js";
import { Notice, Pill, Rows, Segmented, Skeleton, type Tone } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { fmtDate, fmtDateTime, fmtRelative, money, shortId, words } from "../lib/format.js";
import { loanStatusTone, type LoanSummary } from "./LoansPage.js";

interface LoanDetail extends LoanSummary {
  events: {
    id: string;
    sequence: number;
    type: string;
    occurredAt: string;
    actor: string;
    payload: unknown;
  }[];
  balances: { account: string; cents: string }[];
  timers: {
    id: string;
    code: string;
    status: string;
    dueAt?: string | null;
    dueDate?: string | null;
    note?: string | null;
  }[];
  decisions: {
    id: string;
    agent: string;
    action: string;
    ruleCode?: string | null;
    rationale: string;
    confidence: number | null;
    approvedBy?: string | null;
    approvedRole?: string | null;
    createdAt: string;
  }[];
  notices: {
    id: string;
    template: string;
    version: string;
    status: string;
    heldReason?: string | null;
    producedAt: string;
    sentAt?: string | null;
  }[];
  [k: string]: unknown;
}

interface OpenItem {
  id: string;
  kind: string;
  title: string;
  ownerRole: string;
  severity?: number | string | null;
  openedAt: string;
  dueAt?: string | null;
}

type Tab = "events" | "ledger" | "timers" | "decisions" | "notices" | "open";

const timerTone = (s: string): Tone =>
  s === "breached" ? "danger" : s === "armed" ? "info" : s === "satisfied" ? "ok" : "neutral";

export function LoanPage() {
  const { id = "" } = useParams();
  const { role } = useAuth();
  const [tab, setTab] = useState<Tab>("events");
  const loan = useQuery({
    queryKey: ["loan", role, id],
    queryFn: () => api<LoanDetail>(`/loans/${id}`),
  });
  const open = useQuery({
    queryKey: ["loan-open", role, id],
    queryFn: () => api<OpenItem[]>("/queue", { query: { loanId: id } }),
    enabled: tab === "open",
  });
  const d = loan.data;

  const eventColumns = useMemo<Column<LoanDetail["events"][number]>[]>(
    () => [
      {
        key: "when",
        header: "When",
        width: "w-40",
        render: (e) => (
          <span className="text-fg-2" title={fmtDateTime(e.occurredAt)}>
            {fmtDateTime(e.occurredAt)}
          </span>
        ),
      },
      {
        key: "type",
        header: "Event",
        primary: true,
        render: (e) => <span className="font-mono text-sm text-fg">{e.type}</span>,
      },
      { key: "actor", header: "By", render: (e) => <span className="text-fg-2">{e.actor}</span> },
      {
        key: "seq",
        header: "#",
        align: "right",
        width: "w-16",
        render: (e) => <span className="text-fg-3">{e.sequence}</span>,
      },
    ],
    [],
  );

  return (
    <Page
      back={{ to: "/loans", label: "Loans" }}
      title={d ? (d.servicerLoanNumber ?? shortId(d.id, 12)) : <Skeleton className="h-8 w-48" />}
      meta={
        d ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <Pill tone={loanStatusTone(d.status)}>{words(d.status)}</Pill>
            {d.fnmaLoanNumber ? <span>FNMA {d.fnmaLoanNumber}</span> : null}
            <span>· boarded {fmtDate(d.boardedAt)}</span>
          </span>
        ) : null
      }
      wide
    >
      {loan.error ? <Notice tone="danger">{(loan.error as Error).message}</Notice> : null}
      {d ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {d.balances.slice(0, 5).map((b) => (
              <div
                key={b.account}
                className="rounded-lg border border-line-2 bg-surface p-4 shadow-card"
              >
                <div className="text-sm text-fg-2">{words(b.account)}</div>
                <div className="mt-1 text-xl font-semibold tracking-tight">{money(b.cents)}</div>
              </div>
            ))}
          </div>
          <Section>
            <Segmented
              label="Section"
              value={tab}
              onChange={setTab}
              className="mb-3"
              options={[
                { value: "events", label: "Events", count: d.events.length },
                { value: "ledger", label: "Ledger", count: d.balances.length },
                { value: "timers", label: "Clocks", count: d.timers.length },
                { value: "decisions", label: "Decisions", count: d.decisions.length },
                { value: "notices", label: "Notices", count: d.notices.length },
                { value: "open", label: "Open items" },
              ]}
            />
            <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
              {tab === "events" ? (
                <Table
                  columns={eventColumns}
                  rows={[...d.events].reverse()}
                  rowKey={(e) => e.id}
                  empty={{ title: "No events" }}
                />
              ) : null}
              {tab === "ledger" ? (
                <div className="p-4">
                  <Rows
                    rows={d.balances.map((b) => ({
                      label: words(b.account),
                      value: money(b.cents),
                      mono: true,
                    }))}
                  />
                </div>
              ) : null}
              {tab === "timers" ? (
                <Table
                  columns={[
                    {
                      key: "code",
                      header: "Clock",
                      primary: true,
                      render: (t) => <span className="font-mono text-sm text-fg">{t.code}</span>,
                    },
                    {
                      key: "status",
                      header: "Status",
                      render: (t) => <Pill tone={timerTone(t.status)}>{words(t.status)}</Pill>,
                    },
                    {
                      key: "due",
                      header: "Due",
                      render: (t) => (
                        <span className="text-fg-2">
                          {t.dueAt ? fmtRelative(t.dueAt) : (t.dueDate ?? "—")}
                        </span>
                      ),
                    },
                    {
                      key: "note",
                      header: "Note",
                      render: (t) => <span className="text-fg-2">{t.note ?? ""}</span>,
                    },
                  ]}
                  rows={d.timers}
                  rowKey={(t) => t.id}
                  empty={{ icon: "clock", title: "No clocks on this loan" }}
                />
              ) : null}
              {tab === "decisions" ? (
                <Table
                  columns={[
                    {
                      key: "when",
                      header: "When",
                      width: "w-40",
                      render: (x) => <span className="text-fg-2">{fmtDateTime(x.createdAt)}</span>,
                    },
                    {
                      key: "what",
                      header: "Decision",
                      primary: true,
                      render: (x) => (
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-fg">{words(x.action)}</span>
                          <span className="text-sm text-fg-2">{x.rationale}</span>
                        </div>
                      ),
                    },
                    {
                      key: "agent",
                      header: "By",
                      render: (x) => (
                        <span className="text-fg-2">
                          {x.agent}
                          {x.approvedBy ? ` · approved by ${x.approvedRole ?? x.approvedBy}` : ""}
                        </span>
                      ),
                    },
                    {
                      key: "rule",
                      header: "Rule",
                      mono: true,
                      render: (x) => <span className="text-fg-3">{x.ruleCode ?? ""}</span>,
                    },
                  ]}
                  rows={d.decisions}
                  rowKey={(x) => x.id}
                  empty={{ title: "No decisions" }}
                />
              ) : null}
              {tab === "notices" ? (
                <Table
                  columns={[
                    {
                      key: "template",
                      header: "Notice",
                      primary: true,
                      render: (n) => (
                        <span className="font-mono text-sm text-fg">
                          {n.template} <span className="text-fg-3">v{n.version}</span>
                        </span>
                      ),
                    },
                    {
                      key: "status",
                      header: "Status",
                      render: (n) => (
                        <Pill
                          tone={
                            n.status === "held" ? "warn" : n.status === "sent" ? "ok" : "neutral"
                          }
                        >
                          {words(n.status)}
                        </Pill>
                      ),
                    },
                    {
                      key: "produced",
                      header: "Produced",
                      render: (n) => <span className="text-fg-2">{fmtDateTime(n.producedAt)}</span>,
                    },
                    {
                      key: "sent",
                      header: "Sent",
                      render: (n) => (
                        <span className="text-fg-2">
                          {n.sentAt ? fmtDateTime(n.sentAt) : (n.heldReason ?? "—")}
                        </span>
                      ),
                    },
                  ]}
                  rows={d.notices}
                  rowKey={(n) => n.id}
                  empty={{ title: "No notices" }}
                />
              ) : null}
              {tab === "open" ? (
                <Table
                  columns={[
                    {
                      key: "title",
                      header: "Item",
                      primary: true,
                      render: (i) => <span className="font-medium text-fg">{i.title}</span>,
                    },
                    { key: "kind", header: "Kind", render: (i) => <Pill>{words(i.kind)}</Pill> },
                    {
                      key: "owner",
                      header: "Needs",
                      render: (i) => <span className="text-fg-2">{words(i.ownerRole)}</span>,
                    },
                    {
                      key: "opened",
                      header: "Opened",
                      render: (i) => <span className="text-fg-2">{fmtRelative(i.openedAt)}</span>,
                    },
                  ]}
                  rows={open.data}
                  rowKey={(i) => i.id}
                  loading={open.isLoading}
                  empty={{ icon: "check", title: "Nothing open on this loan" }}
                />
              ) : null}
            </div>
          </Section>
        </>
      ) : null}
    </Page>
  );
}
