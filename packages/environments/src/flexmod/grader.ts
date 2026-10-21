/**
 * The grader is the servicing app's Flex Modification engine.
 *
 * The waterfall is the ported `flexmod.ts` itself. The conventions around
 * it live in the servicing app's stateful FlexModService, which does not
 * port, so they are restated here exactly, each with the line it comes from:
 *   - the prechecks, in order: a failed trial fewer than 365 days before the
 *     evaluation (ops-12-8.ts:153), then three or more prior modifications
 *     (ops-12-8.ts:154-155, ops.ts:633);
 *   - the Modification Interest Rate: the row with the latest effective
 *     date on or before the evaluation date (ops.ts:640-645);
 *   - the denial when the waterfall is not eligible (ops-12-8.ts:162);
 *   - exhaustion_offer = P&I above the target (ops-12-8.ts:163);
 *   - the trial schedule (flexmod.ts trialSchedule) with the shortage spread
 *     over 60 months half up (ops.ts:535-545 default), no processing month;
 *   - capitalization = effective − 1 month and maturity = effective +
 *     (term − 1) months (ops-12-8.ts:197-200).
 */

import type { Cents } from "@hm/kernel/money";
import { addMonths, daysBetween } from "@hm/kernel/calendar";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import { trialCount, trialSchedule, waterfall, type WaterfallResult } from "./ported/flexmod.js";
import type { FlexTask } from "./task.js";

export const DENIALS = [
  "FNMA_D23206_TRIAL_FAILED_12M",
  "FNMA_D23206_THREE_PRIOR_MODS",
  "INV_FNMA_F127_PI_RULE",
] as const;
export type Denial = (typeof DENIALS)[number];

/** The rate-table row in force: the latest effective on or before the evaluation date. */
export function mirFor(task: FlexTask): string | null {
  const rows = task.mir_table
    .filter((r) => r.effective <= task.evaluation_on)
    .sort((a, b) => (a.effective < b.effective ? 1 : -1));
  return rows[0]?.rate_pct ?? null;
}

/** The shortage spread over 60 months, half up. */
export const shortageMonthly = (shortage: Cents): Cents => (shortage * 2n + 60n) / 120n;

export interface FlexAnalysis {
  readonly denial: Denial | null;
  readonly mir_pct: string | null;
  readonly waterfall: WaterfallResult | null;
}

export function analyzeFlex(task: FlexTask): FlexAnalysis {
  if (task.last_trial_failed_on && daysBetween(task.last_trial_failed_on, task.evaluation_on) < 365)
    return { denial: "FNMA_D23206_TRIAL_FAILED_12M", mir_pct: null, waterfall: null };
  if (task.prior_modifications >= 3)
    return { denial: "FNMA_D23206_THREE_PRIOR_MODS", mir_pct: null, waterfall: null };
  const mir = mirFor(task);
  if (mir === null) throw new RangeError(`${task.id}: no MIR in force on ${task.evaluation_on}`);
  const w = waterfall({ ...task.loan, mir_pct: mir });
  return { denial: w.eligible ? null : "INV_FNMA_F127_PI_RULE", mir_pct: mir, waterfall: w };
}

/** Cents as decimal strings, rates and percents as the strings the rules state them in; null where the evaluation has no such figure. */
export interface FlexAnswer {
  readonly decision: "offer" | "denied";
  readonly denial_reason: Denial | null;
  readonly mir_pct: string | null;
  readonly gross_upb_cents: string | null;
  readonly mtmltv_pct: string | null;
  readonly target_pi_cents: string | null;
  readonly rate_pct: string | null;
  readonly term_months: number | null;
  readonly forborne_cents: string | null;
  readonly ib_upb_cents: string | null;
  readonly pi_cents: string | null;
  readonly reduction_pct: string | null;
  readonly post_mod_ib_mtmltv_pct: string | null;
  readonly exhaustion_offer: boolean | null;
  readonly trial_months: number | null;
  readonly first_trial_due_on: string | null;
  readonly last_trial_due_on: string | null;
  readonly trial_payment_cents: string | null;
  readonly effective_on: string | null;
  readonly capitalization_on: string | null;
  readonly maturity_on: string | null;
  readonly incentive_deadline: string | null;
}

