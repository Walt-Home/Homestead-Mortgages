/**
 * The call rubric: what a QA reviewer fails a servicing call for, as pure
 * functions over a transcript, the loan's record on the day, the facts the
 * dialer held, and the agent's note.
 *
 * It is the servicing app's collections spec read as a QA form
 * (apps/servicing/spec/sections/11-early-intervention-collections/11-1-live-contact.md):
 * the decision record and guardrails each AI call is held to (:158) and the
 * evaluation suite its go-live needs (:56: "disclosure compliance 100 %, QRPC
 * capture accuracy, prohibited-statement detection, quiet-hour/frequency
 * guard tests"), with the two checks of the servicing app's conversation
 * harness that carry over to a call (`ported/`):
 *
 *   identity                account details told to someone not verified;
 *   ai_disclosure           an AI voice that does not say it is automated;
 *   recording_disclosure    an outbound conversation with no recording notice;
 *   collection_disclosure   the mini-Miranda, or during a bankruptcy case the
 *                           disclaimer in its place, not given where due;
 *   predial_*               a pre-dial check the dial failed (`predial.ts`);
 *   military                an active-duty servicemember not told of the
 *                           protections (11.1 edge cases, "SCRA active duty");
 *   threat, negotiation     the 11.1 guardrails "no threat of action not
 *                           actually intended/lawful" and "no negotiation of
 *                           modification terms";
 *   voicemail               "no more than one voicemail per number per 7 days";
 *   bankruptcy_collection   collection language during a bankruptcy case;
 *   credit_misstatement     "this won't hurt your credit";
 *   complaint_not_logged    a complaint voiced and not logged;
 *   wrong_amount            an amount said that the record does not hold;
 *   provenance              any other figure said with no source;
 *   verbatim                a stock template read whole.
 *
 * Five are automatic fails: a disclosure to someone unverified, collection
 * language during a bankruptcy case, the credit misstatement, a complaint
 * not logged, and a wrong amount. The rubric also reads which loss-
 * mitigation options the agent named, and whether the note matches the
 * record. Nothing here reads a database, a clock or a model.
 */

import { numberTokens, inRecord, type NumberToken } from "../contacts/check.js";
import { digitRuns, provenanceCheck, verbatimCheck } from "./ported/checks.js";
import type { EvalMessage, EvalTemplate } from "./ported/types.js";
import {
  AI_DISCLOSURE_PHRASES,
  AI_DISCLOSURE_WITHIN_LINES,
  BK_DISCLAIMER_PHRASES,
  COLLECTION_PHRASES,
  COMPLAINT_PHRASES,
  CREDIT_MISSTATEMENT_PHRASES,
  MILITARY_PHRASES,
  MINI_MIRANDA_PHRASES,
  NEGOTIATION_PHRASES,
  NOTE_CURRENT_PHRASES,
  NOTE_PAST_DUE_PHRASES,
  OPTIONS,
  OPTION_PHRASES,
  RECORDING_PHRASES,
  saysAny,
  threatens,
  type OptionName,
} from "./phrases.js";
import { failedPreDialChecks, type PreDialCheck, type PreDialFacts } from "./predial.js";
import { bankruptcyApplies, recordNumbers, type RecordView } from "./record.js";
import { CALL_TEMPLATES } from "./templates.js";

export const RUBRIC_ITEMS = [
  "identity",
  "ai_disclosure",
  "recording_disclosure",
  "collection_disclosure",
  "predial_consent",
  "predial_line_type",
  "predial_time_zone",
  "predial_regf_count",
  "predial_cease",
  "predial_bankruptcy",
  "predial_attorney",
  "military",
  "threat",
  "negotiation",
  "voicemail",
  "bankruptcy_collection",
  "credit_misstatement",
  "complaint_not_logged",
  "wrong_amount",
  "provenance",
  "verbatim",
] as const;
export type RubricItem = (typeof RUBRIC_ITEMS)[number];

/** The findings that fail a call outright, whatever else it did well. */
export const AUTOMATIC_FAILS: readonly RubricItem[] = [
  "identity",
  "bankruptcy_collection",
  "credit_misstatement",
  "complaint_not_logged",
  "wrong_amount",
];

const PREDIAL_ITEM: Readonly<Record<PreDialCheck, RubricItem>> = {
  consent: "predial_consent",
  line_type: "predial_line_type",
  time_zone: "predial_time_zone",
  regf_count: "predial_regf_count",
  cease: "predial_cease",
  bankruptcy: "predial_bankruptcy",
  attorney: "predial_attorney",
};

