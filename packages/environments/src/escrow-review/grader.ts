/**
 * The grader is the servicing app's escrow engine.
 *
 * The analysis is escrow-analysis's composition of the ported engine,
 * `analyze`, run on the task's inputs: the lines projected, the year
 * cushioned, the projected actual balance, the decision, the new payment and
 * its effective date. The flag is the engine's own `anomalies` (spec §3.2
 * R10, apps/servicing/src/domain/escrow/analysis.ts:101-107) over the line
 * anomalies and the payments, handed `bill_variance_gt_20` as the servicing
 * app's `compareBillToPriorYear` computes it (apps/servicing/src/app/tools/section03.ts:144):
 * the variance in hundredths of a percent, `(current − prior) × 10000 ÷
 * prior` in integer division, and more than 20 % flags. The comparison is a
 * line's known bills for the year against its prior-year total, where both
 * exist. Every figure is held to the cent and every date to the day; the
 * anomalies as a set.
 */

import type { Cents } from "@hm/kernel/money";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import { DECISIONS, analyze, type EscrowDecision } from "../escrow/grader.js";
import { anomalies, type EscrowLineInput } from "../escrow/ported/analysis.js";
import { analysisOf, type EscrowReviewTask } from "./task.js";

export interface EscrowReviewAnswer {
  readonly annual_cents: string;
  readonly base_payment_cents: string;
  readonly target_at_start_cents: string;
  readonly projected_actual_cents: string;
  readonly decision: EscrowDecision;
  readonly surplus_cents: string | null;
  readonly shortage_cents: string | null;
  readonly deficiency_cents: string | null;
  readonly repayment_months: number | null;
  readonly new_payment_cents: string;
  readonly effective_on: string;
  readonly anomalies: readonly string[];
  readonly flag_stands: boolean;
}

/**
 * A line's bills against last year, as `compareBillToPriorYear` measures it:
 * hundredths of a percent, truncated toward zero; null where the line has no
 * bills or no prior year to compare with.
 */
export function billVariance(line: EscrowLineInput): number | null {
  const bills = line.known_bills ?? [];
  const prior = line.prior_year_annual_cents;
  if (bills.length === 0 || prior <= 0n) return null;
  const current = bills.reduce((s, b) => s + b.amount_cents, 0n);
  return Number(((current - prior) * 10_000n) / prior);
}

/** section03.ts:144: `Math.abs(varPct) > 20`, with varPct the variance ÷ 100. */
export const billVarianceFlags = (lines: readonly EscrowLineInput[]): boolean =>
  lines.some((l) => {
    const v = billVariance(l);
    return v !== null && Math.abs(v / 100) > 20;
  });

/** The engine's run over the task, and the triggers it would hold the analysis on. */
export function reviewAnalysis(task: EscrowReviewTask) {
  const a = analyze(analysisOf(task));
  const triggers = [
    ...a.lines.anomalies,
    ...anomalies(task.current_escrow_payment_cents, a.payment.payment_cents, a.decision, {
      bill_variance_gt_20: billVarianceFlags(task.lines),
    }),
  ];
  return { ...a, triggers: [...new Set(triggers)].sort() };
}

const c = (v: Cents): string => v.toString();

export function expectedEscrowReview(task: EscrowReviewTask): EscrowReviewAnswer {
  const r = reviewAnalysis(task);
  const d = r.decision;
  const p = r.projection;
  return {
    annual_cents: c(p.annual_cents),
    base_payment_cents: c(p.base_payment_cents),
    target_at_start_cents: c(p.target_at_start_cents),
    projected_actual_cents: c(r.actual),
    decision: d.kind,
    surplus_cents:
      d.kind === "refund" || d.kind === "credit" || d.kind === "retain" ? c(d.surplus_cents) : null,
    shortage_cents: d.kind === "shortage" ? c(d.shortage_cents) : null,
    deficiency_cents: d.kind === "shortage" ? c(d.deficiency_cents) : null,
    repayment_months: d.kind === "shortage" ? d.months : null,
    new_payment_cents: c(r.payment.payment_cents),
    effective_on: r.effective,
    anomalies: r.triggers,
    flag_stands: r.triggers.length > 0,
  };
}

