/**
 * The grader: the twin's labels, read root apart from symptom as
 * boarding-triage 1.1.0 reads a package's manifest (boarding/grader.ts), with
 * two differences: a root the window does not hold fails it, and a root's
 * symptoms are required beside it.
 *
 * The fields:
 *   - for each root, found: a finding names its error, kind "root" and its
 *     call; for an S-01 root, also promise: that finding gives the promise's
 *     amount (in cents) and pay-by date as the call's note does;
 *   - for each root, symptoms: every symptom the rules give it is named, each
 *     on its contact. A finding that names them and not the root earns this
 *     field alone, so partial credit at most;
 *   - false roots, one field for every window, a clean one's only field but
 *     the next: no finding of kind "root" names a call these rules do not make
 *     a root (a promise the log holds, a complaint logged, a call raising a
 *     complaint again, or the right call under the wrong error). Calling a
 *     contact a staff error that it is not is the error a QA reviewer must not
 *     make, so one such finding fails the window whatever else is right;
 *   - extra findings: a symptom no label names, or a second finding on one
 *     thing, counted, at most `AUDIT_EXTRA_FINDINGS_CAP`.
 * A pass is every field right. An empty submission passes a clean window and
 * nothing else; no submission at all passes nothing.
 */

import { cents } from "@hm/kernel/money";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import {
  STAFF_ERRORS,
  STAFF_ERROR_IDS,
  type StaffErrorId,
  type StaffLabel,
  type StaffSymptom,
} from "../contacts/index.js";
import { AUDIT_EXTRA_FINDINGS_CAP } from "./rulebook.js";
import type { AuditPlan, ContactAuditTask } from "./task.js";

export interface AuditFinding {
  readonly error: StaffErrorId;
  readonly kind: "root" | StaffSymptom;
  readonly contact: string;
  /** An S-01 root's promise as the note gives it; null on every other finding. */
  readonly promise: { readonly amount: string; readonly pay_by: string } | null;
}

export interface ContactAuditAnswer {
  readonly findings: readonly AuditFinding[];
}

const MONEY = /^\$?\d{1,3}(,\d{3})*\.\d{2}$|^\$?\d+\.\d{2}$/;
/** An amount as the grader compares it, in cents; null when it is not dollars and cents. */
export function amountCents(s: string): bigint | null {
  const t = s.trim();
  if (!MONEY.test(t)) return null;
  return cents(t.replace(/[$,]/g, ""));
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseContactAuditSubmission(raw: unknown): Parsed<ContactAuditAnswer> {
  const bad = (error: string): Parsed<ContactAuditAnswer> => ({ ok: false, error });
  if (!isObj(raw)) return bad("submit_audit takes an object with a findings list");
  const extra = Object.keys(raw).filter((k) => k !== "findings");
  if (extra.length) return bad(`unknown fields: ${extra.join(", ")}`);
  const fs = raw["findings"];
  if (!Array.isArray(fs)) return bad("findings must be a list (empty when there are none)");
  const out: AuditFinding[] = [];
  for (const [k, f] of fs.entries()) {
    if (!isObj(f)) return bad(`finding ${k} must be an object`);
    const unknown = Object.keys(f).filter(
      (x) => !["error", "kind", "contact", "promise"].includes(x),
    );
    if (unknown.length) return bad(`finding ${k}: unknown fields ${unknown.join(", ")}`);
    const error = f["error"];
    if (typeof error !== "string" || !(STAFF_ERROR_IDS as readonly string[]).includes(error))
      return bad(`finding ${k}: error must be one of ${STAFF_ERROR_IDS.join(", ")}`);
    const kinds = ["root", ...STAFF_ERRORS[error as StaffErrorId].symptoms];
    const kind = f["kind"];
    if (typeof kind !== "string" || !kinds.includes(kind))
      return bad(`finding ${k}: kind must be one of ${kinds.join(", ")} for ${error}`);
    const contact = f["contact"];
    if (typeof contact !== "string" || !contact.trim())
      return bad(`finding ${k}: contact must name a contact id`);
    const p = f["promise"] ?? null;
    let promise: AuditFinding["promise"] = null;
    if (error === "S-01" && kind === "root") {
      if (!isObj(p) || Object.keys(p).some((x) => x !== "amount" && x !== "pay_by"))
        return bad(`finding ${k}: an S-01 root gives its promise as {amount, pay_by}`);
      if (typeof p["amount"] !== "string" || amountCents(p["amount"]) === null)
        return bad(
          `finding ${k}: the promise's amount is dollars and cents, as 1234.56 or $1,234.56`,
        );
      if (typeof p["pay_by"] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p["pay_by"]))
        return bad(`finding ${k}: the promise's pay_by is a date, YYYY-MM-DD`);
      promise = { amount: p["amount"].trim(), pay_by: p["pay_by"] };
    } else if (p !== null) return bad(`finding ${k}: only an S-01 root gives a promise; give null`);
    out.push({
      error: error as StaffErrorId,
      kind: kind as AuditFinding["kind"],
      contact: contact.trim(),
      promise,
    });
  }
  return { ok: true, answer: { findings: out } };
}

