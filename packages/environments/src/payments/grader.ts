/**
 * The grader is the servicing app's cashiering engine.
 *
 * `allocate` and `assessLateCharge` are the ported engine itself. The
 * harness around them is the servicing app's daily convention, restated
 * from the lines it comes from:
 *   - each day's late-charge run comes first, before that day's receipts
 *     (the 00:30 run, ops-2-7.ts dailyRun);
 *   - it assesses every installment, in the loan's order, whose grace end
 *     was the previous day, paid or not (ops-2-7.ts:109-111);
 *   - an assessed or accrued-suspended fee is recorded on the loan at once
 *     (ops.ts runAssessment: recordFee);
 *   - then each of the day's receipts is allocated in the order given, each
 *     against the loan the one before it left (allocate's `next`).
 * In v1 a receipt is credited the day it is received, and nothing is
 * waiting to be posted.
 */

import { addDays, type PlainDate } from "@hm/kernel/calendar";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import { allocate, type AllocationPlan } from "./ported/allocation.js";
import {
  assessLateCharge,
  graceEndFor,
  recordFee,
  type AssessmentResult,
} from "./ported/latecharges.js";
import type { LoanCashState } from "./ported/types.js";
import type { PaymentsTask, Receipt } from "./task.js";

export interface PostedReceipt {
  readonly payment_id: string;
  readonly outcome: string;
  readonly installments: readonly {
    readonly due_date: string;
    readonly kind: string;
    readonly interest_cents: string;
    readonly principal_cents: string;
    readonly escrow_cents: string;
  }[];
  readonly late_charge_paid_cents: string;
  readonly curtailment_cents: string;
  readonly to_suspense_cents: string;
  readonly suspense_used_cents: string;
  readonly partial_hold: boolean;
  readonly redirected_curtailment: boolean;
  readonly refused_instruction: boolean;
}

export interface LateChargeRun {
  readonly installment_due_date: string;
  readonly run_on: string;
  readonly outcome: "assessed" | "accrued_suspended" | "not_assessed";
  readonly amount_cents: string | null;
}

export interface PaymentsAnswer {
  readonly receipts: readonly PostedReceipt[];
  readonly late_charge_runs: readonly LateChargeRun[];
  readonly final: {
    readonly upb_cents: string;
    readonly lpi_date: string | null;
    readonly suspense_cents: string;
    readonly late_charges_due_cents: string;
    readonly partial_count_12m: number;
    readonly installments: readonly { readonly due_date: string; readonly status: string }[];
  };
}

/** A deep copy of the loan, so recording a fee never reaches back into the task. */
const cloneLoan = (s: LoanCashState): LoanCashState => ({
  ...s,
  installments: s.installments.map((x) => ({ ...x })),
  holds: [...s.holds],
  fees: (s.fees ?? []).map((f) => ({ ...f })),
  overlays: (s.overlays ?? []).map((o) => ({ ...o })),
});

/** What the generator's scope guard is shown as the month is posted: the engine's own results. */
export interface PostingObserver {
  run?(due: PlainDate, result: AssessmentResult, state: LoanCashState): void;
  receipt?(rc: Receipt, plan: AllocationPlan, before: LoanCashState): void;
}

