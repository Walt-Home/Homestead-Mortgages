/**
 * A refi-tape task: the review, starting from the servicer's tape.
 *
 * refi-review gives a model the loan as the review sees it. Here the model
 * gets what the review is actually handed — our record of the loan and the
 * servicer's newest tape observation, the tape's own fields in `facts` — and
 * must read the loan off them first, by the tape reader's rules, before the
 * review's own. That reading is where real books go wrong: dates that come
 * from one of three places, delinquency counted to the tape's own date, the
 * newest of two valuations, a PMI rate in either of two units.
 */

import type { CandidateRate, GateFacts, Observation, ObservedLoan } from "@hm/refi-review";
import type { PlainDate } from "@hm/kernel/calendar";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";

export const TAPE_ENVIRONMENT_NAME = "refi-tape";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const TAPE_ENVIRONMENT_VERSION = "1.0.0";

export interface RefiTapeTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly review_date: PlainDate;
  readonly loan_record: ObservedLoan;
  readonly tape: Observation;
  readonly quote: CandidateRate | null;
  readonly gate_facts: GateFacts;
  readonly exceptions: readonly string[];
}

export function tapePayload(task: RefiTapeTask): Record<string, unknown> {
  return {
    review_date: task.review_date,
    loan_record: plain(task.loan_record),
    tape: plain(task.tape),
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

export function renderTapeTask(task: RefiTapeTask): string {
  return [
    `Review this loan on ${task.review_date}, starting from our record of it and the servicer's newest tape. A null quote means there is no quote today.`,
    "",
    PAYLOAD_START,
    JSON.stringify(tapePayload(task), null, 2),
    "```",
    "",
    "Read the loan off the record and the tape by the rulebook, review it, use the tools for every figure, and finish by calling submit_review.",
  ].join("\n");
}
