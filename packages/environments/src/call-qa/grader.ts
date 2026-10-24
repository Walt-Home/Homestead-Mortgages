/**
 * The grade: the call rubric (src/calls) run over the task as the reviewer
 * reads it (the channel labels and the recognizer's text), every item it
 * finds a field with its lines, and the call's outright fail, its note and
 * the options told fields of their own. An item neither the rubric nor the
 * answer names is not a field, so naming nothing is never cheaper than
 * naming what is there, and naming what is not there costs a field.
 */

import type { FieldGrade, Grade, Parsed } from "../episode.js";
import {
  AUTOMATIC_FAILS,
  OPTIONS,
  RUBRIC_ITEMS,
  reviewCall,
  type CallReview,
  type OptionName,
  type RubricItem,
} from "../calls/index.js";
import { heardLines, underReview } from "./materials.js";
import type { CallQaTask } from "./task.js";

/** The items found on a line, and those found on none: what is missing, or what happened before the call. */
export const LINE_ITEMS: readonly RubricItem[] = [
  "identity",
  "threat",
  "negotiation",
  "voicemail",
  "bankruptcy_collection",
  "credit_misstatement",
  "complaint_not_logged",
  "wrong_amount",
  "provenance",
  "verbatim",
];
export const NO_LINE_ITEMS: readonly RubricItem[] = RUBRIC_ITEMS.filter(
  (i) => !LINE_ITEMS.includes(i),
);

export interface CallQaAnswer {
  readonly findings: readonly { readonly item: RubricItem; readonly line: number | null }[];
  readonly fails_outright: boolean;
  readonly note: { readonly matches: boolean; readonly contradictions: readonly string[] } | null;
  readonly options_told: readonly { readonly option: OptionName; readonly line: number }[];
}

/** The rubric's review of the task, as the reviewer reads it. */
export function reviewOf(task: CallQaTask): CallReview {
  return reviewCall(
    underReview(
      task.call,
      heardLines(task.transcript),
      task.record,
      task.pre_dial,
      task.note,
      task.copied_record,
    ),
  );
}

export function answerOf(r: CallReview): CallQaAnswer {
  return {
    findings: r.findings.map((f) => ({ item: f.item, line: f.line })),
    fails_outright: r.fails_outright,
    note: r.note ? { matches: r.note.matches, contradictions: [...r.note.contradictions] } : null,
    options_told: r.options_told.map((o) => ({ ...o })),
  };
}

export const expectedCallQa = (task: CallQaTask): CallQaAnswer => answerOf(reviewOf(task));

/** clean, failed (some finding), or fails outright: the verdict a run is summarized by. */
export function callQaVerdict(task: CallQaTask): string {
  const a = expectedCallQa(task);
  return a.fails_outright ? "fails outright" : a.findings.length ? "findings" : "clean";
}

/** A contradiction as written, compared without its dollar sign, commas, case or spaces at its ends. */
export const sameToken = (s: string): string => s.trim().toUpperCase().replace(/[$,]/g, "");

const linesOf = (a: CallQaAnswer, item: RubricItem): string =>
  [
    ...new Set(
      a.findings
        .filter((f) => f.item === item)
        .map((f) => (f.line === null ? "-" : String(f.line))),
    ),
  ]
    .sort((x, y) => (x === "-" ? -1 : y === "-" ? 1 : Number(x) - Number(y)))
    .join(",");

const noteOf = (n: CallQaAnswer["note"]): string =>
  n === null
    ? "none"
    : n.matches
      ? "matches"
      : `contradicts ${[...new Set(n.contradictions.map(sameToken))].sort().join(" | ")}`;

const optionsOf = (a: CallQaAnswer): string =>
  [...a.options_told]
    .sort((x, y) => OPTIONS.indexOf(x.option) - OPTIONS.indexOf(y.option))
    .map((o) => `${o.option}@${o.line}`)
    .join(", ") || "none";

/** Field by field: each item either side names, the outright fail, the note when either side has one, and the options told. */
export function gradeCallQaAgainst(want: CallQaAnswer, answer: CallQaAnswer | null): Grade {
  const fields: FieldGrade[] = [];
  const push = (field: string, expected: string, got: string | null) =>
    fields.push({ field, expected, got, ok: got !== null && expected === got });
  for (const item of RUBRIC_ITEMS) {
    const e = linesOf(want, item);
    const g = answer ? linesOf(answer, item) : "";
    if (e === "" && g === "") continue;
    push(`finding.${item}`, e || "none", answer ? g || "none" : null);
  }
  push(
    "fails_outright",
    String(want.fails_outright),
    answer ? String(answer.fails_outright) : null,
  );
  if (want.note !== null || (answer !== null && answer.note !== null))
    push("note", noteOf(want.note), answer ? noteOf(answer.note) : null);
  push("options_told", optionsOf(want), answer ? optionsOf(answer) : null);
  const ok = fields.filter((f) => f.ok).length;
  return { pass: ok === fields.length, score: fields.length ? ok / fields.length : 0, fields };
}

