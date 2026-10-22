/**
 * The grader is the servicing app's loss-mitigation retention engines.
 *
 * The hierarchy walk, the tier and the decision windows are the ported
 * `evaluation.ts`; the forbearance term, its dates and the repayment plan's
 * term search are `plans.ts`; the deferral screen, its balance, its new
 * payment and its completion timeline are `deferral.ts`. The servicing app
 * has no orchestrator that turns a loan into the walk's facts: the walk takes
 * five booleans (`hierarchy.walk`, section12.ts:165, passes them straight
 * through). The conventions around the engines live in the stateful ops
 * layer and the spec, which do not port, so they are restated here exactly,
 * each with the line it comes from (a test holds those lines to the
 * service's source):
 *   - months delinquent: the installments due from the oldest unpaid one
 *     through the evaluation date, both included (12.6 rule 1: "number of
 *     unpaid contractual installments at evaluation");
 *   - the arrears: unpaid installments × PITI + late charges × their count
 *     (`arrears`, ops.ts:360-363);
 *   - the walk's facts, as 12.2 rule 2 composes them: reinstatement when the
 *     funds cover the arrears with late charges, forbearance on a temporary
 *     unresolved hardship, a repayment plan or a deferral only on a resolved
 *     one, and Flex Modification as its own evaluation found;
 *   - months to maturity: whole months from the evaluation to the maturity
 *     date, the same count the whole_months_between tool gives;
 *   - the forbearance term: it starts on the 1st of the month after the
 *     evaluation (12.4-T1), with the delinquency then as it stands at the
 *     evaluation, through `termComputation` (ops-12-4.ts:66-70) on a loan
 *     with no MBS maturity cap and no repayment component; the Reg X
 *     short-term test of the forborne months with the term
 *     (`forbearanceBasisGate`, ops.ts:216-217);
 *   - the deferral's installments to pay (`capStructure`, ops.ts:368-372, as
 *     `offerDeferral` takes it at ops-12-6.ts:103), its cumulative months
 *     after (ops-12-6.ts:109) and its completion timeline with the partner's
 *     election (ops-12-6.ts:106); the late charges it waives are the
 *     arrears' (`deferralLedger`, ops.ts:406);
 *   - the decision's tier and windows, from the complete date, the sale and
 *     the date the notice is provided (section12.ts:158-159).
 * Nothing here reads a clock: every date comes from the task.
 */

