/**
 * The grader: the delivery's label manifest, read the way the servicing app's
 * own test reads its sample's designed outcomes
 * (`apps/servicing/src/domain/boarding/demo-batch.test.ts:77-87`): every
 * planted defect must be found, and a finding the manifest does not name is
 * allowed, up to a cap. A found defect must also say what the tape says, what
 * is true (or that it cannot be known), and what to ask the partner; and the
 * delivery's verdict must be the one its defects give.
 *
 * The fields:
 *   - for each expected finding: found (its defect, month, loan and column),
 *     says and truth (but for T-01, which names a file and no cell), and ask;
 *   - the verdict: load, load_after_correction or hold;
 *   - the extra findings, all together: a finding no label names, or a
 *     second finding on one, counted, at most `EXTRA_FINDINGS_CAP`.
 * A clean delivery has only the last two. A pass is every field right. Money
 * is compared in cents, a date as the date it names (m/d/yyyy or
 * yyyy-mm-dd), a header as the reader compares one, a code exactly, and a
 * blank as any of null, "", blank or empty. No submission passes nothing.
 */

import { cents } from "@hm/kernel/money";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import { layoutColumn, normalizeHeader } from "./layout.js";

/** Findings beyond the labels a submission may make and still pass. */
export const EXTRA_FINDINGS_CAP = 2;

/** The defects a finding may name: the five tape-stream defects and the three history errors that show on a tape. */
export const INTAKE_DEFECTS = [
  "T-01",
  "T-02",
  "T-03",
  "T-04",
  "T-05",
  "V-01",
  "V-02",
  "D-25",
] as const;
export type IntakeDefect = (typeof INTAKE_DEFECTS)[number];

/** What to ask the partner. */
export const ASKS = [
  "send_missing_month",
  "send_this_month",
  "restore_header",
  "export_codes_as_text",
  "export_dates_in_layout",
  "write_month_end_as_of",
  "research_disbursement",
  "confirm_insurance_billing",
  "move_payment",
] as const;
export type Ask = (typeof ASKS)[number];

export const VERDICTS = ["load", "load_after_correction", "hold"] as const;
export type IntakeVerdict = (typeof VERDICTS)[number];

export interface IntakeFinding {
  readonly defect: IntakeDefect;
  /** The month of the tape it is on, "YYYY-MM"; for a month never delivered, that month. */
  readonly month: string;
  /** The partner's loan number, or null for a defect in the file as a whole. */
  readonly loan: string | null;
  /** The layout's header of the column it is in, or null for a defect in no one column. */
  readonly column: string | null;
  readonly says: string | null;
  /** What is true, or null when the delivery cannot say. */
  readonly truth: string | null;
  readonly ask: Ask;
}

export interface IntakeAnswer {
  readonly verdict: IntakeVerdict;
  readonly findings: readonly IntakeFinding[];
}

/** How a value is compared. */
export type Compare = "text" | "header" | "date" | "money";

/** A finding the labels give, with how each value is compared and what it does to the delivery. */
export interface ExpectedFinding extends IntakeFinding {
  readonly says_as: Compare;
  readonly truth_as: Compare;
  /** The delivery as delivered: loads as it is, once corrected at the desk, or not until the partner sends again. */
  readonly effect: "none" | "corrected" | "hold";
}

export interface IntakeExpected {
  readonly verdict: IntakeVerdict;
  readonly findings: readonly ExpectedFinding[];
}

export function verdictOf(effects: readonly ExpectedFinding["effect"][]): IntakeVerdict {
  return effects.includes("hold")
    ? "hold"
    : effects.includes("corrected")
      ? "load_after_correction"
      : "load";
}

const BLANKS = new Set(["", "blank", "(blank)", "empty", "(empty)", "null"]);
const MONEY = /^-?\$?\d{1,3}(,?\d{3})*(\.\d{1,2})?$|^-?\$?\d+(\.\d{1,2})?$/;
const isBlank = (v: string | null) => v === null || BLANKS.has(v.trim().toLowerCase());

/** A date in m/d/yyyy or yyyy-mm-dd as yyyy-mm-dd, else null. */
function dateOf(v: string): string | null {
  const t = v.trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  return m ? t : null;
}

/** Whether two values are the same, compared as `as` says. */
export function sameValue(as: Compare, got: string | null, want: string | null): boolean {
  if (isBlank(want)) return isBlank(got);
  if (isBlank(got)) return false;
  const g = got!.trim();
  const w = want!.trim();
  if (as === "header") return normalizeHeader(g) === normalizeHeader(w);
  if (as === "money")
    return (
      MONEY.test(g) &&
      MONEY.test(w) &&
      cents(g.replace(/[$,]/g, "")) === cents(w.replace(/[$,]/g, ""))
    );
  if (as === "date") {
    const a = dateOf(g);
    return a !== null && a === dateOf(w);
  }
  return g === w;
}

