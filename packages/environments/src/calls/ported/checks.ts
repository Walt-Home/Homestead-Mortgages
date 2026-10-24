/**
 * The five checks of the evaluation harness (docs/ux/17 §6, DELTA-28; 32.16 §6) — pure functions over a transcript and the tables:
 *
 *   provenance   every digit-run in an agent message appears in the borrower's own messages, the record's numbers and dates, a card's
 *                fields or proposal, or a rates element's figures — anything else is a violation
 *   verbatim     no agent message equals a docs/ux/12 template (the library loaded the way channels.ts loads it; `{{tokens}}` wild)
 *   SAFE and     zero gated SAFE classes sent (docs/ux/17 §6, 32.16 §6 — read literally: a gated class the bus permitted under the MLO of
 *   inquiries    record's attribution is counted in `detail.gated_permitted` and is still a violation of this suite), every model reply
 *                has an `agent_turns` row behind it, the guard's own SAFE/inquiry checks passed on what was sent, and 21.1 scanTranscript
 *                finds zero prohibited inquiries in it
 *   evidence     every captured application fact (application.six_item.captured, application.field.captured, …) has a resolved card
 *                behind it — the tap (card_instances.status = resolved / card_instance_events{to_status: resolved}) or a `card.resolved`
 *                event (resolve_card_by_evidence). Matched by the card_instance_id the fact's payload names, else by the transaction that
 *                wrote it: the fact shares its database instant (`loan_events.created_at`, one `now()` per committed command) with a
 *                `command.executed` row of the resolved card's `command_ref`, and that card's tap (its `card_instance_events.created_at`)
 *                is within the window. The runtime clock (`occurred_at`, `resolved_at`) is one instant under a FixedClock and is never
 *                the link.
 *   completion   the persona's target: an event (application.received), a card (the payoff quote card), or human.request within one
 *                turn of the distress utterance — "within one turn" is the thread's order (the `agent_turns` row that answered the
 *                utterance, the reply line between it and the next borrower message, the event's database instant between theirs)
 *
 * Any failure fails the run (the runner's `pass`). Nothing here reads a database or calls a model.
 */
import type { CheckResult, CompletionTarget, EvalCard, EvalCardEvent, EvalEvent, EvalMessage, EvalRecord, EvalTemplate, EvalTurn, Transcript } from "./types.js";

type P = Record<string, unknown>;
const P_OF = (v: unknown): P | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as P) : null);
const result = (name: CheckResult["name"], violations: readonly string[], detail: P): CheckResult => ({ name, pass: violations.length === 0, violations, detail });

// ---------------------------------------------------------------- (1) provenance: digit-runs with a source
const COPY_TOKEN = /\{\{copy:[a-z0-9_.]+\}\}/g;
const ANY_TOKEN = /\{\{[a-zA-Z0-9_.:-]+\}\}/g;
const DEEP_LINK = /\/d\/[A-Za-z0-9_-]+/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Keys whose values are opaque references, never figures the borrower reads (a token's or a hash's digits would otherwise license anything). An `_id` key is not skipped by name: an NMLSR ID or a servicer number is a figure; a uuid or an opaque token is skipped by its shape. */
const IDENTIFIER_KEY = /(^|_)(token|hash|ref|refs|sequence|version|sid)$/;
/** An opaque identifier by shape: letters and digits mixed, no spaces, twelve characters or more (a hex id, a base64url token). */
const OPAQUE = /^[A-Za-z0-9_-]{12,}$/;
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const digitRuns = (s: string): string[] => s.match(/\d+/g) ?? [];
/** The text of an agent message the model is answerable for: copy-library tokens, filled-token markers and deep links stripped. */
export const agentText = (m: EvalMessage): string => (m.body_text ?? "").replace(COPY_TOKEN, " ").replace(ANY_TOKEN, " ").replace(DEEP_LINK, " ");
/** An agent message that is the model's own words (not a `{{copy:key}}` line the interface rendered). */
export const modelWords = (m: EvalMessage): boolean => m.sender === "agent" && !!m.body_text && !/^\s*\{\{copy:/.test(m.body_text);

/**
 * The digit-runs a source value may put in front of the borrower: the value as written, its money rendering when it is cents
 * ("45000000" → "$450,000.00" → 450 / 000 / 00, and the whole dollars 450000), a date's parts unpadded (2026-09-05 → 2026, 9, 5, 26),
 * a rate's parts. Objects and arrays recurse; identifier keys and uuids contribute nothing.
 */
export function figureRuns(value: unknown, key = ""): string[] {
  const out = new Set<string>();
  const push = (s: string): void => { for (const r of digitRuns(s)) out.add(r); };
  if (value === null || value === undefined || typeof value === "boolean") return [];
  if (IDENTIFIER_KEY.test(key)) return [];
  if (Array.isArray(value)) { for (const v of value) for (const r of figureRuns(v, key)) out.add(r); return [...out]; }
  if (typeof value === "object") { for (const [k, v] of Object.entries(value as P)) for (const r of figureRuns(v, k)) out.add(r); return [...out]; }
  const s = typeof value === "bigint" ? value.toString() : String(value);
  if (UUID.test(s)) return [];
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) { push(s); const y = s.slice(0, 4), m = s.slice(5, 7), d = s.slice(8, 10); push(y); push(y.slice(2)); push(String(Number(m))); push(String(Number(d))); return [...out]; }
  if (OPAQUE.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s)) return [];
  push(s);
  const centsLike = typeof value === "bigint" || key.endsWith("_cents") || /cents|amount|balance|upb|payment/.test(key);
  if (/^-?\d+$/.test(s) && centsLike) { const n = BigInt(s); push(USD.format(Number(n) / 100)); push((n / 100n).toString()); push((n / 100n).toLocaleString("en-US")); }
  return [...out];
}