/** The month posted, day by day: the run, then the receipts. */
export function postMonth(task: PaymentsTask, observe: PostingObserver = {}): PaymentsAnswer {
  let state = cloneLoan(task.loan);
  const receipts: PostedReceipt[] = [];
  const runs: LateChargeRun[] = [];
  for (let d: PlainDate = task.window.from; d <= task.window.through; d = addDays(d, 1)) {
    const yesterday = addDays(d, -1);
    for (const inst of state.installments) {
      if (graceEndFor(state, inst.due_date) !== yesterday) continue;
      const r = assessLateCharge({
        state,
        installment_due_date: inst.due_date,
        run_on: d,
        unposted_receipts_on_or_before_grace: 0,
      });
      if (r.outcome === "assessed" || r.outcome === "accrued_suspended") recordFee(state, r.fee);
      if (r.outcome === "deferred_backlog")
        throw new RangeError(`${task.id}: a posting backlog is outside v1`);
      observe.run?.(inst.due_date, r, state);
      runs.push({
        installment_due_date: inst.due_date,
        run_on: d,
        outcome: r.outcome,
        amount_cents: r.outcome === "not_assessed" ? null : String(r.fee.amount_cents),
      });
    }
    for (const rc of task.receipts.filter((x) => x.received_on === d)) {
      const plan = allocate(state, {
        payment_id: rc.payment_id,
        amount_cents: rc.amount_cents,
        received_on: rc.received_on,
        credited_as_of: rc.received_on,
        designation: rc.designation,
        ...(rc.curtailment_cents !== undefined ? { curtailment_cents: rc.curtailment_cents } : {}),
        ...(rc.instruction_text !== undefined ? { instruction_text: rc.instruction_text } : {}),
      });
      observe.receipt?.(rc, plan, state);
      receipts.push({
        payment_id: rc.payment_id,
        outcome: plan.outcome,
        installments: plan.installments.map((x) => ({
          due_date: x.due_date,
          kind: x.kind,
          interest_cents: String(x.interest_cents),
          principal_cents: String(x.principal_cents),
          escrow_cents: String(x.escrow_cents),
        })),
        late_charge_paid_cents: String(plan.late_charge_cents),
        curtailment_cents: String(plan.curtailment_cents),
        to_suspense_cents: String(plan.to_suspense_cents),
        suspense_used_cents: String(plan.suspense_used_cents),
        partial_hold: plan.partial_hold,
        redirected_curtailment: plan.redirected_curtailment,
        refused_instruction: plan.refused_instruction !== undefined,
      });
      state = plan.next;
    }
  }
  return {
    receipts,
    late_charge_runs: runs,
    final: {
      upb_cents: String(state.upb_cents),
      lpi_date: state.lpi_date,
      suspense_cents: String(state.suspense_unapplied_cents),
      late_charges_due_cents: String(state.late_charges_due_cents),
      partial_count_12m: state.partial_count_12m,
      installments: [...state.installments]
        .sort((a, b) => (a.due_date < b.due_date ? -1 : 1))
        .map((x) => ({ due_date: x.due_date, status: x.status })),
    },
  };
}

export const expectedPayments = (task: PaymentsTask): PaymentsAnswer => postMonth(task);

/* ── grading ──────────────────────────────────────────────────────────────
 * A receipt is three fields: its outcome, the installments it applied, and
 * where the rest went (late charges, curtailment, suspense and the three
 * flags, together). A run is one field, its outcome and amount together. The
 * lists of receipts and of runs are a field each, and a run reported that
 * did not happen is a field of its own, so hedging is never cheaper than
 * committing. The final state is six fields. Most of a receipt's remainder
 * is zero on most receipts; grading it as one field keeps an answer that
 * posts nothing from scoring well.
 */

const REMAINDER = [
  "late_charge_paid_cents",
  "curtailment_cents",
  "to_suspense_cents",
  "suspense_used_cents",
  "partial_hold",
  "redirected_curtailment",
  "refused_instruction",
] as const;
const FINAL_FIELDS = [
  "upb_cents",
  "lpi_date",
  "suspense_cents",
  "late_charges_due_cents",
  "partial_count_12m",
  "installments",
] as const;

const canon = (v: unknown): string =>
  v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);
const runKey = (r: LateChargeRun) => `${r.installment_due_date}@${r.run_on}`;
const remainderOf = (r: PostedReceipt) => Object.fromEntries(REMAINDER.map((k) => [k, r[k]]));
const decisionOf = (r: LateChargeRun) => ({ outcome: r.outcome, amount_cents: r.amount_cents });

