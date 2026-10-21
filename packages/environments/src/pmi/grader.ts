/**
 * The grader is the servicing app's mortgage-insurance engine.
 *
 * The schedule, the 78% date, the midpoint, the current test and cure, the
 * request's evaluation, the finalization clocks and the unearned-premium
 * estimate are the ported files themselves (`ported/`). The conventions
 * around them live in the servicing app's stateful service
 * (app/tools/section10.ts) or nowhere, so they are restated here exactly,
 * each with where it comes from (a test holds the cited lines to the
 * service's source):
 *   - the schedule in effect is the note's, re-amortized at each rate change
 *     from the scheduled balance before it (armResetVersion), over the rows
 *     the note has left: io + amortizing term − (payment number − 1). The
 *     service takes that remaining term as an input (section10.ts:235); the
 *     spec's ARM example re-amortizes over 300 at payment 61 of 360. A
 *     modification replaces the schedule with the modified terms;
 *   - the midpoint runs from the governing first payment due (the note's,
 *     or the modification's) and the full term, interest-only months
 *     included (10.3 R1, R3; ops-30-4.ts:442 and ops-24-6.ts:244 call it
 *     so). It is NOT section10.ts:236's midpoint(v.rows[0].due_date,
 *     v.rows.length), which after a rate change measures from the change,
 *     thirty months late on the spec's ARM (docs/decisions.md has it);
 *   - the trigger is pendingTriggerDate (termination.ts:83, 10.3 R4): the
 *     earlier of the 78% date and the midpoint termination for a loan the
 *     78% rule reaches, the midpoint termination otherwise. No service line
 *     calls it; the service arms the two clocks apart (section10.ts:236-241);
 *   - the sweep is automaticTermination(installments, T, true) at every
 *     trigger: sweepTermination's default (ops.ts:88), which the spec's
 *     10.3-T2 and T3 run through. section10.ts:251 passes rule78Applies
 *     when it is given the loan's applicability, which would leave a
 *     two-unit loan's MI in force at its own midpoint; the 78% rule decides
 *     only which date triggers;
 *   - the request is the service's cancellationRequest (section10.ts:48-56)
 *     with the path and the property class stated, the evaluation balance
 *     the interest-bearing balance at the evaluation date plus deferred and
 *     forborne principal (10.1 R3), and threshold_reached_on, which the
 *     engine takes as an input and nothing computes, set here: the receipt
 *     date when the balance then already met the original-value threshold,
 *     otherwise the first posting after it that did (10.1-T9), otherwise
 *     null, and null on the current-value path;
 *   - a refused request records no evaluation (the service throws before
 *     it writes one, 10.1-T12), so only its result, reason and 30-day clock
 *     are reported; a current-value request with no valuation has no LTV;
 *   - the premium-stop anchor is the effective date for an automatic
 *     termination (finalizationClocks' default) and premiumStopAnchor of
 *     the receipt and evidence dates for a granted request (section10.ts:169);
 *   - the refund's coverage period, which the engine takes as an input
 *     (section10.ts:279): the 1st of the effective date's month for a
 *     monthly premium; the latest anniversary of the certificate on or
 *     before the effective date for an annual one; for a single premium,
 *     the refund schedule's row for the whole months in force, counted as
 *     seasoningMonths counts them;
 *   - lender-paid MI never cancels: its options notice is due 30 days after
 *     the trigger (lpmiOptionsNoticeDue; section10.ts:246-249).
 */

import { addMonths, parts, servicer, ymd, type PlainDate } from "@hm/kernel/calendar";
import { ratePercent, type Cents } from "@hm/kernel/money";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import {
  evaluateCancellation,
  evaluationUpb,
  isCurrentForRequest,
  ltvBps,
  originalValue,
  originalValueThresholdBps,
  premiumStopAnchor,
  seasoningMonths,
  type CancellationDecision,
  type PropertyClass,
} from "./ported/cancellation.js";
import { applyFifo, type AppliedInstallment } from "./ported/delinquency.js";
import { unearnedEstimate, type RefundPlan } from "./ported/refund.js";
import {
  armResetVersion,
  buildSchedule,
  midpoint,
  scheduledDateForPct,
  type Midpoint,
  type ScheduleVersion,
} from "./ported/schedule.js";
import {
  automaticTermination,
  finalizationClocks,
  lpmiOptionsNoticeDue,
  pendingTriggerDate,
  rule78Applies,
  type AutoResult,
  type FinalizationClocks,
} from "./ported/termination.js";
import type { PmiLoan, PmiTask } from "./task.js";

/* ── the schedule in effect ───────────────────────────────────────────── */

