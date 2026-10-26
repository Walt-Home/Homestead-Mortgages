/**
 * The reference policy for contact-audit: the rulebook followed literally,
 * through the tools. In one turn it reads the comment log, the promise log,
 * the complaint log and the payments, and searches every transcript for the
 * complaint phrases and the acknowledgment phrases; in a second it adds up the
 * payments inside each untracked promise's window with the calculator; then it
 * submits. It reads its phrases from the rulebook's own constants and none of
 * the labels or the planter's code: a note's promise, a call's complaint and
 * each symptom are read here as the rulebook's sentences say, so a rule the
 * rulebook states one way and the labels hold another fails here. Held to the
 * labels on every generated task, it is the proof that each window can be
 * audited from the rulebook and the tools alone; the generator keeps a draw
 * only when it is.
 */

import type { ToolCall } from "../episode.js";
import { COMPLAINT_PHRASES } from "../calls/index.js";
import { ScriptedPolicy, type Call, type Json, type Step } from "../refi/reference.js";
import { ACK_PHRASES, NOTE_PREV_MARK } from "./rulebook.js";
import { CONTACT_AUDIT_SUBMIT_TOOL } from "./tools.js";

interface Row {
  id: string;
  on: string;
  at: string;
  direction: string;
  mode: string;
  purpose: string;
  reason: string | null;
  agent: string | null;
  complaint_logged: boolean;
}
interface Note {
  user: string;
  text: string;
  contact: string | null;
}
interface Match {
  phrase: string;
  lines: { contact: string; line: number }[];
}

let batches = 0;
function* together(calls: readonly (readonly [string, Json])[]): Step<Json[]> {
  if (calls.length === 0) return [];
  const batch = ++batches;
  const made: ToolCall[] = calls.map(([name, input], k) => ({
    id: `audit-${batch}-${k}`,
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

/** Dollars and cents to cents: "$1,234.56", "1234.56". */
const toCents = (s: string): bigint => {
  const [w, f] = s.replace(/[$,\s]/g, "").split(".");
  return BigInt(w!) * 100n + BigInt((f ?? "0").padEnd(2, "0"));
};
const plainAmount = (s: string) => s.replace(/[$,\s]/g, "");

/** The note's own part: before the first copied-forward mark. */
const ownPart = (text: string): string => {
  const mark = NOTE_PREV_MARK.trim();
  const at = text.indexOf(mark);
  return at < 0 ? text : text.slice(0, at);
};

/** A dollar amount, the word BY and a date, next to each other: the promise a note states. */
const PROMISE =
  /(\$?\d{1,3}(?:,\d{3})+\.\d{2}|\$?\d+\.\d{2})\s+by\s+(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/i;

const isAfter = (a: Row, b: Row) => a.on > b.on || (a.on === b.on && a.at > b.at);

export function* contactAuditSteps(p: Json, _call: Call): Step<Json> {
  const contacts = p["contacts"] as Row[];
  const got = yield* together([
    ["read_notes", {}],
    ["read_promises", {}],
    ["read_complaints", {}],
    ["read_payments", {}],
    ["search_transcripts", { phrases: [...COMPLAINT_PHRASES, ...ACK_PHRASES] }],
  ]);
  const notes = (got[0] as { notes: Note[] }).notes;
  const promises = (got[1] as { promises: { contact: string }[] }).promises;
  const complaints = (got[2] as { complaints: { contact: string }[] }).complaints;
  const payments = (got[3] as { payments: { on: string; amount: string }[] }).payments;
  const matches = (got[4] as { matches: Match[] }).matches;
  const callsSaying = (phrases: readonly string[]) =>
    new Set(
      matches
        .filter((m) => phrases.includes(m.phrase))
        .flatMap((m) => m.lines.map((l) => l.contact)),
    );

  const findings: Json[] = [];

  // S-01: a promise the note states and the promise log does not hold.
  const roots01: { row: Row; cents: bigint; pay_by: string; amount: string }[] = [];
  for (const c of contacts) {
    if (c.mode !== "call" || c.agent === null) continue;
    const note = notes.find((n) => n.contact === c.id && n.user === c.agent);
    if (!note) continue;
    const m = PROMISE.exec(ownPart(note.text));
    if (!m) continue;
    if (promises.some((x) => x.contact === c.id)) continue;
    const yy = m[4]!.length === 2 ? `20${m[4]}` : m[4]!;
    const payBy = `${yy}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
    roots01.push({ row: c, cents: toCents(m[1]!), pay_by: payBy, amount: m[1]! });
  }
  // The payments inside each window, added up with the calculator where there are several.
  const sums = roots01.map((r) =>
    payments.filter((x) => x.on > r.row.on && x.on <= r.pay_by).map((x) => x.amount),
  );
  const asks: [string, Json][] = sums
    .filter((s) => s.length > 1)
    .map((s) => ["calculate", { expression: s.map(plainAmount).join(" + ") }]);
  const added = yield* together(asks);
  let k = 0;
  roots01.forEach((r, i) => {
    const s = sums[i]!;
    const total =
      s.length === 0
        ? 0n
        : s.length === 1
          ? toCents(s[0]!)
          : toCents(String((added[k++] as { value: string }).value));
    findings.push({
      error: "S-01",
      kind: "root",
      contact: r.row.id,
      promise: { amount: r.amount, pay_by: r.pay_by },
    });
    for (const a of contacts)
      if (
        a.direction === "outbound" &&
        a.mode === "call" &&
        a.purpose === "collection" &&
        isAfter(a, r.row) &&
        a.on <= r.pay_by
      )
        findings.push({ error: "S-01", kind: "dialed_in_window", contact: a.id, promise: null });
    findings.push({
      error: "S-01",
      kind: total >= r.cents ? "kept_not_marked" : "broken_not_followed_up",
      contact: r.row.id,
      promise: null,
    });
  });

  // S-02: a complaint a transcript voices on a call that did not log it.
  const voiced = callsSaying(COMPLAINT_PHRASES);
  const acked = callsSaying(ACK_PHRASES);
  const roots02: Row[] = [];
  for (const c of contacts) {
    if (!voiced.has(c.id) || c.complaint_logged) continue;
    const root = roots02.find((r) => r.reason === c.reason);
    if (root) {
      findings.push({ error: "S-02", kind: "raised_again", contact: c.id, promise: null });
      continue;
    }
    roots02.push(c);
    findings.push({ error: "S-02", kind: "root", contact: c.id, promise: null });
    if (!acked.has(c.id))
      findings.push({ error: "S-02", kind: "no_acknowledgment", contact: c.id, promise: null });
    if (!complaints.some((x) => x.contact === c.id))
      findings.push({ error: "S-02", kind: "no_response", contact: c.id, promise: null });
  }
  return { findings };
}

export class ContactAuditReferencePolicy extends ScriptedPolicy {
  constructor() {
    super("reference", contactAuditSteps, CONTACT_AUDIT_SUBMIT_TOOL);
  }
}