export function gradePaymentsAgainst(want: PaymentsAnswer, answer: PaymentsAnswer | null): Grade {
  const fields: FieldGrade[] = [];
  const check = (field: string, expected: unknown, got: unknown) => {
    const e = canon(expected);
    const g = answer ? canon(got) : null;
    fields.push({ field, expected: e, got: g, ok: g === e });
  };
  check(
    "receipts",
    want.receipts.map((r) => r.payment_id).sort(),
    (answer?.receipts ?? []).map((r) => r.payment_id).sort(),
  );
  for (const r of want.receipts) {
    const a = answer?.receipts.find((x) => x.payment_id === r.payment_id);
    check(`receipt[${r.payment_id}].outcome`, r.outcome, a?.outcome ?? null);
    check(`receipt[${r.payment_id}].installments`, r.installments, a?.installments ?? null);
    check(`receipt[${r.payment_id}].remainder`, remainderOf(r), a ? remainderOf(a) : null);
  }
  check(
    "late_charge_runs",
    want.late_charge_runs.map(runKey).sort(),
    (answer?.late_charge_runs ?? []).map(runKey).sort(),
  );
  for (const r of want.late_charge_runs) {
    const a = answer?.late_charge_runs.find((x) => runKey(x) === runKey(r));
    check(`late_charge[${runKey(r)}]`, decisionOf(r), a ? decisionOf(a) : null);
  }
  const expected = new Set(want.late_charge_runs.map(runKey));
  for (const a of answer?.late_charge_runs ?? [])
    if (!expected.has(runKey(a))) check(`late_charge[${runKey(a)}]`, "no run", decisionOf(a));
  for (const f of FINAL_FIELDS) check(`final.${f}`, want.final[f], answer?.final[f] ?? null);
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradePayments = (task: PaymentsTask, answer: PaymentsAnswer | null): Grade =>
  gradePaymentsAgainst(expectedPayments(task), answer);

/* ── the submission, read strictly ──────────────────────────────────────── */

const centsText = (v: unknown): string | null =>
  typeof v === "string" && /^-?\d+$/.test(v.trim())
    ? BigInt(v.trim()).toString()
    : typeof v === "number" && Number.isSafeInteger(v)
      ? String(v)
      : null;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const OUTCOMES = new Set([
  "applied",
  "applied_with_50_rule",
  "curtailment",
  "prepaid",
  "unapplied",
  "held_trial",
  "held_bk",
  "held_fc",
  "held_dispute",
  "held_other",
]);
const STATUSES = new Set(["due", "satisfied", "prepaid"]);
const byDue = <T extends { due_date: string }>(xs: T[]): T[] =>
  xs.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));

