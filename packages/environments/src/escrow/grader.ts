/**
 * The grader is the servicing app's escrow engine.
 *
 * What a task should conclude is the ported engine run on the task's inputs,
 * composed the one way the rulebook describes: the lines projected (R1), the
 * year projected and cushioned (R2–R5), the projected actual balance from the
 * ledger (R6), the decision (R8), the new payment (R9), its effective date,
 * and the anomalies (R10). Every figure is held to the cent and every date to
 * the day; the anomalies as a set. A pass is every field right.
 */

import type { Cents } from "@hm/kernel/money";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import {
  anomalies,
  decide,
  effectiveDate,
  newPayment,
  project,
  projectLines,
  type Decision,
} from "./ported/analysis.js";
import type { EscrowTask } from "./task.js";

export const DECISIONS = ["balanced", "refund", "credit", "retain", "shortage"] as const;
export type EscrowDecision = (typeof DECISIONS)[number];

/** Cents as decimal strings, dates as YYYY-MM-DD; null where the decision has no such figure. */
export interface EscrowAnswer {
  readonly annual_cents: string;
  readonly base_payment_cents: string;
  readonly required_start_cents: string;
  readonly cushion_cents: string;
  readonly target_at_start_cents: string;
  readonly projected_actual_cents: string;
  readonly decision: EscrowDecision;
  readonly surplus_cents: string | null;
  readonly shortage_cents: string | null;
  readonly deficiency_cents: string | null;
  readonly repayment_months: number | null;
  readonly installment_cents: string | null;
  readonly final_installment_cents: string | null;
  readonly deficiency_installment_cents: string | null;
  readonly deficiency_final_installment_cents: string | null;
  readonly lump_sum_option_offered: boolean | null;
  readonly credit_monthly_cents: string | null;
  readonly first_month_extra_credit_cents: string | null;
  readonly refund_due_on: string | null;
  readonly new_payment_cents: string;
  readonly first_month_payment_cents: string;
  readonly final_month_payment_cents: string;
  readonly effective_on: string;
  readonly anomalies: readonly string[];
}

/** R6: the ledger's balance, plus what posts after the run date and before the new year, less what is paid out. */
export function projectedActual(task: EscrowTask): Cents {
  const counts = (on: string) => on > task.as_of && on < task.year_start;
  const sum = (xs: readonly { on: string; amount_cents: Cents }[]) =>
    xs.filter((x) => counts(x.on)).reduce((s, x) => s + x.amount_cents, 0n);
  return task.ledger.balance_cents + sum(task.ledger.deposits) - sum(task.ledger.disbursements);
}

/** The engine's run over the task, every intermediate kept for the tests. */
export function analyze(task: EscrowTask) {
  const lines = projectLines(task.lines, task.year_start, {
    cpi_change_pct: task.cpi_change_pct,
    as_of: task.as_of,
  });
  const projection = project(lines.items, task.year_start, {
    policy_months: task.cushion.policy_months,
    instrument_months: task.cushion.instrument_months,
    state_max_months: task.cushion.state_max_months,
  });
  const actual = projectedActual(task);
  const decision: Decision = decide({
    projection,
    projected_actual_cents: actual,
    as_of: task.as_of,
    regx_days_delinquent: task.regx_days_delinquent,
    workout: task.workout,
    borrower_election_months: task.borrower_election_months,
    instrument_shortage_max_months: task.instrument_shortage_max_months,
  });
  const payment = newPayment(projection, decision);
  const effective = effectiveDate(task.year_start, task.statement_sent_on);
  const flagged = [
    ...lines.anomalies,
    ...anomalies(task.current_escrow_payment_cents, payment.payment_cents, decision),
  ];
  return { lines, projection, actual, decision, payment, effective, anomalies: flagged };
}

const c = (v: Cents): string => v.toString();