/** A column named by a letter or by any header the layout gives it, as the layout's header. */
const columnName = (c: string | null): string | null =>
  c === null || isBlank(c) ? null : (layoutColumn(c)?.header ?? c.trim());

const keyOf = (f: Pick<IntakeFinding, "defect" | "month" | "loan" | "column">) =>
  [
    f.defect,
    f.month.trim(),
    f.loan === null || isBlank(f.loan) ? "*" : f.loan.trim(),
    normalizeHeader(columnName(f.column) ?? "*"),
  ].join("|");

export function parseIntakeSubmission(raw: unknown): Parsed<IntakeAnswer> {
  const bad = (error: string): Parsed<IntakeAnswer> => ({ ok: false, error });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return bad("the submission must be an object with a verdict and a findings list");
  const o = raw as Record<string, unknown>;
  if (!VERDICTS.includes(o["verdict"] as IntakeVerdict))
    return bad(`verdict must be one of ${VERDICTS.join(", ")}`);
  const fs = o["findings"];
  if (!Array.isArray(fs)) return bad("findings must be a list (empty when there are none)");
  const out: IntakeFinding[] = [];
  for (const [k, f] of fs.entries()) {
    if (!f || typeof f !== "object" || Array.isArray(f))
      return bad(`finding ${k} must be an object`);
    const x = f as Record<string, unknown>;
    const strOrNull = (n: string) => x[n] === null || typeof x[n] === "string";
    if (!INTAKE_DEFECTS.includes(x["defect"] as IntakeDefect))
      return bad(`finding ${k}: defect must be one of ${INTAKE_DEFECTS.join(", ")}`);
    if (typeof x["month"] !== "string" || !/^\d{4}-\d{2}$/.test(x["month"].trim()))
      return bad(`finding ${k}: month must be YYYY-MM`);
    for (const n of ["loan", "column", "says", "truth"])
      if (!strOrNull(n)) return bad(`finding ${k}: ${n} must be text, or null`);
    if (!ASKS.includes(x["ask"] as Ask))
      return bad(`finding ${k}: ask must be one of ${ASKS.join(", ")}`);
    out.push({
      defect: x["defect"] as IntakeDefect,
      month: (x["month"] as string).trim(),
      loan: x["loan"] as string | null,
      column: x["column"] as string | null,
      says: x["says"] as string | null,
      truth: x["truth"] as string | null,
      ask: x["ask"] as Ask,
    });
  }
  return { ok: true, answer: { verdict: o["verdict"] as IntakeVerdict, findings: out } };
}

/** What happened to each expected finding, and which were extra. */
export function readFindings(expected: IntakeExpected, answer: IntakeAnswer) {
  const want = new Map(expected.findings.map((f) => [keyOf(f), f]));
  const matched = new Map<string, IntakeFinding>();
  const extra: IntakeFinding[] = [];
  for (const f of answer.findings) {
    const k = keyOf(f);
    if (want.has(k) && !matched.has(k)) matched.set(k, f);
    else extra.push(f);
  }
  return { want, matched, extra };
}

export function gradeIntakeAgainst(expected: IntakeExpected, answer: IntakeAnswer | null): Grade {
  const { want, matched, extra } = readFindings(
    expected,
    answer ?? { verdict: "load", findings: [] },
  );
  const fields: FieldGrade[] = [];
  const add = (field: string, exp: string, got: string | null, ok: boolean) =>
    fields.push({ field, expected: exp, got, ok });
  for (const [k, w] of [...want].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const f = matched.get(k);
    const at = `${w.defect} ${w.month} ${w.loan ?? "*"} ${w.column ?? "*"}`;
    add(
      `${at}: found`,
      at,
      f ? `${f.defect} ${f.month} ${f.loan ?? "*"} ${f.column ?? "*"}` : null,
      !!f,
    );
    if (w.defect !== "T-01") {
      add(
        `${at}: says`,
        JSON.stringify(w.says),
        f ? JSON.stringify(f.says) : null,
        !!f && sameValue(w.says_as, f.says, w.says),
      );
      add(
        `${at}: truth`,
        JSON.stringify(w.truth),
        f ? JSON.stringify(f.truth) : null,
        !!f && sameValue(w.truth_as, f.truth, w.truth),
      );
    }
    add(`${at}: ask`, w.ask, f ? f.ask : null, !!f && f.ask === w.ask);
  }
  add(
    "verdict",
    expected.verdict,
    answer ? answer.verdict : null,
    !!answer && answer.verdict === expected.verdict,
  );
  add(
    "extra findings",
    `at most ${EXTRA_FINDINGS_CAP}`,
    String(extra.length),
    extra.length <= EXTRA_FINDINGS_CAP,
  );
  // No submission passes nothing, not even a clean delivery: loading it is a decision, and none was made.
  if (answer === null)
    return { pass: false, score: 0, fields: fields.map((x) => ({ ...x, got: null, ok: false })) };
  const right = fields.filter((x) => x.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}
