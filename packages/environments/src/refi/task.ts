/**
 * A refi-review task: one loan as the review sees it, on one day.
 *
 * Version 1 starts from the engine's row — the loan after the tape has been
 * read — rather than from a raw tape line, so it grades the review and not
 * the tape reader. What the model is shown is exactly these inputs; what
 * the review concludes is computed by the grader and never rendered.
 */

import type { CandidateRate, GateFacts, UniverseLoan } from "@hm/refi-review";
import type { PlainDate } from "@hm/kernel/calendar";

export const ENVIRONMENT_NAME = "refi-review";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const ENVIRONMENT_VERSION = "1.0.0";

export type Split = "train" | "heldout" | "spec";

export interface RefiTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly review_date: PlainDate;
  readonly loan: UniverseLoan;
  readonly quote: CandidateRate | null;
  readonly gate_facts: GateFacts;
  readonly exceptions: readonly string[];
}

const plain = (v: unknown): unknown =>
  typeof v === "bigint"
    ? Number(v)
    : Array.isArray(v)
      ? v.map(plain)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
        : v;

/** The inputs as JSON values: cents as integers (every figure here is far below 2^53). */
export function taskPayload(task: RefiTask): Record<string, unknown> {
  return {
    review_date: task.review_date,
    loan: plain(task.loan),
    quote: task.quote
      ? plain({
          note_rate_pct: task.quote.note_rate_pct,
          ...(task.quote.mi_monthly_cents !== undefined
            ? { mi_monthly_cents: task.quote.mi_monthly_cents }
            : {}),
        })
      : null,
    offer_history: plain(task.gate_facts),
    tape_exceptions: [...task.exceptions],
  };
}

export const PAYLOAD_START = "```json";

export function renderTask(task: RefiTask): string {
  return [
    `Review this loan on ${task.review_date}. A null quote means there is no quote today.`,
    "",
    PAYLOAD_START,
    JSON.stringify(taskPayload(task), null, 2),
    "```",
    "",
    "Follow the rulebook, use the tools for every figure, and finish by calling submit_review.",
  ].join("\n");
}

/** The payload back out of a rendered task, for a policy that reads only what a model reads. */
export function payloadOf(rendered: string): Record<string, unknown> {
  const start = rendered.indexOf(PAYLOAD_START);
  const end = rendered.indexOf("```", start + PAYLOAD_START.length);
  if (start < 0 || end < 0) throw new SyntaxError("no JSON payload in the task");
  return JSON.parse(rendered.slice(start + PAYLOAD_START.length, end)) as Record<string, unknown>;
}