/** A money path on a card (32.16 §3.4: the model transcribes cents as a string; the API reads the amount back as money). */
const MONEY_PATH = /_cents$|income|amount|price|payment|balance|value_estimate|down_payment/;
/** The digit-runs a card's fields, proposal and evidence may put in front of the borrower — a money path's value both as cents and as money. */
export function cardFigureRuns(card: EvalCard): string[] {
  const out = new Set<string>(); const props = card.props;
  const money = new Set<string>(Array.isArray(props["money_paths"]) ? (props["money_paths"] as string[]) : []);
  const fields = (list: unknown): void => { if (!Array.isArray(list)) return; for (const f of list as P[]) { const path = String(f["path"] ?? ""); const key = money.has(path) || MONEY_PATH.test(path) ? "amount_cents" : path; for (const v of [f["value"], f["value_confirmed"], f["value_prefilled"]]) for (const r of figureRuns(v, key)) out.add(r); } };
  fields(props["fields"]); fields(P_OF(props["proposal"])?.["fields"]); fields(card.evidence?.["fields"]);
  for (const r of figureRuns(props["options"], "options")) out.add(r);
  return [...out];
}

export interface ProvenanceInput { readonly messages: readonly EvalMessage[]; readonly record: EvalRecord | null; readonly cards: readonly EvalCard[]; /** rates elements not on the thread (a runner may pass the turn ledger's) */ readonly rates?: readonly P[] }
export function provenanceCheck(i: ProvenanceInput): CheckResult {
  const allowed = new Set<string>(); const add = (runs: readonly string[]): void => { for (const r of runs) allowed.add(r); };
  for (const m of i.messages) if (m.sender === "borrower") add(digitRuns(m.body_text ?? ""));
  add(figureRuns(i.record));
  for (const c of i.cards) add(cardFigureRuns(c));
  let elements = 0;
  for (const m of i.messages) if (m.sender === "system" && m.copy_tokens && typeof m.copy_tokens["element"] === "string") { elements++; add(figureRuns(m.copy_tokens, "element")); }
  for (const e of i.rates ?? []) { elements++; add(figureRuns(e, "element")); }
  const violations: string[] = []; let checked = 0;
  for (const m of i.messages) {
    if (m.sender !== "agent") continue; checked++;
    for (const run of digitRuns(agentText(m))) if (!allowed.has(run)) violations.push(`message ${m.message_id}: the figure "${run}" has no source in the borrower's words, the record, a card or a rates element`);
  }
  return result("provenance", violations, { agent_messages: checked, sources: allowed.size, rates_elements: elements });
}

// ---------------------------------------------------------------- (2) verbatim: no agent message equals a copy-library template
const normalize = (s: string): string => s.toLowerCase().replace(/\*([^*]+)\*/g, "$1").replace(/[“”"']/g, "").replace(/\s+/g, " ").replace(/[.!?…]+\s*$/, "").trim();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A template with `{{tokens}}` matches any filling; case, emphasis, quotes and trailing punctuation are ignored. */
export function templateMatches(text: string, template: string): boolean {
  const t = normalize(text); if (!t) return false;
  const pattern = "^" + normalize(template).split(/\{\{[a-z0-9_.]+\}\}/).map(escapeRe).join(".+?") + "$";
  return new RegExp(pattern, "i").test(t);
}
/** A template's own words: what is left outside its `{{tokens}}` — a line that is all tokens (or nearly) matches anything and counts for nothing. */
export const templateLiteral = (text: string): string => normalize(text).replace(/\{\{[a-z0-9_.]+\}\}/g, "").replace(/\s+/g, " ").trim();
export interface VerbatimInput { readonly messages: readonly EvalMessage[]; readonly templates: readonly EvalTemplate[]; /** templates with fewer characters of their own than this (outside their tokens) are too generic to count; default 12 */ readonly minLength?: number }
export function verbatimCheck(i: VerbatimInput): CheckResult {
  const min = i.minLength ?? 12; const templates = i.templates.filter((t) => templateLiteral(t.text).length >= min);
  const violations: string[] = []; let checked = 0;
  for (const m of i.messages) {
    if (!modelWords(m)) continue; checked++;
    const text = (m.body_text ?? "").replace(DEEP_LINK, " ");
    const hit = templates.find((t) => templateMatches(text, t.text));
    if (hit) violations.push(`message ${m.message_id}: equals the copy-library template "${hit.key}" verbatim`);
  }
  return result("verbatim", violations, { model_messages: checked, templates: templates.length });
}

