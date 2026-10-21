/**
 * Synthetic purchase applications and their income, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). An application has
 * a date and a scheduled note date a month or two later, one or two
 * borrowers, and three to six income sources across the file, each with the
 * figures its documents show: a paystub's year-to-date through a month's end
 * or its 15th (whole or half months), the prior year's W-2, the months of
 * history, an award letter, a decree and its receipts, account statements,
 * an agency letter, a Form 1007 and a Schedule E. Every borrower also carries
 * the facts Regulation B protects (age, retirement, part-time work, the
 * intake's flags), which never change a figure.
 *
 * One source on each file is aimed, in turn by index, at an edge of the
 * rules, on one side or the other by the index's turn:
 *   - salary: a salary whose twelfth ends in exactly half a cent, and pay
 *     per week, two weeks, half month or month annualized exactly;
 *   - hourly_band: hours spread exactly 10% of the high week (minor, so
 *     fixed) and a tenth of an hour more (variable, so trended), on the
 *     high weeks where the engine's floating point is exact; guaranteed
 *     hours; spreads well inside and well outside;
 *   - trend_band: year-to-date exactly 5% under the prior year (stable) and
 *     a cent under that (decreasing, with or without a stabilized run), and
 *     exactly level (stable) and a cent over (increasing);
 *   - decreasing: B3-3.3-02's figure since stabilization for overtime,
 *     commission and tips against B3-3.3-01's year-to-date over the months
 *     elapsed for variable hours, and no stabilization at all;
 *   - history: 11 months against 12, and 23 against 24;
 *   - social_security: the 15% share by default and documented at 14%, 15%,
 *     15.01% and above, amounts where the two roundings differ from one,
 *     and benefits on another's record ending on the continuance date, a day
 *     before it, or years after;
 *   - child_support: the 18th birthday on the continuance date and a day
 *     before it, a state extension that does or does not reach it, a 29
 *     February birth date, five months of receipts, a late payment, no decree;
 *   - alimony: with and without a term, the term on the line and a day short;
 *   - retirement: balances exactly 36 months of distributions, a cent short,
 *     and restricted access;
 *   - public_assistance: an end on the line, a day short, none, and no letter;
 *   - rental: 365 Fair Rental Days and 364, 12 months' experience and 11,
 *     rent that nets to the payment exactly, a loss, and 75% of an odd rent
 *     ending in half a cent;
 *   - two_borrowers: a household of two, totaled together;
 *   - regb: a retired borrower past 62 with Social Security, part-time work,
 *     and a retirement distribution or public assistance.
 *
 * The rest of each file is ordinary, mostly counted and sometimes not. A
 * borrower holds one base job at most, and a working borrower under 62 draws
 * Social Security on another's record, never their own.
 *
 * What v1 leaves out is in docs/environments.md. `incomeInScope` runs on the
 * engine's own results and keeps a file only when the engine does nothing
 * in it that its spec calls wrong; a file is then kept only once the
 * reference, working through the tools, lands exactly where the engine does.
 * The tests hold both to zero misses on unfiltered draws.
 */

