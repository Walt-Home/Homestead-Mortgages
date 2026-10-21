/**
 * The grader is the servicing app's ARM engine.
 *
 * The index selection, the eighth rounding, the caps, the payment, the
 * scheduled balance, the windows and the send check are the ported `arm.ts`
 * itself (engine A), and `arm-verify.ts` (engine B) recomputes the rate and
 * the payment independently: the spec's dual-engine gate. The conventions
 * around them live in the servicing app's stateful ops-7-2.ts and ops.ts,
 * which do not port, so they are restated here exactly, each with the line it
 * comes from (a test holds those lines to the service's source):
 *   - the schedule row: the due day of the first payment (ops-7-2.ts:197),
 *     the first new payment's due date and the notice kind (:199,
 *     nextDueAfter :82-86, noticeKindFor :188-194), the index date (:200),
 *     the window's opening (:201) and the notice's due date (:202);
 *   - maturity = first payment + (term − 1) months (:158);
 *   - the expected balance from the schedule basis, counting the payment due
 *     on the change date, or the basis itself while interest-only
 *     (expectedUpbAt :314-319, monthsBetween :80), and the remaining term
 *     with both ends counted (remainingTermAt :321);
 *   - the first change is the change on first_change_date (:334), and the
 *     payment is interest-only while the first new payment is due on or
 *     before the end of the interest-only period (:336); the rounding rule
 *     (roundingOf :322) and the rounded rate before the caps (:339);
 *   - which notice goes (:436-440, with armNoticeSelection at ops.ts:139-143
 *     and fdcpaCeaseArmNotice at ops.ts:159-162) and how its send date is
 *     checked (:445-451, windowFor :401-403, gated :399);
 *   - the next change date, change + the adjustment period (:461);
 *   - on the first change, the (d) notice's status and window
 *     (initialNoticeWindow, as ops-7-3.ts:144 calls it on the initial row).
 * v1's loans carry no payment-change cycle of their own
 * (payment_change_period_months is null, so :342-343 keeps engine A's
 * payment), and nothing here reads a clock: every date comes from the task.
 */