import { addDays, addMonths, parts, ymd, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import { monthsBetween } from "@hm/refi-review";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import {
  evaluationDeadlines,
  hierarchyWalk,
  tier,
  type Determination,
  type Option,
  type Tier,
} from "./ported/evaluation.js";
import {
  forbearanceTerm,
  forbearanceTermDates,
  regxShortTermForbearance,
  repaymentPlan,
} from "./ported/plans.js";
import {
  newPayment,
  nib,
  screen,
  timeline,
  type DeferralFacts,
  type Screen,
} from "./ported/deferral.js";
import type { LossmitTask } from "./task.js";

export const RETENTION = [
  "reinstatement",
  "forbearance",
  "repayment_plan",
  "payment_deferral",
  "flex_mod",
] as const;
export type Retention = (typeof RETENTION)[number];

/** The standard screen's reason codes, in the order the screen tests them (deferral.ts:29-35). */
export const SCREEN_REASONS = [
  "INV_FNMA_D23204_SEASONING_12M",
  "INV_FNMA_D23204_DELQ_WINDOW",
  "INV_FNMA_D23204_PRIOR_DEFERRAL_12M",
  "INV_FNMA_D23204_MATURITY",
  "INV_FNMA_D23204_CONFLICTING_ARRANGEMENT",
  "INV_FNMA_D23204_TRIAL_OR_MOD_12M",
] as const;
export type ScreenReason = (typeof SCREEN_REASONS)[number];

/** The forbearance caps in the order `forbearanceTerm` lists them (plans.ts:8), "requested" left out as it never is named. */
export const FORBEARANCE_CAPS = ["increment_3", "cumulative_12", "delinquency_12"] as const;
export const TIERS: readonly Tier[] = ["ge_90", "lt_90", "le_37"];

/* ── the service's conventions, restated ─────────────────────────────────── */

/** 12.6 rule 1: the installments due from the oldest unpaid one through `on`, both included. */
export function monthsDelinquent(nextDue: PlainDate, on: PlainDate): number {
  let n = 0;
  while (addMonths(nextDue, n) <= on) n++;
  return n;
}

/** ops.ts:360-363 `arrears`: unpaid installments × PITI, and late charges × their count. */
export function arrearsOf(i: {
  piti_cents: Cents;
  unpaid_installments: number;
  late_charge_cents: Cents;
  late_charges: number;
}): { installments_cents: Cents; late_charges_cents: Cents; total_cents: Cents } {
  const inst = BigInt(i.unpaid_installments) * i.piti_cents;
  const lc = BigInt(i.late_charges) * i.late_charge_cents;
  return { installments_cents: inst, late_charges_cents: lc, total_cents: inst + lc };
}

/** ops.ts:368-372 `capStructure`: what the cap leaves to be paid, of the months asked to defer. */
export function installmentsToPay(priorDeferredMonths: number, requestedMonths: number): number {
  const room = Math.max(0, 12 - priorDeferredMonths);
  const allowed = Math.min(room, requestedMonths);
  return requestedMonths - allowed;
}

/** 12.4-T1: a forbearance term starts on the 1st of the month after the evaluation. */
export function forbearanceStart(evaluation: PlainDate): PlainDate {
  const { y, m } = parts(evaluation);
  return addMonths(ymd(y, m, 1), 1);
}

/** Whole months from the evaluation to maturity: the whole_months_between tool's count. */
export const monthsToMaturity = (task: LossmitTask): number =>
  monthsBetween(task.evaluation_date, task.loan.maturity_date);

export const pitiOf = (task: LossmitTask): Cents => task.loan.pi_cents + task.loan.escrow_cents;

/** The screen's facts (DeferralFacts): the standard deferral, never the disaster one, is the prior deferral. */
export function deferralFacts(task: LossmitTask): DeferralFacts {
  const h = task.history;
  return {
    months_delinquent: monthsDelinquent(task.loan.next_due_date, task.evaluation_date),
    origination_date: task.loan.origination_date,
    evaluation_date: task.evaluation_date,
    prior_deferral_effective: h.last_deferral_effective,
    prior_deferral_was_disaster: false,
    cumulative_deferred_months: h.cumulative_deferred_months,
    months_to_maturity: monthsToMaturity(task),
    disaster: null,
    active_arrangements: h.active_arrangements,
    last_failed_trial_on: h.last_failed_trial_on,
    last_modification_effective: h.last_modification_effective,
  };
}

/* ── the engine's run over one task ─────────────────────────────────────── */

export interface LossmitAnalysis {
  readonly months_delinquent: number;
  readonly arrears: ReturnType<typeof arrearsOf>;
  readonly piti_cents: Cents;
  readonly walk: ReturnType<typeof hierarchyWalk>;
  readonly repayment: ReturnType<typeof repaymentPlan>;
  readonly screen: Screen;
  /** Whether the walk tested the deferral with a resolved hardship, so that the screen decided it. */
  readonly screen_reached: boolean;
  readonly forbearance: ReturnType<typeof forbearanceTerm> & {
    readonly start: PlainDate;
    readonly end: PlainDate;
    readonly regx_short_term: boolean;
  };
  readonly new_payment: ReturnType<typeof newPayment>;
  readonly tier: Tier;
  readonly deadlines: ReturnType<typeof evaluationDeadlines>;
}

const determinationOf = (walk: { determinations: readonly Determination[] }, option: Option) =>
  walk.determinations.find((d) => d.option === option);

export function analyzeLossmit(task: LossmitTask): LossmitAnalysis {
  const md = monthsDelinquent(task.loan.next_due_date, task.evaluation_date);
  const piti = pitiOf(task);
  const arrears = arrearsOf({
    piti_cents: piti,
    unpaid_installments: md,
    late_charge_cents: task.loan.late_charge_cents,
    late_charges: task.loan.unpaid_late_charges,
  });
  const resolved = task.borrower.hardship === "resolved";
  const repayment = repaymentPlan(arrears.total_cents, piti, task.borrower.capacity_cents);
  const s = screen(deferralFacts(task));
  // 12.2 rule 2's facts, the five booleans `hierarchy.walk` takes (section12.ts:165).
  const walk = hierarchyWalk({
    can_reinstate: task.borrower.funds_available_cents >= arrears.total_cents,
    hardship_temporary_unresolved: task.borrower.hardship === "temporary_unresolved",
    can_afford_repayment: resolved && repayment.eligible,
    deferral_eligible: resolved && s.eligible,
    flexmod_eligible: task.flexmod_eligible,
  });
  const deferralRow = determinationOf(walk, "payment_deferral");
  const screenReached =
    resolved && deferralRow !== undefined && deferralRow.result !== "not_evaluated_ranking";

  // termComputation (ops-12-4.ts:66-70): no MBS cap, combined = cumulative + no repayment component.
  const start = forbearanceStart(task.evaluation_date);
  const cumulative = task.forbearance.forborne_months;
  const term = forbearanceTerm({
    requested_months: task.forbearance.requested_months ?? 0,
    cumulative_months: cumulative,
    months_delinquent_at_start: monthsDelinquent(task.loan.next_due_date, addDays(start, -1)),
    mbs_months_to_maturity: null,
    combined_months: cumulative + 0,
  });
  const dates = forbearanceTermDates(start, term.months);

  const t = tier(task.evaluation_date, task.scheduled_sale_on);
  return {
    months_delinquent: md,
    arrears,
    piti_cents: piti,
    walk,
    repayment,
    screen: s,
    screen_reached: screenReached,
    forbearance: {
      ...term,
      start: dates.start,
      end: dates.end,
      // forbearanceBasisGate (ops.ts:216-217): the forborne payments before and in the term.
      regx_short_term: regxShortTermForbearance(cumulative + term.months),
    },
    new_payment: newPayment(
      task.loan.pi_cents,
      task.loan.escrow_cents,
      task.deferral.escrow_shortage_cents,
    ),
    tier: t,
    // section12.ts:158-159: from the complete date, the notice's date and the state.
    deadlines: evaluationDeadlines(task.evaluation_date, task.notice_provided_on, t, task.state),
  };
}

/* ── the answer ──────────────────────────────────────────────────────────── */

export interface ForbearanceTermsAnswer {
  readonly months: number;
  readonly capped_by: readonly string[];
  readonly exception_required: boolean;
  readonly term_start: string;
  readonly term_end: string;
  readonly regx_short_term: boolean;
}
export interface RepaymentTermsAnswer {
  readonly months: number;
  readonly installment_cents: string;
  readonly final_installment_cents: string;
  readonly total_monthly_cents: string;
  readonly pct_of_contractual: string;
  readonly regx_short_term: boolean;
}
export interface DeferralTermsAnswer {
  readonly months_deferred: number;
  readonly installments_to_pay: number;
  readonly contractual_payment_required: boolean;
  readonly cumulative_months_after: number;
  readonly nib_cents: string;
  readonly late_charges_waived_cents: string;
  readonly shortage_monthly_cents: string;
  readonly new_payment_cents: string;
}
export interface LossmitAnswer {
  readonly arrears: {
    readonly months_delinquent: number;
    readonly late_charges_cents: string;
    readonly arrears_cents: string;
  };
  readonly offered: Retention;
  readonly terms: ForbearanceTermsAnswer | RepaymentTermsAnswer | DeferralTermsAnswer | null;
  readonly deferral_screen: {
    readonly eligible: boolean;
    readonly reason: ScreenReason | null;
  } | null;
  readonly deferral_timeline: {
    readonly processing_month: boolean;
    readonly entry_deadline: string;
    readonly lar_deadline: string;
    readonly effective: string;
    readonly custodian_by: string;
  } | null;
  readonly regx: {
    readonly tier: Tier;
    readonly decision_due: string;
    readonly window_days: number;
    readonly accept_by: string;
    readonly appeal_rights: boolean;
    readonly deemed_rejected_on: string;
  };
}

export function expectedLossmit(task: LossmitTask): LossmitAnswer {
  const a = analyzeLossmit(task);
  const walked = a.walk.offered;
  if (!walked || !(RETENTION as readonly string[]).includes(walked))
    throw new RangeError(
      `${task.id}: the walk offered ${String(walked)}, outside the retention path`,
    );
  const offered = walked as Retention;
  let terms: LossmitAnswer["terms"] = null;
  if (offered === "forbearance") {
    terms = {
      months: a.forbearance.months,
      capped_by: a.forbearance.capped_by,
      exception_required: a.forbearance.exception_required,
      term_start: a.forbearance.start,
      term_end: a.forbearance.end,
      regx_short_term: a.forbearance.regx_short_term,
    };
  } else if (offered === "repayment_plan") {
    if (!a.repayment.eligible)
      throw new RangeError(`${task.id}: a repayment plan offered with none`);
    const p = a.repayment.terms;
    terms = {
      months: p.months,
      installment_cents: String(p.installment_cents),
      final_installment_cents: String(p.final_installment_cents),
      total_monthly_cents: String(p.total_monthly_cents),
      pct_of_contractual: p.pct_of_contractual,
      regx_short_term: a.repayment.regx_short_term,
    };
  } else if (offered === "payment_deferral") {
    if (!a.screen.eligible)
      throw new RangeError(`${task.id}: a deferral offered on a failed screen`);
    const cumulative = task.history.cumulative_deferred_months;
    terms = {
      months_deferred: a.screen.months_deferred,
      installments_to_pay: installmentsToPay(cumulative, a.months_delinquent),
      contractual_payment_required: a.screen.contractual_payment_required,
      cumulative_months_after: cumulative + a.screen.months_deferred,
      nib_cents: String(
        nib(
          task.loan.pi_cents,
          a.screen.months_deferred,
          task.deferral.escrow_advances_cents,
          task.deferral.servicing_advances_cents,
        ),
      ),
      late_charges_waived_cents: String(a.arrears.late_charges_cents),
      shortage_monthly_cents: String(a.new_payment.shortage_monthly_cents),
      new_payment_cents: String(a.new_payment.payment_cents),
    };
  }
  const tl =
    offered === "payment_deferral"
      ? timeline(task.evaluation_date, {
          processing_month_elected: task.deferral.processing_month_elected,
        })
      : null;
  return {
    arrears: {
      months_delinquent: a.months_delinquent,
      late_charges_cents: String(a.arrears.late_charges_cents),
      arrears_cents: String(a.arrears.total_cents),
    },
    offered,
    terms,
    deferral_screen: a.screen_reached
      ? {
          eligible: a.screen.eligible,
          reason: a.screen.eligible ? null : (a.screen.reason as ScreenReason),
        }
      : null,
    deferral_timeline: tl
      ? {
          processing_month: tl.processing_month,
          entry_deadline: tl.entry_deadline,
          lar_deadline: tl.lar_deadline,
          effective: tl.effective,
          custodian_by: tl.custodian_by,
        }
      : null,
    regx: {
      tier: a.tier,
      decision_due: a.deadlines.decision_due,
      window_days: a.deadlines.window_days,
      accept_by: a.deadlines.accept_by,
      appeal_rights: a.deadlines.appeal_rights,
      deemed_rejected_on: a.deadlines.deemed_rejected_on,
    },
  };
}

/**
 * The class a task's score is read by: the option offered, and for Flex
 * Modification which way the walk reached it. A permanent hardship's is
 * Steps 1, 2 and 8 alone, as reinstatement is; one after a failed screen
 * has walked the plan search and the screen first.
 */
export function lossmitVerdict(task: LossmitTask): string {
  const offered = expectedLossmit(task).offered;
  if (offered !== "flex_mod") return offered;
  return task.borrower.hardship === "permanent"
    ? "flex_mod on a permanent hardship"
    : "flex_mod after the screen";
}

/* ── grading ──────────────────────────────────────────────────────────────
 * Six groups, each one field that stands or falls together: the arrears,
 * the option offered, its terms, the deferral screen, the deferral's
 * timeline and Reg X's windows. The arrears, the offer and the windows are
 * graded on every task. The other three are graded where the engine has
 * them, and also wherever an answer gives one the engine does not, so that
 * answering a section that is not called for costs a field, the same as
 * leaving one out that is. A section that neither has is not a field: a
 * null that is right by default is not credit. Nor is an eligible screen:
 * the parser takes one only with the deferral offered, so it is the offer
 * again, and the screen is a field only where a screen failed, in the
 * engine's answer or the model's.
 */

const CONDITIONAL = ["terms", "deferral_screen", "deferral_timeline"] as const;

const screenFailed = (s: LossmitAnswer["deferral_screen"] | undefined) => s?.eligible === false;

const canon = (v: unknown): string =>
  v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);

