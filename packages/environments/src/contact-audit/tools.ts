/**
 * The tools: the comment log, a call's transcript, a search of every
 * transcript in the window, the promise log, the complaint log, the payments,
 * and refi's exact-decimal calculator. None of them compares two records or
 * names an error: a search returns the lines that say a phrase, whatever the
 * phrase is, and a log is the log. Putting them together is the task.
 *
 * Every tool but the calculator reads the task's own material, which the
 * episode loop hands a tool (episode.ts).
 */

import type { ToolSpec } from "../episode.js";
import { says } from "../calls/index.js";
import { STAFF_ERROR_IDS, STAFF_SYMPTOMS } from "../contacts/index.js";
import { TOOLS, executeTool } from "../refi/tools.js";
import type { ContactAuditTask } from "./task.js";

export const CONTACT_AUDIT_SUBMIT_TOOL = "submit_audit";

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const orNull = (schema: unknown) => ({ anyOf: [schema, { type: "null" }] });
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

export const CONTACT_AUDIT_TOOLS: readonly ToolSpec[] = [
  {
    name: "read_notes",
    description:
      "The comment log's lines in the window, oldest first: each line's id, day, time, user, area code, text and the contact it belongs to (null for the history's own events). Optionally only the lines of one contact, or of the days from and to (both included).",
    input_schema: object({ contact: { type: "string" }, from: DATE, to: DATE }, []),
  },
  {
    name: "read_transcript",
    description:
      "One recorded call's transcript as the recorder exports it: each line's number, its time into the recording, the speaker's label and the recognizer's text.",
    input_schema: object({ contact: { type: "string" } }),
  },
  {
    name: "search_transcripts",
    description:
      "The transcript lines, across every recorded call in the window, that say each phrase: its words in order and next to each other, as whole words, ignoring case and treating every character but a letter, a digit or an apostrophe as a space. Each match gives the call's id, the line's number, its speaker's label and its text. Optionally only one speaker label's lines.",
    input_schema: object(
      {
        phrases: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 60,
        },
        speaker: {
          type: "string",
          description: 'A speaker label ("Agent", "Customer", "IVR", "Speaker 1", …), or "any".',
        },
      },
      ["phrases"],
    ),
  },
  {
    name: "read_promises",
    description:
      "The promise log: every promise made in the window, as it stood at the window's end (its id, the contact that recorded it, the day it was made, its pay-by date, its amount and its status).",
    input_schema: object({}, []),
  },
  {
    name: "read_complaints",
    description:
      "The complaint log: every case received in the window, as it stood at the window's end (its id, the contact it was logged on, the day received, the channel, the category, the acknowledgment, the day a response was due, and the day the written response was mailed, null while none has been).",
    input_schema: object({}, []),
  },
  {
    name: "read_payments",
    description:
      "The payments received in the window, oldest first: each one's id, the day it was received, its amount, the installments it paid by due date, and what went to suspense. Optionally only the days from and to (both included).",
    input_schema: object({ from: DATE, to: DATE }, []),
  },
  ...TOOLS.filter((t) => t.name === "calculate"),
  {
    name: CONTACT_AUDIT_SUBMIT_TOOL,
    description:
      "Submit the audit: every staff error's root and every symptom, each once. An empty list says the window holds no staff error. A valid submission ends the task.",
    input_schema: object({
      findings: {
        type: "array",
        items: object({
          error: { type: "string", enum: [...STAFF_ERROR_IDS] },
          kind: { type: "string", enum: ["root", ...STAFF_SYMPTOMS] },
          contact: { type: "string" },
          promise: orNull(
            object({
              amount: { type: "string", description: "Dollars and cents: 1234.56 or $1,234.56." },
              pay_by: DATE,
            }),
          ),
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
const optDate = (o: Record<string, unknown>, k: string): string | null => {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))
    throw new TypeError(`${k} must be a date, YYYY-MM-DD`);
  return v;
};
const inDays = (on: string, from: string | null, to: string | null) =>
  (from === null || on >= from) && (to === null || on <= to);

export function executeContactAuditTool(
  name: string,
  raw: unknown,
  task?: ContactAuditTask,
): string {
  const i = obj(raw);
  if (name === "calculate") return executeTool(name, i);
  const known = CONTACT_AUDIT_TOOLS.some(
    (t) => t.name === name && name !== CONTACT_AUDIT_SUBMIT_TOOL,
  );
  if (!known)
    throw new TypeError(
      `no tool named ${JSON.stringify(name)}; the tools are ${CONTACT_AUDIT_TOOLS.map((t) => t.name).join(", ")}`,
    );
  if (!task) throw new Error(`${name} reads the task's loan, and none was given`);
  switch (name) {
    case "read_notes": {
      const contact = i["contact"];
      if (contact !== undefined && (typeof contact !== "string" || !contact))
        throw new TypeError("contact must be a contact id");
      const from = optDate(i, "from");
      const to = optDate(i, "to");
      return JSON.stringify({
        notes: task.notes.filter(
          (n) => (contact === undefined || n.contact === contact) && inDays(n.on, from, to),
        ),
      });
    }
    case "read_transcript": {
      const id = i["contact"];
      if (typeof id !== "string" || !id) throw new TypeError("contact must be a contact id");
      const lines = task.transcripts[id];
      if (!lines) {
        const c = task.contacts.find((x) => x.id === id);
        throw new RangeError(
          c ? `${id} was not recorded: it has no transcript` : `no contact ${id} in the window`,
        );
      }
      return JSON.stringify({ contact: id, lines });
    }
    case "search_transcripts": {
      const phrases = i["phrases"];
      if (
        !Array.isArray(phrases) ||
        !phrases.length ||
        phrases.some((p) => typeof p !== "string" || !p.trim())
      )
        throw new TypeError("phrases must be a list of words to look for");
      const who = i["speaker"] ?? "any";
      if (typeof who !== "string" || !who) throw new TypeError("speaker is a label, or any");
      const calls = task.contacts.filter((c) => task.transcripts[c.id]);
      return JSON.stringify({
        matches: (phrases as string[]).map((phrase) => ({
          phrase,
          lines: calls.flatMap((c) =>
            task.transcripts[c.id]!.filter(
              (l) => (who === "any" || l.speaker === who) && says(l.text, phrase),
            ).map((l) => ({ contact: c.id, line: l.line, speaker: l.speaker, text: l.text })),
          ),
        })),
      });
    }
    case "read_promises":
      return JSON.stringify({ promises: task.promises });
    case "read_complaints":
      return JSON.stringify({ complaints: task.complaints });
    case "read_payments": {
      const from = optDate(i, "from");
      const to = optDate(i, "to");
      return JSON.stringify({ payments: task.payments.filter((p) => inDays(p.on, from, to)) });
    }
    default:
      throw new TypeError(`no tool named ${JSON.stringify(name)}`);
  }
}