import {
  addDays,
  addMonths,
  creditor,
  daysInMonth,
  parts,
  plainDate,
  rollBack,
  rollForward,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { rngFor, type Rng } from "../rng.js";
import {
  analyzeIncome,
  expectedIncome,
  gradeIncomeAgainst,
  parseIncomeSubmission,
  type SourceResult,
} from "./grader.js";
import { hourlyClassification } from "./ported/ops-22-3.js";
import { incomeSteps } from "./reference.js";
import {
  INCOME_ENVIRONMENT_NAME,
  INCOME_ENVIRONMENT_VERSION,
  incomePayload,
  sourcesOf,
  type Borrower,
  type EarningsHistory,
  type HourlySource,
  type IncomeSource,
  type IncomeTask,
  type PayFrequency,
  type RegBFlag,
} from "./task.js";
import { executeIncomeTool } from "./tools.js";

export const incomeTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${INCOME_ENVIRONMENT_NAME}/${INCOME_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const INCOME_EDGES = [
  "salary",
  "hourly_band",
  "trend_band",
  "decreasing",
  "history",
  "social_security",
  "child_support",
  "alimony",
  "retirement",
  "public_assistance",
  "rental",
  "two_borrowers",
  "regb",
] as const;
export type IncomeEdge = (typeof INCOME_EDGES)[number];
export const incomeEdgeOf = (index: number): IncomeEdge =>
  INCOME_EDGES[index % INCOME_EDGES.length]!;
/** Which side of its edge a task takes: the edge's aims in turn. */
const turnOf = (index: number) => Math.floor(index / INCOME_EDGES.length);

/** High weeks (whole hours) where the engine's floating-point 10% test agrees with exact arithmetic at exactly 10%. */
export const FLOAT_SAFE_HIGH_WEEKS: readonly number[] = Array.from(
  { length: 41 },
  (_, k) => 20 + k,
).filter((hi) => {
  const lo = Number((0.9 * hi).toFixed(1));
  return (hi - lo) * 100 <= 10 * hi;
});

/** The exact test in tenths of an hour: fixed when the spread × 100 is at most 10 × the high week. */
export function exactHourlyClass(h: {
  guaranteed_hours_per_week: number | null;
  hours_per_week_min: number | null;
  hours_per_week_max: number | null;
}): "base_hourly_fixed" | "base_hourly_variable" {
  if (h.guaranteed_hours_per_week !== null && h.guaranteed_hours_per_week > 0)
    return "base_hourly_fixed";
  const hi = Math.round((h.hours_per_week_max ?? 0) * 10);
  const lo = Math.round((h.hours_per_week_min ?? 0) * 10);
  return (hi - lo) * 100 <= 10 * hi ? "base_hourly_fixed" : "base_hourly_variable";
}

/** The exact trend, by cross-multiplication in integers (months doubled, so halves are whole). */
export function exactTrend(e: EarningsHistory): "increasing" | "stable" | "decreasing" {
  const m2 = BigInt(Math.round(e.ytd_months * 2));
  if (e.ytd_cents * 24n > e.prior_year_cents * m2) return "increasing";
  return e.ytd_cents * 2400n >= e.prior_year_cents * m2 * 95n ? "stable" : "decreasing";
}

/* ── amounts and dates ──────────────────────────────────────────────────── */

const dollars = (r: Rng, lo: number, hi: number): Cents =>
  BigInt(r.int(lo, hi)) * 100n + BigInt(r.int(0, 99));
const roundCents = (x: number): Cents => BigInt(Math.round(x));
const tenths = (x: number) => Math.round(x * 10) / 10;

const OFFSETTING_FACTORS = [
  "six years in the same line of work",
  "completed the employer's two-year training program",
  "licensed in the field",
  "promoted within the same employer",
  "the same position at a prior employer for four years",
];

interface PayDate {
  readonly through: PlainDate;
  readonly months: number;
}

/** The most recent paystub's year-to-date: a month's end or its 15th, at least three days before the application. */
function ytdFor(r: Rng, app: PlainDate): PayDate {
  const { y } = parts(app);
  const limit = addDays(app, -3);
  const marks: PayDate[] = [];
  for (let m = 1; m <= 12; m++) {
    marks.push({ through: ymd(y, m, 15), months: m - 0.5 });
    marks.push({ through: ymd(y, m, daysInMonth(y, m)), months: m });
  }
  const ok = marks.filter((x) => x.through <= limit && x.months >= 1);
  return ok[ok.length - 1 - (ok.length > 1 && r.chance(0.35) ? 1 : 0)]!;
}

/** An older paystub from the same year, at most nine months in. */
function earlierPay(r: Rng, pay: PayDate): PayDate {
  const { y } = parts(pay.through);
  const m = r.int(3, 9);
  return r.chance(0.5)
    ? { through: ymd(y, m, daysInMonth(y, m)), months: m }
    : { through: ymd(y, m, 15), months: m - 0.5 };
}

interface FileCtx {
  readonly r: Rng;
  readonly app: PlainDate;
  readonly note: PlainDate;
  /** The note date + 36 months: the continuance line. */
  readonly required: PlainDate;
}

type HistoryKind = "long" | "short" | "under12";

/** Months of history for a pay date: a full prior year and more, 12 to 23, or under 12. */
function historyFor(r: Rng, pay: PayDate, kind: HistoryKind): number {
  if (kind === "under12") return r.int(Math.floor(pay.months) + 1, 11);
  if (kind === "short") return r.int(Math.max(12, Math.floor(pay.months) + 1), 23);
  return r.int(Math.max(24, Math.ceil(pay.months) + 12), 160);
}
const ordinaryHistory = (r: Rng, pay: PayDate): HistoryKind =>
  r.weighted<HistoryKind>([
    ["long", 82],
    ["short", 11],
    ["under12", pay.months <= 10 ? 7 : 0],
  ]);

type TrendAim = "increasing" | "stable" | "decreasing";

/**
 * Earnings for a prior-year monthly level: the year-to-date drawn to the trend aimed at, the prior
 * year over the months of it the history covers, and for a decline, when asked, a flat run since a
 * month's first.
 */
function earnings(
  r: Rng,
  pay: PayDate,
  level: number,
  history: number,
  trend: TrendAim,
  stabilize: boolean,
): EarningsHistory {
  const m = pay.months;
  const covered = Math.min(12, history - m);
  const prior = roundCents(level * covered);
  const f =
    trend === "increasing"
      ? 1.02 + r.next() * 0.33
      : trend === "stable"
        ? 0.957 + r.next() * 0.036
        : 0.55 + r.next() * 0.37;
  const ytd = roundCents(level * f * m);
  return {
    ytd_through: pay.through,
    ytd_cents: ytd,
    ytd_months: m,
    prior_year_cents: prior,
    history_months: history,
    offsetting_factors: history >= 12 && history < 24 ? [r.pick(OFFSETTING_FACTORS)] : [],
    stabilization: stabilize ? stabilizationFor(r, pay, ytd) : null,
  };
}

/** A flat run since a month's first (February or later), at least two months long, below the year's average. */
function stabilizationFor(r: Rng, pay: PayDate, ytd: Cents): EarningsHistory["stabilization"] {
  const m = pay.months;
  const lastStart = Math.floor(m - 1);
  if (lastStart < 2) return null;
  const j = r.int(2, lastStart);
  const months_since = m - (j - 1);
  const flat = (Number(ytd) / m) * (0.78 + r.next() * 0.17);
  return {
    since: ymd(parts(pay.through).y, j, 1),
    cents_since: roundCents(flat * months_since),
    months_since,
  };
}

const ordinaryTrend = (r: Rng): TrendAim =>
  r.weighted<TrendAim>([
    ["increasing", 40],
    ["stable", 30],
    ["decreasing", 30],
  ]);

/* ── the sources ────────────────────────────────────────────────────────── */

/** A source before it is numbered: every source type, less its income_id. */
type Draft = IncomeSource extends infer S
  ? S extends IncomeSource
    ? Omit<S, "income_id">
    : never
  : never;

const LEVELS: Readonly<Record<"overtime" | "commission" | "tip", readonly [number, number]>> = {
  overtime: [250, 2_500],
  commission: [800, 9_000],
  tip: [400, 3_200],
};

function salary(r: Rng, aim?: string): Draft {
  const frequency: PayFrequency =
    aim === "weekly" || aim === "biweekly" || aim === "semimonthly"
      ? aim
      : aim === "part_time_monthly"
        ? "monthly"
        : aim === "half_cent" || aim === "annual"
          ? "annual"
          : r.weighted<PayFrequency>([
              ["annual", 30],
              ["biweekly", 30],
              ["semimonthly", 15],
              ["monthly", 10],
              ["weekly", 15],
            ]);
  const partTime = aim === "part_time_monthly" || (aim === undefined && r.chance(0.08));
  const annualLevel = partTime ? r.int(14_000, 48_000) : r.int(32_000, 240_000);
  let rate: Cents;
  if (frequency === "annual") {
    rate = r.chance(0.5) ? BigInt(annualLevel) * 100n : dollars(r, annualLevel, annualLevel);
    // A twelfth that ends in exactly half a cent: the annual figure is 6 more than a multiple of 12.
    if (aim === "half_cent") rate = rate - (rate % 12n) + 6n;
  } else {
    const periods = { monthly: 12, semimonthly: 24, biweekly: 26, weekly: 52 }[frequency];
    rate = roundCents((annualLevel * 100) / periods + r.int(-500, 500));
  }
  return {
    type: "base_salary",
    pay_rate_cents: rate,
    pay_frequency: frequency,
    part_time: partTime,
    regb_flags: partTime ? ["part_time"] : [],
  };
}

/** Rate and hours; what the hours are aimed at decides the class. */
function hourly(r: Rng, pay: PayDate, aim: string, trend?: TrendAim, history?: number): Draft {
  const rate = BigInt(r.int(1_600, 8_500));
  let guaranteed: number | null = null;
  let lo: number | null = null;
  let hi: number | null = null;
  if (aim === "guaranteed") {
    guaranteed = r.chance(0.6) ? r.int(20, 45) : r.int(40, 90) / 2;
  } else if (aim === "exact10" || aim === "past10") {
    hi = r.pick(FLOAT_SAFE_HIGH_WEEKS);
    lo = tenths(0.9 * hi - (aim === "past10" ? 0.1 : 0));
  } else if (aim === "guaranteed_part_time") {
    guaranteed = r.int(16, 29);
  } else if (aim === "inside") {
    // Strictly inside the band: a spread of at most a tenth under 10% of the high week.
    hi = tenths(r.int(300, 500) / 10);
    lo = tenths(hi - r.int(0, Math.floor(hi) - 1) / 10);
  } else {
    // wide: well past the band
    hi = tenths(r.int(320, 560) / 10);
    lo = tenths(hi * (0.45 + r.next() * 0.4));
  }
  const avg = lo !== null && hi !== null ? tenths(lo + (hi - lo) * (0.2 + r.next() * 0.6)) : null;
  const hours = guaranteed ?? avg!;
  const level = (Number(rate) * hours * 52) / 12;
  const variable =
    exactHourlyClass({
      guaranteed_hours_per_week: guaranteed,
      hours_per_week_min: lo,
      hours_per_week_max: hi,
    }) === "base_hourly_variable";
  const h =
    history ??
    historyFor(r, pay, variable ? ordinaryHistory(r, pay) : r.chance(0.85) ? "long" : "short");
  const t = trend ?? (variable ? ordinaryTrend(r) : "stable");
  const e = earnings(r, pay, level, h, t, variable && t === "decreasing" && r.chance(0.65));
  const partTime = aim === "guaranteed_part_time" || (hours < 30 && r.chance(0.5));
  return {
    type: "hourly",
    rate_cents: rate,
    guaranteed_hours_per_week: guaranteed,
    hours_per_week_min: lo,
    hours_per_week_max: hi,
    avg_hours_per_week: avg,
    part_time: partTime,
    regb_flags: partTime ? ["part_time"] : [],
    ...e,
  };
}

function variable(
  r: Rng,
  pay: PayDate,
  trend?: TrendAim,
  history?: number,
  stabilize?: boolean,
): Draft {
  const type = r.weighted<"overtime" | "commission" | "tip">([
    ["overtime", 50],
    ["commission", 35],
    ["tip", 15],
  ]);
  const [lo, hi] = LEVELS[type];
  const level = Number(dollars(r, lo, hi));
  const t = trend ?? ordinaryTrend(r);
  const h = history ?? historyFor(r, pay, ordinaryHistory(r, pay));
  return {
    type,
    regb_flags: [],
    ...earnings(r, pay, level, h, t, stabilize ?? (t === "decreasing" && r.chance(0.65))),
  };
}

/**
 * A trended source placed exactly on the trend band: a prior-year month of a multiple of 40 cents,
 * so 95% of it over whole or half months is exact cents, and the engine's decimals are exact.
 */
function onTheBand(r: Rng, pay: PayDate, aim: string): Draft {
  // A full prior year, so its twelfth is the level the band is measured from.
  const history = historyFor(r, pay, "long");
  const base: Draft = r.chance(0.25)
    ? hourly(r, pay, "wide", "stable", history)
    : variable(r, pay, "stable", history);
  const level = Number((base as unknown as EarningsHistory).prior_year_cents) / 12;
  const P = 40n * BigInt(Math.max(5, Math.round(level / 40)));
  const m2 = BigInt(Math.round(pay.months * 2));
  const at95 = (19n * P * m2) / 40n;
  const level1 = (P * m2) / 2n;
  const ytd =
    aim === "minus5_exact" || aim === "minus5_exact_stab"
      ? at95
      : aim === "minus5_cent" || aim === "minus5_cent_stab"
        ? at95 - 1n
        : aim === "level"
          ? level1
          : level1 + 1n;
  const stab = aim.endsWith("_stab") ? stabilizationFor(r, pay, ytd) : null;
  return {
    ...base,
    ytd_cents: ytd,
    prior_year_cents: 12n * P,
    history_months: history,
    offsetting_factors: [],
    stabilization: stab,
  } as Draft;
}

function socialSecurity(r: Rng, ctx: FileCtx, age: number, aim?: string, working = false): Draft {
  // A benefit on the borrower's own record is retirement past 62 or disability, so a working
  // borrower under 62 draws one on another's record (a survivor's or a dependent's).
  const own =
    aim === undefined ? (age >= 62 || !working) && r.chance(0.75) : !aim.startsWith("other");
  const benefit = own
    ? aim === "retired_own" || (age >= 62 && r.chance(0.8))
      ? "retirement"
      : "disability"
    : r.pick(["retirement", "survivor"] as const);
  const record = own ? "own" : r.chance(0.7) ? "another_person" : "dependent";
  let amount = dollars(r, 700, 4_200);
  let documented: number | null =
    aim === "documented_14"
      ? 14
      : aim === "documented_15"
        ? 15
        : aim === "documented_1501"
          ? 15.01
          : aim === "documented_high"
            ? r.pick([22, 40, 62.75, 85, 100])
            : aim === undefined && r.chance(0.35)
              ? r.pick([14, 15, 15.01, 18.5, 25, 40, 62.75, 100])
              : null;
  if (aim === "default_15_double" || aim === "retired_own") {
    documented = null;
    // An amount whose two roundings land a cent from one: 15%, then 25% of the rounded figure.
    for (let k = 0; k < 200; k++) {
      const nt = (amount * 1500n + 5000n) / 10000n;
      const two = (nt * 25n + 50n) / 100n;
      const one = (amount * 375n + 5000n) / 10000n;
      if (two !== one) break;
      amount += 1n;
    }
  }
  const end =
    record === "own"
      ? null
      : aim === "other_at_line"
        ? ctx.required
        : aim === "other_day_short"
          ? addDays(ctx.required, -1)
          : aim === "other_far"
            ? addMonths(ctx.required, r.int(1, 180))
            : addMonths(ctx.note, r.int(6, 200));
  const flags: RegBFlag[] = benefit === "retirement" && own ? ["retirement"] : [];
  if (own && age >= 62) flags.push("age_related");
  return {
    type: "social_security",
    benefit,
    record,
    monthly_benefit_cents: amount,
    documented_nontaxable_pct: documented,
    benefit_end_date: end,
    regb_flags: flags,
  };
}

function childSupport(r: Rng, ctx: FileCtx, aim?: string): Draft {
  let dob: PlainDate;
  let ext: PlainDate | null = null;
  const lineDob = (end: PlainDate): PlainDate => {
    const d = addMonths(end, -216);
    return addMonths(d, 216) === end ? d : addDays(d, -1);
  };
  switch (aim) {
    case "at_line":
      dob = lineDob(ctx.required);
      break;
    case "day_short":
      dob = lineDob(addDays(ctx.required, -1));
      break;
    case "extended":
      dob = addDays(lineDob(ctx.required), -r.int(1, 700));
      ext = r.chance(0.3) ? ctx.required : addDays(ctx.required, r.int(1, 500));
      break;
    case "extended_short":
      dob = addDays(lineDob(ctx.required), -r.int(200, 900));
      ext = addDays(ctx.required, -r.int(1, 150));
      break;
    case "leap":
      dob = plainDate("2012-02-29");
      break;
    default:
      // Born before the application, and under 18 on the note date.
      dob = addDays(ctx.app, -r.int(30, 365 * 17 + 250));
      if (r.chance(0.12)) ext = addMonths(dob, r.chance(0.5) ? 228 : 240);
  }
  const agreement = aim !== "no_decree" && (aim !== undefined || r.chance(0.93));
  const months =
    aim === "receipts_5"
      ? 5
      : aim === "receipts_6"
        ? 6
        : aim === undefined && r.chance(0.07)
          ? r.int(2, 5)
          : r.int(6, 60);
  const timely = aim !== "late" && (aim !== undefined || r.chance(0.94));
  return {
    type: "child_support",
    monthly_cents: dollars(r, 200, 2_400),
    agreement_on_file: agreement,
    receipts_months: months,
    receipts_full_regular_timely: timely,
    child_date_of_birth: dob,
    state_extends_support_to: ext,
    regb_flags: ["alimony_child_support"],
  };
}

function spousal(r: Rng, ctx: FileCtx, aim?: string): Draft {
  const type =
    aim === "separate_maintenance" || (aim === undefined && r.chance(0.3))
      ? "separate_maintenance"
      : "alimony";
  const term =
    aim === "no_term"
      ? null
      : aim === "term_at_line"
        ? ctx.required
        : aim === "term_day_short"
          ? addDays(ctx.required, -1)
          : aim === "term_far"
            ? addMonths(ctx.required, r.int(1, 120))
            : r.chance(0.4)
              ? null
              : addMonths(ctx.note, r.int(6, 150));
  const months =
    aim === "receipts_6" ? 6 : aim === undefined && r.chance(0.06) ? r.int(2, 5) : r.int(6, 72);
  return {
    type,
    monthly_cents: dollars(r, 400, 6_000),
    agreement_on_file: aim !== undefined || r.chance(0.94),
    receipts_months: months,
    receipts_full_regular_timely: aim !== undefined || r.chance(0.95),
    term_end_date: term,
    regb_flags: ["alimony_child_support"],
  };
}

/** Balances split across one to three accounts that add to exactly the total. */
function accounts(r: Rng, total: Cents): Cents[] {
  const n = r.int(1, 3);
  const out: Cents[] = [];
  let left = total;
  for (let k = 1; k < n; k++) {
    const part = (left * BigInt(r.int(20, 70))) / 100n;
    out.push(part);
    left -= part;
  }
  out.push(left);
  return out;
}

function retirement(r: Rng, aim?: string): Draft {
  const monthly = dollars(r, 400, 5_000);
  const need = monthly * 36n;
  const total =
    aim === "exact36"
      ? need
      : aim === "cent_short"
        ? need - 1n
        : aim === undefined && r.chance(0.12)
          ? (need * BigInt(r.int(30, 99))) / 100n
          : (need * BigInt(r.int(101, 600))) / 100n;
  return {
    type: "retirement_distribution",
    monthly_cents: monthly,
    account_balances_cents: accounts(r, total),
    unrestricted_penalty_free: aim !== "restricted" && (aim !== undefined || r.chance(0.93)),
    regb_flags: ["retirement"],
  };
}

function publicAssistance(r: Rng, ctx: FileCtx, aim?: string): Draft {
  const end =
    aim === "end_at_line"
      ? ctx.required
      : aim === "end_day_short"
        ? addDays(ctx.required, -1)
        : aim === "no_end"
          ? null
          : r.chance(0.5)
            ? null
            : addMonths(ctx.note, r.int(6, 80));
  return {
    type: "public_assistance",
    monthly_cents: dollars(r, 150, 1_500),
    agency_letter_on_file: aim !== "no_letter" && (aim !== undefined || r.chance(0.9)),
    duration_end_date: end,
    regb_flags: ["public_assistance"],
  };
}

function rental(r: Rng, aim?: string): Draft {
  let gross = dollars(r, 1_100, 4_800);
  if (aim === "odd_cent") gross = gross - (gross % 4n) + 2n;
  const net = (gross * 75n + 50n) / 100n;
  const pitia =
    aim === "zero_exp" || aim === "zero_new"
      ? net
      : aim === "odd_cent"
        ? net + BigInt(r.int(-1, 1))
        : aim === "loss" || (aim === undefined && r.chance(0.35))
          ? net + dollars(r, 1, 900)
          : net - dollars(r, 1, 700);
  const experience = (): [number | null, number | null] => {
    switch (aim) {
      case "frd365":
        return [365, null];
      case "frd364":
        return [364, null];
      case "exp12":
        return [r.chance(0.5) ? null : r.int(90, 300), 12];
      case "exp11":
        return [r.chance(0.5) ? null : r.int(90, 300), 11];
      case "zero_exp":
        return r.chance(0.5) ? [365, null] : [null, r.int(12, 96)];
      case "zero_new":
        return [r.chance(0.5) ? null : r.int(30, 364), r.chance(0.5) ? null : r.int(0, 11)];
      default:
        return r.weighted<[number | null, number | null]>([
          [[365, null], 40],
          [[null, r.int(12, 150)], 20],
          [[r.int(30, 364), null], 15],
          [[null, null], 25],
        ]);
    }
  };
  const [frd, months] = experience();
  return {
    type: "rental_subject",
    form_1007_gross_rent_cents: gross,
    subject_pitia_cents: pitia > 0n ? pitia : 1n,
    schedule_e_fair_rental_days: frd,
    management_experience_months: months,
    regb_flags: [],
  };
}

/** An ordinary source of any type, mostly counted and sometimes not. */
/** One base job a borrower: a salary or hourly pay, never both, never two. */
const isJob = (d: Draft) => d.type === "base_salary" || d.type === "hourly";

function ordinary(
  r: Rng,
  ctx: FileCtx,
  pay: PayDate,
  age: number,
  rentalAllowed: boolean,
  working: boolean,
): Draft {
  const type = r.weighted<string>([
    ["salary", working ? 0 : 24],
    ["hourly", working ? 0 : 12],
    ["variable", 19],
    ["social_security", 9],
    ["child_support", 6],
    ["spousal", 6],
    ["retirement", 6],
    ["public_assistance", 4],
    ["rental", rentalAllowed ? 8 : 0],
  ]);
  switch (type) {
    case "salary":
      return salary(r);
    case "hourly":
      return hourly(
        r,
        pay,
        r.weighted<string>([
          ["guaranteed", 40],
          ["inside", 30],
          ["wide", 30],
        ]),
      );
    case "variable":
      return variable(r, pay);
    case "social_security":
      return socialSecurity(r, ctx, age, undefined, working);
    case "child_support":
      return childSupport(r, ctx);
    case "spousal":
      return spousal(r, ctx);
    case "retirement":
      return retirement(r);
    case "public_assistance":
      return publicAssistance(r, ctx);
    default:
      return rental(r);
  }
}

/* ── the file ───────────────────────────────────────────────────────────── */

const ASPECTS: Readonly<Record<IncomeEdge, readonly string[]>> = {
  salary: ["half_cent", "weekly", "biweekly", "semimonthly", "part_time_monthly", "annual"],
  hourly_band: ["exact10", "past10", "exact10", "past10", "guaranteed", "inside", "wide"],
  trend_band: [
    "minus5_exact",
    "minus5_cent",
    "minus5_exact_stab",
    "minus5_cent_stab",
    "level",
    "cent_over",
  ],
  decreasing: ["b3302", "b3301", "unstabilized_b3302", "unstabilized_b3301"],
  history: ["h11", "h12", "h23", "h24"],
  social_security: [
    "default_15_double",
    "other_at_line",
    "documented_14",
    "other_day_short",
    "documented_1501",
    "other_far",
    "documented_15",
    "documented_high",
  ],
  child_support: [
    "at_line",
    "day_short",
    "extended",
    "leap",
    "extended_short",
    "receipts_5",
    "late",
    "no_decree",
    "receipts_6",
  ],
  alimony: [
    "no_term",
    "term_at_line",
    "term_day_short",
    "separate_maintenance",
    "term_far",
    "receipts_6",
  ],
  retirement: ["exact36", "cent_short", "restricted", "ample"],
  public_assistance: ["end_at_line", "end_day_short", "no_end", "no_letter"],
  rental: ["frd365", "frd364", "exp12", "exp11", "zero_exp", "zero_new", "loss", "odd_cent"],
  two_borrowers: ["two"],
  regb: ["retired"],
};
export const incomeAimOf = (index: number): string => {
  const aims = ASPECTS[incomeEdgeOf(index)];
  return aims[turnOf(index) % aims.length]!;
};

/** The source an edge aims at, on its turn's side. */
function aimed(
  r: Rng,
  ctx: FileCtx,
  pay: PayDate,
  age: number,
  edge: IncomeEdge,
  aim: string,
): Draft[] {
  switch (edge) {
    case "salary":
      return [salary(r, aim)];
    case "hourly_band":
      return [hourly(r, pay, aim)];
    case "trend_band":
      return [onTheBand(r, pay, aim)];
    case "decreasing": {
      const stabilize = !aim.startsWith("unstabilized");
      if (aim.endsWith("b3301")) {
        const h = hourly(r, pay, "wide", "decreasing", historyFor(r, pay, "long")) as HourlySource;
        return [{ ...h, stabilization: stabilize ? stabilizationFor(r, pay, h.ytd_cents) : null }];
      }
      return [variable(r, pay, "decreasing", historyFor(r, pay, "long"), stabilize)];
    }
    case "history": {
      const h = aim === "h11" ? 11 : aim === "h12" ? 12 : aim === "h23" ? 23 : 24;
      // A paystub early enough in the year that 11 months is more than its year-to-date.
      const early = pay.months <= 9 ? pay : earlierPay(r, pay);
      const t = ordinaryTrend(r);
      return [
        r.chance(0.25)
          ? hourly(r, early, "wide", t, h)
          : variable(r, early, t, h, t === "decreasing" && r.chance(0.7)),
      ];
    }
    case "social_security":
      return [socialSecurity(r, ctx, age, aim)];
    case "child_support":
      return [childSupport(r, ctx, aim)];
    case "alimony":
      return [spousal(r, ctx, aim)];
    case "retirement":
      return [retirement(r, aim)];
    case "public_assistance":
      return [publicAssistance(r, ctx, aim)];
    case "rental":
      return [rental(r, aim)];
    case "two_borrowers":
      return [];
    case "regb": {
      const ss = socialSecurity(r, ctx, age, "retired_own");
      const part = r.chance(0.5)
        ? salary(r, "part_time_monthly")
        : hourly(r, pay, "guaranteed_part_time");
      const out: Draft[] = [ss, part];
      out.push(r.chance(0.6) ? retirement(r, "ample") : publicAssistance(r, ctx, "no_end"));
      return out;
    }
  }
}

/** One candidate; the caller keeps it only if it is in scope and fair to grade. */
export function drawIncomeCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): IncomeTask {
  const edge = incomeEdgeOf(index);
  const aim = incomeAimOf(index);

  // The dates first. A 29 February birth date needs the note date it decides on.
  let app: PlainDate;
  let note: PlainDate;
  if (edge === "child_support" && aim === "leap") {
    // Applied in early February, so the paystub's year-to-date is January's.
    note = plainDate("2027-03-01");
    app = rollForward(addDays(note, -r.int(14, 24)), creditor);
  } else {
    const y = r.int(2026, 2028);
    const m = r.int(2, 12);
    // Back to a business day, so a late-December application stays in its year.
    app = rollBack(ymd(y, m, r.int(m === 2 ? 10 : 1, daysInMonth(y, m))), creditor);
    note = rollForward(addDays(app, r.int(25, 70)), creditor);
  }
  const ctx: FileCtx = { r, app, note, required: addMonths(note, 36) };

  const two = edge === "two_borrowers" || (edge !== "regb" && r.chance(0.2));
  const n = r.int(two ? 4 : 3, 6);
  const rentalFile = edge === "rental" || (edge !== "regb" && r.chance(0.18));
  const occupancy = rentalFile
    ? ("investment" as const)
    : r.weighted<"principal_residence" | "second_home" | "investment">([
        ["principal_residence", 75],
        ["second_home", 10],
        ["investment", 15],
      ]);

  const people = Array.from({ length: two ? 2 : 1 }, (_, k) => {
    const retired = edge === "regb" && k === 0;
    const age = retired ? r.int(62, 84) : r.int(23, 74);
    return {
      borrower_id: `B${k + 1}`,
      age,
      retired: retired || (age >= 62 && r.chance(0.3)),
      pay: ytdFor(r, app),
      drafts: [] as Draft[],
    };
  });
  const first = people[0]!;
  const edgeDrafts = aimed(r, ctx, first.pay, first.age, edge, aim);
  first.drafts.push(...edgeDrafts);
  let rentalPlaced = edgeDrafts.some((d) => d.type === "rental_subject");
  // The rest, ordinary: the first borrower's up to their share, then the second's.
  const share = two ? r.int(Math.max(1, edgeDrafts.length), n - 1) : n;
  for (let k = edgeDrafts.length; k < n; k++) {
    const p = k < share ? first : people[1]!;
    const d = ordinary(r, ctx, p.pay, p.age, rentalFile && !rentalPlaced, p.drafts.some(isJob));
    if (d.type === "rental_subject") rentalPlaced = true;
    p.drafts.push(d);
  }

  // Each borrower's sources in a drawn order, numbered across the file.
  let next = 0;
  const borrowers: Borrower[] = people.map((p) => {
    const order = p.drafts.map((d) => ({ d, key: r.next() }));
    order.sort((a, b) => a.key - b.key);
    return {
      borrower_id: p.borrower_id,
      age: p.age,
      retired: p.retired,
      sources: order.map(({ d }) => ({ income_id: `INC-${++next}`, ...d }) as IncomeSource),
    };
  });

  return {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    application: {
      application_date: app,
      scheduled_note_date: note,
      transaction: "purchase",
      occupancy,
    },
    borrowers,
  };
}

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
export function incomeFairToGrade(task: IncomeTask): boolean {
  const payload = JSON.parse(JSON.stringify(incomePayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(incomeSteps, payload, executeIncomeTool);
  } catch {
    return false;
  }
  const parsed = parseIncomeSubmission(byRules);
  return parsed.ok && gradeIncomeAgainst(expectedIncome(task), parsed.answer).pass;
}

const isHalfMonths = (m: number) => Number.isFinite(m) && m > 0 && Number.isInteger(m * 2);
const isTenths = (h: number | null) =>
  h === null || (h > 0 && Math.abs(h * 10 - Math.round(h * 10)) < 1e-9);
const isHundredths = (p: number) => Math.abs(p * 100 - Math.round(p * 100)) < 1e-9;

/** Why a trended source's figures are outside v1, or null when they are in it. */
function earningsOutside(e: EarningsHistory, result: SourceResult): string | null {
  const { y: year, m: month, d: day } = parts(e.ytd_through);
  const monthEnd = day === daysInMonth(year, month);
  if (!(monthEnd || day === 15)) return "a year-to-date not through a month's end or 15th (E4)";
  if (e.ytd_months !== month - (monthEnd ? 0 : 0.5))
    return "year-to-date months that are not the paystub's (E4)";
  if (!Number.isInteger(e.history_months)) return "history in fractions of a month";
  if (e.history_months <= e.ytd_months) return "a history that leaves the prior year empty (E15)";
  if (e.prior_year_cents <= 0n || e.ytd_cents <= 0n) return "a year with no earnings (E15)";
  if (e.history_months >= 12 && e.history_months < 24 && e.offsetting_factors.length === 0)
    return "12 to 23 months with no offsetting factors, which the engine pays in full (D4)";
  if (e.history_months >= 24 && e.offsetting_factors.length > 0)
    return "offsetting factors on a full history";
  const s = e.stabilization;
  if (s) {
    const sp = parts(s.since);
    if (sp.d !== 1 || sp.y !== year || sp.m < 2)
      return "a stabilized run not from a month's first this year (E14)";
    if (s.months_since !== month - sp.m + (monthEnd ? 1 : 0.5))
      return "months since stabilization that are not the run's (E14)";
    if (!isHalfMonths(s.months_since) || s.months_since < 2)
      return "a stabilized run under two months (E14)";
    if (s.cents_since <= 0n || s.cents_since >= e.ytd_cents)
      return "a stabilized run that is not part of the year (E14)";
  }
  if (result.trend_detail && result.trend_detail.trend !== exactTrend(e))
    return "a trend the engine's decimals decide otherwise than exact arithmetic";
  return null;
}

/** The source types v1 draws. */
const V1_TYPES = [
  "base_salary",
  "hourly",
  "overtime",
  "commission",
  "tip",
  "social_security",
  "child_support",
  "alimony",
  "separate_maintenance",
  "retirement_distribution",
  "public_assistance",
  "rental_subject",
] as const satisfies readonly IncomeSource["type"][];

/**
 * v1's guard, run on the engine's own results: why a file reaches a place
 * where the engine departs from its spec, or null when it reaches none.
 *   - no bonus (D5), annuity or pension (D1), Average Hours or pay raise
 *     (D16), ADU (D11), temporary leave (D9), employment offer (D10),
 *     non-subject, departing-residence or short-term rental, or refinance
 *     (D7): the task cannot carry them, and the type list is checked;
 *   - hours in tenths (D3); guaranteed hours alone, a range always with its
 *     average (D2, D14); and the engine's floating-point 10% test agreeing
 *     with exact arithmetic on every hourly source;
 *   - an hourly source the engine calls fixed has 12 months of history or
 *     more, which it never reads;
 *   - whole or half year-to-date months on a paystub's own date (E4), a
 *     prior year with earnings (E15), offsetting factors exactly when the
 *     history is 12 to 23 months (D4), a stabilized run that fits the year
 *     (E14), and the engine's trend equal to the exact one;
 *   - Social Security on another's record always with an end, on the
 *     borrower's own never (D6); child support always with a birth date
 *     and never a decree term (D6, D13);
 *   - a documented share in hundredths of a percent; ends after the note date;
 *   - every calculation passes the Reg B check.
 */
export function incomeOutOfScope(task: IncomeTask): string | null {
  if (task.application.transaction !== "purchase") return "a refinance (D7)";
  const note = task.application.scheduled_note_date;
  for (const s of sourcesOf(task))
    if (!(V1_TYPES as readonly string[]).includes(s.type))
      return `a source of type ${s.type} (out of v1)`;
  let analysis: ReturnType<typeof analyzeIncome>;
  try {
    analysis = analyzeIncome(task);
  } catch (e) {
    return `the engine refused it: ${e instanceof Error ? e.message : String(e)}`;
  }
  const ids = new Set<string>();
  for (const result of analysis.results) {
    const s = result.source;
    if (ids.has(s.income_id)) return "an income id given twice";
    ids.add(s.income_id);
    switch (s.type) {
      case "base_salary":
        if (s.pay_rate_cents <= 0n) return "a salary of nothing";
        break;
      case "hourly": {
        const range = [s.hours_per_week_min, s.hours_per_week_max, s.avg_hours_per_week];
        if (![s.guaranteed_hours_per_week, ...range].every(isTenths))
          return "hours not in tenths (D3)";
        if (s.guaranteed_hours_per_week !== null) {
          if (range.some((x) => x !== null)) return "guaranteed hours beside a range (D14)";
        } else {
          if (range.some((x) => x === null)) return "a range without its average (D2)";
          if (!(
            s.hours_per_week_min! <= s.avg_hours_per_week! &&
            s.avg_hours_per_week! <= s.hours_per_week_max!
          ))
            return "an average outside its range";
        }
        const engine = hourlyClassification({
          rate_cents: s.rate_cents,
          guaranteed_hours_per_week: s.guaranteed_hours_per_week,
          hours_min: s.hours_per_week_min,
          hours_max: s.hours_per_week_max,
          avg_hours_per_week: s.avg_hours_per_week,
        });
        if (engine !== exactHourlyClass(s))
          return "a 10% test the engine's floating point decides otherwise than exact arithmetic";
        if (engine === "base_hourly_fixed" && s.history_months < 12)
          return "fixed hours with under a year of history";
        const why = earningsOutside(s, result);
        if (why) return why;
        break;
      }
      case "overtime":
      case "commission":
      case "tip": {
        const why = earningsOutside(s, result);
        if (why) return why;
        break;
      }
      case "social_security":
        if ((s.record === "own") !== (s.benefit_end_date === null))
          return "Social Security with an end on the borrower's own record, or none on another's (D6)";
        if (
          s.documented_nontaxable_pct !== null &&
          (!isHundredths(s.documented_nontaxable_pct) ||
            s.documented_nontaxable_pct < 0 ||
            s.documented_nontaxable_pct > 100)
        )
          return "a documented share not in hundredths of a percent";
        if (s.benefit_end_date !== null && s.benefit_end_date <= note)
          return "a benefit that has ended";
        break;
      case "child_support":
        if (!s.child_date_of_birth) return "child support with no birth date (D6)";
        if ("term_end_date" in s)
          return "child support with a decree term beside the birth date (D13)";
        if (addMonths(s.child_date_of_birth, 216) <= note) return "a child already 18";
        break;
      case "alimony":
      case "separate_maintenance":
        if (s.term_end_date !== null && s.term_end_date <= note) return "an award that has ended";
        break;
      case "retirement_distribution":
        if (s.account_balances_cents.length === 0) return "a distribution from no account";
        break;
      case "public_assistance":
        if (s.duration_end_date !== null && s.duration_end_date <= note)
          return "assistance that has ended";
        break;
      case "rental_subject":
        if (task.application.occupancy !== "investment")
          return "rent on a home the borrower lives in";
        break;
      default:
        return `a source of type ${(s as { type: string }).type} (out of v1)`;
    }
  }
  if (analysis.results.filter((x) => x.source.type === "rental_subject").length > 1)
    return "two subject properties";
  return null;
}

export const incomeInScope = (task: IncomeTask): boolean => incomeOutOfScope(task) === null;

const ATTEMPTS = 40;

export function drawIncomeTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: IncomeTask; attempts: number } {
  const id = incomeTaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const task = drawIncomeCandidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (incomeInScope(task) && incomeFairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no application fair to grade in ${ATTEMPTS} draws`);
}

export const generateIncomeTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
) => drawIncomeTask(split, suiteSeed, index).task;

export function generateIncomeSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): IncomeTask[] {
  return Array.from({ length: n }, (_, i) => generateIncomeTask(split, suiteSeed, i));
}

export const INCOME_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's worked examples ─────────────────────────────────────────── */

const SPEC_APP = plainDate("2026-10-05");
/** The spec's purchase fixture closes on Wednesday 18 November 2026. */
const PURCHASE_NOTE = plainDate("2026-11-18");
/** Its refinance fixture, which T8 is stated against, on Friday 6 November 2026. */
const T8_NOTE = plainDate("2026-11-06");
const SEPT: Pick<EarningsHistory, "ytd_through" | "ytd_months"> = {
  ytd_through: plainDate("2026-09-30"),
  ytd_months: 9,
};

const exampleA: Draft = {
  type: "overtime",
  regb_flags: [],
  ...SEPT,
  ytd_cents: 855_000n,
  prior_year_cents: 1_080_000n,
  history_months: 45,
  offsetting_factors: [],
  stabilization: null,
};
const exampleB = (stabilized: boolean): Draft => ({
  ...exampleA,
  prior_year_cents: 1_440_000n,
  stabilization: stabilized
    ? { since: plainDate("2026-04-01"), cents_since: 570_000n, months_since: 6 }
    : null,
});
const t9 = (pitia: Cents, frd: number | null): Draft => ({
  type: "rental_subject",
  form_1007_gross_rent_cents: 240_000n,
  subject_pitia_cents: pitia,
  schedule_e_fair_rental_days: frd,
  management_experience_months: null,
  regb_flags: [],
});
const t6 = (rest: Partial<HourlySource>): Draft => ({
  type: "hourly",
  rate_cents: 3_250n,
  guaranteed_hours_per_week: null,
  hours_per_week_min: null,
  hours_per_week_max: null,
  avg_hours_per_week: null,
  part_time: false,
  regb_flags: [],
  ...SEPT,
  ytd_cents: 5_070_000n,
  prior_year_cents: 6_760_000n,
  history_months: 60,
  offsetting_factors: [],
  stabilization: null,
  ...rest,
});
const t8 = (dob: string): Draft => ({
  type: "child_support",
  monthly_cents: 80_000n,
  agreement_on_file: true,
  receipts_months: 12,
  receipts_full_regular_timely: true,
  child_date_of_birth: plainDate(dob),
  state_extends_support_to: null,
  regb_flags: ["alimony_child_support"],
});

/** Each spec case's name, in the order `incomeSpecTasks` builds them. */
export const INCOME_SPEC_NAMES = [
  "R13: a $75,000.00 salary, overtime example A and $2,000.00 of Social Security, with T9's $2,150.00 PITIA ($9,246.43)",
  "22.3-T5: example B, overtime flat since 1 April 2026 ($950.00)",
  "22.3-T5: example B with no stabilization evidence",
  "22.3-T6: $32.50 an hour, 40 guaranteed hours ($5,633.33)",
  "22.3-T6: 28 to 44 hours with no guaranteed minimum, reclassified and trended (the earnings are ours)",
  "22.3-T7: $2,000.00 of Social Security on the borrower's own record ($2,075.00)",
  "22.3-T8: $800.00 of child support for a child turning 18 on 3 March 2029, and for one born 7 November 2011",
  "22.3-T9: Form 1007 rent of $2,400.00 and PITIA of $1,650.00, with 365 Fair Rental Days",
  "22.3-T9: the same with no management history",
  "22.3-T9: PITIA of $2,150.00 with no management history",
  "22.3-T13: a part-time base salary of $1,800.00 a month",
] as const;

/**
 * Spec §22.3's worked examples (R2, R3, R5, R6, R13 and test cases T4 to
 * T9 and T13), each a file of its own on the purchase fixture's note date,
 * T8 on the date it is stated against. T6's reclassified hours carry
 * earnings of ours, since the spec gives none; every other figure is the
 * spec's. Not here: the $12,000 annual bonus (bonus is out of v1), T10's
 * ADU, and T14's employment offer.
 */
export function incomeSpecTasks(): IncomeTask[] {
  const file = (
    note: PlainDate,
    occupancy: IncomeTask["application"]["occupancy"],
    age: number,
    drafts: Draft[],
  ): Omit<IncomeTask, "id" | "split" | "suite_seed" | "index"> => ({
    application: {
      application_date: SPEC_APP,
      scheduled_note_date: note,
      transaction: "purchase",
      occupancy,
    },
    borrowers: [
      {
        borrower_id: "B1",
        age,
        retired: false,
        sources: drafts.map((d, k) => ({ income_id: `INC-${k + 1}`, ...d }) as IncomeSource),
      },
    ],
  });
  const cases = [
    file(PURCHASE_NOTE, "investment", 64, [
      {
        type: "base_salary",
        pay_rate_cents: 7_500_000n,
        pay_frequency: "annual",
        part_time: false,
        regb_flags: [],
      },
      exampleA,
      {
        type: "social_security",
        benefit: "retirement",
        record: "own",
        monthly_benefit_cents: 200_000n,
        documented_nontaxable_pct: null,
        benefit_end_date: null,
        regb_flags: ["retirement", "age_related"],
      },
      t9(215_000n, 365),
    ]),
    file(PURCHASE_NOTE, "principal_residence", 41, [exampleB(true)]),
    file(PURCHASE_NOTE, "principal_residence", 41, [exampleB(false)]),
    file(PURCHASE_NOTE, "principal_residence", 37, [t6({ guaranteed_hours_per_week: 40 })]),
    file(PURCHASE_NOTE, "principal_residence", 37, [
      t6({
        hours_per_week_min: 28,
        hours_per_week_max: 44,
        avg_hours_per_week: 36,
        ytd_cents: 4_563_000n,
        prior_year_cents: 5_850_000n,
      }),
    ]),
    file(PURCHASE_NOTE, "principal_residence", 67, [
      {
        type: "social_security",
        benefit: "retirement",
        record: "own",
        monthly_benefit_cents: 200_000n,
        documented_nontaxable_pct: null,
        benefit_end_date: null,
        regb_flags: ["retirement", "age_related"],
      },
    ]),
    file(T8_NOTE, "principal_residence", 44, [t8("2011-03-03"), t8("2011-11-07")]),
    file(PURCHASE_NOTE, "investment", 52, [t9(165_000n, 365)]),
    file(PURCHASE_NOTE, "investment", 52, [t9(165_000n, null)]),
    file(PURCHASE_NOTE, "investment", 52, [t9(215_000n, null)]),
    file(PURCHASE_NOTE, "principal_residence", 29, [
      {
        type: "base_salary",
        pay_rate_cents: 180_000n,
        pay_frequency: "monthly",
        part_time: true,
        regb_flags: ["part_time"],
      },
    ]),
  ];
  return cases.map((c, index) => ({
    id: `${INCOME_ENVIRONMENT_NAME}/${INCOME_ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec",
    suite_seed: 0,
    index,
    ...c,
  }));
}
