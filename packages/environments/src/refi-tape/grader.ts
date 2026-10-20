/**
 * The grader is the engine twice over: the tape reader, then the review.
 *
 * `universeLoanOf` reads the record and the tape into the review's row
 * exactly as the daily review does in production; `reviewLoan` reviews it.
 * A tape the reader cannot describe is "not_reviewable", with the reason the
 * reader gives. The comparison is refi-review's, field for field.
 */

import { reviewLoan, universeLoanOf } from "@hm/refi-review";
import type { Grade, Parsed } from "../episode.js";
import {
  expectedAnswer,
  gradeAgainst,
  parseSubmission,
  type RefiAnswer,
  type RefiVerdict,
} from "../refi/grader.js";
import type { RefiTapeTask } from "./task.js";

export const TAPE_VERDICTS: readonly RefiVerdict[] = [
  "candidate",
  "watching",
  "not_now",
  "excluded",
  "not_reviewable",
];

/** The tape reader's reason for a row it cannot build, as the rulebook's code. */
export function skipReason(message: string): string {
  if (/first_payment/i.test(message)) return "no_first_payment_date";
  if (/UPB/i.test(message)) return "no_upb";
  if (/value/i.test(message)) return "no_value";
  return "unreadable";
}

export function expectedTapeAnswer(task: RefiTapeTask): RefiAnswer {
  const read = universeLoanOf(task.loan_record, task.tape, task.review_date);
  if ("skipped" in read) {
    return {
      verdict: "not_reviewable",
      reasons: [skipReason(read.skipped)],
      offer: null,
      watch_rate_pct: null,
    };
  }
  return expectedAnswer(
    reviewLoan(read.row, {
      as_of: task.review_date,
      rate: task.quote,
      gate_facts: task.gate_facts,
      exceptions: task.exceptions,
    }),
  );
}

export const gradeTapeAnswer = (task: RefiTapeTask, answer: RefiAnswer | null): Grade =>
  gradeAgainst(expectedTapeAnswer(task), answer);

export const parseTapeSubmission = (raw: unknown): Parsed<RefiAnswer> =>
  parseSubmission(raw, TAPE_VERDICTS);