/** What the schedule is built from: the note, its rate changes, and any modification. */
export type ScheduleTermsOf = Pick<PmiTask, "loan" | "rate_changes" | "modification">;

/** The note's schedule, then each version a rate change or a modification made, in order. */
export function scheduleVersions(task: ScheduleTermsOf): ScheduleVersion[] {
  const l = task.loan;
  const total = l.io_months + l.amortizing_term_months;
  const versions: ScheduleVersion[] = [
    buildSchedule({
      upb_cents: l.original_principal_cents,
      annual_rate: ratePercent(l.note_rate_pct),
      term_months: l.amortizing_term_months,
      first_due: l.first_payment_due,
      io_months: l.io_months,
    }),
  ];
  for (const rc of task.rate_changes)
    versions.push(
      armResetVersion(
        versions[versions.length - 1]!,
        rc.payment_number,
        ratePercent(rc.new_rate_pct),
        total - (rc.payment_number - 1),
      ),
    );
  const m = task.modification;
  if (m)
    versions.push(
      buildSchedule(
        {
          upb_cents: m.ib_upb_cents,
          annual_rate: ratePercent(m.rate_pct),
          term_months: m.term_months,
          first_due: m.first_modified_due,
          forborne_principal_cents: m.forborne_principal_cents,
        },
        "modification",
      ),
    );
  return versions;
}

/** The governing first due and term: the modification's, or the note's with its interest-only months. */
export function midpointOf(task: ScheduleTermsOf): Midpoint {
  const m = task.modification;
  return m
    ? midpoint(m.first_modified_due, m.term_months)
    : midpoint(task.loan.first_payment_due, task.loan.io_months + task.loan.amortizing_term_months);
}

export function propertyClassOf(loan: PmiLoan): PropertyClass {
  if (loan.occupancy_at_origination === "investment") return "1_4u_investment";
  if (loan.units === 1) return "1u_principal_or_second";
  return "2_4u_principal";
}

/* ── the request ───────────────────────────────────────────────────────── */

/** The interest-bearing balance at the evaluation date: the last posting's, or the receipt-day balance. */
export function balanceAtEvaluation(task: PmiTask): Cents {
  const b = task.request!.balance;
  return b.postings.length > 0
    ? b.postings[b.postings.length - 1]!.upb_after_cents
    : b.upb_on_receipt_cents;
}

/**
 * The date the actual balance met the original-value threshold: the receipt
 * date when it already had, else the first posting that did, else null; null
 * on the current-value path.
 */
export function thresholdReachedOn(task: PmiTask, ov: Cents): PlainDate | null {
  const r = task.request!;
  if (r.path !== "original_value") return null;
  const th = originalValueThresholdBps(propertyClassOf(task.loan));
  const meets = (ib: Cents) =>
    ltvBps(
      evaluationUpb({
        upb_cents: ib,
        deferred_principal_cents: r.balance.deferred_principal_cents,
        forborne_principal_cents: r.balance.forborne_principal_cents,
      }),
      ov,
    ) <= th;
  if (meets(r.balance.upb_on_receipt_cents)) return r.received_on;
  return r.balance.postings.find((p) => meets(p.upb_after_cents))?.posted_on ?? null;
}

/* ── the refund ────────────────────────────────────────────────────────── */

/** The latest anniversary of the certificate on or before E (whole years by date_add's months). */
export function anniversaryOnOrBefore(start: PlainDate, E: PlainDate): PlainDate {
  let k = Math.max(0, parts(E).y - parts(start).y);
  while (k > 0 && addMonths(start, 12 * k) > E) k--;
  return addMonths(start, 12 * k);
}

/** "45.00" percent as the fraction the engine multiplies by: "0.4500". */
const pctFraction = (pct: string): string => {
  const [w, f = ""] = pct.split(".");
  const bps = BigInt(w!) * 100n + BigInt((f + "00").slice(0, 2));
  return `${bps / 10_000n}.${String(bps % 10_000n).padStart(4, "0")}`;
};

/** The single premium's schedule row for the whole months in force at E. */
export function singleRefundPct(task: PmiTask, E: PlainDate): string {
  const months = seasoningMonths(task.mi.coverage_start, E);
  const rows = [...(task.mi.refund_schedule ?? [])]
    .filter((r) => r.months_in_force_from <= months)
    .sort((a, b) => b.months_in_force_from - a.months_in_force_from);
  if (!rows[0]) throw new RangeError(`${task.id}: no refund schedule row for ${months} months`);
  return rows[0].refund_pct;
}

