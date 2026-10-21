/**
 * The grader is the servicing app's payoff engine.
 *
 * The statement, the reconciliation and Fannie Mae's share are the ported
 * `quote.ts`, `remit.ts` and `investor/remittance.ts` themselves. What the
 * engine takes from its caller lives in the servicing app's stateful ops
 * layer and runtime tools, which do not port; it is restated here exactly,
 * each with the line it comes from (a test holds those lines to the source):
 *   - the CT requested payoff date is the request's good-through date
 *     (`statementDeadlines`' third argument, quote.ts:60);
 *   - the payoff date is the day the funds were credited, or the installment
 *     due date under the F-1-09 non-business-day rule (ops-16-2.ts:44-48).
 *     The borrower pays directly, so the S/S closing agent's settlement date
 *     (ops-16-2.ts:45) never applies;
 *   - the exact figure is the statement recomputed as of the payoff date
 *     (ops-16-2.ts:373, `exactFigure`);
 *   - a reliance state is one in `RELIANCE_STATES` (quote.ts:35), and the
 *     payoff is within good-through when the payoff date is on or before it;
 *     the runtime takes both as flags (section16-2.ts:138);
 *   - the S/S exception: an MBS loan processed on the first Fannie Mae
 *     business day of its month and reported by the second
 *     (ops-16-2.ts:157-161, over investor/period.ts:20 `fannieBusinessDay`),
 *     processed on the payoff date (ops-16-2.ts:171, `processed_on ??
 *     payoff_on`);
 *   - participation is 100 %, which `fnmaShare` never reads anyway.
 * The servicing fee is graded for A/A only and the S/S gap for S/S only:
 * for S/A and S/S the portable engine's fee of 0 is not what the runtime
 * books (ops-16-2.ts:169-185 computes one for every type), so v1 reports
 * neither figure where it is not the remittance type's own.
 */

