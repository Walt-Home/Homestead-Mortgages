/**
 * Compliance: the clocks, the queues and the notices at a glance, and which
 * AI paths are switched off.
 */

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Page, Section } from "../components/Page.js";
import { Notice, Pill, Rows, Stat } from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { fmtDateTime, words } from "../lib/format.js";

interface Dashboard {
  asOf: string;
  timers: {
    armed: number;
    breached: number;
    dueNext24h: number;
    breachedBySeverity: Record<string, number>;
    breachedBySection: Record<string, number>;
  };
  queues: Record<string, number>;
  notices: { held: number; sentLast7d: number; returnedLast7d: number };
  agents: {
    agent: string;
    off: boolean;
    why?: string | null;
    tier: string;
    decisionsLast7d: number;
  }[];
}

export function CompliancePage() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["dashboard", role],
    queryFn: () => api<Dashboard>("/dashboard"),
  });
  const d = q.data;
  return (
    <Page title="Compliance" meta={d ? `As of ${fmtDateTime(d.asOf)}` : undefined} wide>
      {q.error ? <Notice tone="danger">{(q.error as Error).message}</Notice> : null}
      {d ? (
        <>
          <Section title="Clocks">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat
                label="Breached"
                value={d.timers.breached}
                tone={d.timers.breached ? "danger" : undefined}
                onClick={() => navigate("/oversight/controls?tab=timers&status=breached")}
              />
              <Stat
                label="Due in 24 hours"
                value={d.timers.dueNext24h}
                tone={d.timers.dueNext24h ? "warn" : undefined}
                onClick={() => navigate("/oversight/controls?tab=timers&status=due")}
              />
              <Stat
                label="Armed"
                value={d.timers.armed}
                onClick={() => navigate("/oversight/controls?tab=timers")}
              />
            </div>
            {Object.keys(d.timers.breachedBySeverity).length ||
            Object.keys(d.timers.breachedBySection).length ? (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border border-line-2 bg-surface p-4">
                  <div className="mb-1 text-sm font-medium text-fg">Breached, by severity</div>
                  <Rows
                    rows={Object.entries(d.timers.breachedBySeverity)
                      .sort()
                      .map(([k, v]) => ({ label: words(k), value: v.toLocaleString() }))}
                  />
                </div>
                <div className="rounded-lg border border-line-2 bg-surface p-4">
                  <div className="mb-1 text-sm font-medium text-fg">Breached, by section</div>
                  <Rows
                    rows={Object.entries(d.timers.breachedBySection)
                      .sort((a, b) => b[1] - a[1])
                      .map(([k, v]) => ({ label: `§${k}`, value: v.toLocaleString() }))}
                  />
                </div>
              </div>
            ) : null}
          </Section>
          <Section title="Queues and notices">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Object.entries(d.queues).map(([k, v]) => (
                <Stat key={k} label={words(k)} value={v} onClick={() => navigate(`/work/${k}`)} />
              ))}
              <Stat
                label="Notices held"
                value={d.notices.held}
                tone={d.notices.held ? "warn" : undefined}
                onClick={() => navigate("/work/held_notice")}
              />
              <Stat label="Sent, 7 days" value={d.notices.sentLast7d} />
              <Stat
                label="Returned, 7 days"
                value={d.notices.returnedLast7d}
                tone={d.notices.returnedLast7d ? "warn" : undefined}
              />
            </div>
          </Section>
          <Section title="AI paths">
            <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
              <ul className="divide-y divide-line">
                {d.agents.map((a) => (
                  <li key={a.agent} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-base font-medium text-fg">{words(a.agent)}</div>
                      <div className="text-sm text-fg-2">
                        Tier {a.tier} · {a.decisionsLast7d.toLocaleString()} decisions in 7 days
                        {a.off && a.why ? ` · off: ${a.why}` : ""}
                      </div>
                    </div>
                    <Pill tone={a.off ? "warn" : "ok"}>{a.off ? "Off" : "On"}</Pill>
                  </li>
                ))}
              </ul>
            </div>
          </Section>
        </>
      ) : null}
    </Page>
  );
}