import { Decimal, type Cents } from "@hm/kernel/money";
import {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  parts,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import {
  computeArmAdjustment,
  indexDate,
  initialNoticeWindow,
  newRate,
  noticeWindow,
  roundToEighth,
  scheduledUpbAfter,
  selectIndex,
  sendCheck,
  type ArmAdjustmentInput,
  type ArmAdjustmentResult,
  type IndexObs,
  type RateBound,
} from "./ported/arm.js";
import { verifyArmAdjustment } from "./ported/arm-verify.js";
import type { ArmLoan, ArmTask } from "./task.js";

export type NoticeKind = "c_60_120" | "c_25_120" | "c_first_25" | "fnma_only";
export const NOTICE_KINDS: readonly NoticeKind[] = [
  "c_60_120",
  "c_25_120",
  "c_first_25",
  "fnma_only",
];
/** The two notices a change can send (ops-7-2.ts:76). */
export const TEMPLATES = {
  regz_c: "NTC_REGZ_20C_ARM_ADJ",
  fnma_change: "NTC_FNMA_C2_1_02_RATE_CHANGE",
} as const;
export type Template = (typeof TEMPLATES)[keyof typeof TEMPLATES];
export const BOUNDS: readonly RateBound[] = ["none", "initial", "periodic", "lifetime", "floor"];
export type SendOutcome = "blocked" | "on_time" | "late";
export type InitialStatus = "servicer" | "originator_duty" | "exempt_short_term";

/* ── the service's conventions, restated ─────────────────────────────────── */

/** ops-7-2.ts:80: months by year and month alone; the day of the month is not read. */
export const monthsBetween = (a: PlainDate, b: PlainDate): number => {
  const pa = parts(a);
  const pb = parts(b);
  return (pb.y - pa.y) * 12 + (pb.m - pa.m);
};

/** ops-7-2.ts:82-86: the first due date (day `dueDay`, clipped to the month) strictly after `d`. */
export function nextDueAfter(d: PlainDate, dueDay: number): PlainDate {
  const p = parts(d);
  const cand = ymd(p.y, p.m, Math.min(dueDay, daysInMonth(p.y, p.m)));
  if (cand > d) return cand;
  const n = parts(addMonths(ymd(p.y, p.m, 1), 1));
  return ymd(n.y, n.m, Math.min(dueDay, daysInMonth(n.y, n.m)));
}

/** ops-7-2.ts:188-194: which (c) timing row applies; the first match wins. */
export function noticeKindFor(
  t: Pick<
    ArmLoan,
    | "term_months"
    | "consummation_date"
    | "initial_disclosure_estimate"
    | "adjustment_period_months"
    | "lookback_days"
  >,
  initial: boolean,
  changeDate: PlainDate,
  firstNewPaymentDue: PlainDate,
): NoticeKind {
  if (t.term_months <= 12) return "fnma_only";
  if (
    initial &&
    daysBetween(t.consummation_date, firstNewPaymentDue) <= 210 &&
    !t.initial_disclosure_estimate
  )
    return "fnma_only";
  if (
    initial &&
    daysBetween(t.consummation_date, changeDate) <= 60 &&
    t.initial_disclosure_estimate
  )
    return "c_first_25";
  if (
    t.adjustment_period_months <= 2 ||
    (t.consummation_date < "2015-01-10" && t.lookback_days < 45)
  )
    return "c_25_120";
  return "c_60_120";
}

/** ops-7-2.ts:158: maturity, when the terms do not state one. */
export const maturityOf = (t: ArmLoan): PlainDate =>
  addMonths(t.first_payment_due, t.term_months - 1);

/** ops-7-2.ts:314-319: the scheduled balance after the payment due on the change date. */
export function expectedUpbAt(t: ArmLoan, changeDate: PlainDate): Cents {
  const b = t.schedule_basis;
  const months = monthsBetween(b.from_due_date, changeDate) + 1;
  if (months < 0) throw new RangeError(`schedule basis ${b.from_due_date} is after ${changeDate}`);
  if (t.interest_only_until !== null && changeDate <= t.interest_only_until) return b.upb_cents;
  return scheduledUpbAfter(b.upb_cents, b.rate_pct, b.pi_cents, months);
}

/** ops-7-2.ts:321: months from the first new payment to maturity, both counted. */
export const remainingTermAt = (t: ArmLoan, firstNewPaymentDue: PlainDate): number =>
  monthsBetween(firstNewPaymentDue, maturityOf(t)) + 1;

/** ops-7-2.ts:322. */
export const roundingOf = (t: ArmLoan): "half_down" | "half_up" =>
  t.rounding_rule === "nearest_eighth_half_up" ? "half_up" : "half_down";

/** ops-7-2.ts:399: the kinds with a not-before gate. */
const gated = (k: NoticeKind): boolean => k === "c_60_120" || k === "c_25_120";

/* ── the analysis: every figure the engine and the service produce ───────── */

export interface ArmAnalysis {
  readonly initial: boolean;
  readonly index_date: PlainDate;
  readonly selected: IndexObs;
  readonly first_new_payment_due: PlainDate;
  readonly maturity: PlainDate;
  readonly notice_kind: NoticeKind;
  readonly notice_window_open: PlainDate | null;
  readonly notice_due_by: PlainDate;
  readonly input: ArmAdjustmentInput;
  readonly a: ArmAdjustmentResult;
  readonly b: ReturnType<typeof verifyArmAdjustment>;
  readonly rounded_pct: string;
  readonly midpoint_flag: boolean;
  readonly rate_changed: boolean;
  readonly payment_changed: boolean;
  readonly template: Template | null;
  /** The Fannie Mae notice in place of a Reg Z notice that would otherwise go (both changed). */
  readonly regz_suppressed: boolean;
  readonly send_outcome: SendOutcome | null;
  readonly days_late: number | null;
  readonly next_change_date: PlainDate;
  readonly initial_notice: ReturnType<typeof initialNoticeWindow> | null;
}

export function analyzeArm(task: ArmTask): ArmAnalysis {
  const t = task.loan;
  const change = task.change_date;
  // The schedule row (ops-7-2.ts:197-202).
  const dueDay = parts(t.first_payment_due).d;
  const initial = change === t.first_change_date;
  const fnpd = nextDueAfter(change, dueDay);
  const kind = noticeKindFor(t, initial, change, fnpd);
  const index_date = indexDate(change, t.lookback_days);
  const notice_window_open = gated(kind) ? addDays(fnpd, -120) : null;
  const notice_due_by =
    kind === "c_60_120"
      ? addDays(fnpd, -60)
      : kind === "fnma_only"
        ? addDays(change, -25)
        : addDays(fnpd, -25);

  // The calculation (ops-7-2.ts:332-339).
  const selected = selectIndex(task.index_series, index_date);
  if (!selected)
    throw new RangeError(`${task.id}: no index publication on or before ${index_date}`);
  const interest_only = t.interest_only_until !== null && fnpd <= t.interest_only_until;
  const input: ArmAdjustmentInput = {
    index_pct: selected.value,
    margin_pct: t.margin_pct,
    prior_rate_pct: t.current_rate_pct,
    initial_note_rate_pct: t.initial_note_rate_pct,
    initial_cap_pct: t.initial_cap_pct,
    periodic_cap_pct: t.periodic_cap_pct,
    lifetime_cap_pct: t.lifetime_cap_pct,
    first_change: initial,
    rounding: roundingOf(t),
    expected_upb_cents: expectedUpbAt(t, change),
    remaining_term_months: remainingTermAt(t, fnpd),
    interest_only,
  };
  const a = computeArmAdjustment(input);
  const r = newRate(input);
  const rounded_pct = roundToEighth(Decimal.parse(a.unrounded_pct), roundingOf(t)).rate.toFixed(3);
  const b = verifyArmAdjustment(input, a);

  // Which notice (ops-7-2.ts:436-440; ops.ts:139-143, 159-162).
  const rate_changed = a.new_rate_pct !== t.current_rate_pct;
  const payment_changed = a.new_pi_cents !== t.current_pi_cents;
  const cease = t.fdcpa_cease_on_file && t.fdcpa_debt_collector;
  const both = rate_changed && payment_changed;
  const regz = both && kind !== "fnma_only" && !cease;
  const template: Template | null = regz
    ? TEMPLATES.regz_c
    : rate_changed || payment_changed
      ? TEMPLATES.fnma_change
      : null;

  // The send check (ops-7-2.ts:445-451): the Reg Z window, or the Fannie Mae notice's 25 days.
  let send_outcome: SendOutcome | null = null;
  let days_late: number | null = null;
  if (regz) {
    const w = noticeWindow(fnpd, change, t.lookback_days, kind !== "c_60_120");
    const check = sendCheck(
      task.proposed_send_on,
      {
        not_before: gated(kind) ? w.not_before : task.proposed_send_on,
        deadline: kind === "c_60_120" ? w.deadline : addDays(fnpd, -25),
      },
      { gate: "not_before", deadline: "deadline" },
    );
    send_outcome = !check.allowed ? "blocked" : check.breach ? "late" : "on_time";
    days_late = check.breach ? check.breach.days_late : null;
  } else if (template !== null) {
    // armNoticeSelection's send_by: change − 25 when exactly one changed, none when both did.
    const sendBy = both ? null : addDays(change, -25);
    send_outcome = sendBy !== null && task.proposed_send_on > sendBy ? "late" : "on_time";
  }

  return {
    initial,
    index_date,
    selected,
    first_new_payment_due: fnpd,
    maturity: maturityOf(t),
    notice_kind: kind,
    notice_window_open,
    notice_due_by,
    input,
    a,
    b,
    rounded_pct,
    midpoint_flag: r.midpoint_flag,
    rate_changed,
    payment_changed,
    template,
    regz_suppressed: both && !regz,
    send_outcome,
    days_late,
    next_change_date: addMonths(change, t.adjustment_period_months),
    initial_notice: initial ? initialNoticeWindow(fnpd, t.consummation_date, t.term_months) : null,
  };
}

/** Rates and dates as the strings the rulebook states them in, cents as decimal strings; null where a change has no such figure. */
export interface ArmAnswer {
  readonly index_date: string;
  readonly index_effective_date: string;
  readonly index_value: string;
  readonly unrounded_pct: string;
  readonly rounded_pct: string;
  readonly midpoint_flag: boolean;
  readonly new_rate_pct: string;
  readonly bound: RateBound;
  readonly expected_upb_cents: string;
  readonly first_new_payment_due: string;
  readonly remaining_term_months: number;
  readonly next_change_date: string;
  readonly new_pi_cents: string;
  readonly notice_kind: NoticeKind;
  readonly notice_window_open: string | null;
  readonly notice_due_by: string;
  readonly notice_template: Template | null;
  readonly send_outcome: SendOutcome | null;
  readonly days_late: number | null;
  readonly initial_notice_status: InitialStatus | null;
  readonly initial_notice_window_open: string | null;
  readonly initial_notice_due_by: string | null;
}

export function answerOf(x: ArmAnalysis): ArmAnswer {
  return {
    index_date: x.index_date,
    index_effective_date: x.selected.effective_date,
    index_value: x.selected.value,
    unrounded_pct: x.a.unrounded_pct,
    rounded_pct: x.rounded_pct,
    midpoint_flag: x.midpoint_flag,
    new_rate_pct: x.a.new_rate_pct,
    bound: x.a.bound,
    expected_upb_cents: String(x.input.expected_upb_cents),
    first_new_payment_due: x.first_new_payment_due,
    remaining_term_months: x.input.remaining_term_months,
    next_change_date: x.next_change_date,
    new_pi_cents: String(x.a.new_pi_cents),
    notice_kind: x.notice_kind,
    notice_window_open: x.notice_window_open,
    notice_due_by: x.notice_due_by,
    notice_template: x.template,
    send_outcome: x.send_outcome,
    days_late: x.days_late,
    initial_notice_status: x.initial_notice?.status ?? null,
    initial_notice_window_open: x.initial_notice?.not_before ?? null,
    initial_notice_due_by: x.initial_notice?.deadline ?? null,
  };
}

export const expectedArm = (task: ArmTask): ArmAnswer => answerOf(analyzeArm(task));

/* ── grading ──────────────────────────────────────────────────────────────
 * A field per decision or figure, with the figures that only travel with
 * another graded beside it: the index (its date, the print chosen and its
 * value), the rounding (the unrounded rate, the eighth and whether it was a
 * midpoint), the rate (the new rate and the limit that bound it), the
 * expected balance, the schedule (the first new payment, the remaining term
 * and the next change), the payment, the (c) notice's timing (its kind,
 * opening and due date), the notice (which one goes, and the send check
 * against it), and on the first change the (d) notice. Most changes bind no
 * cap, round no midpoint and send the Reg Z notice on time; grading those
 * labels with the figure or the decision beside them keeps an answer that
 * guesses the commonest label from scoring well (about 0.11 on the held-out
 * suite). An initial notice reported on a later change is a field of its
 * own, so hedging is never cheaper than committing.
 */

export const ARM_GROUPS = {
  index: ["index_date", "index_effective_date", "index_value"],
  rounding: ["unrounded_pct", "rounded_pct", "midpoint_flag"],
  rate: ["new_rate_pct", "bound"],
  expected_upb_cents: ["expected_upb_cents"],
  schedule: ["first_new_payment_due", "remaining_term_months", "next_change_date"],
  new_pi_cents: ["new_pi_cents"],
  notice_timing: ["notice_kind", "notice_window_open", "notice_due_by"],
  notice: ["notice_template", "send_outcome", "days_late"],
} as const satisfies Record<string, readonly (keyof ArmAnswer)[]>;
const INITIAL = [
  "initial_notice_status",
  "initial_notice_window_open",
  "initial_notice_due_by",
] as const satisfies readonly (keyof ArmAnswer)[];

const shown = (v: unknown): string => (v === null || v === undefined ? "null" : String(v));
const groupOf = (a: ArmAnswer, keys: readonly (keyof ArmAnswer)[]): string =>
  keys.length === 1
    ? shown(a[keys[0]!])
    : JSON.stringify(Object.fromEntries(keys.map((k) => [k, a[k] ?? null])));

export function gradeArmAgainst(want: ArmAnswer, answer: ArmAnswer | null): Grade {
  const fields: FieldGrade[] = Object.entries(ARM_GROUPS).map(([field, keys]) => {
    const expected = groupOf(want, keys);
    const got = answer ? groupOf(answer, keys) : null;
    return { field, expected, got, ok: got === expected };
  });
  const reportsInitial = answer !== null && INITIAL.some((k) => answer[k] !== null);
  if (want.initial_notice_status !== null) {
    const expected = groupOf(want, INITIAL);
    const got = answer ? groupOf(answer, INITIAL) : null;
    fields.push({ field: "initial_notice", expected, got, ok: got === expected });
  } else if (reportsInitial) {
    fields.push({
      field: "initial_notice",
      expected: "none: not the first change",
      got: groupOf(answer, INITIAL),
      ok: false,
    });
  }
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradeArm = (task: ArmTask, answer: ArmAnswer | null): Grade =>
  gradeArmAgainst(expectedArm(task), answer);

/* ── the submission, read strictly ──────────────────────────────────────── */

const FIELDS: readonly (keyof ArmAnswer)[] = [
  ...Object.values(ARM_GROUPS).flat(),
  ...INITIAL,
] as (keyof ArmAnswer)[];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHAPES: Readonly<Partial<Record<keyof ArmAnswer, RegExp>>> = {
  index_value: /^\d{1,2}\.\d{5}$/,
  unrounded_pct: /^\d{1,2}\.\d{5}$/,
  rounded_pct: /^\d{1,2}\.\d{3}$/,
  new_rate_pct: /^\d{1,2}\.\d{3}$/,
};
const REQUIRED_DATES = new Set<keyof ArmAnswer>([
  "index_date",
  "index_effective_date",
  "first_new_payment_due",
  "next_change_date",
  "notice_due_by",
]);
const NULLABLE_DATES = new Set<keyof ArmAnswer>([
  "notice_window_open",
  "initial_notice_window_open",
  "initial_notice_due_by",
]);
const ENUMS: Readonly<Partial<Record<keyof ArmAnswer, readonly string[]>>> = {
  bound: BOUNDS,
  notice_kind: NOTICE_KINDS,
};
const NULLABLE_ENUMS: Readonly<Partial<Record<keyof ArmAnswer, readonly string[]>>> = {
  notice_template: Object.values(TEMPLATES),
  send_outcome: ["blocked", "on_time", "late"],
  initial_notice_status: ["servicer", "originator_duty", "exempt_short_term"],
};

export function parseArmSubmission(raw: unknown): Parsed<ArmAnswer> {
  const fail = (error: string): Parsed<ArmAnswer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_adjustment again.`,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("the submission must be an object");
  const s = raw as Record<string, unknown>;
  const unknown = Object.keys(s).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length) return fail(`${unknown.join(", ")} is not a field of the submission`);
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) {
    if (!(f in s)) return fail(`${f} is missing; give every field, null where the rulebook says`);
    const v = s[f];
    if (REQUIRED_DATES.has(f) || NULLABLE_DATES.has(f)) {
      if (v === null && NULLABLE_DATES.has(f)) out[f] = null;
      else if (typeof v === "string" && DATE.test(v.trim())) out[f] = v.trim();
      else
        return fail(`${f} must be a date, YYYY-MM-DD${NULLABLE_DATES.has(f) ? ", or null" : ""}`);
    } else if (f === "expected_upb_cents" || f === "new_pi_cents") {
      if (typeof v === "string" && /^\d+$/.test(v.trim())) out[f] = BigInt(v.trim()).toString();
      else if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[f] = String(v);
      else return fail(`${f} must be integer cents as a string`);
    } else if (f === "remaining_term_months") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
        return fail(`${f} must be a whole number of months`);
      out[f] = v;
    } else if (f === "days_late") {
      if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 1))
        return fail("days_late must be a whole number of days late, or null");
      out[f] = v;
    } else if (f === "midpoint_flag") {
      if (typeof v !== "boolean") return fail("midpoint_flag must be true or false");
      out[f] = v;
    } else if (ENUMS[f]) {
      if (typeof v !== "string" || !ENUMS[f].includes(v))
        return fail(`${f} must be one of ${ENUMS[f].join(", ")}`);
      out[f] = v;
    } else if (NULLABLE_ENUMS[f]) {
      if (v !== null && (typeof v !== "string" || !NULLABLE_ENUMS[f].includes(v)))
        return fail(`${f} must be one of ${NULLABLE_ENUMS[f].join(", ")}, or null`);
      out[f] = v;
    } else {
      const shape = SHAPES[f]!;
      if (typeof v !== "string" || !shape.test(v.trim()))
        return fail(
          `${f} is not in the form the rulebook states (${f === "index_value" || f === "unrounded_pct" ? "five" : "three"} decimals)`,
        );
      out[f] = v.trim();
    }
  }
  return { ok: true, answer: out as unknown as ArmAnswer };
}
