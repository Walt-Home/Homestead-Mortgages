/**
 * The grader is the servicing app's origination income engine.
 *
 * Every figure comes from the ported calculators in `./ported/ops-22-3.ts`
 * (baseSalary, hourlyBase, variableIncome, socialSecurity, supportIncome,
 * retirementDistribution, publicAssistance, subjectRental, regbCheck,
 * continuance3y, totalQualifying). Never `calculateIncome`, `evaluateContinuance`
 * or `finalizeIncome`: they append events to an EventStore. So the service
 * conventions around the calculators are restated here, each with the line
 * it comes from (a test holds those lines to the source):
 *   - the dispatch by type and its input defaults, calculateIncome
 *     (ops-22-3.ts:764-790): a support source's receipts default to full,
 *     regular and timely and a retirement source's access to unrestricted
 *     (:774-775); Social Security's record defaults to the borrower's own
 *     (:773); a variable source takes the 5% band (:771), and the dispatch
 *     forwards neither offsetting factors nor an Average Hours figure;
 *   - an hourly source the hours reclassify as variable is calculated again
 *     as base_hourly_variable with its year-to-date and prior-year earnings,
 *     which the dispatch trends under R3 (:767-768);
 *   - the Reg B check on every calculation, under the type it ended as
 *     (:791), with no factor and no written reason;
 *   - used_for_qualifying = monthly > 0 or gross-up > 0, and a rental's
 *     offset_only, as the service stores them (section22-3.ts:74);
 *   - the three-year continuance against the scheduled note date
 *     (continuance3y, as the gate runs it, evaluators-22-3.ts:17-22); a
 *     failure sets used_for_qualifying false and keeps the figure
 *     (section22-3.ts:84);
 *   - the total is totalQualifying over those rows (section22-3.ts:88).
 * A salary paid per period is annualized exactly (rate × periods a year)
 * before baseSalary divides it: the environment's reading of the paystub.
 */

import { addMonths, type PlainDate } from "@hm/kernel/calendar";
import type { FieldGrade, Grade, Parsed } from "../episode.js";
import {
  FORMULAS,
  STABLE_BAND_PCT_DEFAULT,
  baseSalary,
  continuance3y,
  hourlyBase,
  publicAssistance,
  regbCheck,
  retirementDistribution,
  socialSecurity,
  subjectRental,
  supportIncome,
  totalQualifying,
  variableIncome,
  type IncomeCalculation,
  type IncomeType,
  type RentalResult,
  type TrendResult,
} from "./ported/ops-22-3.js";
import {
  PERIODS_PER_YEAR,
  sourcesOf,
  type EarningsHistory,
  type IncomeSource,
  type IncomeTask,
} from "./task.js";

export const METHODS = [
  "base_salary",
  "base_hourly_fixed",
  "variable_trending",
  "variable_base_trending",
  "social_security",
  "support",
  "retirement",
  "public_assistance",
  "rental_subject",
] as const;
export type Method = (typeof METHODS)[number];

export const EXCLUSIONS = [
  "history_under_12_months",
  "not_stabilized",
  "no_agreement",
  "receipt_history_insufficient",
  "continuance_assets_insufficient",
  "agency_letter_missing",
  "continuance_3y",
  "offset_only",
] as const;
export type Exclusion = (typeof EXCLUSIONS)[number];

export const TRENDS = ["stable", "increasing", "decreasing"] as const;

/** One source as the submission states it: cents as decimal strings. */
export interface SourceRow {
  readonly income_id: string;
  readonly method: Method;
  readonly trend: (typeof TRENDS)[number] | null;
  readonly monthly_qualifying_cents: string;
  readonly nontaxable_cents: string;
  readonly gross_up_cents: string;
  readonly continuance_end_date: string | null;
  readonly counted: boolean;
  readonly exclusion_reason: Exclusion | null;
  readonly liability_added_cents: string;
}
export const ROW_FIELDS = [
  "income_id",
  "method",
  "trend",
  "monthly_qualifying_cents",
  "nontaxable_cents",
  "gross_up_cents",
  "continuance_end_date",
  "counted",
  "exclusion_reason",
  "liability_added_cents",
] as const satisfies readonly (keyof SourceRow)[];

