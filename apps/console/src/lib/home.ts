/**
 * `/portal/home`: the counts the whole console hangs off, and the queue.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";
import { useAuth } from "./auth.js";

export const QUEUE_KINDS = [
  "escalation",
  "portal_task",
  "held_notice",
  "dead_letter",
  "breached_timer",
] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

export const KIND_WORDS: Record<QueueKind, string> = {
  escalation: "Escalations",
  portal_task: "Portal tasks",
  held_notice: "Held notices",
  dead_letter: "Dead letters",
  breached_timer: "Breached timers",
};
export const KIND_WORD: Record<QueueKind, string> = {
  escalation: "Escalation",
  portal_task: "Portal task",
  held_notice: "Held notice",
  dead_letter: "Dead letter",
  breached_timer: "Breached timer",
};

export interface QueueRow {
  id: string;
  kind: QueueKind;
  title: string;
  needs: string;
  held: boolean;
  queue_roles: string[];
  loan_id: string | null;
  severity: number | string | null;
  opened_at: string;
  due_at: string | null;
  fake_reviewer?: unknown;
  detail: Record<string, unknown> | string | null;
}

export interface ClockRow {
  timer_id: string;
  code: string;
  status: string;
  subject_kind: string;
  subject_id: string;
  loan_id: string | null;
  application_id: string | null;
  due_at: string | null;
  due_date: string | null;
  breached_at: string | null;
  breach_role: string | null;
  severity: number | null;
  process: string | null;
}

export interface Home {
  as_of: string;
  acted_as: string;
  roles: string[];
  ops_roles: string[];
  kind: QueueKind | null;
  clocks: {
    due_24h: ClockRow[];
    breached: ClockRow[];
    counts: { due_24h: number; breached: number };
  } | null;
  escalations: { open_by_role: Record<string, number>; open: number } | null;
  my_queue: {
    title: string;
    rows: QueueRow[];
    count: number;
    by_kind: Record<QueueKind, number>;
    by_role: Record<string, number>;
  } | null;
  counts: { dead_letters: number; held_notices: number; portal_tasks: number } | null;
  admin: { tiles: { code: string; label: string; path: string; detail: string }[] } | null;
}

export function useHome(kind?: QueueKind) {
  const { role, status } = useAuth();
  return useQuery({
    queryKey: ["home", role, kind ?? null],
    queryFn: () => api<Home>("/portal/home", { query: { kind } }),
    enabled: status === "signed-in",
  });
}