export function refundPlanAt(task: PmiTask, E: PlainDate): RefundPlan | null {
  const mi = task.mi;
  if (mi.plan === "monthly") {
    const { y, m } = parts(E);
    return { kind: "monthly", premium_cents: mi.premium_cents, coverage_month_start: ymd(y, m, 1) };
  }
  if (mi.plan === "annual")
    return {
      kind: "annual",
      premium_cents: mi.premium_cents,
      anniversary_start: anniversaryOnOrBefore(mi.coverage_start, E),
    };
  if (mi.plan === "single")
    return {
      kind: "single",
      premium_cents: mi.premium_cents,
      refund_pct: pctFraction(singleRefundPct(task, E)),
    };
  return null;
}

/* ── the analysis ──────────────────────────────────────────────────────── */

export interface PmiAnalysis {
  readonly original_value_cents: Cents;
  readonly rule_78_applies: boolean;
  readonly versions: readonly ScheduleVersion[];
  readonly version: ScheduleVersion;
  readonly scheduled_78: { readonly due_date: PlainDate; readonly n: number } | null;
  readonly midpoint: Midpoint;
  readonly trigger: PlainDate;
  readonly installments: readonly AppliedInstallment[];
  readonly request: {
    readonly decision: CancellationDecision;
    readonly evaluation_upb_cents: Cents;
    readonly threshold_reached_on: PlainDate | null;
    /** isCurrentForRequest: Fannie Mae's test at the month before receipt, the HPA's at the decision. */
    readonly current: { readonly fnma: boolean; readonly hpa: boolean };
  } | null;
  readonly automatic: AutoResult | null;
  readonly clocks: FinalizationClocks | null;
  readonly unearned_cents: Cents | null;
  readonly lpmi_options_notice_due: PlainDate | null;
}

export function analyzePmi(task: PmiTask): PmiAnalysis {
  const l = task.loan;
  const ov = originalValue({
    sales_price_cents: l.sales_price_cents,
    appraised_value_cents: l.appraised_value_cents,
    is_refinance: l.is_refinance,
    state: l.state,
  });
  if (ov === null) throw new RangeError(`${task.id}: no original value`);
  const rule78 = rule78Applies({
    consummation: l.consummation,
    units: l.units,
    occupancy_at_origination: l.occupancy_at_origination,
  });
  const versions = scheduleVersions(task);
  const version = versions[versions.length - 1]!;
  const d78 = scheduledDateForPct(version, ov, 78);
  const mp = midpointOf(task);
  const T = pendingTriggerDate(d78?.due_date ?? null, mp.midpoint_termination_date, rule78);
  const installments = applyFifo(task.ledger.installments, task.ledger.receipts).installments;
  const base = {
    original_value_cents: ov,
    rule_78_applies: rule78,
    versions,
    version,
    scheduled_78: d78 ? { due_date: d78.due_date, n: d78.n } : null,
    midpoint: mp,
    trigger: T,
    installments,
  };

  if (task.request) {
    const r = task.request;
    const evalUpb = evaluationUpb({
      upb_cents: balanceAtEvaluation(task),
      deferred_principal_cents: r.balance.deferred_principal_cents,
      forborne_principal_cents: r.balance.forborne_principal_cents,
    });
    const reached = thresholdReachedOn(task, ov);
    const pc = propertyClassOf(l);
    const decision = evaluateCancellation({
      received_on: r.received_on,
      decision_on: task.as_of,
      evidence_satisfied_on: r.evidence_satisfied_on,
      path: r.path,
      property_class: pc,
      hpa_covered: rule78 && l.occupancy_at_origination === "principal",
      original_value_cents: ov,
      valuation_cents: r.valuation?.value_cents ?? null,
      valuation_delivered_on: r.valuation?.delivered_on ?? null,
      evaluation_upb_cents: evalUpb,
      threshold_reached_on: reached,
      installments,
      avm_cents: r.avm_cents,
      consummation: l.consummation,
      improvements_accepted: r.improvements_accepted,
      disaster_excluded: new Set(r.disaster_excluded),
    });
    const E = decision.result === "eligible" ? decision.effective_on! : null;
    const clocks = E
      ? finalizationClocks(
          E,
          decision.lar89_action_code!,
          servicer,
          premiumStopAnchor(r.received_on, r.evidence_satisfied_on),
        )
      : null;
    const plan = E ? refundPlanAt(task, E) : null;
    return {
      ...base,
      request: {
        decision,
        evaluation_upb_cents: evalUpb,
        threshold_reached_on: reached,
        current: isCurrentForRequest(installments, r.received_on, task.as_of),
      },
      automatic: null,
      clocks,
      unearned_cents: plan && E ? unearnedEstimate(plan, E) : null,
      lpmi_options_notice_due: null,
    };
  }

  if (task.mi.plan === "lender_paid")
    return {
      ...base,
      request: null,
      automatic: null,
      clocks: null,
      unearned_cents: null,
      lpmi_options_notice_due: task.as_of >= T ? lpmiOptionsNoticeDue(T) : null,
    };

  if (task.as_of < T)
    return {
      ...base,
      request: null,
      automatic: null,
      clocks: null,
      unearned_cents: null,
      lpmi_options_notice_due: null,
    };
  const auto = automaticTermination(installments, T, true);
  const clocks = auto.status === "not_applicable_midpoint_only" ? null : auto.clocks;
  const plan = clocks ? refundPlanAt(task, clocks.effective_on) : null;
  return {
    ...base,
    request: null,
    automatic: auto,
    clocks,
    unearned_cents: plan && clocks ? unearnedEstimate(plan, clocks.effective_on) : null,
    lpmi_options_notice_due: null,
  };
}