export interface IncomeAnswer {
  readonly sources: readonly SourceRow[];
  readonly total_qualifying_cents: string;
  readonly obligations_from_rental_cents: string;
}

/** The method a formula id names: its family, as FORMULAS keys it (the support formula is shared by alimony). */
const METHOD_OF: Readonly<Record<string, Method>> = {
  [FORMULAS.base_salary]: "base_salary",
  [FORMULAS.base_hourly_fixed]: "base_hourly_fixed",
  [FORMULAS.variable_trending]: "variable_trending",
  [FORMULAS.variable_base_trending]: "variable_base_trending",
  [FORMULAS.social_security]: "social_security",
  [FORMULAS.child_support]: "support",
  [FORMULAS.retirement]: "retirement",
  [FORMULAS.public_assistance]: "public_assistance",
  [FORMULAS.rental_subject]: "rental_subject",
};

/** The engine's reason, as the exclusion it names. */
function exclusionOf(reason: string | null): Exclusion | null {
  if (reason === null) return null;
  if (reason.startsWith("management_experience_under_12_months")) return "offset_only";
  if ((EXCLUSIONS as readonly string[]).includes(reason)) return reason as Exclusion;
  throw new RangeError(`the engine gave a reason v1 does not name: ${reason}`);
}

/** One source run through the engine. */
export interface SourceResult {
  readonly source: IncomeSource;
  readonly calculation: IncomeCalculation;
  /** The trend detail of a trended source (assessTrend inside variableIncome). */
  readonly trend_detail: TrendResult | null;
  /** The hourly classification before any recalculation (hourlyBase's). */
  readonly hourly_class: "base_hourly_fixed" | "base_hourly_variable" | null;
  readonly rental: RentalResult | null;
  readonly used: boolean;
  readonly offset_only: boolean;
  readonly continuance: ReturnType<typeof continuance3y> | null;
  readonly counted: boolean;
}

const trended = (type: IncomeType, s: EarningsHistory) =>
  variableIncome({
    income_type: type,
    ytd_cents: s.ytd_cents,
    ytd_months: s.ytd_months,
    prior_year_cents: s.prior_year_cents,
    stable_band_pct: STABLE_BAND_PCT_DEFAULT,
    history_months: s.history_months,
    stabilization: s.stabilization,
  });

