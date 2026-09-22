/**
 * Controls (his 34.4): the clocks, the escalations, the outbox and the AI
 * kill switches, each a list with the one act it allows.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Page, Section } from "../components/Page.js";
import { Table, type Column } from "../components/Table.js";
import { Sheet } from "../components/Sheet.js";
import {
  Button,
  Field,
  Notice,
  Pill,
  Rows,
  Segmented,
  Select,
  Textarea,
  type Tone,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAct } from "../lib/act.js";
import { roleWord, useAuth } from "../lib/auth.js";
import { fmtDateTime, fmtRelative, parseTs, shortId, words } from "../lib/format.js";

interface Timer {
  timer_id: string;
  code: string;
  status: string;
  loan_id: string | null;
  application_id: string | null;
  due_at: string | null;
  due_date: string | null;
  breached_at: string | null;
  severity: number | null;
  breach_role: string | null;
  process: string | null;
  note?: string | null;
}
interface Escalation {
  id: string;
  kind: string;
  owner_role: string;
  severity: number | null;
  status: string;
  loan_id: string | null;
  opened_at: string;
  completed_at: string | null;
  disposition: string | null;
  reason: string | null;
  dispositions: string[];
  payload?: Record<string, unknown>;
}
interface Message {
  id: string;
  adapter: string;
  direction: string;
  status: string;
  attempts: number;
  error: string | null;
  loan_id: string | null;
  created_at: string;
  next_attempt_at: string | null;
  requeues: number;
  requeues_left: number;
}
interface AiSystem {
  code: string;
  name: string;
  risk_tier: string;
  owner_role: string;
  status: string;
  model_version: string | null;
  kill_switch: { state?: string; tripped?: boolean; [k: string]: unknown } | null;
  pending_request: { request_id?: string; expires_at?: string; by?: string } | null;
}

const TABS = ["timers", "escalations", "outbox", "ai"] as const;
type Tab = (typeof TABS)[number];
const timerTone = (s: string): Tone =>
  s === "breached"
    ? "danger"
    : s === "due"
      ? "warn"
      : s === "armed"
        ? "info"
        : s === "satisfied"
          ? "ok"
          : "neutral";
const sevTone = (n: number | null): Tone =>
  n === null ? "neutral" : n <= 1 ? "danger" : n === 2 ? "warn" : "neutral";

export function ControlsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS as readonly string[]).includes(params.get("tab") ?? "")
    ? (params.get("tab") as Tab)
    : "timers";
  const setTab = (t: Tab) => setParams({ tab: t });
  return (
    <Page
      title="Controls"
      description="The clocks, the escalations, the outbox and the AI switches."
      wide
    >
      <Section>
        <Segmented
          label="Control"
          value={tab}
          onChange={setTab}
          className="mb-3"
          options={[
            { value: "timers", label: "Clocks" },
            { value: "escalations", label: "Escalations" },
            { value: "outbox", label: "Outbox" },
            { value: "ai", label: "AI switches" },
          ]}
        />
        {tab === "timers" ? <Timers initialStatus={params.get("status") ?? "open"} /> : null}
        {tab === "escalations" ? <Escalations /> : null}
        {tab === "outbox" ? <Outbox /> : null}
        {tab === "ai" ? <AiSwitches /> : null}
      </Section>
    </Page>
  );
}

function LoanLink({ id }: { id: string | null }) {
  return id ? (
    <Link
      to={`/loans/${id}`}
      onClick={(e) => e.stopPropagation()}
      className="font-mono text-sm text-fg-2 hover:text-fg hover:underline"
    >
      {shortId(id)}
    </Link>
  ) : (
    <span className="text-fg-3">—</span>
  );
}

function Timers({ initialStatus }: { initialStatus: string }) {
  const { role } = useAuth();
  const [status, setStatus] = useState(initialStatus);
  const [selected, setSelected] = useState<Timer | null>(null);
  const q = useQuery({
    queryKey: ["timers", role, status],
    queryFn: () =>
      api<{ timers: Timer[]; counts: { armed: number; due: number; breached: number } }>(
        "/controls/timers",
        { query: { status, limit: 500 } },
      ),
  });
  const columns = useMemo<Column<Timer>[]>(
    () => [
      {
        key: "code",
        header: "Clock",
        primary: true,
        render: (t) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-sm font-medium text-fg">{t.code}</span>
            <span className="text-xs text-fg-3">
              {t.process ? `§${t.process}` : ""}
              {t.note ? ` · ${t.note}` : ""}
            </span>
          </div>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (t) => (
          <span className="inline-flex gap-1.5">
            <Pill tone={timerTone(t.status)}>{words(t.status)}</Pill>
            {t.severity !== null ? <Pill tone={sevTone(t.severity)}>Sev {t.severity}</Pill> : null}
          </span>
        ),
      },
      { key: "loan", header: "Loan", render: (t) => <LoanLink id={t.loan_id} /> },
      {
        key: "role",
        header: "On breach",
        render: (t) => (
          <span className="text-fg-2">{t.breach_role ? roleWord(t.breach_role) : "—"}</span>
        ),
      },
      {
        key: "due",
        header: "Due",
        render: (t) => {
          const d = parseTs(t.due_at ?? t.due_date);
          const late = !!d && d.getTime() < Date.now() && t.status !== "satisfied";
          return (
            <span
              className={late ? "font-medium text-danger" : "text-fg-2"}
              title={fmtDateTime(t.due_at ?? t.due_date)}
            >
              {fmtRelative(t.due_at ?? t.due_date)}
            </span>
          );
        },
      },
    ],
    [],
  );
  return (
    <>
      <div className="mb-3">
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "open", label: "Open" },
            { value: "breached", label: "Breached", count: q.data?.counts.breached },
            { value: "due", label: "Due", count: q.data?.counts.due },
            { value: "armed", label: "Armed", count: q.data?.counts.armed },
            { value: "satisfied", label: "Satisfied" },
          ]}
        />
      </div>
      <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
        <Table
          columns={columns}
          rows={q.data?.timers}
          rowKey={(t) => t.timer_id}
          onRowClick={setSelected}
          loading={q.isLoading}
          empty={{
            icon: "clock",
            title: `No ${status === "open" ? "open" : words(status).toLowerCase()} clocks`,
          }}
        />
      </div>
      {q.error ? (
        <Notice tone="danger" className="mt-3">
          {(q.error as Error).message}
        </Notice>
      ) : null}
      {selected ? (
        <Sheet
          open
          onClose={() => setSelected(null)}
          title={selected.code}
          subtitle={<Pill tone={timerTone(selected.status)}>{words(selected.status)}</Pill>}
        >
          <Rows
            rows={[
              { label: "Due", value: fmtDateTime(selected.due_at ?? selected.due_date) },
              {
                label: "Breached",
                value: selected.breached_at ? fmtDateTime(selected.breached_at) : "—",
              },
              { label: "Severity", value: selected.severity ?? "—" },
              {
                label: "On breach",
                value: selected.breach_role ? roleWord(selected.breach_role) : "—",
              },
              { label: "Loan", value: <LoanLink id={selected.loan_id} /> },
              { label: "Process", value: selected.process ? `§${selected.process}` : "—" },
              { label: "Id", value: selected.timer_id, mono: true },
            ]}
          />
          {selected.note ? <p className="mt-4 text-base text-fg-2">{selected.note}</p> : null}
        </Sheet>
      ) : null}
    </>
  );
}

function Escalations() {
  const { role } = useAuth();
  const [status, setStatus] = useState("open");
  const [selected, setSelected] = useState<Escalation | null>(null);
  const q = useQuery({
    queryKey: ["escalations", role, status],
    queryFn: () =>
      api<{ escalations: Escalation[] }>("/controls/escalations", {
        query: { status, limit: 500 },
      }),
  });
  const columns = useMemo<Column<Escalation>[]>(
    () => [
      {
        key: "kind",
        header: "Escalation",
        primary: true,
        render: (e) => (
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-fg">{words(e.kind)}</span>
            {e.reason ? <span className="text-xs text-fg-3">{e.reason}</span> : null}
          </div>
        ),
      },
      {
        key: "sev",
        header: "Severity",
        render: (e) =>
          e.severity !== null ? (
            <Pill tone={sevTone(e.severity)}>Sev {e.severity}</Pill>
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
      {
        key: "owner",
        header: "Owner",
        render: (e) => <span className="text-fg-2">{roleWord(e.owner_role)}</span>,
      },
      { key: "loan", header: "Loan", render: (e) => <LoanLink id={e.loan_id} /> },
      {
        key: "opened",
        header: "Opened",
        render: (e) => (
          <span className="text-fg-2" title={fmtDateTime(e.opened_at)}>
            {fmtRelative(e.opened_at)}
          </span>
        ),
      },
      {
        key: "status",
        header: "Status",
        render: (e) => (
          <Pill tone={e.status === "open" ? "warn" : "ok"}>
            {words(e.status)}
            {e.disposition ? ` · ${words(e.disposition)}` : ""}
          </Pill>
        ),
      },
    ],
    [],
  );
  return (
    <>
      <div className="mb-3">
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "open", label: "Open" },
            { value: "completed", label: "Completed" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
        <Table
          columns={columns}
          rows={q.data?.escalations}
          rowKey={(e) => e.id}
          onRowClick={setSelected}
          loading={q.isLoading}
          empty={{ icon: "alert", title: "No escalations" }}
        />
      </div>
      {q.error ? (
        <Notice tone="danger" className="mt-3">
          {(q.error as Error).message}
        </Notice>
      ) : null}
      {selected ? <EscalationSheet e={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

function EscalationSheet({ e, onClose }: { e: Escalation; onClose: () => void }) {
  const { role, me } = useAuth();
  const act = useAct({ invalidate: [["escalations"], ["home"]], done: "Completed" });
  const [disposition, setDisposition] = useState(e.dispositions[0] ?? "");
  const [reason, setReason] = useState("");
  const ownerHeld = !!me?.roles.includes(e.owner_role);
  const asOwner = e.owner_role !== role;
  const complete = async () => {
    const ok = await act.run(`/controls/escalations/${e.id}/complete`, {
      body: { disposition, reason },
      role: e.owner_role,
    });
    if (ok) onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={words(e.kind)}
      subtitle={
        <span className="inline-flex gap-2">
          {e.severity !== null ? <Pill tone={sevTone(e.severity)}>Sev {e.severity}</Pill> : null}
          <span>owned by {roleWord(e.owner_role)}</span>
        </span>
      }
      footer={
        e.status === "open" && ownerHeld ? (
          <Button
            variant="primary"
            loading={act.busy}
            disabled={!disposition || !reason.trim()}
            onClick={() => void complete()}
          >
            Complete{asOwner ? ` as ${roleWord(e.owner_role)}` : ""}
          </Button>
        ) : undefined
      }
    >
      <Rows
        rows={[
          { label: "Opened", value: fmtDateTime(e.opened_at) },
          { label: "Loan", value: <LoanLink id={e.loan_id} /> },
          { label: "Status", value: words(e.status) },
          ...(e.completed_at
            ? [
                {
                  label: "Completed",
                  value: `${fmtDateTime(e.completed_at)} · ${words(e.disposition ?? "")}`,
                },
              ]
            : []),
          { label: "Id", value: e.id, mono: true },
        ]}
      />
      {e.payload && Object.keys(e.payload).length ? (
        <pre className="mt-4 overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-fg-2">
          {JSON.stringify(e.payload, null, 2)}
        </pre>
      ) : null}
      {e.status === "open" ? (
        ownerHeld ? (
          <div className="mt-5 space-y-4">
            <Field label="Disposition" htmlFor="disposition">
              <Select
                id="disposition"
                value={disposition}
                onChange={(ev) => setDisposition(ev.target.value)}
              >
                {e.dispositions.map((d) => (
                  <option key={d} value={d}>
                    {words(d)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reason" htmlFor="reason">
              <Textarea id="reason" value={reason} onChange={(ev) => setReason(ev.target.value)} />
            </Field>
          </div>
        ) : (
          <Notice tone="neutral" className="mt-4">
            Only {roleWord(e.owner_role)} can complete this.
          </Notice>
        )
      ) : null}
    </Sheet>
  );
}

function Outbox() {
  const { role } = useAuth();
  const [status, setStatus] = useState("open");
  const act = useAct({ invalidate: [["outbox"], ["home"]], done: "Requeued" });
  const q = useQuery({
    queryKey: ["outbox", role, status],
    queryFn: () =>
      api<{
        messages: Message[];
        by_adapter: { adapter: string; status: string; count: number }[];
      }>("/controls/outbox", { query: { status, limit: 500 } }),
  });
  const tone = (s: string): Tone =>
    s === "dead" || s === "failed"
      ? "danger"
      : s === "queued"
        ? "info"
        : s === "sent" || s === "acked"
          ? "ok"
          : "neutral";
  return (
    <>
      <div className="mb-3">
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "open", label: "Open" },
            { value: "dead", label: "Dead" },
            { value: "failed", label: "Failed" },
            { value: "queued", label: "Queued" },
            { value: "sent", label: "Sent" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
        <Table
          columns={[
            {
              key: "adapter",
              header: "Message",
              primary: true,
              render: (m) => (
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium text-fg">
                    {words(m.adapter)} <span className="text-fg-3">· {m.direction}</span>
                  </span>
                  {m.error ? <span className="truncate text-xs text-danger">{m.error}</span> : null}
                </div>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (m) => <Pill tone={tone(m.status)}>{words(m.status)}</Pill>,
            },
            {
              key: "attempts",
              header: "Attempts",
              align: "right",
              render: (m) => <span className="text-fg-2">{m.attempts}</span>,
            },
            { key: "loan", header: "Loan", render: (m) => <LoanLink id={m.loan_id} /> },
            {
              key: "next",
              header: "Next try",
              render: (m) => (
                <span className="text-fg-2">
                  {m.next_attempt_at ? fmtRelative(m.next_attempt_at) : "—"}
                </span>
              ),
            },
            {
              key: "act",
              header: "",
              align: "right",
              hideOnCard: false,
              render: (m) =>
                m.status === "dead" ? (
                  <Button
                    size="sm"
                    loading={act.busy}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void act.run(`/controls/outbox/${m.id}/requeue`, { body: {} });
                    }}
                    disabled={m.requeues_left === 0}
                  >
                    Requeue{m.requeues_left < 3 ? ` (${m.requeues_left} left)` : ""}
                  </Button>
                ) : null,
            },
          ]}
          rows={q.data?.messages}
          rowKey={(m) => m.id}
          loading={q.isLoading}
          empty={{ icon: "mail-off", title: "Nothing in the outbox" }}
        />
      </div>
      {q.error ? (
        <Notice tone="danger" className="mt-3">
          {(q.error as Error).message}
        </Notice>
      ) : null}
    </>
  );
}

function AiSwitches() {
  const { role, holds } = useAuth();
  const act = useAct({ invalidate: [["ai-controls"]], done: "Recorded" });
  const [reason, setReason] = useState("");
  const q = useQuery({
    queryKey: ["ai-controls", role],
    queryFn: () => api<{ systems: AiSystem[] }>("/controls/ai"),
  });
  const tripped = (s: AiSystem) =>
    !!(s.kill_switch && (s.kill_switch.tripped || s.kill_switch.state === "tripped"));
  return (
    <>
      <Notice tone="neutral" className="mb-3">
        Two people switch an AI system off or on: compliance asks, an admin confirms within ten
        minutes.
      </Notice>
      <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
        <Table
          columns={[
            {
              key: "name",
              header: "System",
              primary: true,
              render: (s) => (
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium text-fg">{s.name}</span>
                  <span className="text-xs text-fg-3">
                    {s.code} · tier {s.risk_tier} · {s.model_version ?? "no model"}
                  </span>
                </div>
              ),
            },
            {
              key: "state",
              header: "State",
              render: (s) => (
                <Pill tone={tripped(s) ? "danger" : "ok"}>{tripped(s) ? "Off" : "On"}</Pill>
              ),
            },
            {
              key: "pending",
              header: "Pending",
              render: (s) => (
                <span className="text-fg-2">
                  {s.pending_request?.request_id
                    ? `Asked · expires ${fmtRelative(s.pending_request.expires_at)}`
                    : "—"}
                </span>
              ),
            },
            {
              key: "act",
              header: "",
              align: "right",
              render: (s) =>
                s.pending_request?.request_id && holds("admin") ? (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={act.busy}
                    onClick={() =>
                      void act.run(`/controls/ai/${s.code}/${tripped(s) ? "reset" : "kill"}`, {
                        body: { request_id: s.pending_request?.request_id },
                        role: "admin",
                      })
                    }
                  >
                    Confirm
                  </Button>
                ) : holds("compliance") ? (
                  <Button
                    size="sm"
                    variant={tripped(s) ? "secondary" : "danger"}
                    loading={act.busy}
                    onClick={() =>
                      void act.run(`/controls/ai/${s.code}/${tripped(s) ? "reset" : "kill"}`, {
                        body: { reason: reason || "operator request" },
                        role: "compliance",
                      })
                    }
                  >
                    {tripped(s) ? "Ask to turn on" : "Ask to turn off"}
                  </Button>
                ) : null,
            },
          ]}
          rows={q.data?.systems}
          rowKey={(s) => s.code}
          loading={q.isLoading}
          empty={{ icon: "sparkles", title: "No AI systems registered" }}
        />
      </div>
      {holds("compliance") ? (
        <Field label="Reason for the next request" htmlFor="ai-reason" className="mt-3 max-w-md">
          <Textarea id="ai-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      ) : null}
      {q.error ? (
        <Notice tone="danger" className="mt-3">
          {(q.error as Error).message}
        </Notice>
      ) : null}
    </>
  );
}
