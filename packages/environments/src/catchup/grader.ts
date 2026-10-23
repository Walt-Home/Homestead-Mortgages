/**
 * The grader is the servicing app's cashiering engine and its late-charge
 * function.
 *
 * Each late charge is held to the note with `lateChargeAmount(basis, pct,
 * cap)`, the port of apps/servicing/src/domain/cashiering/latecharges.ts:40,
 * which is the correction D-03's handling names (docs/synthetic-data-defects.md):
 * what is still owed falls to the allowed amount, and what was collected above
 * it is owed back. The receipt is then posted by the ported `allocate` against
 * the loan's cash state with that late-charge balance and the note's terms, as
 * the servicing app's posting run hands it over: received and credited the
 * same day, designation unspecified, no instruction. The task's state is the
 * one the life generator was about to post the receipt against, read off the
 * history at that moment (`LifeMoment`), after the day's late-charge run.
 */

import type { Cents } from "@hm/kernel/money";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import { allocate, type AllocationPlan } from "../payments/ported/allocation.js";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import type { LoanCashState } from "../payments/ported/types.js";
import type { CatchupTask } from "./task.js";

export interface CatchupAnswer {
  readonly installments: readonly {
    readonly due_date: string;
    readonly kind: string;
    readonly interest_cents: string;
    readonly principal_cents: string;
    readonly escrow_cents: string;
  }[];
  readonly late_charge_paid_cents: string;
  readonly to_suspense_cents: string;
  readonly late_charges: readonly {
    readonly installment_due_date: string;
    readonly allowed_cents: string;
  }[];
  readonly refund_due_cents: string;
  readonly late_charges_due_after_cents: string;
  readonly upb_after_cents: string;
  readonly lpi_after: string | null;
  readonly current_after_posting: boolean;
}

/** Each late charge held to the note: what it may be, what is still owed on it, and what was collected above it. */
export function heldToNote(task: CatchupTask) {
  const { pct, cap_cents } = task.note.late_charge;
  const charges = task.late_charges.map((f) => {
    const allowed = lateChargeAmount(f.installment_pi_cents, pct, cap_cents);
    return {
      ...f,
      allowed,
      owed: allowed > f.collected_cents ? allowed - f.collected_cents : 0n,
      over: f.collected_cents > allowed ? f.collected_cents - allowed : 0n,
    };
  });
  return {
    charges,
    late_charges_due: charges.reduce((s, c) => s + c.owed, 0n),
    refund_due: charges.reduce((s, c) => s + c.over, 0n),
  };
}

/** The cash state the receipt is posted against: the system's, with every late charge held to the note. */
export function catchupCashState(task: CatchupTask): LoanCashState {
  const held = heldToNote(task);
  const terms = task.note.late_charge;
  return {
    loan_id: task.loan_number,
    instrument_date: task.loan.instrument_date,
    lien: task.loan.lien,
    escrowed: task.loan.escrowed,
    note_rate_pct: task.loan.note_rate_pct,
    remittance_type: "A/A",
    upb_cents: task.loan.upb_cents,
    lpi_date: task.loan.lpi_date,
    installments: task.loan.installments.map((i) => ({
      due_date: i.due_date,
      pi_cents: i.pi_cents,
      escrow_cents: i.escrow_cents,
      status: i.status,
      ...(i.satisfied_on ? { satisfied_on: i.satisfied_on, credited_as_of: i.satisfied_on } : {}),
    })),
    late_charges_due_cents: held.late_charges_due,
    nsf_fees_due_cents: 0n,
    other_fees_due_cents: 0n,
    suspense_unapplied_cents: task.loan.suspense_cents,
    holds: [],
    trial_active: false,
    plan_active: false,
    partial_count_12m: task.loan.partial_count_12m,
    opted_out_of_50_rule: false,
    late_charge_pct: terms.pct,
    late_charge_grace_days: terms.grace_days,
    late_charge_cap_cents: terms.cap_cents,
    late_charge_basis: terms.basis,
    fees: [],
    overlays: [],
  };
}

/** The receipt posted by the engine, with what the scope guard reads. */
export function postCatchup(task: CatchupTask): {
  readonly state: LoanCashState;
  readonly plan: AllocationPlan;
  readonly held: ReturnType<typeof heldToNote>;
} {
  const state = catchupCashState(task);
  const plan = allocate(state, {
    payment_id: task.receipt.payment_id,
    amount_cents: task.receipt.amount_cents,
    received_on: task.receipt.received_on,
    credited_as_of: task.receipt.received_on,
    designation: "unspecified",
  });
  return { state, plan, held: heldToNote(task) };
}

const c = (v: Cents): string => v.toString();

export function expectedCatchup(task: CatchupTask): CatchupAnswer {
  const { plan, held } = postCatchup(task);
  const due = plan.next.installments.filter((i) => i.status === "due");
  return {
    installments: plan.installments.map((x) => ({
      due_date: x.due_date,
      kind: x.kind,
      interest_cents: c(x.interest_cents),
      principal_cents: c(x.principal_cents),
      escrow_cents: c(x.escrow_cents),
    })),
    late_charge_paid_cents: c(plan.late_charge_cents),
    to_suspense_cents: c(plan.to_suspense_cents),
    late_charges: held.charges
      .map((x) => ({ installment_due_date: x.installment_due_date, allowed_cents: c(x.allowed) }))
      .sort((a, b) => (a.installment_due_date < b.installment_due_date ? -1 : 1)),
    refund_due_cents: c(held.refund_due),
    late_charges_due_after_cents: c(plan.next.late_charges_due_cents),
    upb_after_cents: c(plan.next.upb_cents),
    lpi_after: plan.next.lpi_date,
    current_after_posting: !due.some((i) => i.due_date <= task.receipt.received_on),
  };
}