/** The dispatch, restated from calculateIncome (ops-22-3.ts:764-790). */
function dispatch(
  s: IncomeSource,
): Pick<SourceResult, "calculation" | "trend_detail" | "hourly_class" | "rental"> {
  const none = { trend_detail: null, hourly_class: null, rental: null };
  switch (s.type) {
    case "base_salary":
      return {
        calculation: baseSalary(s.pay_rate_cents * BigInt(PERIODS_PER_YEAR[s.pay_frequency]), [
          ...s.regb_flags,
        ]),
        ...none,
      };
    case "hourly": {
      const fixed = hourlyBase({
        rate_cents: s.rate_cents,
        guaranteed_hours_per_week: s.guaranteed_hours_per_week,
        hours_min: s.hours_per_week_min,
        hours_max: s.hours_per_week_max,
        avg_hours_per_week: s.avg_hours_per_week,
      });
      if (fixed.reclassified_to !== "base_hourly_variable")
        return { ...none, calculation: fixed, hourly_class: "base_hourly_fixed" };
      const v = trended("base_hourly_variable", s);
      return {
        ...none,
        calculation: v,
        trend_detail: v.trend_detail,
        hourly_class: "base_hourly_variable",
      };
    }
    case "overtime":
    case "commission":
    case "tip": {
      const v = trended(s.type, s);
      return { ...none, calculation: v, trend_detail: v.trend_detail };
    }
    case "social_security":
      return {
        calculation: socialSecurity({
          amount_cents: s.monthly_benefit_cents,
          record: s.record,
          benefit: s.benefit,
          documented_nontaxable_pct: s.documented_nontaxable_pct,
          continuance_end_date: s.benefit_end_date,
        }),
        ...none,
      };
    case "child_support":
    case "alimony":
    case "separate_maintenance":
      return {
        calculation: supportIncome({
          amount_cents: s.monthly_cents,
          kind: s.type,
          receipts_months: s.receipts_months,
          receipts_full_regular_timely: s.receipts_full_regular_timely,
          agreement_document_id: s.agreement_on_file ? `${s.income_id}-agreement` : null,
          child_date_of_birth: s.type === "child_support" ? s.child_date_of_birth : null,
          term_end_date: s.type === "child_support" ? null : s.term_end_date,
          state_extends_support_to: s.type === "child_support" ? s.state_extends_support_to : null,
        }),
        ...none,
      };
    case "retirement_distribution":
      return {
        calculation: retirementDistribution({
          monthly_cents: s.monthly_cents,
          eligible_balances_cents: s.account_balances_cents,
          unrestricted_penalty_free: s.unrestricted_penalty_free,
        }),
        ...none,
      };
    case "public_assistance":
      return {
        calculation: publicAssistance({
          monthly_cents: s.monthly_cents,
          agency_letter_document_id: s.agency_letter_on_file ? `${s.income_id}-letter` : null,
          duration_end_date: s.duration_end_date,
        }),
        ...none,
      };
    case "rental_subject": {
      // :779-781: the purchase formula, with the lease and 1040 inputs at their defaults.
      const rr = subjectRental({
        gross_rent_cents: s.form_1007_gross_rent_cents,
        pitia_cents: s.subject_pitia_cents,
        transaction: "purchase",
        management_experience_months: s.management_experience_months,
        fair_rental_days: s.schedule_e_fair_rental_days,
        lease_term_months: null,
        on_1040: true,
      });
      const calculation: IncomeCalculation = {
        income_type: "rental_subject",
        formula_version: rr.formula_version,
        inputs: {
          offset_only: rr.offset_only,
          liability_added_cents: String(rr.liability_added_cents),
        },
        steps: [],
        monthly_qualifying_cents: rr.income_added_cents,
        nontaxable_cents: 0n,
        gross_up_cents: 0n,
        qualifying_cents: rr.income_added_cents,
        trend: "n_a",
        stabilized_since: null,
        continuance_basis: "no_expiration",
        continuance_end_date: null,
        reason: rr.reason,
        reclassified_to: null,
      };
      return { ...none, calculation, rental: rr };
    }
  }
}

const historyOf = (s: IncomeSource): number | null =>
  s.type === "hourly" || s.type === "overtime" || s.type === "commission" || s.type === "tip"
    ? s.history_months
    : null;

/** One source, calculated, checked under Reg B, and tested for continuance against the note date. */
export function runSource(s: IncomeSource, noteDate: PlainDate): SourceResult {
  const d = dispatch(s);
  const c = d.calculation;
  // :791, under the type the calculation ended as; it throws on a discount the rules forbid.
  regbCheck({
    income_type: c.reclassified_to ?? c.income_type,
    regb_flags: [...s.regb_flags],
    formula_version: c.formula_version,
    factor: null,
    history_months: historyOf(s),
  });
  const offset_only = c.inputs["offset_only"] === true;
  let used = c.monthly_qualifying_cents > 0n || c.gross_up_cents > 0n;
  const continuance = used
    ? continuance3y(c.continuance_end_date, noteDate, c.continuance_basis)
    : null;
  if (continuance && !continuance.pass) used = false;
  return { ...d, source: s, used, offset_only, continuance, counted: used && !offset_only };
}

export interface IncomeAnalysis {
  readonly required_through: PlainDate;
  readonly results: readonly SourceResult[];
  readonly total_qualifying_cents: bigint;
  readonly obligations_from_rental_cents: bigint;
}