export function expectedEscrow(task: EscrowTask): EscrowAnswer {
  const a = analyze(task);
  const d = a.decision;
  const p = a.projection;
  return {
    annual_cents: c(p.annual_cents),
    base_payment_cents: c(p.base_payment_cents),
    required_start_cents: c(p.required_start_cents),
    cushion_cents: c(p.cushion_cents),
    target_at_start_cents: c(p.target_at_start_cents),
    projected_actual_cents: c(a.actual),
    decision: d.kind,
    surplus_cents:
      d.kind === "refund" || d.kind === "credit" || d.kind === "retain" ? c(d.surplus_cents) : null,
    shortage_cents: d.kind === "shortage" ? c(d.shortage_cents) : null,
    deficiency_cents: d.kind === "shortage" ? c(d.deficiency_cents) : null,
    repayment_months: d.kind === "shortage" ? d.months : null,
    installment_cents: d.kind === "shortage" ? c(d.installment_cents) : null,
    final_installment_cents: d.kind === "shortage" ? c(d.final_installment_cents) : null,
    deficiency_installment_cents: d.kind === "shortage" ? c(d.deficiency_installment_cents) : null,
    deficiency_final_installment_cents: d.kind === "shortage" ? c(d.deficiency_final_cents) : null,
    lump_sum_option_offered: d.kind === "shortage" ? d.lump_sum_option_offered : null,
    credit_monthly_cents: d.kind === "credit" ? c(d.credit_monthly_cents) : null,
    first_month_extra_credit_cents: d.kind === "credit" ? c(d.first_month_extra_cents) : null,
    refund_due_on: d.kind === "refund" ? d.due_on : null,
    new_payment_cents: c(a.payment.payment_cents),
    first_month_payment_cents: c(a.payment.first_month_cents),
    final_month_payment_cents: c(a.payment.final_month_cents),
    effective_on: a.effective,
    anomalies: [...new Set(a.anomalies)].sort(),
  };
}

const FIELDS: readonly (keyof EscrowAnswer)[] = [
  "annual_cents",
  "base_payment_cents",
  "required_start_cents",
  "cushion_cents",
  "target_at_start_cents",
  "projected_actual_cents",
  "decision",
  "surplus_cents",
  "shortage_cents",
  "deficiency_cents",
  "repayment_months",
  "installment_cents",
  "final_installment_cents",
  "deficiency_installment_cents",
  "deficiency_final_installment_cents",
  "lump_sum_option_offered",
  "credit_monthly_cents",
  "first_month_extra_credit_cents",
  "refund_due_on",
  "new_payment_cents",
  "first_month_payment_cents",
  "final_month_payment_cents",
  "effective_on",
  "anomalies",
];

const shown = (v: unknown): string =>
  Array.isArray(v) ? [...new Set(v.map(String))].sort().join(",") : v === null ? "null" : String(v);

export function gradeEscrowAgainst(want: EscrowAnswer, answer: EscrowAnswer | null): Grade {
  const fields: FieldGrade[] = FIELDS.map((f) => {
    const expected = shown(want[f]);
    const got = answer ? shown(answer[f]) : null;
    return { field: f, expected, got, ok: got === expected };
  });
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradeEscrow = (task: EscrowTask, answer: EscrowAnswer | null): Grade =>
  gradeEscrowAgainst(expectedEscrow(task), answer);

/* ── the submission, read strictly ──────────────────────────────────────── */

const CENTS_FIELDS = new Set<keyof EscrowAnswer>([
  "annual_cents",
  "base_payment_cents",
  "required_start_cents",
  "cushion_cents",
  "target_at_start_cents",
  "projected_actual_cents",
  "surplus_cents",
  "shortage_cents",
  "deficiency_cents",
  "installment_cents",
  "final_installment_cents",
  "deficiency_installment_cents",
  "deficiency_final_installment_cents",
  "credit_monthly_cents",
  "first_month_extra_credit_cents",
  "new_payment_cents",
  "first_month_payment_cents",
  "final_month_payment_cents",
]);
const REQUIRED = new Set<keyof EscrowAnswer>([
  "annual_cents",
  "base_payment_cents",
  "required_start_cents",
  "cushion_cents",
  "target_at_start_cents",
  "projected_actual_cents",
  "decision",
  "new_payment_cents",
  "first_month_payment_cents",
  "final_month_payment_cents",
  "effective_on",
  "anomalies",
]);

export function parseEscrowSubmission(raw: unknown): Parsed<EscrowAnswer> {
  const fail = (error: string): Parsed<EscrowAnswer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_analysis again.`,
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
    } else if (f === "lump_sum_option_offered") {
      if (typeof v !== "boolean") return fail(`${f} must be true or false`);
      out[f] = v;
    } else if (f === "effective_on" || f === "refund_due_on") {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim()))
        return fail(`${f} must be a date, YYYY-MM-DD`);
      out[f] = v.trim();
    } else if (f === "anomalies") {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
        return fail("anomalies must be a list of codes");
      out[f] = v;
    }
  }
  return { ok: true, answer: out as unknown as EscrowAnswer };
}