/* ── the answer ────────────────────────────────────────────────────────── */

export const REQUEST_RESULTS = ["eligible", "ineligible", "value_check_needed", "refused"] as const;
export const REQUEST_REASONS = [
  "LTV_ABOVE_THRESHOLD",
  "LTV_ABOVE_THRESHOLD_CURRENT",
  "SEASONING_INSUFFICIENT",
  "NOT_CURRENT",
  "PAYMENT_HISTORY_30_12M",
  "PAYMENT_HISTORY_60_24M",
  "VALUE_DECLINED_OR_UNKNOWN",
  "VALUATION_REQUIRED",
  "VALUATION_EXPIRED",
] as const;
export const LAR89_CODES = ["51", "52", "53"] as const;

export interface PmiPositionAnswer {
  readonly original_value_cents: string;
  readonly rule_78_applies: boolean;
  readonly pi_cents: string;
  readonly scheduled_78_payment_number: number | null;
  readonly scheduled_78_date: string | null;
  readonly midpoint_termination_date: string;
  readonly trigger_date: string;
}

export interface PmiRequestAnswer {
  readonly evaluation_upb_cents: string | null;
  readonly threshold_bps: number | null;
  readonly ltv_bps: number | null;
  readonly fnma_current: boolean | null;
  readonly late30_12m: number | null;
  readonly late60_24m: number | null;
  readonly result: (typeof REQUEST_RESULTS)[number];
  readonly reasons: readonly string[];
  readonly decision_due: string;
}

export interface PmiAutomaticAnswer {
  readonly current_on_trigger: boolean;
  readonly not_current_installments: readonly string[];
  readonly not_current_notice_due: string | null;
  readonly cure_on: string | null;
}

export interface PmiTerminationAnswer {
  readonly effective_on: string;
  readonly lar89_action_code: (typeof LAR89_CODES)[number];
  readonly lar89_action_date: string;
  readonly notice_due: string;
  readonly premium_stop_by: string;
  readonly refund_due: string;
  readonly insurer_notice_due: string;
  readonly escrow_interim_analysis_due: string;
  readonly unearned_premium_cents: string;
}

export interface PmiAnswer {
  readonly position: PmiPositionAnswer;
  readonly request: PmiRequestAnswer | null;
  readonly automatic: PmiAutomaticAnswer | null;
  readonly termination: PmiTerminationAnswer | null;
  readonly lpmi_options_notice_due: string | null;
}

export function expectedPmi(task: PmiTask): PmiAnswer {
  const a = analyzePmi(task);
  const position: PmiPositionAnswer = {
    original_value_cents: String(a.original_value_cents),
    rule_78_applies: a.rule_78_applies,
    pi_cents: String(a.version.pi_cents),
    scheduled_78_payment_number: a.scheduled_78?.n ?? null,
    scheduled_78_date: a.scheduled_78?.due_date ?? null,
    midpoint_termination_date: a.midpoint.midpoint_termination_date,
    trigger_date: a.trigger,
  };
  let request: PmiRequestAnswer | null = null;
  if (a.request) {
    const d = a.request.decision;
    const refused = d.result === "refused";
    const noValue = d.reasons.includes("VALUATION_REQUIRED");
    request = {
      evaluation_upb_cents: refused ? null : String(a.request.evaluation_upb_cents),
      threshold_bps: refused ? null : d.threshold_bps,
      ltv_bps: refused || noValue ? null : d.ltv_bps,
      fnma_current: refused ? null : a.request.current.fnma,
      late30_12m: refused ? null : d.history.late30_12m,
      late60_24m: refused ? null : d.history.late60_24m,
      result: d.result,
      reasons: [...d.reasons],
      decision_due: d.decision_due,
    };
  }
  let automatic: PmiAutomaticAnswer | null = null;
  if (a.automatic && a.automatic.status !== "not_applicable_midpoint_only") {
    automatic =
      a.automatic.status === "terminated"
        ? {
            current_on_trigger: true,
            not_current_installments: [],
            not_current_notice_due: null,
            cure_on: null,
          }
        : {
            current_on_trigger: false,
            not_current_installments: [...a.automatic.grounds],
            not_current_notice_due: a.automatic.not_current_notice_due,
            cure_on: a.automatic.cure_on,
          };
  }
  const c = a.clocks;
  const termination: PmiTerminationAnswer | null = c
    ? {
        effective_on: c.effective_on,
        lar89_action_code: c.lar89.code as PmiTerminationAnswer["lar89_action_code"],
        lar89_action_date: c.lar89.action_date,
        notice_due: c.notice_due,
        premium_stop_by: c.premium_stop_by,
        refund_due: c.refund_due,
        insurer_notice_due: c.insurer_notice_due,
        escrow_interim_analysis_due: c.escrow_interim_analysis_due,
        unearned_premium_cents: String(a.unearned_cents ?? 0n),
      }
    : null;
  return {
    position,
    request,
    automatic,
    termination,
    lpmi_options_notice_due: a.lpmi_options_notice_due,
  };
}