export function gradeLossmitAgainst(want: LossmitAnswer, answer: LossmitAnswer | null): Grade {
  const fields: FieldGrade[] = [];
  const check = (field: string, expected: unknown, got: unknown) => {
    const e = canon(expected);
    const g = answer ? canon(got) : null;
    fields.push({ field, expected: e, got: g, ok: g === e });
  };
  check("arrears", want.arrears, answer?.arrears);
  check("offered", want.offered, answer?.offered);
  for (const f of CONDITIONAL) {
    const given = answer ? answer[f] : null;
    const graded =
      f === "deferral_screen"
        ? screenFailed(want.deferral_screen) || screenFailed(answer?.deferral_screen)
        : want[f] !== null || given !== null;
    if (graded) check(f, want[f], given);
  }
  check("regx", want.regx, answer?.regx);
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradeLossmit = (task: LossmitTask, answer: LossmitAnswer | null): Grade =>
  gradeLossmitAgainst(expectedLossmit(task), answer);

/* ── the submission, read strictly ──────────────────────────────────────── */

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
/** Integer cents as the schema's string, nothing around it: a number or "12.50" is not cents. */
const centsText = (v: unknown): string | null =>
  typeof v === "string" && /^-?\d+$/.test(v) ? BigInt(v).toString() : null;
const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

class Bounce extends Error {}

/** An object with exactly these keys: every one present, nothing else. */
function exactly(v: unknown, what: string, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(v)) throw new Bounce(`${what} must be an object`);
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  if (extra.length)
    throw new Bounce(`${what} has ${extra.join(", ")}, which the schema does not name`);
  const missing = keys.filter((k) => !(k in v));
  if (missing.length) throw new Bounce(`${what} needs ${missing.join(", ")}`);
  return v;
}
const whole = (v: unknown, what: string, lo = 0, hi = 1000): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi)
    throw new Bounce(`${what} must be a whole number from ${lo} to ${hi}`);
  return v;
};
const bool = (v: unknown, what: string): boolean => {
  if (typeof v !== "boolean") throw new Bounce(`${what} must be true or false`);
  return v;
};
const cents = (v: unknown, what: string): string => {
  const c = centsText(v);
  if (c === null) throw new Bounce(`${what} must be integer cents as a string`);
  return c;
};
const date = (v: unknown, what: string): string => {
  if (!isDate(v)) throw new Bounce(`${what} must be a date, YYYY-MM-DD`);
  return v;
};