const keyOf = (error: string, kind: string, contact: string) => `${error}|${kind}|${contact}`;
const labelKey = (l: StaffLabel) =>
  keyOf(l.defect_id, l.root_cause ? "root" : l.symptom!, l.contact!);

/** The answer the labels give: every root, with an S-01 root's promise, and every symptom a rule names. */
export function expectedContactAudit(task: ContactAuditTask): ContactAuditAnswer {
  return {
    findings: task.labels.map((l) => ({
      error: l.defect_id as StaffErrorId,
      kind: l.root_cause ? ("root" as const) : l.symptom!,
      contact: l.contact!,
      promise: l.root_cause && l.promise ? { ...l.promise } : null,
    })),
  };
}

export function gradeContactAudit(
  task: ContactAuditTask,
  answer: ContactAuditAnswer | null,
): Grade {
  const roots = new Map(task.labels.filter((l) => l.root_cause).map((l) => [labelKey(l), l]));
  const symptoms = new Map(task.labels.filter((l) => !l.root_cause).map((l) => [labelKey(l), l]));
  const matched = new Map<string, AuditFinding>();
  const named = new Set<string>();
  const falseRoots: AuditFinding[] = [];
  const extra: AuditFinding[] = [];
  for (const f of answer?.findings ?? []) {
    const k = keyOf(f.error, f.kind, f.contact);
    if (f.kind === "root") {
      if (!roots.has(k)) falseRoots.push(f);
      else if (matched.has(k)) extra.push(f);
      else matched.set(k, f);
    } else if (symptoms.has(k) && !named.has(k)) named.add(k);
    else extra.push(f);
  }
  const fields: FieldGrade[] = [];
  const add = (field: string, expected: string, got: string | null, ok: boolean) =>
    fields.push({ field, expected, got, ok });
  const said = (f: { readonly error: string; readonly contact: string }) =>
    `${f.error} root on ${f.contact}`;
  for (const [k, l] of [...roots].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const f = matched.get(k);
    const at = `${l.defect_id} ${l.contact}`;
    add(`${at}: found`, `${l.defect_id} root on ${l.contact}`, f ? said(f) : null, !!f);
    if (l.promise) {
      const want = l.promise;
      const got = f?.promise ?? null;
      add(
        `${at}: promise`,
        `${want.amount} by ${want.pay_by}`,
        got ? `${got.amount} by ${got.pay_by}` : null,
        got !== null &&
          amountCents(got.amount) === amountCents(want.amount) &&
          got.pay_by === want.pay_by,
      );
    }
    const own = [...symptoms].filter(([, s]) => s.defect_id === l.defect_id);
    if (own.length) {
      const seen = own.filter(([sk]) => named.has(sk));
      const list = (xs: typeof own) => xs.map(([, s]) => `${s.symptom} on ${s.contact}`).join(", ");
      add(
        `${at}: symptoms`,
        list(own),
        seen.length ? list(seen) : null,
        seen.length === own.length,
      );
    }
  }
  add(
    "false roots",
    "none",
    falseRoots.length ? falseRoots.map(said).join(", ") : "none",
    falseRoots.length === 0,
  );
  add(
    "extra findings",
    `at most ${AUDIT_EXTRA_FINDINGS_CAP}`,
    String(extra.length),
    extra.length <= AUDIT_EXTRA_FINDINGS_CAP,
  );
  // No submission passes nothing, not even a clean window: calling it clean is a decision, and none was made.
  if (answer === null)
    return { pass: false, score: 0, fields: fields.map((x) => ({ ...x, got: null, ok: false })) };
  const right = fields.filter((x) => x.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

/** What a task holds, for a run's tally. */
export function contactAuditVerdict(task: ContactAuditTask): AuditPlan {
  const ids = [...new Set(task.labels.filter((l) => l.root_cause).map((l) => l.defect_id))].sort();
  return ids.length === 0 ? "clean" : (ids.join("+") as AuditPlan);
}
