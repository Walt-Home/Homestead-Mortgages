/**
 * AI: the borrower conversations the assistant has had, turn by turn, and
 * the agents with their switches.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Page, Section } from "../components/Page.js";
import { Table } from "../components/Table.js";
import { Sheet } from "../components/Sheet.js";
import { Button, Notice, Pill, Rows, Segmented } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAct } from "../lib/act.js";
import { useAuth } from "../lib/auth.js";
import { fmtDateTime, fmtRelative, words } from "../lib/format.js";

interface Turn {
  turn_id: string;
  party_id: string;
  conversation_id: string;
  email_masked: string | null;
  borrower_text: string;
  reply_text: string;
  model_version: string | null;
  tool_calls: unknown[];
  guard_result: string | null;
  safe_classification: string | null;
  latency_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
}
interface Agent {
  agent: string;
  off: boolean;
  why?: string | null;
  tier: string;
  decisionsLast7d: number;
}

export function AiPage() {
  const { role } = useAuth();
  const [tab, setTab] = useState<"conversations" | "agents">("conversations");
  const [selected, setSelected] = useState<Turn | null>(null);
  const turns = useQuery({
    queryKey: ["ai-turns", role],
    queryFn: () => api<{ turns: Turn[] }>("/ai/conversation/recent", { query: { limit: 50 } }),
    enabled: tab === "conversations",
  });
  const agents = useQuery({
    queryKey: ["dashboard", role],
    queryFn: () => api<{ agents: Agent[] }>("/dashboard"),
    enabled: tab === "agents",
  });
  const act = useAct({ invalidate: [["dashboard"]], done: "Recorded" });
  return (
    <Page
      title="AI"
      description="What the assistant said to borrowers, and which agents are on."
      wide
    >
      <Section>
        <Segmented
          label="View"
          value={tab}
          onChange={setTab}
          className="mb-3"
          options={[
            { value: "conversations", label: "Conversations" },
            { value: "agents", label: "Agents" },
          ]}
        />
        <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
          {tab === "conversations" ? (
            <Table
              columns={[
                {
                  key: "who",
                  header: "Borrower",
                  primary: true,
                  render: (t) => (
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-fg">{t.email_masked ?? "—"}</span>
                      <span className="line-clamp-1 text-sm text-fg-2">{t.borrower_text}</span>
                    </div>
                  ),
                },
                {
                  key: "reply",
                  header: "Reply",
                  render: (t) => <span className="line-clamp-2 text-fg-2">{t.reply_text}</span>,
                },
                {
                  key: "guard",
                  header: "Guard",
                  render: (t) => (
                    <Pill
                      tone={
                        t.guard_result === "pass" || t.guard_result === "allowed"
                          ? "ok"
                          : t.guard_result
                            ? "warn"
                            : "neutral"
                      }
                    >
                      {words(t.guard_result ?? "—")}
                    </Pill>
                  ),
                },
                {
                  key: "when",
                  header: "When",
                  render: (t) => (
                    <span className="text-fg-2" title={fmtDateTime(t.created_at)}>
                      {fmtRelative(t.created_at)}
                    </span>
                  ),
                },
              ]}
              rows={turns.data?.turns}
              rowKey={(t) => t.turn_id}
              onRowClick={setSelected}
              loading={turns.isLoading}
              empty={{ icon: "sparkles", title: "No conversations yet" }}
            />
          ) : (
            <ul className="divide-y divide-line">
              {(agents.data?.agents ?? []).map((a) => (
                <li
                  key={a.agent}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="text-base font-medium text-fg">{words(a.agent)}</div>
                    <div className="text-sm text-fg-2">
                      Tier {a.tier} · {a.decisionsLast7d.toLocaleString()} decisions in 7 days
                      {a.off && a.why ? ` · off: ${a.why}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={a.off ? "warn" : "ok"}>{a.off ? "Off" : "On"}</Pill>
                    <Button
                      size="sm"
                      variant={a.off ? "secondary" : "danger"}
                      loading={act.busy}
                      onClick={() =>
                        void act.run("/agents/ai-off", {
                          body: {
                            agent: a.agent,
                            why: a.off ? null : "switched off from the console",
                          },
                        })
                      }
                    >
                      {a.off ? "Turn on" : "Turn off"}
                    </Button>
                  </div>
                </li>
              ))}
              {agents.isLoading ? <li className="px-4 py-6 text-sm text-fg-3">Loading…</li> : null}
            </ul>
          )}
        </div>
        {turns.error || agents.error ? (
          <Notice tone="danger" className="mt-3">
            {((turns.error ?? agents.error) as Error).message}
          </Notice>
        ) : null}
      </Section>
      {selected ? (
        <Sheet
          open
          onClose={() => setSelected(null)}
          title={selected.email_masked ?? "Conversation"}
          subtitle={fmtDateTime(selected.created_at)}
          wide
        >
          <div className="space-y-3">
            <div className="rounded-lg bg-surface-2 p-3 text-base text-fg">
              {selected.borrower_text}
            </div>
            <div className="rounded-lg border border-line-2 p-3 text-base text-fg">
              {selected.reply_text}
            </div>
          </div>
          <div className="mt-5">
            <Rows
              rows={[
                { label: "Guard", value: words(selected.guard_result ?? "—") },
                { label: "Classification", value: words(selected.safe_classification ?? "—") },
                { label: "Model", value: selected.model_version ?? "—", mono: true },
                { label: "Tools called", value: selected.tool_calls.length },
                {
                  label: "Latency",
                  value: selected.latency_ms !== null ? `${selected.latency_ms} ms` : "—",
                },
                {
                  label: "Tokens",
                  value: `${selected.tokens_in ?? "—"} in · ${selected.tokens_out ?? "—"} out`,
                },
              ]}
            />
          </div>
        </Sheet>
      ) : null}
    </Page>
  );
}