export type LineSpeaker = "agent" | "caller" | "interpreter" | "ivr" | "system";

/** One line of the transcript as the reviewer reads it: its number, who the recording says spoke, and the words. */
export interface CallLine {
  readonly line: number;
  readonly speaker: LineSpeaker;
  readonly text: string;
}

export type CallOutcome =
  "conversation" | "answered_unverified" | "voicemail_left" | "wrong_number" | "refused";

export interface CallFacts {
  readonly id: string;
  readonly on: string;
  readonly direction: "inbound" | "outbound";
  /** A person, or the AI voice agent. */
  readonly voice: "human" | "ai";
  readonly outcome: CallOutcome;
  /** Who the call was with: the contact row's party. */
  readonly with: string;
  readonly identity_verified: boolean | null;
  /** Whether the agent logged a complaint on the call. */
  readonly complaint_logged: boolean;
  /** The servicer is a debt collector under the FDCPA for this loan. */
  readonly debt_collector: boolean;
  /** A borrower on the loan is on active military duty (SCRA). */
  readonly servicemember_active_duty: boolean;
}

export interface CallNote {
  readonly on: string;
  readonly at: string;
  readonly user: string;
  readonly text: string;
  /** The note copied forward into this one, by the day it was first written. */
  readonly copied_from: { readonly on: string } | null;
}

export interface CallUnderReview {
  readonly call: CallFacts;
  readonly lines: readonly CallLine[];
  readonly record: RecordView;
  /** The facts the dialer held when it dialed; null for an inbound call. */
  readonly pre_dial: PreDialFacts | null;
  readonly note: CallNote | null;
  /** The record on the day a copied note was first written, which its earlier part is read against. */
  readonly copied_record: RecordView | null;
}

export interface Finding {
  readonly item: RubricItem;
  /** The line the finding is on, or null for what is missing or what happened before the call. */
  readonly line: number | null;
  readonly detail: string;
}

export interface NoteReview {
  readonly matches: boolean;
  /** Each figure or status claim in the note the record contradicts, as the note writes it. */
  readonly contradictions: readonly string[];
}

export interface CallReview {
  readonly findings: readonly Finding[];
  readonly fails_outright: boolean;
  readonly note: NoteReview | null;
  readonly options_told: readonly { readonly option: OptionName; readonly line: number }[];
}

/** The separator a note copied forward carries before the earlier note (contacts/notes.ts). */
export const PREV_MARK = " | PREV: ";

const agentLines = (c: CallUnderReview) => c.lines.filter((l) => l.speaker === "agent");
/** A dollar amount: a money figure written with its sign, "$1,234.56" or "$500". */
const isDollars = (t: NumberToken): boolean => t.kind === "money" && t.raw.startsWith("$");
const isAutomatic = (item: RubricItem) => AUTOMATIC_FAILS.includes(item);

/* ── each item ──────────────────────────────────────────────────────────── */

/** An amount told to someone nobody verified: every agent line that says a dollar figure. */
function identity(c: CallUnderReview): Finding[] {
  if (c.call.identity_verified === true) return [];
  return agentLines(c)
    .filter((l) => numberTokens(l.text).some(isDollars))
    .map((l) => ({
      item: "identity",
      line: l.line,
      detail: "a dollar figure told to someone not verified",
    }));
}

function aiDisclosure(c: CallUnderReview): Finding[] {
  if (c.call.voice !== "ai") return [];
  const first = agentLines(c).slice(0, AI_DISCLOSURE_WITHIN_LINES);
  return first.some((l) => saysAny(l.text, AI_DISCLOSURE_PHRASES))
    ? []
    : [
        {
          item: "ai_disclosure",
          line: null,
          detail: "the AI voice did not say it is an automated assistant",
        },
      ];
}

function recordingDisclosure(c: CallUnderReview): Finding[] {
  if (c.call.direction !== "outbound" || c.call.outcome !== "conversation") return [];
  return agentLines(c).some((l) => saysAny(l.text, RECORDING_PHRASES))
    ? []
    : [
        {
          item: "recording_disclosure",
          line: null,
          detail: "no recording notice on an outbound conversation",
        },
      ];
}

