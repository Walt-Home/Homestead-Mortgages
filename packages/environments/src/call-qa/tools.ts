/**
 * The tools: a search of the call's transcript for phrases, the loan's record
 * on another day, the time of an instant in a zone, and the minutes between
 * two instants. None of them reads a rule: a search returns the lines that
 * say a phrase, whatever the phrase is, and the record is the record. Putting
 * them together into findings is the task.
 *
 * The first two read the task's own material, which the episode loop hands
 * a tool (episode.ts); the last two are pure.
 */

import { plainDate } from "@hm/kernel/calendar";
import type { ToolSpec } from "../episode.js";
import { OPTIONS, RUBRIC_ITEMS, localTime, says, type RecordView } from "../calls/index.js";
import type { CallQaTask } from "./task.js";
import { rebuild, recordView } from "./view.js";

export const CALL_QA_SUBMIT_TOOL = "submit_review";

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const INSTANT = {
  type: "string",
  description: "An ISO 8601 instant, as the task writes them: 2026-11-17T15:04:00.000Z.",
};

export const CALL_QA_TOOLS: readonly ToolSpec[] = [
  {
    name: "search_transcript",
    description:
      "The transcript lines that say each phrase: its words in order and next to each other, as whole words, ignoring case and treating every character but a letter, a digit or an apostrophe as a space. Optionally only one speaker's lines.",
    input_schema: object(
      {
        phrases: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 60,
        },
        speaker: { type: "string", enum: ["Agent", "Customer", "IVR", "any"] },
      },
      ["phrases"],
    ),
  },
  {
    name: "record_on",
    description:
      "The loan's record at the end of a day on or before the call's, in the shape the task's record has.",
    input_schema: object({ date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }),
  },
  {
    name: "local_time",
    description:
      "The date and the wall-clock time (HH:MM, 24-hour) of an instant in an IANA time zone.",
    input_schema: object({ instant: INSTANT, time_zone: { type: "string" } }),
  },
  {
    name: "minutes_between",
    description:
      "Whole minutes from one instant to another: to minus from, negative when to is earlier.",
    input_schema: object({ from: INSTANT, to: INSTANT }),
  },
  {
    name: CALL_QA_SUBMIT_TOOL,
    description:
      "Submit the review. Call it once, when every rule has been read. A valid submission ends the task.",
    input_schema: object({
      findings: {
        type: "array",
        items: object({
          item: { type: "string", enum: [...RUBRIC_ITEMS] },
          line: orNull({ type: "integer", minimum: 1 }),
        }),
      },
      fails_outright: { type: "boolean" },
      note: orNull(
        object({
          matches: { type: "boolean" },
          contradictions: { type: "array", items: { type: "string" } },
        }),
      ),
      options_told: {
        type: "array",
        items: object({
          option: { type: "string", enum: [...OPTIONS] },
          line: { type: "integer", minimum: 1 },
        }),
      },
    }),
  },
];

const obj = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new TypeError("the input is an object");
  return raw as Record<string, unknown>;
};
const str = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v !== "string" || !v) throw new TypeError(`${k} must be a string`);
  return v;
};
const instant = (o: Record<string, unknown>, k: string): number => {
  const s = str(o, k);
  const ms = Date.parse(s);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s) || Number.isNaN(ms))
    throw new RangeError(`${k} is not an ISO 8601 instant: ${s}`);
  return ms;
};

/** The record on `date`, read the way the task's was. */
export function recordFor(task: CallQaTask, date: string): RecordView {
  const d = plainDate(date);
  if (d > task.call.on)
    throw new RangeError(`the record is read on or before the call's day, ${task.call.on}`);
  const src = task.source;
  if (src.kind === "fixed") {
    const r = src.records.find((x) => x.on === d);
    if (!r)
      throw new RangeError(
        `this case keeps the record of ${src.records.map((x) => x.on).join(", ")} only`,
      );
    return r;
  }
  const { book, center } = rebuild(src.seed, src.scenario, src.pins);
  const life = book.loans[src.loan]!;
  const loan = center.loans[src.loan]!;
  if (d < life.draw.note_date)
    throw new RangeError(`the loan's record begins ${life.draw.note_date}`);
  return recordView(life, loan, d, src.bankruptcy ?? loan.bankruptcy);
}

export function executeCallQaTool(name: string, raw: unknown, task?: CallQaTask): string {
  const i = obj(raw);
  switch (name) {
    case "search_transcript": {
      if (!task)
        throw new Error("search_transcript reads the task's transcript, and none was given");
      const phrases = i["phrases"];
      if (
        !Array.isArray(phrases) ||
        !phrases.length ||
        phrases.some((p) => typeof p !== "string" || !p.trim())
      )
        throw new TypeError("phrases must be a list of words to look for");
      const who = i["speaker"] ?? "any";
      if (!["Agent", "Customer", "IVR", "any"].includes(String(who)))
        throw new TypeError("speaker is Agent, Customer, IVR or any");
      const lines = task.transcript.filter((l) => who === "any" || l.speaker === who);
      return JSON.stringify({
        matches: (phrases as string[]).map((phrase) => ({
          phrase,
          lines: lines
            .filter((l) => says(l.text, phrase))
            .map((l) => ({ line: l.line, speaker: l.speaker, text: l.text })),
        })),
      });
    }
    case "record_on": {
      if (!task) throw new Error("record_on reads the task's loan, and none was given");
      return JSON.stringify({ record: recordFor(task, str(i, "date")) });
    }
    case "local_time": {
      const ms = instant(i, "instant");
      const zone = str(i, "time_zone");
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
      } catch {
        throw new RangeError(`no time zone ${zone}`);
      }
      return JSON.stringify(localTime(new Date(ms).toISOString(), zone));
    }
    case "minutes_between": {
      const from = instant(i, "from");
      const to = instant(i, "to");
      return JSON.stringify({ minutes: Math.round((to - from) / 60_000) });
    }
    default:
      throw new TypeError(
        `no tool named ${JSON.stringify(name)}; the tools are ${CALL_QA_TOOLS.map((t) => t.name).join(", ")}`,
      );
  }
}