import { addBusinessDays, fannieEt, parts, ymd, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import {
  RELIANCE_STATES,
  alternativeFigures,
  deemedPayoffDate,
  quote,
  statementDeadlines,
  validUntil,
  type Components,
} from "./ported/quote.js";
import { fnmaShare, housekeeping, variance } from "./ported/remit.js";
import type { RemittanceType } from "./ported/types.js";
import type { PayoffTask } from "./task.js";

export const DISPOSITIONS = [
  "paid_in_full",
  "paid_in_full_tolerance_expense",
  "paid_in_full_overage_refund_10bd",
  "short_payoff_demand_1bd",
  "reliance_absorbed",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** The loan as the engine's `Components`, quoted through `goodThrough`. */
export function componentsOf(task: PayoffTask, goodThrough: PlainDate): Components {
  const l = task.loan;
  return {
    upb_cents: l.upb_cents,
    rate_pct: l.rate_pct,
    lpi_due: l.lpi_due,
    good_through: goodThrough,
    nib_deferred_cents: l.nib_deferred_cents,
    nib_forborne_cents: l.nib_forborne_cents,
    late_charges_cents: l.late_charges_cents,
    fees_cents: l.fees_cents,
    corporate_advances_cents: l.corporate_advances_cents,
    escrow_advance_cents: l.escrow_advance_cents,
    recording_fee_cents: l.recording_fee_cents,
    mi_premium_cents: l.mi_premium_cents,
    buydown_credit_cents: l.buydown_credit_cents,
    suspense_credit_cents: l.suspense_credit_cents,
    method: l.accrual_method,
  };
}

/** Business day `n` of a date's month on the fannie_et calendar: investor/period.ts:20, verbatim. */
export function fannieBusinessDay(d: PlainDate, n: number): PlainDate {
  const { y, m } = parts(d);
  const first = ymd(y, m, 1);
  return addBusinessDays(first, n, fannieEt) === first
    ? first
    : fannieEt.isBusinessDay(first)
      ? addBusinessDays(first, n - 1, fannieEt)
      : addBusinessDays(first, n, fannieEt);
}

/** The F-1-20 S/S exception (ops-16-2.ts:157-161), processed on the payoff date (ops-16-2.ts:171). */
export function ssBd1Bd2Exception(i: {
  type: RemittanceType;
  mbs_pool: boolean;
  processed_on: PlainDate;
  reported_on: PlainDate;
}): boolean {
  if (i.type !== "SS" || !i.mbs_pool) return false;
  const bd1 = fannieBusinessDay(i.processed_on, 1);
  const bd2 = fannieBusinessDay(i.processed_on, 2);
  return i.processed_on === bd1 && i.reported_on <= bd2;
}

/** Everything the engine concludes about a task, before it is put in the answer's words. */
export function analyzePayoff(task: PayoffTask) {
  const { request: r, funds: f, investor: inv } = task;
  const deadlines = statementDeadlines(r.state, r.received_on, r.good_through);
  const statement = quote(componentsOf(task, r.good_through));
  const alternative = task.next_installment
    ? alternativeFigures(componentsOf(task, r.good_through), {
        calc_at: r.issued_on,
        installment_due: task.next_installment.due_on,
        installment_principal_cents: task.next_installment.principal_cents,
        autodraft: task.next_installment.autodraft,
      })
    : null;
  const payoffOn = deemedPayoffDate(f.received_on, f.installment_due_on);
  const exact = quote(componentsOf(task, payoffOn));
  const reconciled = variance(
    f.amount_cents,
    exact.total_cents,
    RELIANCE_STATES.has(r.state),
    payoffOn <= r.good_through,
  );
  const exception = ssBd1Bd2Exception({
    type: inv.remittance_type,
    mbs_pool: inv.mbs_pool,
    processed_on: payoffOn,
    reported_on: inv.reported_on,
  });
  const share = fnmaShare({
    type: inv.remittance_type,
    upb_cents: task.loan.upb_cents,
    nib_cents: statement.nib_line_cents,
    note_rate_pct: task.loan.rate_pct,
    ptr_pct: inv.ptr_pct,
    lpi_due: task.loan.lpi_due,
    payoff_on: payoffOn,
    participation: "100",
    mbs_pool: inv.mbs_pool,
    processed_bd1_reported_bd2: exception,
  });
  return {
    deadlines,
    valid_until: validUntil(r.state, r.issued_on, r.good_through),
    statement,
    alternative,
    payoff_on: payoffOn,
    exact,
    reconciled,
    housekeeping: housekeeping(payoffOn),
    exception,
    share,
  };
}
export type PayoffAnalysis = ReturnType<typeof analyzePayoff>;

/** Cents as decimal strings, dates as YYYY-MM-DD; null where the figure is not this loan's. */
export interface PayoffAnswer {
  readonly federal_due: string;
  readonly state_due: string | null;
  readonly governing: "federal" | "state";
  readonly governing_due: string;
  readonly valid_until: string;
  readonly months_full: number;
  readonly days_partial: number;
  readonly interest_full_cents: string;
  readonly interest_partial_cents: string;
  readonly per_diem_cents: string;
  readonly nib_line_cents: string;
  readonly total_cents: string;
  readonly alt_applies: boolean;
  readonly alt_if_posts_total_cents: string | null;
  readonly payoff_date: string;
  readonly exact_total_cents: string;
  readonly variance_cents: string;
  readonly disposition: Disposition;
  readonly escrow_refund_by: string;
  readonly fnma_principal_cents: string;
  readonly fnma_interest_cents: string;
  readonly servicing_fee_cents: string | null;
  readonly ss_interest_gap_cents: string | null;
  readonly fnma_total_cents: string;
}

const s = (c: Cents): string => String(c);

export function answerOf(task: PayoffTask, a: PayoffAnalysis): PayoffAnswer {
  const type = task.investor.remittance_type;
  return {
    federal_due: a.deadlines.federal_due,
    state_due: a.deadlines.state_due,
    governing: a.deadlines.governing,
    governing_due: a.deadlines.governing_due,
    valid_until: a.valid_until,
    months_full: a.statement.interest.months_full,
    days_partial: a.statement.interest.days_partial,
    interest_full_cents: s(a.statement.interest.full_cents),
    interest_partial_cents: s(a.statement.interest.partial_cents),
    per_diem_cents: s(a.statement.per_diem_cents),
    nib_line_cents: s(a.statement.nib_line_cents),
    total_cents: s(a.statement.total_cents),
    alt_applies: a.alternative?.applies ?? false,
    alt_if_posts_total_cents: a.alternative?.if_installment_posts
      ? s(a.alternative.if_installment_posts.total_cents)
      : null,
    payoff_date: a.payoff_on,
    exact_total_cents: s(a.exact.total_cents),
    variance_cents: s(a.reconciled.variance_cents),
    disposition: a.reconciled.disposition,
    escrow_refund_by: a.housekeeping.escrow_refund_by,
    fnma_principal_cents: s(a.share.principal_cents),
    fnma_interest_cents: s(a.share.interest_cents),
    servicing_fee_cents: type === "AA" ? s(a.share.servicing_fee_cents) : null,
    ss_interest_gap_cents: type === "SS" ? s(a.share.ss_interest_gap_cents) : null,
    fnma_total_cents: s(a.share.total_cents),
  };
}

export const expectedPayoff = (task: PayoffTask): PayoffAnswer =>
  answerOf(task, analyzePayoff(task));

/* ── grading ──────────────────────────────────────────────────────────────
 * Twelve fields, each a group of the answer's figures that stand or fall
 * together. Figures that are the same on most loans are graded with the
 * figure that decides them: the state's deadline with how long the
 * statement is good (good-through, except in Massachusetts), the payoff
 * date with the exact figure (the day the funds arrived, except under the
 * non-business-day rule), the NIB line with the total, and the servicing
 * fee and S/S gap with Fannie Mae's interest. So an answer that copies the
 * request and the funds back scores little, and one cent off any figure
 * fails exactly its group.
 */

export const PAYOFF_FIELDS = {
  federal_due: ["federal_due"],
  state_rules: ["state_due", "governing", "governing_due", "valid_until"],
  day_count: ["months_full", "days_partial"],
  interest: ["interest_full_cents", "interest_partial_cents"],
  per_diem: ["per_diem_cents"],
  total: ["nib_line_cents", "total_cents"],
  alternative: ["alt_applies", "alt_if_posts_total_cents"],
  reconciliation: ["payoff_date", "exact_total_cents", "variance_cents"],
  disposition: ["disposition"],
  escrow_refund_by: ["escrow_refund_by"],
  fnma_interest: ["fnma_interest_cents", "servicing_fee_cents", "ss_interest_gap_cents"],
  fnma_principal_and_total: ["fnma_principal_cents", "fnma_total_cents"],
} as const satisfies Record<string, readonly (keyof PayoffAnswer)[]>;

const shown = (a: PayoffAnswer, keys: readonly (keyof PayoffAnswer)[]): string =>
  keys.length === 1
    ? String(a[keys[0]!] ?? "null")
    : JSON.stringify(Object.fromEntries(keys.map((k) => [k, a[k] ?? null])));

export function gradePayoffAgainst(want: PayoffAnswer, answer: PayoffAnswer | null): Grade {
  const fields: FieldGrade[] = Object.entries(PAYOFF_FIELDS).map(([field, keys]) => {
    const expected = shown(want, keys);
    const got = answer ? shown(answer, keys) : null;
    return { field, expected, got, ok: got === expected };
  });
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradePayoff = (task: PayoffTask, answer: PayoffAnswer | null): Grade =>
  gradePayoffAgainst(expectedPayoff(task), answer);

/* ── the submission, read strictly ────────────────────────────────────────
 * Every key the schema requires, none it does not name, and each in the
 * form the schema states: cents as strings of digits, dates as real
 * YYYY-MM-DD dates, whole numbers as numbers, the enums spelled as listed.
 */

const ANSWER_KEYS: readonly (keyof PayoffAnswer)[] = Object.values(PAYOFF_FIELDS).flat();
const CENTS_KEYS = new Set<keyof PayoffAnswer>(ANSWER_KEYS.filter((k) => k.endsWith("_cents")));
const DATE_KEYS = new Set<keyof PayoffAnswer>([
  "federal_due",
  "state_due",
  "governing_due",
  "valid_until",
  "payoff_date",
  "escrow_refund_by",
]);
const NULLABLE = new Set<keyof PayoffAnswer>([
  "state_due",
  "alt_if_posts_total_cents",
  "servicing_fee_cents",
  "ss_interest_gap_cents",
]);

const isRealDate = (v: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export function parsePayoffSubmission(raw: unknown): Parsed<PayoffAnswer> {
  const fail = (error: string): Parsed<PayoffAnswer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_payoff again.`,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("the submission must be an object");
  const sub = raw as Record<string, unknown>;
  const extra = Object.keys(sub).filter((k) => !(ANSWER_KEYS as readonly string[]).includes(k));
  if (extra.length)
    return fail(`the submission has keys the schema does not name: ${extra.join(", ")}`);
  const out: Record<string, unknown> = {};
  for (const k of ANSWER_KEYS) {
    if (!(k in sub)) return fail(`${k} is required (null where the rulebook says null)`);
    const v = sub[k];
    if (v === null) {
      if (!NULLABLE.has(k)) return fail(`${k} may not be null`);
      out[k] = null;
    } else if (CENTS_KEYS.has(k)) {
      if (typeof v !== "string" || !/^-?\d+$/.test(v))
        return fail(`${k} must be integer cents as a string of digits, e.g. "25039082"`);
      out[k] = BigInt(v).toString();
    } else if (DATE_KEYS.has(k)) {
      if (typeof v !== "string" || !isRealDate(v)) return fail(`${k} must be a date, YYYY-MM-DD`);
      out[k] = v;
    } else if (k === "months_full" || k === "days_partial") {
      if (typeof v !== "number" || !Number.isInteger(v)) return fail(`${k} must be a whole number`);
      out[k] = v;
    } else if (k === "alt_applies") {
      if (typeof v !== "boolean") return fail(`${k} must be true or false`);
      out[k] = v;
    } else if (k === "governing") {
      if (v !== "federal" && v !== "state") return fail('governing must be "federal" or "state"');
      out[k] = v;
    } else if (k === "disposition") {
      if (typeof v !== "string" || !(DISPOSITIONS as readonly string[]).includes(v))
        return fail(`disposition must be one of ${DISPOSITIONS.join(", ")}`);
      out[k] = v;
    }
  }
  return { ok: true, answer: out as unknown as PayoffAnswer };
}
