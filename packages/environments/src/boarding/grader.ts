/**
 * The grader: the package's label manifest, read the way the servicing app's
 * own test reads the sample batch's designed outcomes
 * (`apps/servicing/src/domain/boarding/demo-batch.test.ts:77-87`): every
 * planted defect must be found on its loan, and a finding the manifest does
 * not name is allowed, up to a cap. Here a found defect must also say what
 * the cell holds, what it should hold, and what to do about it; and a clean
 * loan must be passed, which is to say neither held nor changed.
 *
 * The manifest labels each defect's root, the cell planted, and its symptoms,
 * the cells the root reached or a reviewer's checks flag because of it. A
 * root is graded; a symptom is credit for having seen the defect at all.
 *
 * The fields:
 *   - for each root, four: found (a finding names its loan, file, column and,
 *     in a file of several rows per loan, its row), says (the cell as the file
 *     has it), truth (what the rest of the package says it should hold) and
 *     handling (one the label accepts);
 *   - for each root with symptoms, a fifth, traced: a finding names the root,
 *     or failing that one of its symptoms. A finding that names a symptom but
 *     not the root earns that field alone, so partial credit at most; one that
 *     names the root covers its symptoms, and a symptom found beside it is
 *     neither required nor extra;
 *   - for each clean loan, passed: no finding on it holds it or corrects it;
 *   - the extra findings, all together: a finding on a cell no label names,
 *     or a second finding on a cell, counted, at most `EXTRA_FINDINGS_CAP`.
 * A pass is every field right. Money is compared in cents ($50, 50 and 50.00
 * are one figure), a code exactly, and a blank as any of "", null, blank or
 * empty. An empty submission passes a package with nothing planted; no
 * submission at all passes nothing.
 */

import { cents } from "@hm/kernel/money";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import { HANDLINGS, type Handling } from "../life/defects.js";
import {
  PACKAGE_FILES,
  ROW_KEY,
  type PackageFile,
  type PackageLabel,
} from "../life/transfer-package.js";
import type { BoardingTask } from "./task.js";

/** Findings beyond the labels a submission may make and still pass. */
export const EXTRA_FINDINGS_CAP = 2;

export interface TriageFinding {
  /** The transferor loan number. */
  readonly loan: string;
  readonly file: string;
  /** The column. */
  readonly field: string;
  /** The row, in a file of several rows per loan (a payment history row's due date); null otherwise. */
  readonly row?: string | null;
  /** The cell as the file has it; "" or null for a blank. */
  readonly says: string | null;
  /** What the rest of the package says the cell should hold, or null when it cannot say. */
  readonly truth: string | null;
  readonly handling: Handling;
}

export interface TriageAnswer {
  readonly findings: readonly TriageFinding[];
}

/** The files with several rows per loan, whose findings name a row. */
export const MULTI_ROW_FILES: readonly PackageFile[] = Object.keys(ROW_KEY) as PackageFile[];

const BLANKS = new Set(["", "blank", "(blank)", "empty", "(empty)"]);
const MONEY = /^-?\$?\d{1,3}(,?\d{3})*(\.\d{1,2})?$|^-?\$?\d+(\.\d{1,2})?$/;

/** A cell as the grader compares it: a blank, a figure in cents, or the text. */
function cell(v: string | null): string {
  if (v === null) return "";
  const t = v.trim();
  if (BLANKS.has(t.toLowerCase())) return "";
  if (MONEY.test(t)) return `${cents(t.replace(/[$,]/g, ""))}¢`;
  return t;
}
export const sameCell = (a: string | null, b: string | null): boolean => cell(a) === cell(b);

const multi = (file: string) => (MULTI_ROW_FILES as readonly string[]).includes(file.trim());
/** Where a finding or a label points: the loan, file, column and, in a file of several rows per loan, the row. */
const key = (loan: string, file: string, field: string, row: string | null | undefined) =>
  `${loan.trim()}|${file.trim()}|${field.trim().toLowerCase()}${multi(file) ? `|${(row ?? "").trim()}` : ""}`;
const labelKey = (l: PackageLabel) => key(l.loan, l.file_or_table, l.field, l.row);

export function parseTriageSubmission(raw: unknown): Parsed<TriageAnswer> {
  const bad = (error: string): Parsed<TriageAnswer> => ({ ok: false, error });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return bad("the submission must be an object with a findings list");
  const fs = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(fs)) return bad("findings must be a list (empty when there are none)");
  const out: TriageFinding[] = [];
  for (const [k, f] of fs.entries()) {
    if (!f || typeof f !== "object" || Array.isArray(f))
      return bad(`finding ${k} must be an object`);
    const o = f as Record<string, unknown>;
    const str = (n: string) => typeof o[n] === "string" && (o[n] as string).trim().length > 0;
    const strOrNull = (n: string) => o[n] === null || typeof o[n] === "string";
    if (!str("loan")) return bad(`finding ${k}: loan must name a transferor loan number`);
    if (!str("file") || !(PACKAGE_FILES as readonly string[]).includes(o["file"] as string))
      return bad(`finding ${k}: file must be one of ${PACKAGE_FILES.join(", ")}`);
    if (!str("field")) return bad(`finding ${k}: field must name the column`);
    if (o["row"] !== undefined && !strOrNull("row"))
      return bad(`finding ${k}: row must be the row's key, or null for a file of one row per loan`);
    if (multi(o["file"] as string) && !str("row"))
      return bad(
        `finding ${k}: ${o["file"] as string} has several rows per loan, so row must name one (in payment_history.csv, its due_date)`,
      );
    if (!strOrNull("says"))
      return bad(`finding ${k}: says must be the cell's text, or null for a blank`);
    if (!strOrNull("truth"))
      return bad(`finding ${k}: truth must be text, or null when the package cannot say`);
    if (!HANDLINGS.includes(o["handling"] as Handling))
      return bad(`finding ${k}: handling must be one of ${HANDLINGS.join(", ")}`);
    out.push({
      loan: (o["loan"] as string).trim(),
      file: o["file"] as string,
      field: (o["field"] as string).trim(),
      row: multi(o["file"] as string) ? (o["row"] as string).trim() : null,
      says: o["says"] as string | null,
      truth: o["truth"] as string | null,
      handling: o["handling"] as Handling,
    });
  }
  return { ok: true, answer: { findings: out } };
}