const FORBEARANCE_KEYS = [
  "months",
  "capped_by",
  "exception_required",
  "term_start",
  "term_end",
  "regx_short_term",
];
const REPAYMENT_KEYS = [
  "months",
  "installment_cents",
  "final_installment_cents",
  "total_monthly_cents",
  "pct_of_contractual",
  "regx_short_term",
];
const DEFERRAL_KEYS = [
  "months_deferred",
  "installments_to_pay",
  "contractual_payment_required",
  "cumulative_months_after",
  "nib_cents",
  "late_charges_waived_cents",
  "shortage_monthly_cents",
  "new_payment_cents",
];
const TIMELINE_KEYS = [
  "processing_month",
  "entry_deadline",
  "lar_deadline",
  "effective",
  "custodian_by",
];
const REGX_KEYS = [
  "tier",
  "decision_due",
  "window_days",
  "accept_by",
  "appeal_rights",
  "deemed_rejected_on",
];
export const LOSSMIT_ANSWER_KEYS = [
  "arrears",
  "offered",
  "terms",
  "deferral_screen",
  "deferral_timeline",
  "regx",
] as const;

function termsOf(offered: Retention, v: unknown): LossmitAnswer["terms"] {
  if (offered === "reinstatement" || offered === "flex_mod") {
    if (v !== null) throw new Bounce(`terms must be null when the offer is ${offered}`);
    return null;
  }
  if (offered === "forbearance") {
    const t = exactly(v, "forbearance terms", FORBEARANCE_KEYS);
    const caps = t["capped_by"];
    if (
      !Array.isArray(caps) ||
      caps.some((c) => !(FORBEARANCE_CAPS as readonly string[]).includes(c))
    )
      throw new Bounce(`capped_by must be a list drawn from ${FORBEARANCE_CAPS.join(", ")}`);
    if (new Set(caps).size !== caps.length) throw new Bounce("capped_by names a cap twice");
    return {
      months: whole(t["months"], "months", 0, 3),
      // The engine's order (plans.ts:8); the order carries nothing, so it is put right, not graded.
      capped_by: FORBEARANCE_CAPS.filter((c) => caps.includes(c)),
      exception_required: bool(t["exception_required"], "exception_required"),
      term_start: date(t["term_start"], "term_start"),
      term_end: date(t["term_end"], "term_end"),
      regx_short_term: bool(t["regx_short_term"], "regx_short_term"),
    };
  }
  if (offered === "repayment_plan") {
    const t = exactly(v, "repayment terms", REPAYMENT_KEYS);
    const pct = t["pct_of_contractual"];
    if (typeof pct !== "string" || !/^\d{1,3}\.\d{2}$/.test(pct))
      throw new Bounce('pct_of_contractual must be a percentage with two decimals, e.g. "138.25"');
    return {
      months: whole(t["months"], "months", 1, 12),
      installment_cents: cents(t["installment_cents"], "installment_cents"),
      final_installment_cents: cents(t["final_installment_cents"], "final_installment_cents"),
      total_monthly_cents: cents(t["total_monthly_cents"], "total_monthly_cents"),
      pct_of_contractual: pct,
      regx_short_term: bool(t["regx_short_term"], "regx_short_term"),
    };
  }
  const t = exactly(v, "deferral terms", DEFERRAL_KEYS);
  return {
    months_deferred: whole(t["months_deferred"], "months_deferred", 0, 12),
    installments_to_pay: whole(t["installments_to_pay"], "installments_to_pay", 0, 12),
    contractual_payment_required: bool(
      t["contractual_payment_required"],
      "contractual_payment_required",
    ),
    cumulative_months_after: whole(t["cumulative_months_after"], "cumulative_months_after", 0, 24),
    nib_cents: cents(t["nib_cents"], "nib_cents"),
    late_charges_waived_cents: cents(t["late_charges_waived_cents"], "late_charges_waived_cents"),
    shortage_monthly_cents: cents(t["shortage_monthly_cents"], "shortage_monthly_cents"),
    new_payment_cents: cents(t["new_payment_cents"], "new_payment_cents"),
  };
}

