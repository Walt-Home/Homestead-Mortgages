/**
 * A call-qa task: one recorded call, as the QA desk has it the day after.
 *
 * The model gets the call's row (the direction, a person or the AI voice,
 * the outcome, who it was with, whether they were verified, whether a
 * complaint was logged, and the loan's debt-collector and active-duty
 * flags), the transcript the recorder wrote, line by line, the loan's
 * record on the call's day, the facts the dialer held when it dialed (an
 * outbound call only), and the agent's note. It reviews the call against
 * the call rubric (src/calls): every item the call fails, with its line;
 * whether the call fails outright; whether the note matches the record; and
 * the loss-mitigation options the agent named.
 *
 * What the call is drawn from is kept beside it and never rendered: how to
 * rebuild the loan's record on any day (the life book's seed and scenario
 * and the contact center's pins), and what was planted.
 */

import type { Scenario } from "../life/scenario.js";
import type { BankruptcyCase, ProfilePins } from "../contacts/types.js";
import type { CallFacts, CallNote, PreDialFacts, RecordView } from "../calls/index.js";
import { PAYLOAD_START, plain, type Split } from "../refi/task.js";

export const CALL_QA_ENVIRONMENT_NAME = "call-qa";
/** Bump on any change to the rulebook, the tools, the rendering or the generator. */
export const CALL_QA_ENVIRONMENT_VERSION = "1.0.0";

/** A transcript line as the recorder exports it: its number, the time into the call, the channel's label and the words. */
export interface TranscriptLine {
  readonly line: number;
  /** "00:04:17" into the recording. */
  readonly at: string;
  /** "Agent", "Customer" or "IVR" on a stereo recording's channels, or "" for the recorder's own markup. */
  readonly speaker: string;
  readonly text: string;
}

/** How to read the loan's record on any day: rebuild the book and its contact center, or, for a spec case, the records it was written with. */
export type RecordSource =
  | {
      readonly kind: "book";
      readonly seed: string;
      readonly scenario: Scenario;
      readonly pins: ProfilePins;
      /** The call's loan, by its place in the book. */
      readonly loan: number;
      /** A bankruptcy the plant put on the record in place of the contact center's, or null for the center's own. */
      readonly bankruptcy: BankruptcyCase | null;
    }
  | { readonly kind: "fixed"; readonly records: readonly RecordView[] };

export interface CallQaTask {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
  readonly call: CallFacts;
  readonly transcript: readonly TranscriptLine[];
  /** The loan's record on the call's day. */
  readonly record: RecordView;
  readonly pre_dial: PreDialFacts | null;
  readonly note: CallNote | null;
  /** Never rendered: how `record_on` reads another day. */
  readonly source: RecordSource;
  /** Never rendered: the record on the day a copied note was first written, which the grader reads it against. */
  readonly copied_record: RecordView | null;
  /** Never rendered: what the generator planted, by the contact center's id (C-01 to C-08) or ours (Q-01 to Q-14), and the arm. */
  readonly planted: { readonly defect: string; readonly arm: number } | null;
}

export function callQaPayload(task: CallQaTask): Record<string, unknown> {
  return plain({
    call: task.call,
    transcript: task.transcript,
    record: task.record,
    pre_dial: task.pre_dial,
    note: task.note,
  }) as Record<string, unknown>;
}

/** The payload as JSON, each transcript line on a line of its own. */
export function callQaJson(task: CallQaTask): string {
  const p = callQaPayload(task);
  const mark = "__TRANSCRIPT__";
  const lines = (p["transcript"] as unknown[]).map((l) => `    ${JSON.stringify(l)}`).join(",\n");
  return JSON.stringify({ ...p, transcript: mark }, null, 2).replace(
    `"${mark}"`,
    lines ? `[\n${lines}\n  ]` : "[]",
  );
}

export function renderCallQaTask(task: CallQaTask): string {
  return [
    `Review call ${task.call.id} of ${task.call.on} against the call rubric.`,
    "",
    PAYLOAD_START,
    callQaJson(task),
    "```",
    "",
    "Follow the rulebook, use the tools for every time and every other day's record, and finish by calling submit_review.",
  ].join("\n");
}
