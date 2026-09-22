/**
 * The access review (his 34.1): every active account looked at, each one
 * kept, changed or disabled, with a reason, on a clock.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Page, Section } from "../components/Page.js";
import {
  Button,
  Checkbox,
  Field,
  Notice,
  Pill,
  Select,
  Textarea,
  type Tone,
} from "../components/ui.js";
import { api } from "../lib/api.js";
import { useAct } from "../lib/act.js";
import { roleWord, STAFF_ROLES, useAuth } from "../lib/auth.js";
import { fmtDate, fmtDateTime, fmtRelative, words } from "../lib/format.js";
import type { StaffUser } from "./StaffPage.js";

interface Reviews {
  as_of: string;
  reviews: {
    id: string;
    reviewed_by: string;
    reviewed_at: string;
    users: { staff_user_id: string; decision: string; roles_after: string[] }[];
  }[];
  clock: {
    timer_id: string;
    status: string;
    due_at: string | null;
    due_date: string | null;
  } | null;
  active_users: StaffUser[];
}
type Decision = "keep" | "change" | "disable";

export function AccessReviewPage() {
  const { role, holds } = useAuth();
  const q = useQuery({
    queryKey: ["access-reviews", role],
    queryFn: () => api<Reviews>("/staff/access-reviews"),
  });
  const act = useAct({ invalidate: [["access-reviews"], ["staff"]], done: "Review recorded" });
  const [decisions, setDecisions] = useState<
    Record<string, { decision: Decision; roles: string[]; rationale: string }>
  >({});
  const [rationale, setRationale] = useState("");
  useEffect(() => {
    if (!q.data) return;
    setDecisions((d) => {
      const next = { ...d };
      for (const u of q.data.active_users)
        if (!next[u.staff_user_id])
          next[u.staff_user_id] = { decision: "keep", roles: u.roles, rationale: "" };
      return next;
    });
  }, [q.data]);
  const record = async () => {
    await act.run("/staff/access-review", {
      body: {
        decisions: Object.entries(decisions).map(([id, d]) => ({
          staff_user_id: id,
          decision: d.decision,
          roles: d.decision === "change" ? d.roles : undefined,
          rationale: d.rationale || undefined,
        })),
        rationale,
      },
      role: holds("compliance") ? "compliance" : "admin",
    });
  };
  const d = q.data;
  const clockTone: Tone =
    d?.clock?.status === "breached" ? "danger" : d?.clock ? "info" : "neutral";
  return (
    <Page
      title="Access review"
      description="Every active account, looked at and decided on. Recorded with your name."
      meta={
        d?.clock ? (
          <span className="inline-flex items-center gap-2">
            <Pill tone={clockTone}>{words(d.clock.status)}</Pill>next due{" "}
            {fmtRelative(d.clock.due_at ?? d.clock.due_date)}
          </span>
        ) : undefined
      }
      actions={
        <Button
          variant="primary"
          loading={act.busy}
          disabled={!d || !rationale.trim()}
          onClick={() => void record()}
        >
          Record the review
        </Button>
      }
    >
      {q.error ? <Notice tone="danger">{(q.error as Error).message}</Notice> : null}
      {d ? (
        <>
          <Section title="Active accounts">
            <div className="overflow-hidden rounded-lg border border-line-2 bg-surface">
              <ul className="divide-y divide-line">
                {d.active_users.map((u) => {
                  const dec = decisions[u.staff_user_id] ?? {
                    decision: "keep" as Decision,
                    roles: u.roles,
                    rationale: "",
                  };
                  const set = (patch: Partial<typeof dec>) =>
                    setDecisions((x) => ({ ...x, [u.staff_user_id]: { ...dec, ...patch } }));
                  return (
                    <li
                      key={u.staff_user_id}
                      className="grid gap-3 px-4 py-3 md:grid-cols-[1fr_auto] md:items-start"
                    >
                      <div className="min-w-0">
                        <div className="text-base font-medium text-fg">
                          {u.legal_name ?? u.email_masked}
                        </div>
                        <div className="text-sm text-fg-2">
                          {u.roles.map(roleWord).join(", ")} · {u.open_sessions} open session
                          {u.open_sessions === 1 ? "" : "s"} · enrolled{" "}
                          {u.enrolled_at ? fmtDate(u.enrolled_at) : "—"}
                        </div>
                        {dec.decision === "change" ? (
                          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {STAFF_ROLES.map((r) => (
                              <Checkbox
                                key={r}
                                label={roleWord(r)}
                                checked={dec.roles.includes(r)}
                                onChange={(e) =>
                                  set({
                                    roles: e.target.checked
                                      ? [...dec.roles, r]
                                      : dec.roles.filter((x) => x !== r),
                                  })
                                }
                              />
                            ))}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex w-full flex-col gap-2 md:w-56">
                        <Select
                          value={dec.decision}
                          onChange={(e) => set({ decision: e.target.value as Decision })}
                          aria-label="Decision"
                        >
                          <option value="keep">Keep as is</option>
                          <option value="change">Change roles</option>
                          <option value="disable">Disable</option>
                        </Select>
                        {dec.decision !== "keep" ? (
                          <Textarea
                            value={dec.rationale}
                            onChange={(e) => set({ rationale: e.target.value })}
                            placeholder="Why"
                            className="min-h-12"
                          />
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
            <Field label="The review, in a sentence" htmlFor="review-why" className="mt-4 max-w-xl">
              <Textarea
                id="review-why"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                placeholder="Quarterly review; everyone still needs what they hold."
              />
            </Field>
          </Section>
          <Section title="Earlier reviews">
            {d.reviews.length === 0 ? (
              <p className="text-base text-fg-2">None recorded yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line-2 bg-surface">
                {d.reviews.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-4 px-4 py-3 text-base"
                  >
                    <span className="text-fg">{fmtDateTime(r.reviewed_at)}</span>
                    <span className="text-fg-2">
                      {r.users.length} accounts ·{" "}
                      {r.users.filter((u) => u.decision !== "keep").length} changed
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      ) : null}
    </Page>
  );
}