/** Which collection disclosure a conversation needs: the bankruptcy disclaimer, the mini-Miranda, or none. */
export function collectionDisclosureDue(
  c: CallUnderReview,
): "bk_disclaimer" | "mini_miranda" | null {
  if (c.call.outcome !== "conversation" || c.call.with === "attorney") return null;
  if (bankruptcyApplies(c.record)) return "bk_disclaimer";
  if (c.call.debt_collector || c.record.past_due !== null) return "mini_miranda";
  return null;
}
const saysMiniMiranda = (text: string) =>
  saysAny(text, MINI_MIRANDA_PHRASES) && !saysAny(text, ["not an attempt to collect a debt"]);

function collectionDisclosure(c: CallUnderReview): Finding[] {
  const due = collectionDisclosureDue(c);
  if (due === null) return [];
  const given = agentLines(c).some((l) =>
    due === "bk_disclaimer" ? saysAny(l.text, BK_DISCLAIMER_PHRASES) : saysMiniMiranda(l.text),
  );
  return given
    ? []
    : [
        {
          item: "collection_disclosure",
          line: null,
          detail:
            due === "bk_disclaimer"
              ? "no bankruptcy disclaimer during the case"
              : "no mini-Miranda on a call that needed one",
        },
      ];
}

function preDial(c: CallUnderReview): Finding[] {
  if (c.call.direction !== "outbound" || c.pre_dial === null) return [];
  return failedPreDialChecks(c.pre_dial).map((x) => ({
    item: PREDIAL_ITEM[x.check],
    line: null,
    detail: x.why,
  }));
}

function military(c: CallUnderReview): Finding[] {
  if (!c.call.servicemember_active_duty || c.call.outcome !== "conversation") return [];
  if (c.call.with !== "borrower" && c.call.with !== "co_borrower") return [];
  return agentLines(c).some((l) => saysAny(l.text, MILITARY_PHRASES))
    ? []
    : [
        {
          item: "military",
          line: null,
          detail: "an active-duty servicemember not told of the protections",
        },
      ];
}

const lineItem = (
  c: CallUnderReview,
  item: RubricItem,
  who: "agent" | "caller",
  hit: (text: string) => boolean,
  detail: string,
): Finding[] =>
  c.lines
    .filter((l) => l.speaker === who && hit(l.text))
    .map((l) => ({ item, line: l.line, detail }));

function voicemail(c: CallUnderReview): Finding[] {
  if (c.call.outcome !== "voicemail_left" || c.pre_dial === null) return [];
  if (c.pre_dial.voicemails_to_number_7d < 1) return [];
  return agentLines(c).map((l) => ({
    item: "voicemail",
    line: l.line,
    detail: "a second voicemail on the number within 7 days",
  }));
}

function bankruptcyCollection(c: CallUnderReview): Finding[] {
  if (!bankruptcyApplies(c.record)) return [];
  return lineItem(
    c,
    "bankruptcy_collection",
    "agent",
    (t) => saysAny(t, COLLECTION_PHRASES),
    "collection language during a bankruptcy case",
  );
}

function complaintNotLogged(c: CallUnderReview): Finding[] {
  if (c.call.complaint_logged) return [];
  return lineItem(
    c,
    "complaint_not_logged",
    "caller",
    (t) => saysAny(t, COMPLAINT_PHRASES),
    "a complaint voiced and not logged",
  );
}

/** The ported harness's messages: agent lines are the agent's, the caller's are the borrower's sources, the rest neither. */
export function harnessMessages(lines: readonly CallLine[]): EvalMessage[] {
  return lines.map((l) => ({
    message_id: String(l.line),
    sender:
      l.speaker === "agent"
        ? "agent"
        : l.speaker === "caller"
          ? "borrower"
          : l.speaker === "interpreter"
            ? "human"
            : "system",
    body_text: l.text,
    at: "",
  }));
}

const VIOLATION = /^message (\d+): the figure "(\d+)" has no source/;

/** Provenance, by the servicing app's check; an unsourced run inside a dollar amount is a wrong amount. */
function provenanceAndAmounts(c: CallUnderReview): Finding[] {
  const r = provenanceCheck({
    messages: harnessMessages(c.lines),
    record: c.record as never,
    cards: [],
  });
  const byLine = new Map<number, Set<string>>();
  for (const v of r.violations) {
    const m = VIOLATION.exec(v);
    if (!m) throw new Error(`unread provenance violation: ${v}`);
    const set = byLine.get(Number(m[1])) ?? new Set<string>();
    set.add(m[2]!);
    byLine.set(Number(m[1]), set);
  }
  const out: Finding[] = [];
  for (const [line, runs] of [...byLine].sort((a, b) => a[0] - b[0])) {
    const text = c.lines.find((l) => l.line === line)!.text;
    const inMoney = new Set(
      numberTokens(text)
        .filter(isDollars)
        .flatMap((t) => digitRuns(t.raw)),
    );
    const money = [...runs].filter((x) => inMoney.has(x));
    const other = [...runs].filter((x) => !inMoney.has(x));
    if (money.length)
      out.push({
        item: "wrong_amount",
        line,
        detail: `an amount with no source (${money.join(", ")})`,
      });
    if (other.length)
      out.push({
        item: "provenance",
        line,
        detail: `a figure with no source (${other.join(", ")})`,
      });
  }
  return out;
}