export function expectedFlex(task: FlexTask): FlexAnswer {
  const a = analyzeFlex(task);
  const w = a.waterfall;
  const offer = a.denial === null && w !== null;
  const s = offer
    ? trialSchedule(
        task.trial.notice_sent_on,
        trialCount(task.loan.delinquent_31_plus),
        task.trial.ti_monthly_cents,
        shortageMonthly(task.trial.escrow_shortage_cents),
        w.pi_cents,
      )
    : null;
  return {
    decision: offer ? "offer" : "denied",
    denial_reason: a.denial,
    mir_pct: a.mir_pct === null ? null : Number(a.mir_pct).toFixed(3),
    gross_upb_cents: w ? String(w.gross_upb_cents) : null,
    mtmltv_pct: w ? w.mtmltv : null,
    target_pi_cents: w ? String(w.target_pi_cents) : null,
    rate_pct: w ? w.rate_pct : null,
    term_months: w ? w.term_months : null,
    forborne_cents: w ? String(w.forborne_cents) : null,
    ib_upb_cents: w ? String(w.ib_upb_cents) : null,
    pi_cents: w ? String(w.pi_cents) : null,
    reduction_pct: w ? w.reduction_pct : null,
    post_mod_ib_mtmltv_pct: w ? w.post_mod_ib_mtmltv : null,
    exhaustion_offer: offer ? w.pi_cents > w.target_pi_cents : null,
    trial_months: s ? s.due_dates.length : null,
    first_trial_due_on: s ? s.due_dates[0]! : null,
    last_trial_due_on: s ? s.due_dates[s.due_dates.length - 1]! : null,
    trial_payment_cents: s ? String(s.trial_payment_cents) : null,
    effective_on: s ? s.effective : null,
    capitalization_on: s ? addMonths(s.effective, -1) : null,
    maturity_on: s && w ? addMonths(s.effective, w.term_months - 1) : null,
    incentive_deadline: s ? s.incentive_deadline : null,
  };
}

export const FLEX_FIELDS: readonly (keyof FlexAnswer)[] = [
  "decision",
  "denial_reason",
  "mir_pct",
  "gross_upb_cents",
  "mtmltv_pct",
  "target_pi_cents",
  "rate_pct",
  "term_months",
  "forborne_cents",
  "ib_upb_cents",
  "pi_cents",
  "reduction_pct",
  "post_mod_ib_mtmltv_pct",
  "exhaustion_offer",
  "trial_months",
  "first_trial_due_on",
  "last_trial_due_on",
  "trial_payment_cents",
  "effective_on",
  "capitalization_on",
  "maturity_on",
  "incentive_deadline",
];

const shown = (v: unknown): string => (v === null || v === undefined ? "null" : String(v));

export function gradeFlexAgainst(want: FlexAnswer, answer: FlexAnswer | null): Grade {
  const fields: FieldGrade[] = FLEX_FIELDS.map((f) => {
    const expected = shown(want[f]);
    const got = answer ? shown(answer[f]) : null;
    return { field: f, expected, got, ok: got === expected };
  });
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradeFlex = (task: FlexTask, answer: FlexAnswer | null): Grade =>
  gradeFlexAgainst(expectedFlex(task), answer);

/* ── the submission, read strictly ──────────────────────────────────────── */

const CENTS = new Set<keyof FlexAnswer>([
  "gross_upb_cents",
  "target_pi_cents",
  "forborne_cents",
  "ib_upb_cents",
  "pi_cents",
  "trial_payment_cents",
]);
const DATES = new Set<keyof FlexAnswer>([
  "first_trial_due_on",
  "last_trial_due_on",
  "effective_on",
  "capitalization_on",
  "maturity_on",
  "incentive_deadline",
]);
const SHAPES: Readonly<Partial<Record<keyof FlexAnswer, RegExp>>> = {
  mir_pct: /^\d{1,2}\.\d{3}$/,
  rate_pct: /^\d{1,2}\.\d{3}$/,
  mtmltv_pct: /^\d{1,4}\.\d{2}$/,
  post_mod_ib_mtmltv_pct: /^\d{1,4}\.\d{2}$/,
  reduction_pct: /^-?\d{1,4}\.\d{4}$/,
};

export function parseFlexSubmission(raw: unknown): Parsed<FlexAnswer> {
  const fail = (error: string): Parsed<FlexAnswer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_evaluation again.`,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("the submission must be an object");
  const s = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of FLEX_FIELDS) {
    const v = s[f] ?? null;
    if (f === "decision") {
      if (v !== "offer" && v !== "denied") return fail('decision must be "offer" or "denied"');
      out[f] = v;
    } else if (v === null) {
      out[f] = null;
    } else if (f === "denial_reason") {
      if (typeof v !== "string" || !(DENIALS as readonly string[]).includes(v))
        return fail(`denial_reason must be one of ${DENIALS.join(", ")}, or null`);
      out[f] = v;
    } else if (CENTS.has(f)) {
      if (typeof v === "string" && /^-?\d+$/.test(v.trim())) out[f] = BigInt(v.trim()).toString();
      else if (typeof v === "number" && Number.isSafeInteger(v)) out[f] = String(v);
      else return fail(`${f} must be integer cents as a string, or null`);
    } else if (DATES.has(f)) {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim()))
        return fail(`${f} must be a date, YYYY-MM-DD, or null`);
      out[f] = v.trim();
    } else if (f === "term_months" || f === "trial_months") {
      if (typeof v !== "number" || !Number.isInteger(v))
        return fail(`${f} must be a whole number, or null`);
      out[f] = v;
    } else if (f === "exhaustion_offer") {
      if (typeof v !== "boolean") return fail(`${f} must be true, false or null`);
      out[f] = v;
    } else {
      const shape = SHAPES[f]!;
      if (typeof v !== "string" || !shape.test(v.trim()))
        return fail(`${f} is not in the form the rulebook states, or null`);
      out[f] = v.trim();
    }
  }
  return { ok: true, answer: out as unknown as FlexAnswer };
}
