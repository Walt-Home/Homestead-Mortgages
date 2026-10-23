/**
 * The reference policy for call-qa: the rulebook followed literally, through
 * the tools. It searches the transcript for every phrase the rules list,
 * asks local_time for the dial in each zone and minutes_between for every
 * earlier attempt, and record_on for the day a copied note was written, all
 * in one turn, then reads the rest off the task: the dollar amounts on agent
 * lines, the runs of digits and their sources, the templates, the note's
 * numbers. It reads its word lists from the rulebook's own constants and
 * none of the rubric's code: the figures, the templates and the note are read
 * here as the rulebook's sentences say, so a rule the rulebook states one way
 * and the rubric computes another fails here. Held to the grader on every
 * generated task, it is the proof that each call can be reviewed from the
 * rulebook and the tools alone.
 */

import type { ToolCall } from "../episode.js";
import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import {
  AI_DISCLOSURE_PHRASES,
  AI_DISCLOSURE_WITHIN_LINES,
  AUTOMATIC_FAILS,
  BK_DISCLAIMER_PHRASES,
  CALL_CAP,
  CALL_CAP_DAYS,
  CALL_TEMPLATES,
  COLLECTION_PHRASES,
  COMPLAINT_PHRASES,
  CREDIT_MISSTATEMENT_PHRASES,
  LANDLINE_AI_CAP,
  LANDLINE_AI_DAYS,
  MILITARY_PHRASES,
  MINI_MIRANDA_PHRASES,
  NEGOTIATION_PHRASES,
  NOTE_CURRENT_PHRASES,
  NOTE_PAST_DUE_PHRASES,
  OPTIONS,
  OPTION_PHRASES,
  PREV_MARK,
  RECORDING_PHRASES,
  THREAT_PHRASES,
  VOICE_WINDOW,
  type RubricItem,
} from "../calls/index.js";
import { CALL_QA_SUBMIT_TOOL } from "./tools.js";

interface Line {
  line: number;
  speaker: string;
  text: string;
}
interface PreDial {
  dial_at: string;
  mode: string;
  time_zones: string[];
  line_type: string;
  tcpa_voice_consent_active: boolean;
  written_consent: boolean;
  ai_voice_attempts_at: string[];
  fdcpa_debt_collector: boolean;
  state: string;
  counted_call_attempts_at: string[];
  voicemails_to_number_7d: number;
  cease_active: boolean;
  written_cease: boolean;
  bk_active: boolean;
  attorney_represented: boolean;
}
type Rec = Record<string, unknown> & {
  on: string;
  past_due: unknown;
  bankruptcy: { chapter: number; discharged_on: string | null } | null;
};

let batches = 0;
/** Independent calls made together in one turn, each answer parsed. */
function* together(calls: readonly (readonly [string, Json])[]): Step<Json[]> {
  if (calls.length === 0) return [];
  const batch = ++batches;
  const made: ToolCall[] = calls.map(([name, input], k) => ({
    id: `qa-${batch}-${k}`,
    name,
    input,
  }));
  const observations = yield made;
  return made.map((c) => {
    const o = observations.find((x) => x.call_id === c.id);
    if (!o || o.is_error) throw new Error(`${c.name} failed: ${o?.content ?? "no observation"}`);
    return JSON.parse(o.content) as Json;
  });
}

/* ── reading, as the rulebook says ──────────────────────────────────────── */

const runs = (s: string): string[] => s.match(/\d+/g) ?? [];

/** The record's sources: each value's runs, and a date's year, short year, month and day. */
function recordRuns(v: unknown, out: Set<string>): void {
  if (v === null || v === undefined || typeof v === "boolean") return;
  if (Array.isArray(v)) {
    for (const x of v) recordRuns(x, out);
    return;
  }
  if (typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) recordRuns(x, out);
    return;
  }
  const s = String(v);
  for (const r of runs(s)) out.add(r);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) {
    out.add(d[1]!);
    out.add(d[1]!.slice(2));
    out.add(String(Number(d[2])));
    out.add(String(Number(d[3])));
  }
}

/** The runs of digits inside the dollar amounts of a line. */
const dollarRuns = (text: string): Set<string> =>
  new Set((text.match(/\$\s?\d[\d,]*(?:\.\d+)?/g) ?? []).flatMap(runs));