export function parsePaymentsSubmission(raw: unknown): Parsed<PaymentsAnswer> {
  const fail = (error: string): Parsed<PaymentsAnswer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_posting again.`,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("the submission must be an object");
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s["receipts"])) return fail("receipts must be a list, one entry per receipt");
  const receipts: PostedReceipt[] = [];
  const ids = new Set<string>();
  for (const r of s["receipts"] as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") return fail("each receipt must be an object");
    const id = r["payment_id"];
    if (typeof id !== "string" || id === "") return fail("each receipt needs its payment_id");
    if (ids.has(id)) return fail(`receipt ${id} is listed twice; give one entry per receipt`);
    ids.add(id);
    if (typeof r["outcome"] !== "string" || !OUTCOMES.has(r["outcome"]))
      return fail(`receipt ${id}: outcome must be one of ${[...OUTCOMES].join(", ")}`);
    const cents = [
      "late_charge_paid_cents",
      "curtailment_cents",
      "to_suspense_cents",
      "suspense_used_cents",
    ].map((k) => centsText(r[k]));
    if (cents.some((c) => c === null))
      return fail(`receipt ${String(r["payment_id"])}: amounts must be integer cents as strings`);
    if (!Array.isArray(r["installments"]))
      return fail(`receipt ${String(r["payment_id"])}: installments must be a list`);
    const insts = [];
    for (const x of r["installments"] as Record<string, unknown>[]) {
      const parts = ["interest_cents", "principal_cents", "escrow_cents"].map((k) =>
        centsText(x?.[k]),
      );
      if (
        !isDate(x?.["due_date"]) ||
        (x["kind"] !== "contractual" && x["kind"] !== "prepaid") ||
        parts.some((c) => c === null)
      )
        return fail(
          `receipt ${String(r["payment_id"])}: each installment needs due_date, kind (contractual or prepaid) and cents`,
        );
      insts.push({
        due_date: x["due_date"],
        kind: x["kind"],
        interest_cents: parts[0]!,
        principal_cents: parts[1]!,
        escrow_cents: parts[2]!,
      });
    }
    for (const k of ["partial_hold", "redirected_curtailment", "refused_instruction"])
      if (typeof r[k] !== "boolean")
        return fail(`receipt ${String(r["payment_id"])}: ${k} must be true or false`);
    receipts.push({
      payment_id: id,
      outcome: r["outcome"],
      // Applied oldest first; the order is the engine's, not something to be graded.
      installments: byDue(insts),
      late_charge_paid_cents: cents[0]!,
      curtailment_cents: cents[1]!,
      to_suspense_cents: cents[2]!,
      suspense_used_cents: cents[3]!,
      partial_hold: r["partial_hold"] as boolean,
      redirected_curtailment: r["redirected_curtailment"] as boolean,
      refused_instruction: r["refused_instruction"] as boolean,
    });
  }
  if (!Array.isArray(s["late_charge_runs"]))
    return fail("late_charge_runs must be a list (empty if none)");
  const runs: LateChargeRun[] = [];
  for (const r of s["late_charge_runs"] as Record<string, unknown>[]) {
    const o = r?.["outcome"];
    if (
      !isDate(r?.["installment_due_date"]) ||
      !isDate(r?.["run_on"]) ||
      (o !== "assessed" && o !== "accrued_suspended" && o !== "not_assessed")
    )
      return fail(
        "each late-charge run needs installment_due_date, run_on and an outcome of assessed, accrued_suspended or not_assessed",
      );
    const amount = r["amount_cents"] === null ? null : centsText(r["amount_cents"]);
    if (r["amount_cents"] !== null && amount === null)
      return fail("a late-charge amount must be integer cents as a string, or null");
    if ((o === "not_assessed") !== (amount === null))
      return fail(
        "a late-charge run's amount is null when it is not_assessed, and integer cents otherwise",
      );
    runs.push({
      installment_due_date: r["installment_due_date"],
      run_on: r["run_on"],
      outcome: o,
      amount_cents: amount,
    });
  }
  const f = s["final"] as Record<string, unknown> | undefined;
  if (!f || typeof f !== "object") return fail("final must be an object");
  const fc = ["upb_cents", "suspense_cents", "late_charges_due_cents"].map((k) => centsText(f[k]));
  if (fc.some((c) => c === null)) return fail("final amounts must be integer cents as strings");
  if (f["lpi_date"] !== null && !isDate(f["lpi_date"]))
    return fail("final.lpi_date must be a date or null");
  if (!Number.isInteger(f["partial_count_12m"]))
    return fail("final.partial_count_12m must be a whole number");
  if (!Array.isArray(f["installments"])) return fail("final.installments must be a list");
  for (const x of f["installments"] as Record<string, unknown>[])
    if (!isDate(x?.["due_date"]) || typeof x["status"] !== "string" || !STATUSES.has(x["status"]))
      return fail(
        "each final installment needs a due_date and a status of due, satisfied or prepaid",
      );
  return {
    ok: true,
    answer: {
      receipts,
      late_charge_runs: runs,
      final: {
        upb_cents: fc[0]!,
        lpi_date: (f["lpi_date"] as string | null) ?? null,
        suspense_cents: fc[1]!,
        late_charges_due_cents: fc[2]!,
        partial_count_12m: f["partial_count_12m"] as number,
        installments: byDue(
          (f["installments"] as Record<string, unknown>[]).map((x) => ({
            due_date: String(x["due_date"]),
            status: String(x["status"]),
          })),
        ),
      },
    },
  };
}
