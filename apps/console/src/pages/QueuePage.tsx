/**
 * The queue: what is waiting for the roles you hold, with the clocks that
 * are breached or about to be at the top, because those are the ones that
 * cost money. One list, filtered by kind; a row opens a sheet with the
 * detail and the one act that closes it.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Page, Section } from "../components/Page.js";
import { Table, type Column } from "../components/Table.js";
import { Sheet } from "../components/Sheet.js";
import {
  Button,
  Field,
  Input,
  Notice,
  Pill,
  Rows,
  Segmented,
  Stat,
  type Tone,
} from "../components/ui.js";
import { useAct } from "../lib/act.js";
import { roleWord, useAuth } from "../lib/auth.js";
import { fmtDateTime, fmtRelative, parseTs, shortId, words } from "../lib/format.js";
import {
  KIND_WORD,
  KIND_WORDS,
  QUEUE_KINDS,
  useHome,
  type QueueKind,
  type QueueRow,
} from "../lib/home.js";

const severityTone = (s: QueueRow["severity"]): Tone => {
  const n = typeof s === "number" ? s : Number(String(s ?? "").replace(/\D/g, ""));
  if (Number.isNaN(n) || n === 0) return "neutral";
  return n <= 1 ? "danger" : n === 2 ? "warn" : "neutral";
};
const severityWord = (s: QueueRow["severity"]): string | null => {
  if (s === null || s === undefined || s === "") return null;
  const n = typeof s === "number" ? s : Number(String(s).replace(/\D/g, ""));
  return Number.isNaN(n) ? String(s) : `Sev ${n}`;
};

function Due({ at }: { at: string | null }) {
  if (!at) return <span className="text-fg-3">—</span>;
  const d = parseTs(at);
  const late = !!d && d.getTime() < Date.now();
  return (
    <span className={late ? "font-medium text-danger" : "text-fg"} title={fmtDateTime(at)}>
      {fmtRelative(at)}
    </span>
  );
}

function RowDetail({ detail }: { detail: QueueRow["detail"] }) {
  if (!detail) return null;
  if (typeof detail === "string") return <p className="text-base text-fg-2">{detail}</p>;
  const rows = Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => ({ label: words(k), value: String(v), mono: /id$|_at$/.test(k) }));
  const nested = Object.entries(detail).filter(([, v]) => v && typeof v === "object");
  return (
    <>
      {rows.length ? <Rows rows={rows} /> : null}
      {nested.length ? (
        <pre className="mt-3 overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs text-fg-2">
          {JSON.stringify(Object.fromEntries(nested), null, 2)}
        </pre>
      ) : null}
    </>
  );
}

function RowSheet({ row, onClose }: { row: QueueRow | null; onClose: () => void }) {
  const [evidence, setEvidence] = useState("");
  const [replacement, setReplacement] = useState("");
  const act = useAct({ invalidate: [["home"]], done: "Done" });

  if (!row) return null;
  const kind = row.kind;
  const finish = async () => {
    let ok: unknown = null;
    if (kind === "escalation")
      ok = await act.run("/escalations/complete", {
        body: { id: row.id, evidenceDocumentId: evidence || null },
      });
    else if (kind === "portal_task")
      ok = await act.run("/portal-tasks/complete", {
        body: { id: row.id, evidenceDocumentId: evidence },
      });
    else if (kind === "held_notice")
      ok = await act.run("/notices/supersede", {
        body: { id: row.id, replacementId: replacement },
      });
    else if (kind === "dead_letter")
      ok = await act.run("/outbox/requeue", { body: { id: row.id } });
    if (ok) onClose();
  };

  const action: ReactNode =
    kind === "breached_timer" ? (
      <Link
        to="/oversight/controls?tab=timers"
        className="text-sm font-medium text-fg-2 hover:text-fg"
      >
        Open in Controls
      </Link>
    ) : (
      <>
        {act.actAs.length ? (
          act.actAs.map((r) => (
            <Button key={r} onClick={() => void act.retryAs(r)} loading={act.busy}>
              Do it as {roleWord(r)}
            </Button>
          ))
        ) : (
          <Button
            variant="primary"
            onClick={() => void finish()}
            loading={act.busy}
            disabled={
              (kind === "portal_task" && !evidence) || (kind === "held_notice" && !replacement)
            }
          >
            {kind === "escalation" && "Complete"}
            {kind === "portal_task" && "Mark completed"}
            {kind === "held_notice" && "Supersede"}
            {kind === "dead_letter" && "Requeue"}
          </Button>
        )}
      </>
    );

  return (
    <Sheet
      open
      onClose={onClose}
      title={words(row.title)}
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-2">
          <Pill>{KIND_WORD[kind]}</Pill>
          {severityWord(row.severity) ? (
            <Pill tone={severityTone(row.severity)}>{severityWord(row.severity)}</Pill>
          ) : null}
          <span>needs {roleWord(row.needs)}</span>
        </span>
      }
      footer={action}
    >
      <Rows
        rows={[
          { label: "Opened", value: fmtDateTime(row.opened_at) },
          { label: "Due", value: <Due at={row.due_at} /> },
          {
            label: "Loan",
            value: row.loan_id ? (
              <Link
                to={`/loans/${row.loan_id}`}
                className="font-mono text-sm text-fg underline decoration-line-3 underline-offset-2"
              >
                {shortId(row.loan_id, 12)}
              </Link>
            ) : (
              "—"
            ),
          },
          { label: "Queues", value: row.queue_roles.map(roleWord).join(", ") || "—" },
          { label: "Id", value: row.id, mono: true },
        ]}
      />
      {row.held ? (
        <Notice tone="warn" className="mt-4">
          Held: the role this needs is not staffed, so it waits.
        </Notice>
      ) : null}
      <div className="mt-5">
        <div className="mb-2 text-sm font-medium text-fg">Detail</div>
        <RowDetail detail={row.detail} />
      </div>
      {act.error && act.actAs.length ? (
        <Notice
          tone="warn"
          className="mt-4"
          title={`This needs ${act.actAs.map(roleWord).join(" or ")}`}
        >
          You hold that role. Send it again under it.
        </Notice>
      ) : null}
      {kind === "escalation" || kind === "portal_task" ? (
        <div className="mt-5">
          <Field
            label={
              kind === "portal_task" ? "Evidence document id" : "Evidence document id (optional)"
            }
            htmlFor="evidence"
            hint="The document that shows the work was done."
          >
            <Input
              id="evidence"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
      ) : null}
      {kind === "held_notice" ? (
        <div className="mt-5">
          <Field label="Replacement notice id" htmlFor="replacement">
            <Input
              id="replacement"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
      ) : null}
    </Sheet>
  );
}

export function QueuePage({ kind }: { kind?: QueueKind }) {
  const navigate = useNavigate();
  const { role } = useAuth();
  const home = useHome(kind);
  const [selected, setSelected] = useState<QueueRow | null>(null);
  const data = home.data;
  const rows = data?.my_queue?.rows;

  const columns = useMemo<Column<QueueRow>[]>(
    () => [
      {
        key: "item",
        header: "Item",
        primary: true,
        render: (r) => (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate font-medium text-fg">{words(r.title)}</span>
            <span className="flex flex-wrap items-center gap-1.5">
              {!kind ? <Pill>{KIND_WORD[r.kind]}</Pill> : null}
              {severityWord(r.severity) ? (
                <Pill tone={severityTone(r.severity)}>{severityWord(r.severity)}</Pill>
              ) : null}
              {r.held ? <Pill tone="warn">Held</Pill> : null}
            </span>
          </div>
        ),
      },
      {
        key: "needs",
        header: "Needs",
        render: (r) => <span className="text-fg-2">{roleWord(r.needs)}</span>,
        width: "w-36",
      },
      {
        key: "loan",
        header: "Loan",
        mono: true,
        width: "w-32",
        render: (r) =>
          r.loan_id ? (
            <Link
              to={`/loans/${r.loan_id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-fg-2 hover:text-fg hover:underline"
            >
              {shortId(r.loan_id)}
            </Link>
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
      {
        key: "opened",
        header: "Opened",
        width: "w-32",
        render: (r) => (
          <span className="text-fg-2" title={fmtDateTime(r.opened_at)}>
            {fmtRelative(r.opened_at)}
          </span>
        ),
      },
      { key: "due", header: "Due", width: "w-28", render: (r) => <Due at={r.due_at} /> },
    ],
    [kind],
  );

  const title = kind ? KIND_WORDS[kind] : "Queue";
  const counts = data?.my_queue?.by_kind;

  return (
    <Page
      title={title}
      meta={
        data ? (
          <>
            As of {fmtDateTime(data.as_of)} · acting as {roleWord(data.acted_as || role || "")}
          </>
        ) : null
      }
      wide
    >
      {!kind && data ? (
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat
            label="Breached clocks"
            value={data.clocks?.counts.breached ?? "—"}
            tone={data.clocks?.counts.breached ? "danger" : undefined}
            onClick={() => navigate("/work/breached_timer")}
          />
          <Stat
            label="Due in 24 hours"
            value={data.clocks?.counts.due_24h ?? "—"}
            tone={data.clocks?.counts.due_24h ? "warn" : undefined}
            onClick={() => navigate("/oversight/controls?tab=timers&status=due")}
          />
          <Stat
            label="Open escalations"
            value={data.escalations?.open ?? "—"}
            onClick={() => navigate("/work/escalation")}
          />
          <Stat
            label="Portal tasks"
            value={data.counts?.portal_tasks ?? "—"}
            onClick={() => navigate("/work/portal_task")}
          />
          <Stat
            label="Held notices"
            value={data.counts?.held_notices ?? "—"}
            onClick={() => navigate("/work/held_notice")}
          />
          <Stat
            label="Dead letters"
            value={data.counts?.dead_letters ?? "—"}
            onClick={() => navigate("/work/dead_letter")}
          />
        </div>
      ) : null}

      <Section
        title={kind ? undefined : "Waiting for you"}
        aside={
          rows
            ? `${rows.length.toLocaleString()} of ${(data?.my_queue?.count ?? rows.length).toLocaleString()}`
            : undefined
        }
      >
        {!kind ? (
          <div className="mb-3">
            <Segmented
              label="Kind"
              value={"all"}
              onChange={(v) => (v === "all" ? undefined : navigate(`/work/${v}`))}
              options={[
                { value: "all", label: "Everything", count: data?.my_queue?.count },
                ...QUEUE_KINDS.map((k) => ({ value: k, label: KIND_WORDS[k], count: counts?.[k] })),
              ]}
            />
          </div>
        ) : (
          <div className="mb-3">
            <Segmented
              label="Kind"
              value={kind}
              onChange={(v) => navigate(v === "all" ? "/" : `/work/${v}`)}
              options={[
                { value: "all" as string, label: "Everything" },
                ...QUEUE_KINDS.map((k) => ({
                  value: k as string,
                  label: KIND_WORDS[k],
                  count: counts?.[k],
                })),
              ]}
            />
          </div>
        )}
        <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
          <Table
            columns={columns}
            rows={rows}
            rowKey={(r) => `${r.kind}:${r.id}`}
            onRowClick={setSelected}
            loading={home.isLoading}
            empty={{
              icon: "check",
              title: kind
                ? `No ${KIND_WORDS[kind].toLowerCase()} waiting`
                : "Nothing waiting for you",
              body: "New work lands here as the sweep opens it.",
            }}
          />
        </div>
        {home.error ? (
          <Notice tone="danger" className="mt-3">
            {String((home.error as Error).message)}
          </Notice>
        ) : null}
      </Section>

      {selected ? <RowSheet row={selected} onClose={() => setSelected(null)} /> : null}
    </Page>
  );
}