export function analyzeIncome(task: IncomeTask): IncomeAnalysis {
  const note = task.application.scheduled_note_date;
  const results = sourcesOf(task).map((s) => runSource(s, note));
  const t = totalQualifying(
    results.map((r) => ({
      income_id: r.source.income_id,
      monthly_qualifying_cents: r.calculation.monthly_qualifying_cents,
      gross_up_cents: r.calculation.gross_up_cents,
      used_for_qualifying: r.used,
      offset_only: r.offset_only,
      liability_added_cents: r.rental?.liability_added_cents ?? 0n,
    })),
  );
  return {
    required_through: addMonths(note, 36),
    results,
    total_qualifying_cents: t.total_qualifying_cents,
    obligations_from_rental_cents: t.obligations_from_rental_cents,
  };
}

export function rowOf(r: SourceResult): SourceRow {
  const c = r.calculation;
  const method = METHOD_OF[c.formula_version];
  if (!method) throw new RangeError(`no method for ${c.formula_version}`);
  const failed = r.continuance !== null && !r.continuance.pass;
  return {
    income_id: r.source.income_id,
    method,
    trend: c.trend === "n_a" ? null : c.trend,
    monthly_qualifying_cents: String(c.monthly_qualifying_cents),
    nontaxable_cents: String(c.nontaxable_cents),
    gross_up_cents: String(c.gross_up_cents),
    continuance_end_date: c.continuance_end_date,
    counted: r.counted,
    exclusion_reason: exclusionOf(c.reason) ?? (failed ? "continuance_3y" : null),
    liability_added_cents: String(r.rental?.liability_added_cents ?? 0n),
  };
}

export function expectedIncome(task: IncomeTask): IncomeAnswer {
  const a = analyzeIncome(task);
  return {
    sources: a.results.map(rowOf),
    total_qualifying_cents: String(a.total_qualifying_cents),
    obligations_from_rental_cents: String(a.obligations_from_rental_cents),
  };
}

/* ── grading ──────────────────────────────────────────────────────────────
 * A source is one field: its whole row. Most of a row's labels are nearly
 * fixed by its type (the method), usually null (the trend, the end date,
 * the exclusion) or usually zero (the gross-up, the liability), so each
 * travels with the figure that decides it, and a guess at the common case
 * earns nothing on its own. The file is one field: the total and the
 * rental obligations together, since the obligations are zero on most
 * files. A source answered that the file does not have is a field of its
 * own, failed.
 */

const canonRow = (r: SourceRow): string => JSON.stringify(ROW_FIELDS.map((k) => [k, r[k]]));
const fileOf = (a: IncomeAnswer) => ({
  total_qualifying_cents: a.total_qualifying_cents,
  obligations_from_rental_cents: a.obligations_from_rental_cents,
});

export function gradeIncomeAgainst(want: IncomeAnswer, answer: IncomeAnswer | null): Grade {
  const fields: FieldGrade[] = [];
  const push = (field: string, expected: string, got: string | null) =>
    fields.push({ field, expected, got, ok: got === expected });
  for (const r of want.sources) {
    const a = answer?.sources.find((x) => x.income_id === r.income_id);
    push(`source[${r.income_id}]`, canonRow(r), a ? canonRow(a) : null);
  }
  const ids = new Set(want.sources.map((r) => r.income_id));
  for (const a of answer?.sources ?? [])
    if (!ids.has(a.income_id)) push(`source[${a.income_id}]`, "no such source", canonRow(a));
  push("file", JSON.stringify(fileOf(want)), answer ? JSON.stringify(fileOf(answer)) : null);
  const right = fields.filter((f) => f.ok).length;
  return { pass: right === fields.length, score: right / fields.length, fields };
}

export const gradeIncome = (task: IncomeTask, answer: IncomeAnswer | null): Grade =>
  gradeIncomeAgainst(expectedIncome(task), answer);

/** What the runner groups a task under: how many of its sources do not count. */
export function incomeVerdict(task: IncomeTask): string {
  const out = expectedIncome(task).sources.filter((r) => !r.counted).length;
  return out === 0
    ? "every source counted"
    : out === 1
      ? "one not counted"
      : "two or more not counted";
}