/* ── grading ───────────────────────────────────────────────────────────────
 * The position is six fields (the 78% payment and its date are one). A
 * section the evaluation date does not call for (no request, no sweep, no
 * termination) is one field when it is answered null. Answered anyway, it
 * costs every field it holds, exactly as leaving out a section the date does
 * call for does: a grant, a cure or a sweep claimed that is not there costs
 * what one missed costs, so neither direction pays under doubt. Inside a
 * section, a run of fields that are all null or empty on this task is one
 * field: a request refused before it is evaluated, a sweep that found the
 * loan current; and the two late-payment counts are one.
 */

const canon = (v: unknown): string =>
  v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v);
const sorted = (xs: readonly string[]) => [...xs].sort();

type Fields = (readonly [string, unknown])[];

/** A request's graded fields, grouped as `shape` groups them: a refused request's evaluation is one field. */
function requestFields(x: PmiRequestAnswer, shape: PmiRequestAnswer): Fields {
  const evaluation: Fields =
    shape.result === "refused"
      ? [
          [
            "request.evaluation",
            {
              evaluation_upb_cents: x.evaluation_upb_cents,
              threshold_bps: x.threshold_bps,
              ltv_bps: x.ltv_bps,
              fnma_current: x.fnma_current,
              late30_12m: x.late30_12m,
              late60_24m: x.late60_24m,
            },
          ],
        ]
      : [
          ["request.evaluation_upb_cents", x.evaluation_upb_cents],
          ["request.threshold_bps", x.threshold_bps],
          ["request.ltv_bps", x.ltv_bps],
          ["request.fnma_current", x.fnma_current],
          ["request.history", { late30_12m: x.late30_12m, late60_24m: x.late60_24m }],
        ];
  return [
    ...evaluation,
    ["request.result", x.result],
    ["request.reasons", sorted(x.reasons)],
    ["request.decision_due", x.decision_due],
  ];
}

/** A sweep's graded fields, grouped as `shape` groups them: a current sweep's empty findings are one field. */
function automaticFields(x: PmiAutomaticAnswer, shape: PmiAutomaticAnswer): Fields {
  const findings: Fields = shape.current_on_trigger
    ? [
        [
          "automatic.not_current",
          {
            not_current_installments: sorted(x.not_current_installments),
            not_current_notice_due: x.not_current_notice_due,
            cure_on: x.cure_on,
          },
        ],
      ]
    : [
        ["automatic.not_current_installments", sorted(x.not_current_installments)],
        ["automatic.not_current_notice_due", x.not_current_notice_due],
        ["automatic.cure_on", x.cure_on],
      ];
  return [["automatic.current_on_trigger", x.current_on_trigger], ...findings];
}

function terminationFields(x: PmiTerminationAnswer): Fields {
  return [
    ["termination.effective_on", x.effective_on],
    ["termination.lar89", { code: x.lar89_action_code, action_date: x.lar89_action_date }],
    ["termination.notice_due", x.notice_due],
    ["termination.premium_stop_by", x.premium_stop_by],
    ["termination.refund_due", x.refund_due],
    ["termination.insurer_notice_due", x.insurer_notice_due],
    ["termination.escrow_interim_analysis_due", x.escrow_interim_analysis_due],
    ["termination.unearned_premium_cents", x.unearned_premium_cents],
  ];
}

