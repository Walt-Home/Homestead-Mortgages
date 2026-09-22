/**
 * Work items (his 35.8): one item per source, claimed and closed here.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
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
  Select,
  Textarea,
  type Tone,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAct } from "../lib/act.js";
import { roleWord, useAuth } from "../lib/auth.js";
import { fmtDateTime, fmtRelative, shortId, words } from "../lib/format.js";

interface WorkItem {
  id: string;
  screen_code: string;
  subject_kind: string;
  subject_id: string;
  required_role: string;
  status: string;
  reason?: string | null;
  opened_at?: string;
  created_at?: string;
  claimed_by?: string | null;
  claimed_by_name?: string | null;
  claim_expires_at?: string | null;
  closed_at?: string | null;
  disposition?: string | null;
  [k: string]: unknown;
}

const STATUSES = ["open", "claimed", "waiting_approval", "closed", "cancelled"] as const;
const statusTone = (s: string): Tone =>
  s === "open"
    ? "info"
    : s === "claimed"
      ? "warn"
      : s === "waiting_approval"
        ? "accent"
        : s === "closed"
          ? "ok"
          : "neutral";

export function WorkItemsPage() {
  const { role, me } = useAuth();
  const [status, setStatus] = useState<string>("open");
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const q = useQuery({
    queryKey: ["work", role, status],
    queryFn: () =>
      api<{ items: WorkItem[]; total: number }>("/work/queue", {
        query: { status: status === "all" ? undefined : status, page_size: 200 },
      }),
  });
  const columns = useMemo<Column<WorkItem>[]>(
    () => [
      {
        key: "screen",
        header: "Screen",
        primary: true,
        render: (r) => (
          <div className="flex flex-col gap-1">
            <span className="font-medium text-fg">{words(r.screen_code)}</span>
            <span className="text-xs text-fg-3">{r.reason ?? ""}</span>
          </div>
        ),
      },
      {
        key: "subject",
        header: "Subject",
        mono: true,
        render: (r) =>
          r.subject_kind === "loan" ? (
            <Link
              to={`/loans/${r.subject_id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-fg-2 hover:text-fg hover:underline"
            >
              {words(r.subject_kind)} {shortId(r.subject_id)}
            </Link>
          ) : (
            <span className="text-fg-2">
              {words(r.subject_kind)} {shortId(r.subject_id)}
            </span>
          ),
      },
      {
        key: "role",
        header: "Needs",
        render: (r) => <span className="text-fg-2">{roleWord(r.required_role)}</span>,
      },
      {
        key: "status",
        header: "Status",
        render: (r) => <Pill tone={statusTone(r.status)}>{words(r.status)}</Pill>,
      },
      {
        key: "opened",
        header: "Opened",
        render: (r) => (
          <span className="text-fg-2" title={fmtDateTime(r.opened_at ?? r.created_at)}>
            {fmtRelative(r.opened_at ?? r.created_at)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <Page
      title="Work items"
      description="One item per source. Claim it, do the work on its screen, close it with a disposition."
    >
      <Section>
        <div className="mb-3">
          <Segmented
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              ...STATUSES.map((s) => ({ value: s as string, label: words(s) })),
              { value: "all", label: "All" },
            ]}
          />
        </div>
        <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
          <Table
            columns={columns}
            rows={q.data?.items}
            rowKey={(r) => r.id}
            onRowClick={setSelected}
            loading={q.isLoading}
            empty={{
              title: `No ${status === "all" ? "" : words(status).toLowerCase() + " "}work items`,
            }}
          />
        </div>
        {q.error ? (
          <Notice tone="danger" className="mt-3">
            {(q.error as Error).message}
          </Notice>
        ) : null}
      </Section>
      {selected ? (
        <ItemSheet
          item={selected}
          onClose={() => setSelected(null)}
          mine={me?.staff_user_id ?? null}
        />
      ) : null}
    </Page>
  );
}

function ItemSheet({
  item,
  onClose,
  mine,
}: {
  item: WorkItem;
  onClose: () => void;
  mine: string | null;
}) {
  const act = useAct({ invalidate: [["work"], ["home"]], done: "Done" });
  const [disposition, setDisposition] = useState("done");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [closing, setClosing] = useState(false);
  const claimedByMe = item.claimed_by === mine;
  const go = async (path: string, body: unknown) => {
    if (await act.run(path, { body })) onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={words(item.screen_code)}
      subtitle={<Pill tone={statusTone(item.status)}>{words(item.status)}</Pill>}
      footer={
        act.actAs.length ? (
          act.actAs.map((r) => (
            <Button key={r} onClick={() => void act.retryAs(r)} loading={act.busy}>
              Do it as {roleWord(r)}
            </Button>
          ))
        ) : closing ? (
          <>
            <Button variant="ghost" onClick={() => setClosing(false)}>
              Back
            </Button>
            <Button
              variant="primary"
              loading={act.busy}
              disabled={!reason.trim()}
              onClick={() =>
                void go(`/work/items/${item.id}/close`, {
                  disposition,
                  reason,
                  evidence_document_id: evidence || undefined,
                })
              }
            >
              Close item
            </Button>
          </>
        ) : (
          <>
            {item.status === "open" ? (
              <Button
                variant="primary"
                loading={act.busy}
                onClick={() => void go(`/work/items/${item.id}/claim`, {})}
              >
                Claim
              </Button>
            ) : null}
            {item.status === "claimed" && claimedByMe ? (
              <>
                <Button
                  loading={act.busy}
                  onClick={() => void go(`/work/items/${item.id}/release`, {})}
                >
                  Release
                </Button>
                <Button variant="primary" onClick={() => setClosing(true)}>
                  Close…
                </Button>
              </>
            ) : null}
          </>
        )
      }
    >
      <Rows
        rows={[
          { label: "Subject", value: `${words(item.subject_kind)} ${item.subject_id}`, mono: true },
          { label: "Needs", value: roleWord(item.required_role) },
          { label: "Opened", value: fmtDateTime(item.opened_at ?? item.created_at) },
          {
            label: "Claimed by",
            value: item.claimed_by_name ?? (item.claimed_by ? shortId(item.claimed_by) : "—"),
          },
          { label: "Reason", value: item.reason ?? "—" },
          { label: "Id", value: item.id, mono: true },
        ]}
      />
      {act.error && act.actAs.length ? (
        <Notice
          tone="warn"
          className="mt-4"
          title={`This needs ${act.actAs.map(roleWord).join(" or ")}`}
        >
          You hold that role. Send it again under it.
        </Notice>
      ) : null}
      {closing ? (
        <div className="mt-5 space-y-4">
          <Field label="Disposition" htmlFor="disposition">
            <Select
              id="disposition"
              value={disposition}
              onChange={(e) => setDisposition(e.target.value)}
            >
              <option value="done">Done</option>
              <option value="no_action">No action needed</option>
              <option value="handed_off">Handed off</option>
            </Select>
          </Field>
          <Field label="Reason" htmlFor="reason">
            <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Evidence document id (optional)" htmlFor="evidence">
            <Input
              id="evidence"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
      ) : null}
    </Sheet>
  );
}