/** Whether any charge the system recorded is above what the note allows. */
export const capBreached = (task: CatchupTask): boolean =>
  heldToNote(task).charges.some((x) => x.amount_cents > x.allowed);

/** The task's outcome, as the runner and the playground tally it. */
export function catchupVerdict(task: CatchupTask): string {
  const a = expectedCatchup(task);
  return [
    capBreached(task) ? "above the note's cap" : "within the note",
    a.refund_due_cents !== "0" ? "refund due" : "nothing to refund",
    a.current_after_posting ? "current" : "still behind",
  ].join(", ");
}

/* ── grading ──────────────────────────────────────────────────────────────
 * Nine fields: the installments the receipt applied (a list, each with its
 * split), the late charge it paid, what it sent to suspense, every late
 * charge held to the note (a list), the refund due, and four of the state
 * after posting. A pass is every field right. The installment the loan is
 * paid through is graded, not the next one due: the history projects one
 * installment ahead, and a payment that prepays it leaves none open.
 */

const FIELDS = [
  "installments",
  "late_charge_paid_cents",
  "to_suspense_cents",
  "late_charges",
  "refund_due_cents",
  "late_charges_due_after_cents",
  "upb_after_cents",
  "lpi_after",
  "current_after_posting",
] as const;

const canon = (v: unknown): string =>
  v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);

export function gradeCatchupAgainst(want: CatchupAnswer, answer: CatchupAnswer | null): Grade {
  const fields: FieldGrade[] = FIELDS.map((f) => {
    const expected = canon(want[f]);
    const got = answer ? canon(answer[f]) : null;
    return { field: f, expected, got, ok: got === expected };
  });
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradeCatchup = (task: CatchupTask, answer: CatchupAnswer | null): Grade =>
  gradeCatchupAgainst(expectedCatchup(task), answer);

/* ── the submission, read strictly ──────────────────────────────────────── */

const centsText = (v: unknown): string | null =>
  typeof v === "string" && /^-?\d+$/.test(v.trim())
    ? BigInt(v.trim()).toString()
    : typeof v === "number" && Number.isSafeInteger(v)
      ? String(v)
      : null;
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const byDue = <T>(xs: T[], due: (x: T) => string): T[] =>
  xs.sort((a, b) => (due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : 0));

export function parseCatchupSubmission(raw: unknown): Parsed<CatchupAnswer> {
  const fail = (error: string): Parsed<CatchupAnswer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_posting again.`,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("the submission must be an object");
  const s = raw as Record<string, unknown>;

  if (!Array.isArray(s["installments"]))
    return fail("installments must be a list, one entry per installment applied");
  const installments: CatchupAnswer["installments"][number][] = [];
  for (const x of s["installments"] as Record<string, unknown>[]) {
    const parts = ["interest_cents", "principal_cents", "escrow_cents"].map((k) =>
      centsText(x?.[k]),
    );
    if (
      !isDate(x?.["due_date"]) ||
      (x["kind"] !== "contractual" && x["kind"] !== "prepaid") ||
      parts.some((p) => p === null)
    )
      return fail(
        "each installment needs a due_date, a kind (contractual or prepaid) and its interest, principal and escrow as integer cents",
      );
    if (installments.some((y) => y.due_date === x["due_date"]))
      return fail(`installment ${x["due_date"]} is listed twice`);
    installments.push({
      due_date: x["due_date"],
      kind: x["kind"],
      interest_cents: parts[0]!,
      principal_cents: parts[1]!,
      escrow_cents: parts[2]!,
    });
  }

  if (!Array.isArray(s["late_charges"]))
    return fail("late_charges must be a list, one entry per late charge on the loan");
  const charges: CatchupAnswer["late_charges"][number][] = [];
  for (const x of s["late_charges"] as Record<string, unknown>[]) {
    const allowed = centsText(x?.["allowed_cents"]);
    if (!isDate(x?.["installment_due_date"]) || allowed === null)
      return fail("each late charge needs its installment_due_date and allowed_cents");
    if (charges.some((y) => y.installment_due_date === x["installment_due_date"]))
      return fail(`the late charge on ${x["installment_due_date"]} is listed twice`);
    charges.push({ installment_due_date: x["installment_due_date"], allowed_cents: allowed });
  }

  const amounts = [
    "late_charge_paid_cents",
    "to_suspense_cents",
    "refund_due_cents",
    "late_charges_due_after_cents",
    "upb_after_cents",
  ] as const;
  const read: Record<string, string> = {};
  for (const k of amounts) {
    const v = centsText(s[k]);
    if (v === null) return fail(`${k} must be integer cents as a string`);
    read[k] = v;
  }
  const lpi = s["lpi_after"] ?? null;
  if (lpi !== null && !isDate(lpi)) return fail("lpi_after must be a date, YYYY-MM-DD, or null");
  if (typeof s["current_after_posting"] !== "boolean")
    return fail("current_after_posting must be true or false");

  return {
    ok: true,
    answer: {
      // Applied oldest first; the order is the engine's, not something to be graded.
      installments: byDue(installments, (x) => x.due_date),
      late_charge_paid_cents: read["late_charge_paid_cents"]!,
      to_suspense_cents: read["to_suspense_cents"]!,
      late_charges: byDue(charges, (x) => x.installment_due_date),
      refund_due_cents: read["refund_due_cents"]!,
      late_charges_due_after_cents: read["late_charges_due_after_cents"]!,
      upb_after_cents: read["upb_after_cents"]!,
      lpi_after: lpi as string | null,
      current_after_posting: s["current_after_posting"],
    },
  };
}