/** A template's comparison form: lower case, no quotes or apostrophes or emphasis marks, single spaces, no closing punctuation. */
const plainText = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/[“”"']/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+\s*$/, "")
    .trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isTemplate = (text: string, template: string): boolean => {
  const t = plainText(text);
  if (!t) return false;
  const parts = plainText(template)
    .split(/\{\{[a-z0-9_.]+\}\}/)
    .map(escape);
  return new RegExp(`^${parts.join(".+?")}$`, "i").test(t);
};

/** The numbers of a note's part, read left to right as the rulebook reads them. */
function noteNumbers(
  text: string,
): (
  | { kind: "money"; raw: string; cents: string }
  | { kind: "date"; raw: string; m: number; d: number; y: number | null }
  | { kind: "rate"; raw: string; value: number }
  | { kind: "number"; raw: string; value: number }
)[] {
  type T = ReturnType<typeof noteNumbers>[number];
  const found: { at: number; t: T }[] = [];
  let work = text;
  const take = (re: RegExp, make: (m: RegExpExecArray) => T) => {
    re.lastIndex = 0;
    const spans: [number, number][] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(work)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      found.push({ at: m.index, t: make(m) });
    }
    for (const [a, b] of spans) work = work.slice(0, a) + " ".repeat(b - a) + work.slice(b);
  };
  const cents = (raw: string) => {
    const [w, f] = raw.replace(/[$,\s]/g, "").split(".");
    return (BigInt(w!) * 100n + BigInt((f ?? "0").padEnd(2, "0"))).toString();
  };
  take(/\$\s?\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\s?\d+(?:\.\d{2})?/g, (m) => ({
    kind: "money",
    raw: m[0],
    cents: cents(m[0]),
  }));
  take(/\b\d+(?:\.\d+)?\s?(?:%|percent)/gi, (m) => ({
    kind: "rate",
    raw: m[0],
    value: Number(m[0].replace(/[^\d.]/g, "")),
  }));
  take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g, (m) => ({
    kind: "date",
    raw: m[0],
    m: Number(m[1]),
    d: Number(m[2]),
    y: m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null,
  }));
  take(/\b\d{1,3}(?:,\d{3})+\.\d{2}\b|\b\d+\.\d{2}\b/g, (m) => ({
    kind: "money",
    raw: m[0],
    cents: cents(m[0]),
  }));
  take(/\b\d+(?:\.\d+)?\b/g, (m) => ({ kind: "number", raw: m[0], value: Number(m[0]) }));
  return found.sort((a, b) => a.at - b.at).map((x) => x.t);
}

/** What a record holds, as the note rule reads it. */
function noteSources(record: unknown) {
  const money = new Set<string>();
  const dates: [number, number, number][] = [];
  const numbers = new Set<number>();
  const rates = new Set<number>();
  const walk = (v: unknown, key: string) => {
    if (v === null || v === undefined || typeof v === "boolean") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (typeof v === "object")
      return Object.entries(v as Record<string, unknown>).forEach(([k, x]) => walk(x, k));
    if (key.endsWith("_pct")) return void rates.add(Number(v));
    if (typeof v === "number") return void numbers.add(v);
    const s = String(v);
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (/^-?\$\d{1,3}(,\d{3})*\.\d{2}$/.test(s)) {
      const [w, f] = s.replace(/[-$,]/g, "").split(".");
      money.add((BigInt(w!) * 100n + BigInt(f!)).toString());
    } else if (d) {
      dates.push([Number(d[1]), Number(d[2]), Number(d[3])]);
      numbers.add(Number(d[1]));
    } else if (/^\d+$/.test(s)) numbers.add(Number(s));
  };
  walk(record, "");
  return { money, dates, numbers, rates };
}

function readNotePart(text: string, record: Rec): string[] {
  const src = noteSources(record);
  const out: string[] = [];
  for (const t of noteNumbers(text)) {
    const found =
      t.kind === "money"
        ? src.money.has(t.cents)
        : t.kind === "date"
          ? src.dates.some(([y, m, d]) => m === t.m && d === t.d && (t.y === null || t.y === y))
          : t.kind === "rate"
            ? src.rates.has(t.value)
            : src.numbers.has(t.value);
    if (!found) out.push(t.raw);
  }
  const plainWords = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
  const said = (xs: readonly string[]) => xs.some((x) => plainWords.includes(` ${x} `));
  if (said(NOTE_CURRENT_PHRASES) && record.past_due !== null) out.push("CURRENT");
  if (said(NOTE_PAST_DUE_PHRASES) && record.past_due === null) out.push("PAST DUE");
  return out;
}