/** The answer the labels give: one finding per root. */
export function expectedTriage(task: BoardingTask): TriageAnswer {
  return { findings: task.labels.filter((l) => l.root_cause).map(findingOf) };
}

export const findingOf = (l: PackageLabel): TriageFinding => ({
  loan: l.loan,
  file: l.file_or_table,
  field: l.field,
  row: multi(l.file_or_table) ? l.row : null,
  says: l.planted_value,
  truth: l.true_value,
  handling: l.handling,
});

/** What each finding matched: a root, a symptom, or nothing (an extra). */
export function readFindings(task: BoardingTask, answer: TriageAnswer) {
  const roots = new Map(task.labels.filter((l) => l.root_cause).map((l) => [labelKey(l), l]));
  const symptoms = new Map(task.labels.filter((l) => !l.root_cause).map((l) => [labelKey(l), l]));
  const matched = new Map<string, TriageFinding>();
  const named = new Set<string>();
  const extra: TriageFinding[] = [];
  for (const f of answer.findings) {
    const k = key(f.loan, f.file, f.field, f.row);
    if (roots.has(k) && !matched.has(k)) matched.set(k, f);
    else if (symptoms.has(k) && !named.has(k)) named.add(k);
    else extra.push(f);
  }
  return { roots, symptoms, matched, named, extra };
}

export function gradeTriage(task: BoardingTask, answer: TriageAnswer | null): Grade {
  const { roots, symptoms, matched, named, extra } = readFindings(task, answer ?? { findings: [] });
  const fields: FieldGrade[] = [];
  const add = (field: string, expected: string, got: string | null, ok: boolean) =>
    fields.push({ field, expected, got, ok });
  for (const [k, l] of [...roots].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const f = matched.get(k);
    const at = `${l.loan} ${l.field}${multi(l.file_or_table) ? ` ${l.row}` : ""}`;
    const accepted = [l.handling, ...l.also_accepted];
    add(`${at}: found`, `${l.file_or_table} ${l.field}`, f ? `${f.file} ${f.field}` : null, !!f);
    add(
      `${at}: says`,
      JSON.stringify(l.planted_value),
      f ? JSON.stringify(f.says) : null,
      !!f && sameCell(f.says, l.planted_value),
    );
    add(
      `${at}: truth`,
      JSON.stringify(l.true_value),
      f ? JSON.stringify(f.truth) : null,
      !!f && sameCell(f.truth, l.true_value),
    );
    add(
      `${at}: handling`,
      accepted.join(" or "),
      f ? f.handling : null,
      !!f && accepted.includes(f.handling),
    );
    // A root whose symptoms a reviewer may see first: credit for tracing the defect at all.
    const own = [...symptoms].filter(([, s]) => s.loan === l.loan && s.defect_id === l.defect_id);
    if (own.length) {
      const seen = own.filter(([sk]) => named.has(sk)).map(([, s]) => s.field);
      add(
        `${at}: traced`,
        `${l.field}, or one of ${own.map(([, s]) => s.field).join(", ")}`,
        f ? f.field : seen.length ? `${seen.join(", ")} (a symptom)` : null,
        !!f || seen.length > 0,
      );
    }
  }
  const defective = new Set(task.labels.map((l) => l.loan));
  for (const loan of task.loans.filter((n) => !defective.has(n))) {
    const acts = (answer?.findings ?? []).filter(
      (f) => f.loan.trim() === loan && (f.handling === "hold" || f.handling === "correct"),
    );
    add(
      `${loan}: passed`,
      "passed",
      acts.length === 0 ? "passed" : acts.map((f) => `${f.handling} ${f.field}`).join(", "),
      acts.length === 0,
    );
  }
  add(
    `extra findings`,
    `at most ${EXTRA_FINDINGS_CAP}`,
    String(extra.length),
    extra.length <= EXTRA_FINDINGS_CAP,
  );
  // No submission passes nothing, not even a clean loan: passing a loan is a decision, and none was made.
  if (answer === null)
    return { pass: false, score: 0, fields: fields.map((f) => ({ ...f, got: null, ok: false })) };
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

/** The task's verdict, for a run's tally: what the package holds. */
export function boardingVerdict(task: BoardingTask): string {
  const ids = [...new Set(task.labels.filter((l) => l.root_cause).map((l) => l.defect_id))].sort();
  return ids.length === 0 ? "clean" : ids.join("+");
}