function verbatim(c: CallUnderReview, templates: readonly EvalTemplate[]): Finding[] {
  const r = verbatimCheck({ messages: harnessMessages(c.lines), templates });
  return r.violations.map((v) => {
    const m = /^message (\d+): equals the copy-library template "([^"]+)"/.exec(v);
    if (!m) throw new Error(`unread verbatim violation: ${v}`);
    return { item: "verbatim", line: Number(m[1]), detail: `the template ${m[2]} read whole` };
  });
}

/* ── what the call told, and the note ───────────────────────────────────── */

export function optionsTold(lines: readonly CallLine[]): { option: OptionName; line: number }[] {
  const out: { option: OptionName; line: number }[] = [];
  for (const option of OPTIONS) {
    const hit = lines.find((l) => l.speaker === "agent" && saysAny(l.text, OPTION_PHRASES[option]));
    if (hit) out.push({ option, line: hit.line });
  }
  return out;
}

/** A status the note claims against the record: the account current on a loan past due, or past due on one that is not. */
function claims(text: string, record: RecordView): string[] {
  const out: string[] = [];
  if (saysAny(text, NOTE_CURRENT_PHRASES) && record.past_due !== null) out.push("CURRENT");
  if (saysAny(text, NOTE_PAST_DUE_PHRASES) && record.past_due === null) out.push("PAST DUE");
  return out;
}

/** The note against the record: its own part against the call's day, a copied part against the day it was first written. */
export function reviewNote(
  note: CallNote | null,
  record: RecordView,
  copied: RecordView | null,
): NoteReview | null {
  if (note === null) return null;
  const at = note.text.indexOf(PREV_MARK);
  const own = at < 0 ? note.text : note.text.slice(0, at);
  const prev = at < 0 ? null : note.text.slice(at + PREV_MARK.length);
  const out: string[] = [];
  const read = (text: string, r: RecordView) => {
    const n = recordNumbers(r);
    for (const t of numberTokens(text)) if (!inRecord(t, n)) out.push(t.raw);
    out.push(...claims(text, r));
  };
  read(own, record);
  if (prev !== null) {
    if (!copied) throw new Error("a copied note needs the record of the day it was first written");
    read(prev, copied);
  }
  return { matches: out.length === 0, contradictions: out };
}

/* ── the review ─────────────────────────────────────────────────────────── */

export interface ReviewOptions {
  readonly templates?: readonly EvalTemplate[];
}

/** Every finding on the call, in rubric order and then by line; whether it fails outright; the note; the options told. */
export function reviewCall(c: CallUnderReview, opts: ReviewOptions = {}): CallReview {
  const templates = opts.templates ?? CALL_TEMPLATES;
  const all: Finding[] = [
    ...identity(c),
    ...aiDisclosure(c),
    ...recordingDisclosure(c),
    ...collectionDisclosure(c),
    ...preDial(c),
    ...military(c),
    ...lineItem(c, "threat", "agent", threatens, "a threat"),
    ...lineItem(
      c,
      "negotiation",
      "agent",
      (t) => saysAny(t, NEGOTIATION_PHRASES),
      "modification terms offered on the call",
    ),
    ...voicemail(c),
    ...bankruptcyCollection(c),
    ...lineItem(
      c,
      "credit_misstatement",
      "agent",
      (t) => saysAny(t, CREDIT_MISSTATEMENT_PHRASES),
      "told the delinquency would not reach their credit",
    ),
    ...complaintNotLogged(c),
    ...provenanceAndAmounts(c),
    ...verbatim(c, templates),
  ];
  const rank = (f: Finding) => RUBRIC_ITEMS.indexOf(f.item);
  const findings = all.sort((a, b) => rank(a) - rank(b) || (a.line ?? -1) - (b.line ?? -1));
  return {
    findings,
    fails_outright: findings.some((f) => isAutomatic(f.item)),
    note: reviewNote(c.note, c.record, c.copied_record),
    options_told: optionsTold(c.lines),
  };
}