/* ── the submission, read strictly: what the schema forbids is bounced ──── */

const CENTS_RE = /^\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOP_KEYS = ["sources", "total_qualifying_cents", "obligations_from_rental_cents"];

const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): string | null => {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) return `unexpected ${extra.map((k) => JSON.stringify(k)).join(", ")}`;
  const missing = keys.filter((k) => !(k in o));
  return missing.length ? `missing ${missing.join(", ")}` : null;
};
const cents = (v: unknown): string | null =>
  typeof v === "string" && CENTS_RE.test(v) ? BigInt(v).toString() : null;

export function parseIncomeSubmission(raw: unknown): Parsed<IncomeAnswer> {
  const fail = (error: string): Parsed<IncomeAnswer> => ({
    ok: false,
    error: `${error}. Nothing was submitted; fix it and call submit_income again.`,
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("the submission must be an object");
  const s = raw as Record<string, unknown>;
  const top = exactKeys(s, TOP_KEYS);
  if (top) return fail(`the submission has ${top}; it takes ${TOP_KEYS.join(", ")}`);
  if (!Array.isArray(s["sources"])) return fail("sources must be a list, one entry per source");
  const rows: SourceRow[] = [];
  const seen = new Set<string>();
  for (const x of s["sources"] as unknown[]) {
    if (!x || typeof x !== "object" || Array.isArray(x))
      return fail("each source must be an object");
    const r = x as Record<string, unknown>;
    const id = r["income_id"];
    if (typeof id !== "string" || id === "") return fail("each source needs its income_id");
    const keys = exactKeys(r, ROW_FIELDS);
    if (keys) return fail(`source ${id} has ${keys}`);
    if (seen.has(id)) return fail(`source ${id} is listed twice; give one entry per source`);
    seen.add(id);
    if (typeof r["method"] !== "string" || !(METHODS as readonly string[]).includes(r["method"]))
      return fail(`source ${id}: method must be one of ${METHODS.join(", ")}`);
    const trend = r["trend"];
    if (
      trend !== null &&
      (typeof trend !== "string" || !(TRENDS as readonly string[]).includes(trend))
    )
      return fail(`source ${id}: trend must be one of ${TRENDS.join(", ")}, or null`);
    const money = (
      [
        "monthly_qualifying_cents",
        "nontaxable_cents",
        "gross_up_cents",
        "liability_added_cents",
      ] as const
    ).map((k) => cents(r[k]));
    if (money.some((m) => m === null))
      return fail(`source ${id}: amounts must be whole cents as strings of digits, e.g. "92143"`);
    const end = r["continuance_end_date"];
    if (end !== null && (typeof end !== "string" || !DATE_RE.test(end)))
      return fail(`source ${id}: continuance_end_date must be a date, YYYY-MM-DD, or null`);
    if (typeof r["counted"] !== "boolean")
      return fail(`source ${id}: counted must be true or false`);
    const why = r["exclusion_reason"];
    if (
      why !== null &&
      (typeof why !== "string" || !(EXCLUSIONS as readonly string[]).includes(why))
    )
      return fail(
        `source ${id}: exclusion_reason must be one of ${EXCLUSIONS.join(", ")}, or null`,
      );
    rows.push({
      income_id: id,
      method: r["method"] as Method,
      trend: trend as SourceRow["trend"],
      monthly_qualifying_cents: money[0]!,
      nontaxable_cents: money[1]!,
      gross_up_cents: money[2]!,
      continuance_end_date: end as string | null,
      counted: r["counted"],
      exclusion_reason: why as Exclusion | null,
      liability_added_cents: money[3]!,
    });
  }
  const total = cents(s["total_qualifying_cents"]);
  const obligations = cents(s["obligations_from_rental_cents"]);
  if (total === null || obligations === null)
    return fail("the totals must be whole cents as strings of digits");
  return {
    ok: true,
    answer: {
      sources: rows,
      total_qualifying_cents: total,
      obligations_from_rental_cents: obligations,
    },
  };
}