const caseOpen = (r: Rec) =>
  r.bankruptcy !== null &&
  !(
    r.bankruptcy.chapter === 13 &&
    r.bankruptcy.discharged_on !== null &&
    r.bankruptcy.discharged_on <= r.on
  );

/* ── the steps ──────────────────────────────────────────────────────────── */

const PHRASES: readonly string[] = [
  ...new Set([
    ...AI_DISCLOSURE_PHRASES,
    ...RECORDING_PHRASES,
    ...BK_DISCLAIMER_PHRASES,
    ...MINI_MIRANDA_PHRASES,
    ...MILITARY_PHRASES,
    ...THREAT_PHRASES,
    ...NEGOTIATION_PHRASES,
    ...COLLECTION_PHRASES,
    ...CREDIT_MISSTATEMENT_PHRASES,
    ...COMPLAINT_PHRASES,
    ...OPTIONS.flatMap((o) => OPTION_PHRASES[o]),
  ]),
];

export function* callQaSteps(p: Json, _call: Call): Step<Json> {
  const call = p["call"] as {
    direction: string;
    voice: string;
    outcome: string;
    with: string;
    identity_verified: boolean | null;
    complaint_logged: boolean;
    debt_collector: boolean;
    servicemember_active_duty: boolean;
    on: string;
  };
  const lines = p["transcript"] as Line[];
  const record = p["record"] as Rec;
  const pre = p["pre_dial"] as PreDial | null;
  const note = p["note"] as { text: string; copied_from: { on: string } | null } | null;

  // One turn: every search, every clock reading, and the other day's record.
  const asks: [string, Json][] = [["search_transcript", { phrases: [...PHRASES] }]];
  if (pre) {
    for (const z of pre.time_zones)
      asks.push(["local_time", { instant: pre.dial_at, time_zone: z }]);
    for (const t of [...pre.counted_call_attempts_at, ...pre.ai_voice_attempts_at])
      asks.push(["minutes_between", { from: t, to: pre.dial_at }]);
  }
  if (note?.copied_from) asks.push(["record_on", { date: note.copied_from.on }]);
  const got = yield* together(asks);

  const search = got[0] as { matches: { phrase: string; lines: Line[] }[] };
  const hits = (phrases: readonly string[], speaker = "Agent"): Line[] => {
    const seen = new Map<number, Line>();
    for (const m of search.matches)
      if (phrases.includes(m.phrase))
        for (const l of m.lines) if (l.speaker === speaker) seen.set(l.line, l);
    return [...seen.values()].sort((a, b) => a.line - b.line);
  };
  let k = 1;
  const times: string[] = [];
  const gaps = new Map<string, number>();
  if (pre) {
    for (const _z of pre.time_zones) times.push(String((got[k++] as { time: string }).time));
    for (const t of [...pre.counted_call_attempts_at, ...pre.ai_voice_attempts_at])
      gaps.set(t, Number((got[k++] as { minutes: number }).minutes));
  }
  const copied = note?.copied_from ? (got[k++] as { record: Rec }).record : null;

  const findings: { item: RubricItem; line: number | null }[] = [];
  const add = (item: RubricItem, line: number | null) => findings.push({ item, line });
  const agent = lines.filter((l) => l.speaker === "Agent");
  const caller = lines.filter((l) => l.speaker === "Customer");

  // Who was told what.
  if (call.identity_verified !== true)
    for (const l of agent) if (/\$\s?\d/.test(l.text)) add("identity", l.line);

  // Disclosures.
  if (call.voice === "ai") {
    const first = new Set(agent.slice(0, AI_DISCLOSURE_WITHIN_LINES).map((l) => l.line));
    if (!hits(AI_DISCLOSURE_PHRASES).some((l) => first.has(l.line))) add("ai_disclosure", null);
  }
  if (
    call.direction === "outbound" &&
    call.outcome === "conversation" &&
    !hits(RECORDING_PHRASES).length
  )
    add("recording_disclosure", null);
  if (call.outcome === "conversation" && call.with !== "attorney") {
    if (caseOpen(record)) {
      if (!hits(BK_DISCLAIMER_PHRASES).length) add("collection_disclosure", null);
    } else if (call.debt_collector || record.past_due !== null) {
      const not = new Set(hits(["not an attempt to collect a debt"]).map((l) => l.line));
      if (!hits(MINI_MIRANDA_PHRASES).some((l) => !not.has(l.line)))
        add("collection_disclosure", null);
    }
  }

  // Before the call.
  if (call.direction === "outbound" && pre) {
    const within = (ts: readonly string[], days: number) =>
      ts.filter((t) => {
        const g = gaps.get(t)!;
        return g >= 0 && g < days * 1440;
      }).length;
    if (pre.mode === "ai_voice" && pre.line_type !== "landline" && !pre.tcpa_voice_consent_active)
      add("predial_consent", null);
    if (
      pre.mode === "ai_voice" &&
      pre.line_type === "landline" &&
      !pre.written_consent &&
      within(pre.ai_voice_attempts_at, LANDLINE_AI_DAYS) >= LANDLINE_AI_CAP
    )
      add("predial_line_type", null);
    if (times.some((t) => !(t > VOICE_WINDOW.after && t <= VOICE_WINDOW.through)))
      add("predial_time_zone", null);
    const cap = pre.fdcpa_debt_collector
      ? CALL_CAP.debt_collector
      : pre.state === "MA"
        ? CALL_CAP.MA
        : CALL_CAP.policy;
    if (within(pre.counted_call_attempts_at, CALL_CAP_DAYS) + 1 > cap)
      add("predial_regf_count", null);
    if (pre.cease_active || pre.written_cease) add("predial_cease", null);
    if (pre.bk_active) add("predial_bankruptcy", null);
    if (pre.attorney_represented) add("predial_attorney", null);
  }

  // The loan's flags.
  if (
    call.servicemember_active_duty &&
    call.outcome === "conversation" &&
    (call.with === "borrower" || call.with === "co_borrower") &&
    !hits(MILITARY_PHRASES).length
  )
    add("military", null);

  // What is never said.
  for (const l of hits(THREAT_PHRASES)) add("threat", l.line);
  for (const l of hits(NEGOTIATION_PHRASES)) add("negotiation", l.line);
  if (call.outcome === "voicemail_left" && pre && pre.voicemails_to_number_7d >= 1)
    for (const l of agent) add("voicemail", l.line);
  if (caseOpen(record))
    for (const l of hits(COLLECTION_PHRASES)) add("bankruptcy_collection", l.line);
  for (const l of hits(CREDIT_MISSTATEMENT_PHRASES)) add("credit_misstatement", l.line);
  if (!call.complaint_logged)
    for (const l of hits(COMPLAINT_PHRASES, "Customer")) add("complaint_not_logged", l.line);

  // Figures.
  const sources = new Set<string>();
  for (const l of caller) for (const r of runs(l.text)) sources.add(r);
  recordRuns(record, sources);
  for (const l of agent) {
    const loose = runs(l.text).filter((r) => !sources.has(r));
    if (!loose.length) continue;
    const money = dollarRuns(l.text);
    if (loose.some((r) => money.has(r))) add("wrong_amount", l.line);
    if (loose.some((r) => !money.has(r))) add("provenance", l.line);
  }
  for (const l of agent)
    if (CALL_TEMPLATES.some((t) => isTemplate(l.text, t.text))) add("verbatim", l.line);

  // The note.
  let noteAnswer: Json | null = null;
  if (note) {
    const at = note.text.indexOf(PREV_MARK);
    const own = at < 0 ? note.text : note.text.slice(0, at);
    const contradictions = readNotePart(own, record);
    if (at >= 0)
      contradictions.push(...readNotePart(note.text.slice(at + PREV_MARK.length), copied!));
    noteAnswer = { matches: contradictions.length === 0, contradictions };
  }

  const options = OPTIONS.flatMap((o) => {
    const h = hits(OPTION_PHRASES[o]);
    return h.length ? [{ option: o, line: h[0]!.line }] : [];
  });

  return {
    findings,
    fails_outright: findings.some((f) => AUTOMATIC_FAILS.includes(f.item)),
    note: noteAnswer,
    options_told: options,
  };
}

export class CallQaReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference", callQaSteps, CALL_QA_SUBMIT_TOOL);
  }
}