export function gradePmiAgainst(want: PmiAnswer, answer: PmiAnswer | null): Grade {
  const fields: FieldGrade[] = [];
  const push = (field: string, expected: string, got: string | null) =>
    fields.push({ field, expected, got, ok: got === expected });
  /**
   * One section: null where the date does not call for it is one field; anything else is graded field
   * by field as the expected section groups them, and a section answered where none is called for is
   * charged every field it holds, as one left out is.
   */
  const section = <T>(
    name: string,
    expected: T | null,
    got: T | null | undefined,
    fieldsOf: (x: T, shape: T) => Fields,
  ) => {
    if (answer === null) got = null;
    if (expected === null) {
      if (got === null || got === undefined)
        return push(name, "null", answer === null ? null : "null");
      for (const [field, value] of fieldsOf(got, got))
        push(field, "null (not called for)", canon(value));
      return;
    }
    const answered = got === null || got === undefined ? null : fieldsOf(got, expected);
    fieldsOf(expected, expected).forEach(([field, value], k) =>
      push(
        field,
        canon(value),
        answer === null ? null : answered ? canon(answered[k]![1]) : "(section not answered)",
      ),
    );
  };

  const positionFields = (x: PmiPositionAnswer): Fields => [
    ["position.original_value_cents", x.original_value_cents],
    ["position.rule_78_applies", x.rule_78_applies],
    ["position.pi_cents", x.pi_cents],
    ["position.scheduled_78", { n: x.scheduled_78_payment_number, date: x.scheduled_78_date }],
    ["position.midpoint_termination_date", x.midpoint_termination_date],
    ["position.trigger_date", x.trigger_date],
  ];
  const answeredPosition = answer ? positionFields(answer.position) : null;
  positionFields(want.position).forEach(([field, value], k) =>
    push(field, canon(value), answeredPosition ? canon(answeredPosition[k]![1]) : null),
  );

  section("request", want.request, answer?.request, requestFields);
  section("automatic", want.automatic, answer?.automatic, automaticFields);
  section("termination", want.termination, answer?.termination, (x) => terminationFields(x));
  push(
    "lpmi_options_notice_due",
    canon(want.lpmi_options_notice_due),
    answer === null ? null : canon(answer.lpmi_options_notice_due),
  );
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradePmi = (task: PmiTask, answer: PmiAnswer | null): Grade =>
  gradePmiAgainst(expectedPmi(task), answer);

/* ── the submission, read strictly ─────────────────────────────────────────
 * Exactly the schema: every key it requires, none it does not, each value of
 * its stated type and form, and no list holding the same entry twice.
 */

class Bounce extends Error {}
const bounce = (message: string): never => {
  throw new Bounce(message);
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CENTS_RE = /^\d+$/;

function objectWith(v: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bounce(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!keys.includes(k))
      bounce(`${where} has no field ${JSON.stringify(k)}; its fields are ${keys.join(", ")}`);
  for (const k of keys)
    if (!(k in o)) bounce(`${where}.${k} is required (null where the rulebook says null)`);
  return o;
}
const dateOf = (v: unknown, where: string): string =>
  typeof v === "string" && DATE_RE.test(v) ? v : bounce(`${where} must be a date, YYYY-MM-DD`);
const dateOrNull = (v: unknown, where: string): string | null =>
  v === null ? null : dateOf(v, `${where} (or null)`);
const centsOf = (v: unknown, where: string): string =>
  typeof v === "string" && CENTS_RE.test(v)
    ? BigInt(v).toString()
    : bounce(`${where} must be integer cents as a string, e.g. "31200000"`);
const centsOrNull = (v: unknown, where: string): string | null =>
  v === null ? null : centsOf(v, `${where} (or null)`);
const intOrNull = (v: unknown, where: string): number | null =>
  v === null
    ? null
    : typeof v === "number" && Number.isInteger(v) && v >= 0
      ? v
      : bounce(`${where} must be a whole number, or null`);
const boolOf = (v: unknown, where: string): boolean =>
  typeof v === "boolean" ? v : bounce(`${where} must be true or false`);
const boolOrNull = (v: unknown, where: string): boolean | null =>
  v === null ? null : boolOf(v, `${where} (or null)`);
function oneOf<T extends string>(v: unknown, where: string, values: readonly T[]): T {
  return typeof v === "string" && (values as readonly string[]).includes(v)
    ? (v as T)
    : bounce(`${where} must be one of ${values.join(", ")}`);
}
function listOf<T>(v: unknown, where: string, item: (x: unknown, w: string) => T): T[] {
  if (!Array.isArray(v)) return bounce(`${where} must be a list`);
  const out = v.map((x, i) => item(x, `${where}[${i}]`));
  if (new Set(out.map(String)).size !== out.length) bounce(`${where} lists the same entry twice`);
  return out;
}

export const POSITION_KEYS = [
  "original_value_cents",
  "rule_78_applies",
  "pi_cents",
  "scheduled_78_payment_number",
  "scheduled_78_date",
  "midpoint_termination_date",
  "trigger_date",
] as const;
export const REQUEST_KEYS = [
  "evaluation_upb_cents",
  "threshold_bps",
  "ltv_bps",
  "fnma_current",
  "late30_12m",
  "late60_24m",
  "result",
  "reasons",
  "decision_due",
] as const;
export const AUTOMATIC_KEYS = [
  "current_on_trigger",
  "not_current_installments",
  "not_current_notice_due",
  "cure_on",
] as const;
export const TERMINATION_KEYS = [
  "effective_on",
  "lar89_action_code",
  "lar89_action_date",
  "notice_due",
  "premium_stop_by",
  "refund_due",
  "insurer_notice_due",
  "escrow_interim_analysis_due",
  "unearned_premium_cents",
] as const;
export const ANSWER_KEYS = [
  "position",
  "request",
  "automatic",
  "termination",
  "lpmi_options_notice_due",
] as const;

function readAnswer(raw: unknown): PmiAnswer {
  const s = objectWith(raw, "the submission", ANSWER_KEYS);
  const p = objectWith(s["position"], "position", POSITION_KEYS);
  const position: PmiPositionAnswer = {
    original_value_cents: centsOf(p["original_value_cents"], "position.original_value_cents"),
    rule_78_applies: boolOf(p["rule_78_applies"], "position.rule_78_applies"),
    pi_cents: centsOf(p["pi_cents"], "position.pi_cents"),
    scheduled_78_payment_number: intOrNull(
      p["scheduled_78_payment_number"],
      "position.scheduled_78_payment_number",
    ),
    scheduled_78_date: dateOrNull(p["scheduled_78_date"], "position.scheduled_78_date"),
    midpoint_termination_date: dateOf(
      p["midpoint_termination_date"],
      "position.midpoint_termination_date",
    ),
    trigger_date: dateOf(p["trigger_date"], "position.trigger_date"),
  };
  let request: PmiRequestAnswer | null = null;
  if (s["request"] !== null) {
    const r = objectWith(s["request"], "request", REQUEST_KEYS);
    request = {
      evaluation_upb_cents: centsOrNull(r["evaluation_upb_cents"], "request.evaluation_upb_cents"),
      threshold_bps: intOrNull(r["threshold_bps"], "request.threshold_bps"),
      ltv_bps: intOrNull(r["ltv_bps"], "request.ltv_bps"),
      fnma_current: boolOrNull(r["fnma_current"], "request.fnma_current"),
      late30_12m: intOrNull(r["late30_12m"], "request.late30_12m"),
      late60_24m: intOrNull(r["late60_24m"], "request.late60_24m"),
      result: oneOf(r["result"], "request.result", REQUEST_RESULTS),
      reasons: listOf(r["reasons"], "request.reasons", (x, w) => oneOf(x, w, REQUEST_REASONS)),
      decision_due: dateOf(r["decision_due"], "request.decision_due"),
    };
  }
  let automatic: PmiAutomaticAnswer | null = null;
  if (s["automatic"] !== null) {
    const a = objectWith(s["automatic"], "automatic", AUTOMATIC_KEYS);
    automatic = {
      current_on_trigger: boolOf(a["current_on_trigger"], "automatic.current_on_trigger"),
      not_current_installments: listOf(
        a["not_current_installments"],
        "automatic.not_current_installments",
        dateOf,
      ),
      not_current_notice_due: dateOrNull(
        a["not_current_notice_due"],
        "automatic.not_current_notice_due",
      ),
      cure_on: dateOrNull(a["cure_on"], "automatic.cure_on"),
    };
  }
  let termination: PmiTerminationAnswer | null = null;
  if (s["termination"] !== null) {
    const t = objectWith(s["termination"], "termination", TERMINATION_KEYS);
    const lar = t["lar89_action_date"];
    termination = {
      effective_on: dateOf(t["effective_on"], "termination.effective_on"),
      lar89_action_code: oneOf(
        t["lar89_action_code"],
        "termination.lar89_action_code",
        LAR89_CODES,
      ),
      lar89_action_date:
        typeof lar === "string" && /^\d{6}$/.test(lar)
          ? lar
          : bounce("termination.lar89_action_date must be six digits, MMDDYY"),
      notice_due: dateOf(t["notice_due"], "termination.notice_due"),
      premium_stop_by: dateOf(t["premium_stop_by"], "termination.premium_stop_by"),
      refund_due: dateOf(t["refund_due"], "termination.refund_due"),
      insurer_notice_due: dateOf(t["insurer_notice_due"], "termination.insurer_notice_due"),
      escrow_interim_analysis_due: dateOf(
        t["escrow_interim_analysis_due"],
        "termination.escrow_interim_analysis_due",
      ),
      unearned_premium_cents: centsOf(
        t["unearned_premium_cents"],
        "termination.unearned_premium_cents",
      ),
    };
  }
  const answer: PmiAnswer = {
    position,
    request,
    automatic,
    termination,
    lpmi_options_notice_due: dateOrNull(s["lpmi_options_notice_due"], "lpmi_options_notice_due"),
  };
  agree(answer);
  return answer;
}

const VALUE_REASONS = ["VALUE_DECLINED_OR_UNKNOWN", "VALUATION_REQUIRED", "VALUATION_EXPIRED"];

/**
 * The sections must agree with one another as the rulebook ties them, so an answer cannot say two
 * things at once: a request or a sweep, never both; a result and its reasons; a sweep's findings and
 * whether it found the loan current; a termination exactly when the request is eligible or the sweep
 * found the loan current or cured, with the code its kind takes; and the lender-paid notice alone.
 */
function agree(a: PmiAnswer): void {
  const r = a.request;
  const s = a.automatic;
  if (r && s)
    bounce("request and automatic cannot both be answered: a task has a request or a sweep");
  if (r) {
    const reasons = r.reasons;
    if (r.result === "eligible" && reasons.length > 0)
      bounce("an eligible request has no reasons: request.reasons must be []");
    if (
      r.result === "ineligible" &&
      (reasons.length === 0 || reasons.some((x) => VALUE_REASONS.includes(x)))
    )
      bounce(
        "an ineligible request gives its reasons from Step 7.9 (SEASONING_INSUFFICIENT, the LTV reasons, NOT_CURRENT, the history reasons) and no others",
      );
    if (
      r.result === "value_check_needed" &&
      !(
        reasons.length === 1 &&
        ["VALUE_DECLINED_OR_UNKNOWN", "VALUATION_REQUIRED"].includes(reasons[0]!)
      )
    )
      bounce(
        "a value check needed gives one reason: VALUE_DECLINED_OR_UNKNOWN or VALUATION_REQUIRED",
      );
    if (r.result === "refused") {
      if (!(reasons.length === 1 && reasons[0] === "VALUATION_EXPIRED"))
        bounce('a refused request gives one reason: ["VALUATION_EXPIRED"]');
      const evaluated = [
        r.evaluation_upb_cents,
        r.threshold_bps,
        r.ltv_bps,
        r.fnma_current,
        r.late30_12m,
        r.late60_24m,
      ];
      if (evaluated.some((x) => x !== null))
        bounce(
          "a refused request evaluates nothing: every request field but result, reasons and decision_due is null",
        );
    }
    if (reasons.includes("VALUATION_REQUIRED") && r.ltv_bps !== null)
      bounce("with no valuation there is no LTV: request.ltv_bps is null");
  }
  if (s) {
    if (
      s.current_on_trigger &&
      (s.not_current_installments.length > 0 ||
        s.not_current_notice_due !== null ||
        s.cure_on !== null)
    )
      bounce(
        "a sweep that finds the loan current lists no installments and has no notice and no cure",
      );
    if (
      !s.current_on_trigger &&
      (s.not_current_installments.length === 0 || s.not_current_notice_due === null)
    )
      bounce(
        "a sweep that finds the loan not current lists the installments that failed and the notice's due date",
      );
  }
  const ends =
    r?.result === "eligible" || (s !== null && (s.current_on_trigger || s.cure_on !== null));
  if (ends && a.termination === null)
    bounce(
      "the MI ends here (an eligible request, or a sweep that found the loan current or cured): termination is required",
    );
  if (!ends && a.termination !== null)
    bounce(
      "termination is null unless the request is eligible or the sweep found the loan current or cured",
    );
  const t = a.termination;
  if (t && r && t.lar89_action_code === "53")
    bounce("a request's termination is coded 51 or 52; 53 is the automatic termination's");
  if (t && s && t.lar89_action_code !== "53") bounce("an automatic termination is coded 53");
  if (a.lpmi_options_notice_due !== null && (r || s || t))
    bounce(
      "lpmi_options_notice_due is lender-paid MI's alone: request, automatic and termination are then null",
    );
}

export function parsePmiSubmission(raw: unknown): Parsed<PmiAnswer> {
  try {
    return { ok: true, answer: readAnswer(raw) };
  } catch (e) {
    if (!(e instanceof Bounce)) throw e;
    return {
      ok: false,
      error: `${e.message}. Nothing was submitted; fix it and call submit_mi_review again.`,
    };
  }
}