export const gradeCallQa = (task: CallQaTask, answer: CallQaAnswer | null): Grade =>
  gradeCallQaAgainst(expectedCallQa(task), answer);

/* ── reading a submission ───────────────────────────────────────────────── */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isLine = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

/**
 * The submission, read strictly: the schema's shapes, and a review that hangs
 * together. An item that takes a line has one, an item that takes none has
 * none, a line is one of the transcript's, the outright fail agrees with the
 * findings, and a note matches exactly when it lists no contradiction.
 */
export function parseCallQaSubmission(raw: unknown, lineCount?: number): Parsed<CallQaAnswer> {
  const bad = (error: string): Parsed<CallQaAnswer> => ({ ok: false, error });
  if (!isObj(raw)) return bad("submit_review takes an object");
  const extra = Object.keys(raw).filter(
    (k) => !["findings", "fails_outright", "note", "options_told"].includes(k),
  );
  if (extra.length) return bad(`unknown fields: ${extra.join(", ")}`);
  if (!Array.isArray(raw["findings"])) return bad("findings must be a list");
  const findings: { item: RubricItem; line: number | null }[] = [];
  for (const f of raw["findings"] as unknown[]) {
    if (!isObj(f) || Object.keys(f).some((k) => k !== "item" && k !== "line"))
      return bad("each finding is {item, line}");
    const item = f["item"];
    if (typeof item !== "string" || !(RUBRIC_ITEMS as readonly string[]).includes(item))
      return bad(
        `no rubric item ${JSON.stringify(item)}; the items are ${RUBRIC_ITEMS.join(", ")}`,
      );
    const line = f["line"] === undefined ? null : f["line"];
    if (LINE_ITEMS.includes(item as RubricItem)) {
      if (!isLine(line)) return bad(`${item} is found on a line: give the line's number`);
      if (lineCount !== undefined && line > lineCount)
        return bad(`${item}: there is no line ${line}; the transcript has ${lineCount}`);
    } else if (line !== null) return bad(`${item} is found on no line: give line null`);
    if (!findings.some((x) => x.item === item && x.line === line))
      findings.push({ item: item as RubricItem, line: line as number | null });
  }
  const fails = raw["fails_outright"];
  if (typeof fails !== "boolean") return bad("fails_outright must be true or false");
  const automatic = findings.some((f) => AUTOMATIC_FAILS.includes(f.item));
  if (fails !== automatic)
    return bad(
      fails
        ? "fails_outright is true, but no finding is an automatic fail"
        : `fails_outright is false, but ${findings.find((f) => AUTOMATIC_FAILS.includes(f.item))!.item} is an automatic fail`,
    );
  const n = raw["note"];
  let note: CallQaAnswer["note"] = null;
  if (n !== null) {
    if (!isObj(n) || typeof n["matches"] !== "boolean" || !Array.isArray(n["contradictions"]))
      return bad("note is {matches, contradictions} or null");
    if (Object.keys(n).some((k) => k !== "matches" && k !== "contradictions"))
      return bad("note is {matches, contradictions} or null");
    const cs = n["contradictions"] as unknown[];
    if (cs.some((c) => typeof c !== "string" || !c.trim()))
      return bad("each contradiction is the figure or the status, as the note writes it");
    if (n["matches"] !== (cs.length === 0))
      return bad("a note matches exactly when it lists no contradiction");
    note = { matches: n["matches"] as boolean, contradictions: cs as string[] };
  }
  if (!Array.isArray(raw["options_told"])) return bad("options_told must be a list");
  const options: { option: OptionName; line: number }[] = [];
  for (const o of raw["options_told"] as unknown[]) {
    if (!isObj(o) || Object.keys(o).some((k) => k !== "option" && k !== "line"))
      return bad("each option told is {option, line}");
    if (typeof o["option"] !== "string" || !(OPTIONS as readonly string[]).includes(o["option"]))
      return bad(`no option ${JSON.stringify(o["option"])}; the options are ${OPTIONS.join(", ")}`);
    if (!isLine(o["line"])) return bad("an option told is on a line: give the line's number");
    if (options.some((x) => x.option === o["option"]))
      return bad(`${o["option"]} is listed twice: give the first line that names it`);
    options.push({ option: o["option"] as OptionName, line: o["line"] });
  }
  return { ok: true, answer: { findings, fails_outright: fails, note, options_told: options } };
}