export function parseLossmitSubmission(raw: unknown): Parsed<LossmitAnswer> {
  try {
    const s = exactly(raw, "the submission", LOSSMIT_ANSWER_KEYS);
    const ar = exactly(s["arrears"], "arrears", [
      "months_delinquent",
      "late_charges_cents",
      "arrears_cents",
    ]);
    const offered = s["offered"];
    if (typeof offered !== "string" || !(RETENTION as readonly string[]).includes(offered))
      throw new Bounce(`offered must be one of ${RETENTION.join(", ")}`);
    const o = offered as Retention;
    const terms = termsOf(o, s["terms"]);

    let scr: LossmitAnswer["deferral_screen"] = null;
    if (s["deferral_screen"] !== null) {
      const d = exactly(s["deferral_screen"], "deferral_screen", ["eligible", "reason"]);
      const eligible = bool(d["eligible"], "deferral_screen.eligible");
      const reason = d["reason"];
      if (eligible ? reason !== null : !(SCREEN_REASONS as readonly unknown[]).includes(reason))
        throw new Bounce(
          `deferral_screen.reason is null on an eligible screen, and one of ${SCREEN_REASONS.join(", ")} on an ineligible one`,
        );
      scr = { eligible, reason: (reason as ScreenReason | null) ?? null };
    }
    // The walk ties the screen to the offer (Step 2): it is reached only past the repayment plan,
    // and an eligible screen is the deferral offered.
    if (o === "payment_deferral" && scr?.eligible !== true)
      throw new Bounce("a payment deferral is offered only on an eligible deferral_screen");
    if ((o === "reinstatement" || o === "forbearance" || o === "repayment_plan") && scr !== null)
      throw new Bounce(`deferral_screen must be null when the walk stops at ${o}`);
    if (o === "flex_mod" && scr?.eligible === true)
      throw new Bounce(
        "an eligible deferral_screen is the deferral offered, not Flex Modification",
      );

    let tl: LossmitAnswer["deferral_timeline"] = null;
    if (s["deferral_timeline"] !== null) {
      const t = exactly(s["deferral_timeline"], "deferral_timeline", TIMELINE_KEYS);
      tl = {
        processing_month: bool(t["processing_month"], "processing_month"),
        entry_deadline: date(t["entry_deadline"], "entry_deadline"),
        lar_deadline: date(t["lar_deadline"], "lar_deadline"),
        effective: date(t["effective"], "effective"),
        custodian_by: date(t["custodian_by"], "custodian_by"),
      };
    }
    if ((o === "payment_deferral") !== (tl !== null))
      throw new Bounce("deferral_timeline is given when, and only when, the deferral is offered");

    const rx = exactly(s["regx"], "regx", REGX_KEYS);
    const t = rx["tier"];
    if (typeof t !== "string" || !(TIERS as readonly string[]).includes(t))
      throw new Bounce(`regx.tier must be one of ${TIERS.join(", ")}`);
    return {
      ok: true,
      answer: {
        arrears: {
          months_delinquent: whole(ar["months_delinquent"], "months_delinquent", 0, 600),
          late_charges_cents: cents(ar["late_charges_cents"], "late_charges_cents"),
          arrears_cents: cents(ar["arrears_cents"], "arrears_cents"),
        },
        offered: o,
        terms,
        deferral_screen: scr,
        deferral_timeline: tl,
        regx: {
          tier: t as Tier,
          decision_due: date(rx["decision_due"], "decision_due"),
          window_days: whole(rx["window_days"], "window_days", 1, 90),
          accept_by: date(rx["accept_by"], "accept_by"),
          appeal_rights: bool(rx["appeal_rights"], "appeal_rights"),
          deemed_rejected_on: date(rx["deemed_rejected_on"], "deemed_rejected_on"),
        },
      },
    };
  } catch (e) {
    if (!(e instanceof Bounce)) throw e;
    return {
      ok: false,
      error: `${e.message}. Nothing was submitted; fix it and call submit_evaluation again.`,
    };
  }
}