/** The task's outcome, as the runner and the playground tally it. */
export function reviewVerdict(task: EscrowReviewTask): string {
  const a = expectedEscrowReview(task);
  return `${a.flag_stands ? "flag stands" : "no flag"}, ${a.decision}`;
}

const FIELDS: readonly (keyof EscrowReviewAnswer)[] = [
  "annual_cents",
  "base_payment_cents",
  "target_at_start_cents",
  "projected_actual_cents",
  "decision",
  "surplus_cents",
  "shortage_cents",
  "deficiency_cents",
  "repayment_months",
  "new_payment_cents",
  "effective_on",
  "anomalies",
  "flag_stands",
];

const shown = (v: unknown): string =>
  Array.isArray(v) ? [...new Set(v.map(String))].sort().join(",") : v === null ? "null" : String(v);

export function gradeReviewAgainst(
  want: EscrowReviewAnswer,
  answer: EscrowReviewAnswer | null,
): Grade {
  const fields: FieldGrade[] = FIELDS.map((f) => {
    const expected = shown(want[f]);
    const got = answer ? shown(answer[f]) : null;
    return { field: f, expected, got, ok: got === expected };
  });
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradeReview = (task: EscrowReviewTask, answer: EscrowReviewAnswer | null): Grade =>
  gradeReviewAgainst(expectedEscrowReview(task), answer);

/* ── the submission, read strictly ──────────────────────────────────────── */

const CENTS_FIELDS = new Set<keyof EscrowReviewAnswer>([
  "annual_cents",
  "base_payment_cents",
  "target_at_start_cents",
  "projected_actual_cents",
  "surplus_cents",
  "shortage_cents",
  "deficiency_cents",
  "new_payment_cents",
]);
const REQUIRED = new Set<keyof EscrowReviewAnswer>([
  "annual_cents",
  "base_payment_cents",
  "target_at_start_cents",
  "projected_actual_cents",
  "decision",
  "new_payment_cents",
  "effective_on",
  "anomalies",
  "flag_stands",
]);

export function parseReviewSubmission(raw: unknown): Parsed<EscrowReviewAnswer> {
  const fail = (error: string): Parsed<EscrowReviewAnswer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_review again.`,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("the submission must be an object");
  const s = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    const v = s[f] ?? null;
    if (v === null) {
      if (REQUIRED.has(f)) return fail(`${f} is required`);
      out[f] = null;
      continue;
    }
    if (CENTS_FIELDS.has(f)) {
      if (typeof v === "string" && /^-?\d+$/.test(v.trim())) out[f] = BigInt(v.trim()).toString();
      else if (typeof v === "number" && Number.isSafeInteger(v)) out[f] = String(v);
      else return fail(`${f} must be integer cents as a string, e.g. "13833"`);
    } else if (f === "decision") {
      if (typeof v !== "string" || !(DECISIONS as readonly string[]).includes(v))
        return fail(`decision must be one of ${DECISIONS.join(", ")}`);
      out[f] = v;
    } else if (f === "repayment_months") {
      if (typeof v !== "number" || !Number.isInteger(v)) return fail(`${f} must be a whole number`);
      out[f] = v;
    } else if (f === "flag_stands") {
      if (typeof v !== "boolean") return fail(`${f} must be true or false`);
      out[f] = v;
    } else if (f === "effective_on") {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim()))
        return fail(`${f} must be a date, YYYY-MM-DD`);
      out[f] = v.trim();
    } else if (f === "anomalies") {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
        return fail("anomalies must be a list of codes");
      out[f] = v;
    }
  }
  return { ok: true, answer: out as unknown as EscrowReviewAnswer };
}
