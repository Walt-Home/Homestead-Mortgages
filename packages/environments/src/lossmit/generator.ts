/**
 * Synthetic delinquent loans and their complete applications, seeded: no
 * borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). A loan is a Fannie
 * Mae first lien with an original balance, a rate and a term, its P&I the
 * level payment, an escrow payment, a late charge, and an oldest unpaid
 * installment some months back; the evaluation date is the day the
 * application became complete. Then the file is aimed, in turn by index, at
 * one edge of the hierarchy, and within an edge its arms are taken in turn
 * too, so each arm's share is fixed rather than drawn:
 *   - reinstatement: funds at the arrears to the cent, a cent over, or more,
 *     under every hardship (the walk tests reinstatement first, whatever the
 *     hardship);
 *   - funds_edge: the same files as the other edges, with funds exactly at
 *     the arrears or a cent short, so one cent moves the offer;
 *   - forbearance: a temporary hardship's first term, near the delinquency
 *     cap sometimes;
 *   - forbearance_caps: an extension at the cumulative cap, at the
 *     delinquency cap, at both (ties), a month under, across Reg X's six
 *     forborne months, and after installments paid during the plan, where
 *     the cumulative cap binds alone;
 *   - repayment: a plan found by the term search, its capacity at a total to
 *     the cent;
 *   - repayment_limits: 150% of PITI exactly, the rounded-up installment
 *     flipping a term the exact quotient would allow, capacity a cent short of
 *     a term's total, and a month behind;
 *   - deferral: the screen passed at its boundaries (originated exactly 12
 *     months back, a prior deferral or a modification exactly 12 months back,
 *     37 months to maturity, a disaster deferral that never counts);
 *   - deferral_gate: the contractual payment at 6 months and at the
 *     cumulative cap, a processing month, and a reporting deadline that steps
 *     back over a weekend or holiday;
 *   - screen_fails: the screen failing on the delinquency window, a prior
 *     deferral within 12 months, or maturity, alone and before a later
 *     failure;
 *   - permanent_or_falls: a permanent hardship, and capacity a cent short of
 *     the twelve-month plan, which passes the file to the screen.
 *
 * What v1 leaves out is in docs/environments.md. `lossmitInScope` runs on the
 * engine's own outputs and keeps a file only when the engine does nothing in
 * it that its spec calls wrong. A file is then kept only once the reference,
 * working through the tools, lands exactly where the engine does; the tests
 * hold both to zero misses on unfiltered draws.
 */

import {
  addBusinessDays,
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  endOfMonth,
  fannieEt,
  fannieEtObserved,
  federal,
  parts,
  plainDate,
  startOfMonth,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";
import { divRound, levelPayment, ratePercent, type Cents } from "@hm/kernel/money";
import { monthsBetween } from "@hm/refi-review";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import {
  analyzeLossmit,
  expectedLossmit,
  gradeLossmitAgainst,
  installmentsToPay,
  monthsDelinquent,
  monthsToMaturity,
  parseLossmitSubmission,
} from "./grader.js";
import { newPayment } from "./ported/deferral.js";
import { repaymentTerms } from "./ported/plans.js";
import { lossmitSteps } from "./reference.js";
import {
  LOSSMIT_ENVIRONMENT_NAME,
  LOSSMIT_ENVIRONMENT_VERSION,
  lossmitPayload,
  type Hardship,
  type LossmitTask,
} from "./task.js";
import { executeLossmitTool } from "./tools.js";

export const lossmitTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${LOSSMIT_ENVIRONMENT_NAME}/${LOSSMIT_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const LOSSMIT_EDGES = [
  "reinstatement",
  "funds_edge",
  "forbearance",
  "forbearance_caps",
  "repayment",
  "repayment_limits",
  "deferral",
  "deferral_gate",
  "screen_fails",
  "permanent_or_falls",
] as const;
export type LossmitEdge = (typeof LOSSMIT_EDGES)[number];
export const lossmitEdgeOf = (index: number): LossmitEdge =>
  LOSSMIT_EDGES[index % LOSSMIT_EDGES.length]!;
/** An edge's arm: taken in turn by index, so each arm's share of the edge is fixed. */
export const lossmitArmOf = (index: number, arms: number): number =>
  Math.floor(index / LOSSMIT_EDGES.length) % arms;

const FIRST_MONTH = plainDate("2026-01-01");
const MONTHS_DRAWN = 36;
/** States whose foreclosures run outside the courts, fast enough for a sale within the year. */
const NONJUDICIAL = ["TX", "GA", "AL", "TN", "VA", "MO", "MI", "NC", "AZ", "CO", "WA", "NV", "MN"];
const OTHER_STATES = [...NONJUDICIAL, "FL", "NJ", "IL", "OH", "PA", "CA", "MD", "MA", "WI", "OR"];

const dollars = (r: Rng, lo: number, hi: number): Cents =>
  BigInt(r.int(lo, hi)) * 100n + BigInt(r.int(0, 99));
const eighths = (r: Rng, lo: number, hi: number) => (r.int(lo * 8, hi * 8) / 8).toFixed(3);
const before = (a: PlainDate, b: PlainDate) => (a < b ? a : b);

/**
 * An evaluation date in `month`, a day from `lo` to `hi`, whose day 30 is a
 * business day: the spec moves a decision date on a weekend to the business
 * day before as policy, and the engine never moves it, so v1 draws none.
 */
function evaluationIn(r: Rng, month: PlainDate, lo = 1, hi = 31): PlainDate {
  const { y, m } = parts(month);
  const days: PlainDate[] = [];
  for (let d = lo; d <= Math.min(hi, daysInMonth(y, m)); d++) {
    const e = ymd(y, m, d);
    if (federal.isBusinessDay(addDays(e, 30))) days.push(e);
  }
  return r.pick(days);
}

/**
 * Whether the spec disagrees with itself about the deferral's reporting
 * deadline from this entry deadline. The engine steps back over the federal
 * calendar. 5.1, which owns the timer, has Fannie Mae-only holidays such as
 * the day after Thanksgiving shift reporting deadlines (the kernel's
 * `fannieEtObserved`), where 19.1-T6 and 19.3 count that day a business day.
 * It is 2026-11-30 in v1's years: no deferral is offered with it.
 */
export const larDisputed = (entry: PlainDate): boolean =>
  addBusinessDays(entry, -1, fannieEt) !== addBusinessDays(entry, -1, fannieEtObserved);

/**
 * How early a workout can be, in months from the origination's month (12.6,
 * 12.8). A payment deferral is evaluated a year after origination at the
 * earliest (12.6 criterion 5) and takes effect the 1st of a later month; a
 * later one is evaluated a year after the last took effect (criterion 7), so
 * 13 months on. Each defers 2 to 6 months, the delinquency window, so
 * `cumulative` months take ceil(cumulative ÷ 6) deferrals. A Flex
 * Modification is evaluated a year after origination too (12.8), its three
 * trial payments fall due from the 1st of the next month, and it takes effect
 * the 1st of the month after the trial: 16 months on. A trial fails on the
 * last day of a month a trial payment was due in, 13 months on at the
 * earliest.
 */
export const DEFERRAL_SEASONED = 13;
export const MODIFICATION_SEASONED = 16;
export const TRIAL_SEASONED = 13;
export const deferralsFor = (cumulative: number): number => Math.ceil(cumulative / 6);
/**
 * And how soon one can follow another: a deferral is evaluated a year after a
 * modification or a failed trial at the earliest (12.6 criterion 6), so it
 * takes effect 13 months after the modification's month or the trial's; a
 * Flex Modification is evaluated a year after a failed trial (12.8), so with
 * its own trial it takes effect 16 months after the failed one's month.
 */
export const LATER_DEFERRAL_AFTER = 13;
export const LATER_MODIFICATION_AFTER = 16;

/**
 * A sale is on the calendar only where a first notice could have gone out
 * before the application became complete: not before day 121 of the
 * delinquency (1024.41(f)(1); 13.1 counts day N as the due date + N days),
 * and not once the complete application is in ((f)(2)). So the evaluation is
 * day 122 or later.
 */
export const SALE_FROM_DAY = 122;

const MONTHS: readonly PlainDate[] = Array.from({ length: MONTHS_DRAWN }, (_, k) =>
  addMonths(FIRST_MONTH, k),
);
/** The months a resolved hardship is evaluated in: none whose deferral would be entered on a disputed day. */
const DEFERRAL_MONTHS = MONTHS.filter((m) => !larDisputed(endOfMonth(m)));
/** And with a processing month elected, none whose next month's would be. */
const ELECTABLE_MONTHS = DEFERRAL_MONTHS.filter((m) => !larDisputed(endOfMonth(addMonths(m, 1))));
/** And on a month's last day, only where its day 30 is a business day. */
const MONTH_END_MONTHS = DEFERRAL_MONTHS.filter((m) =>
  federal.isBusinessDay(addDays(endOfMonth(m), 30)),
);

/**
 * A month whose last day is not a Fannie Mae business day, or is a Monday: the reporting deadline
 * steps back over it. None where the spec disputes the day it steps back to.
 */
const STEP_BACK_MONTHS: readonly PlainDate[] = Array.from({ length: MONTHS_DRAWN + 1 }, (_, k) =>
  addMonths(FIRST_MONTH, k),
).filter((m) => {
  const end = endOfMonth(m);
  const day = new Date(`${end}T00:00:00Z`).getUTCDay();
  return (!federal.isBusinessDay(end) || day === 1) && !larDisputed(end);
});

/** What the aim fixes; the rest is drawn around it. */
interface Aim {
  hardship: Hardship;
  md: number;
  /**
   * A temporary hardship's active plan (the evaluation in its last month), or a resolved one's ended
   * plan. More months forborne than delinquent are installments paid during the plan.
   */
  forborne?: number;
  requested?: number;
  /** The evaluation's month and days; `monthEnd` puts it on the month's last day. */
  evaluation?: { month?: PlainDate; lo?: number; hi?: number; monthEnd?: boolean };
  /** Whole months from the evaluation to maturity, when it is aimed. */
  toMaturity?: number;
  /** The origination exactly 12 months before the evaluation. */
  seasonedToTheDay?: boolean;
  /** Months back of the last deferral's effective month (12 is exactly a year: it passes). */
  deferralBack?: number;
  cumulative?: number;
  disasterBack?: number;
  /** Months back of a modification's effective month, or a failed trial a year back to the day (a month's end). */
  modBack?: number;
  trialYearToTheDay?: boolean;
  noLateCharges?: boolean;
  piti?: "even" | "odd";
  funds?: "exact" | "cent_over" | "over" | "cent_short" | "short";
  capacity?: Capacity;
  elect?: boolean;
}
type Capacity =
  | { kind: "random" }
  /** A plan at a term the search reaches: its total, to the cent when exact. */
  | { kind: "plan"; target: "smallest" | "any"; exact: boolean }
  /** A cent short of a term's total, so the search moves on. */
  | { kind: "cent_short" }
  /** Enough for the deferral's new payment and short of the cheapest plan: the walk reaches the screen. */
  | { kind: "screen"; at?: "cent_short_of_12" };

function totals(arrears: Cents, piti: Cents): { m: number; total: Cents; allowed: boolean }[] {
  return Array.from({ length: 12 }, (_, k) => {
    const t = repaymentTerms(arrears, piti, k + 1);
    return { m: k + 1, total: t.total_monthly_cents, allowed: t.allowed };
  });
}

/** One candidate; the caller keeps it only if it is in scope and fair to grade. */
export function drawLossmitCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): LossmitTask {
  const edge = lossmitEdgeOf(index);
  const aim = aimFor(r, edge, index);
  return build(r, aim, { id, split, suite_seed: suiteSeed, index });
}

const mdWeights = (r: Rng, pairs: readonly (readonly [number, number])[]) => r.weighted(pairs);

function aimFor(r: Rng, edge: LossmitEdge, index: number): Aim {
  const temporaryPlan = (): Aim => ({
    hardship: "temporary_unresolved",
    md: mdWeights(r, [
      [1, 15],
      [2, 25],
      [3, 20],
      [4, 15],
      [5, 13],
      [6, 12],
    ]),
    forborne: 0,
  });
  const resolvedPlan = (): Aim => ({
    hardship: "resolved",
    md: mdWeights(r, [
      [1, 15],
      [2, 30],
      [3, 25],
      [4, 18],
      [5, 12],
    ]),
    capacity: { kind: "plan", target: "any", exact: r.chance(0.25) },
  });
  const deferralFile = (): Aim => ({
    hardship: "resolved",
    md: mdWeights(r, [
      [2, 22],
      [3, 28],
      [4, 25],
      [5, 15],
      [6, 10],
    ]),
    capacity: { kind: "screen" },
  });
  const permanentFile = (): Aim => ({ hardship: "permanent", md: r.int(2, 10) });

  switch (edge) {
    case "reinstatement": {
      const hardship = r.weighted<Hardship>([
        ["temporary_unresolved", 35],
        ["resolved", 40],
        ["permanent", 25],
      ]);
      const md = hardship === "permanent" ? r.int(2, 9) : r.int(1, 8);
      const extension = hardship === "temporary_unresolved" && md >= 4 && r.chance(0.3);
      return {
        hardship,
        md,
        ...(extension ? { forborne: r.int(3, Math.min(9, md)) } : {}),
        funds: r.weighted([
          ["exact", 40],
          ["cent_over", 15],
          ["over", 45],
        ]),
      };
    }
    case "funds_edge": {
      // The other edges' files, with funds exactly at the arrears or a cent short of them.
      const arm = lossmitArmOf(index, 8);
      const base = [temporaryPlan, resolvedPlan, deferralFile, permanentFile][arm % 4]!();
      return { ...base, funds: arm < 4 ? "exact" : "cent_short" };
    }
    case "forbearance": {
      if (r.chance(0.15)) return { ...temporaryPlan(), md: r.int(9, 11) };
      return temporaryPlan();
    }
    case "forbearance_caps": {
      // An extension decided in the active term's last month: the start is the day after its end.
      const arm = lossmitArmOf(index, 7);
      if (arm === 6) {
        // Installments paid during the plan: 12.4 rule 1's reduced payments sit in suspense until a
        // full installment accrues, and it is applied. Fewer delinquent than forborne, so the
        // cumulative cap is under the delinquency cap: alone at 1 or 2, tied with the increment at 3.
        const forborne = r.int(9, 11);
        const paid = r.int(1, 3);
        return {
          hardship: "temporary_unresolved",
          md: forborne - paid + r.int(0, paid - 1),
          forborne,
          requested: r.weighted([
            [1, 15],
            [2, 30],
            [3, 55],
          ]),
        };
      }
      if (arm === 4) {
        // Across Reg X's six forborne payments: the request lands on 6, or on 7.
        const [forborne, requested] = r.pick([
          [3, 3],
          [5, 1],
          [4, 2],
          [6, 1],
          [4, 3],
          [5, 2],
        ] as const);
        return {
          hardship: "temporary_unresolved",
          md: forborne + r.int(0, 2),
          forborne,
          requested,
        };
      }
      const [forborne, before0] =
        arm === 0
          ? [9, 2] // §12.4's fourth term: 11 delinquent, one month left
          : arm === 1
            ? [9, 0] // all three caps at 3
            : arm === 2
              ? [10, r.int(0, 1)]
              : arm === 3
                ? [11, 0] // both 12-month caps at 1
                : [r.int(6, 8), r.int(0, 3)];
      return {
        hardship: "temporary_unresolved",
        md: Math.min(11, forborne + before0),
        forborne,
        requested: r.weighted([
          [1, 20],
          [2, 25],
          [3, 55],
        ]),
      };
    }
    case "repayment": {
      const a = resolvedPlan();
      return r.chance(0.12) && a.md >= 2 ? { ...a, forborne: r.int(1, a.md - 1) } : a;
    }
    case "repayment_limits": {
      const arm = lossmitArmOf(index, 5);
      if (arm === 0)
        // 3 × PITI over 6 is 150.00% exactly, and allowed.
        return {
          hardship: "resolved",
          md: 3,
          noLateCharges: true,
          piti: "even",
          capacity: { kind: "plan", target: "smallest", exact: r.chance(0.4) },
        };
      if (arm === 1)
        // An odd-cent PITI: the rounded-up installment puts 6 months over 150%, so 7.
        return {
          hardship: "resolved",
          md: 3,
          noLateCharges: true,
          piti: "odd",
          capacity: { kind: "plan", target: "smallest", exact: r.chance(0.3) },
        };
      if (arm === 2)
        return { ...resolvedPlan(), capacity: { kind: "plan", target: "any", exact: true } };
      if (arm === 3) return { ...resolvedPlan(), capacity: { kind: "cent_short" } };
      return {
        ...resolvedPlan(),
        md: 1,
        capacity: { kind: "plan", target: "any", exact: r.chance(0.3) },
      };
    }
    case "deferral": {
      const a = deferralFile();
      const arm = lossmitArmOf(index, 6);
      if (arm === 1) return { ...a, md: Math.min(a.md, 6), seasonedToTheDay: true };
      if (arm === 2)
        return { ...a, deferralBack: 12, cumulative: r.int(2, Math.min(6, 12 - a.md)) };
      if (arm === 3) return { ...a, disasterBack: r.int(Math.max(1, a.md), 11) };
      if (arm === 4) return { ...a, toMaturity: 37 };
      if (arm === 5)
        // A modification a year back passes the screen. Two installments behind, the delinquency
        // reached Section 12's 60 days on the modification's first anniversary, outside its first
        // year as 12.8 requires; three would put them inside it. A trial fails on a month's last
        // day, so the evaluation a year on to the day is one too.
        return r.chance(0.5)
          ? { ...a, md: 2, modBack: 12 }
          : { ...a, trialYearToTheDay: true, evaluation: { monthEnd: true } };
      return r.chance(0.2) ? { ...a, forborne: r.int(1, a.md - 1) } : a;
    }
    case "deferral_gate": {
      const a = deferralFile();
      const arm = lossmitArmOf(index, 4);
      if (arm === 0)
        return {
          ...a,
          md: 6,
          cumulative: r.weighted([
            [0, 50],
            [r.int(2, 6), 50],
          ]),
        };
      if (arm === 1) {
        // The cumulative cap: 12 − cumulative is deferred, and one installment is left to pay.
        const cumulative = r.int(7, 10);
        return { ...a, md: 13 - cumulative, cumulative, deferralBack: r.int(13, 30) };
      }
      if (arm === 2) return { ...a, evaluation: { lo: 16, hi: 31 }, elect: true };
      return { ...a, evaluation: { month: r.pick(STEP_BACK_MONTHS) } };
    }
    case "screen_fails": {
      const arm = lossmitArmOf(index, 6);
      const base: Aim = { hardship: "resolved", md: r.int(2, 6), capacity: { kind: "screen" } };
      const late = (): Partial<Aim> =>
        r.chance(0.5) ? { toMaturity: r.int(24, 35) } : { deferralBack: r.int(1, 11) };
      if (arm === 0 || arm === 3)
        // Outside the window: 7 to 11 months behind, past any repayment plan.
        return { ...base, md: r.int(7, 11), ...(arm === 3 ? late() : {}) };
      if (arm === 1 || arm === 4) {
        // A deferral within 12 months; 11 months back is a month short of the year.
        const back = r.chance(0.35) ? 11 : r.int(base.md - 1 < 1 ? 1 : base.md - 1, 11);
        return {
          ...base,
          deferralBack: Math.max(back, base.md - 1),
          ...(arm === 4 ? { toMaturity: r.int(24, 35) } : {}),
        };
      }
      return { ...base, toMaturity: arm === 5 ? 35 : r.int(24, 35) };
    }
    case "permanent_or_falls": {
      const arm = lossmitArmOf(index, 4);
      if (arm === 1)
        return { ...deferralFile(), capacity: { kind: "screen", at: "cent_short_of_12" } };
      if (arm === 3) return { ...permanentFile(), md: r.int(5, 10) };
      return permanentFile();
    }
  }
}

interface Coordinates {
  readonly id: string;
  readonly split: Split;
  readonly suite_seed: number;
  readonly index: number;
}

function build(r: Rng, aim: Aim, coordinates: Coordinates): LossmitTask {
  // The evaluation, the delinquency and the oldest unpaid installment. Only a resolved hardship can be
  // offered a deferral, so only its months are kept off the disputed reporting deadline.
  const month =
    aim.evaluation?.month ??
    r.pick(
      aim.evaluation?.monthEnd
        ? MONTH_END_MONTHS
        : aim.elect
          ? ELECTABLE_MONTHS
          : aim.hardship === "resolved"
            ? DEFERRAL_MONTHS
            : MONTHS,
    );
  const evaluation_date = aim.evaluation?.monthEnd
    ? endOfMonth(month)
    : evaluationIn(r, month, aim.evaluation?.lo ?? 1, aim.evaluation?.hi ?? 31);
  const { d: day } = parts(evaluation_date);
  const md = aim.md;
  const evalMonth = startOfMonth(evaluation_date);
  const next_due_date = addMonths(evalMonth, -(md - 1));

  // The loan's money.
  const term = r.weighted([
    [360, 70],
    [300, 8],
    [240, 10],
    [180, 12],
  ]);
  const original = BigInt(r.int(12_000, 90_000)) * 1_000n;
  const pi_cents = levelPayment(original, ratePercent(eighths(r, 2.5, 7.5)), term);
  let escrow_cents = dollars(r, 150, 1_400);
  if (aim.piti === "even" && (pi_cents + escrow_cents) % 2n === 1n) escrow_cents += 1n;
  if (aim.piti === "odd" && (pi_cents + escrow_cents) % 2n === 0n) escrow_cents += 1n;
  const late_charge_cents = r.chance(0.8)
    ? divRound(pi_cents * BigInt(r.pick([4, 5])), 100n, "HALF_UP")
    : BigInt(r.int(15, 120)) * 100n;

  // The workout history is counted in months back from the evaluation month, and never after the
  // oldest unpaid installment, because a workout brings the loan current.
  const backOf = (b: number | undefined) => (b === undefined ? undefined : Math.max(b, md - 1));
  const aimedDeferral = backOf(aim.deferralBack);
  const freshMonths = (): number => r.int(2, Math.min(10, Math.max(2, 12 - md)));
  const aimedCumulative = aimedDeferral === undefined ? 0 : (aim.cumulative ?? freshMonths());

  // The loan's age, in months from its first installment to the evaluation month: old enough for
  // the history the aim names (its origination at least a month before the first installment), and
  // seasoned past a year.
  const forborne = aim.forborne ?? 0;
  let age: number;
  if (aim.seasonedToTheDay) {
    age = 12 - r.pick([1, 2]);
  } else if (aim.toMaturity !== undefined) {
    age = term - 1 - aim.toMaturity - (day > 1 ? 1 : 0);
  } else {
    const floor = Math.max(
      14,
      md + 2,
      (aim.cumulative ?? 0) * 2 + md + 14,
      (aim.disasterBack ?? 0) + 3,
      aimedDeferral === undefined
        ? 0
        : aimedDeferral + DEFERRAL_SEASONED * deferralsFor(aimedCumulative) - 1,
      aim.modBack === undefined ? 0 : aim.modBack + MODIFICATION_SEASONED - 1,
      aim.trialYearToTheDay ? 12 + TRIAL_SEASONED - 1 : 0,
    );
    age = r.int(floor, Math.max(floor, term - 40));
  }
  const first_payment = addMonths(evalMonth, -age);
  const maturity_date = addMonths(first_payment, term - 1);
  const originatedIn = addMonths(first_payment, -r.pick([1, 2]));
  const origination_date = aim.seasonedToTheDay
    ? addMonths(evaluation_date, -12)
    : ymd(parts(originatedIn).y, parts(originatedIn).m, r.int(1, 28));

  // The rest of the history is drawn around the aim: a deferral, a disaster deferral and a
  // modification each on a month of its own, none before its seasoning (DEFERRAL_SEASONED), a
  // disaster deferral after the first installment, and a failed trial on a month's last day.
  const sinceOrigination = monthsBetween(startOfMonth(origination_date), evalMonth);
  const room = age - 2;
  const used = new Set(
    [aimedDeferral, aim.disasterBack, aim.modBack].filter((b): b is number => b !== undefined),
  );
  /** Months back, `lo` to `hi`, with probability `p`; none without room, or on a month taken. */
  const noise = (p: number, lo: number, hi: number): number | undefined => {
    const top = Math.min(hi, 60);
    if (aim.seasonedToTheDay || top < lo || !r.chance(p)) return undefined;
    const back = r.int(lo, top);
    if (used.has(back)) return undefined;
    used.add(back);
    return back;
  };
  const at = (back: number | undefined) =>
    back === undefined ? null : before(addMonths(evalMonth, -back), next_due_date);

  let deferralBack = aimedDeferral;
  let cumulative = aimedCumulative;
  if (
    deferralBack === undefined &&
    aim.cumulative !== 0 &&
    !aim.seasonedToTheDay &&
    r.chance(0.15)
  ) {
    // The months deferred before decide how many deferrals there were, and so how late the last.
    const months = aim.cumulative ?? freshMonths();
    deferralBack = noise(
      1,
      Math.max(md - 1, 1),
      sinceOrigination - DEFERRAL_SEASONED * deferralsFor(months),
    );
    cumulative = deferralBack === undefined ? 0 : months;
  }
  const disasterBack = aim.disasterBack ?? noise(0.08, Math.max(md - 1, 1), room);
  // 12.8 bars a Flex Modification after one that went 60 days delinquent in its first year, or
  // within the year before: the delinquency reaches Section 12's 60 days when its second installment
  // falls due, at least a year after the last modification took effect (see flexFactsHold).
  let modBack =
    aim.modBack ?? noise(0.1, Math.max(12, md + 10), sinceOrigination - MODIFICATION_SEASONED);
  // A failed trial is the month's last day, `trialBack` months back (a year to the day when aimed).
  let trialBack = aim.trialYearToTheDay
    ? 12
    : noise(0.1, TRIAL_SEASONED, sinceOrigination - TRIAL_SEASONED);
  // A later workout its own evaluation would have refused gives way, the one not aimed: a deferral
  // within 13 months after a modification or a failed trial (12.6 criterion 6 at its evaluation),
  // and a modification within 16 after a failed trial (12.8's year with none, then its trial).
  const tooSoon = (later: number | undefined, earlier: number | undefined, gap: number) =>
    later !== undefined && earlier !== undefined && earlier > later && earlier - later < gap;
  if (tooSoon(deferralBack, modBack, LATER_DEFERRAL_AFTER)) {
    if (aimedDeferral === undefined) [deferralBack, cumulative] = [undefined, 0];
    else modBack = undefined;
  }
  if (tooSoon(deferralBack, trialBack, LATER_DEFERRAL_AFTER)) {
    if (aimedDeferral === undefined) [deferralBack, cumulative] = [undefined, 0];
    else trialBack = undefined;
  }
  if (tooSoon(modBack, trialBack, LATER_MODIFICATION_AFTER)) {
    if (aim.trialYearToTheDay) modBack = undefined;
    else trialBack = undefined;
  }
  const last_deferral_effective = at(deferralBack);
  const last_disaster_deferral_effective = at(disasterBack);
  const last_modification_effective = at(modBack);
  const last_failed_trial_on =
    trialBack === undefined
      ? null
      : aim.trialYearToTheDay
        ? addMonths(evaluation_date, -12)
        : endOfMonth(addMonths(evalMonth, -trialBack));

  // Late charges: one for each unpaid installment past its grace, none for a forborne month.
  const planEnd =
    forborne > 0
      ? aim.hardship === "temporary_unresolved"
        ? evalMonth
        : addMonths(evalMonth, -1)
      : null;
  const planStart = planEnd ? addMonths(planEnd, -(forborne - 1)) : null;
  let chargeable = 0;
  for (let k = 0; k < md; k++) {
    const due = addMonths(next_due_date, k);
    const forborneMonth =
      planStart !== null && planEnd !== null && due >= planStart && due <= planEnd;
    if (!forborneMonth && addDays(due, 16) <= evaluation_date) chargeable++;
  }
  const unpaid_late_charges = aim.noLateCharges
    ? 0
    : r.chance(0.8)
      ? chargeable
      : r.int(0, chargeable);

  // The deferral's money and the partner's election.
  const escrow_advances_cents = r.chance(0.4)
    ? 0n
    : (escrow_cents * BigInt(md) * BigInt(r.int(20, 100))) / 100n;
  const servicing_advances_cents = r.chance(0.55) ? 0n : dollars(r, 10, 600);
  const escrow_shortage_cents = r.weighted<Cents>([
    [0n, 35],
    // Spread over 60 months, exactly half a cent over: rounds up.
    [BigInt(r.int(0, 3_990)) * 60n + 30n, 15],
    [dollars(r, 0, 3_999), 50],
  ]);
  // No processing month where it would put the entry deadline on the disputed one (larDisputed).
  const processing_month_elected =
    day > 15 && !larDisputed(endOfMonth(addMonths(evalMonth, 1))) && (aim.elect ?? r.chance(0.55));

  const piti = pi_cents + escrow_cents;
  const arrears = BigInt(md) * piti + BigInt(unpaid_late_charges) * late_charge_cents;

  // What the borrower has, and can pay.
  const funds_available_cents = ((): Cents => {
    switch (aim.funds ?? "short") {
      case "exact":
        return arrears;
      case "cent_over":
        return arrears + 1n;
      case "over":
        return arrears + BigInt(r.int(1, Number(piti) * 3));
      case "cent_short":
        return arrears - 1n;
      case "short":
        return r.chance(0.15) ? 0n : (arrears * BigInt(r.int(0, 95))) / 100n;
    }
  })();
  const table = totals(arrears, piti);
  const allowed = table.filter((t) => t.allowed);
  const np = newPayment(pi_cents, escrow_cents, escrow_shortage_cents).payment_cents;
  const capacity_cents = ((): Cents => {
    const c = aim.capacity ?? { kind: "random" };
    if (c.kind === "random") return (piti * BigInt(r.int(80, 160))) / 100n;
    if (c.kind === "screen") {
      // Criterion (2): able to make the new payment; and short of every allowed plan.
      const cheapest = allowed.length ? allowed[allowed.length - 1]!.total : null;
      if (cheapest === null) return np + BigInt(r.int(0, 50_000));
      if (c.at === "cent_short_of_12" || r.chance(0.2)) return cheapest - 1n;
      if (r.chance(0.2)) return np;
      return np + BigInt(r.int(0, Math.max(0, Number(cheapest - 1n - np))));
    }
    if (c.kind === "cent_short") {
      // A cent short of a term whose next term costs less: the search moves on to that one.
      const moves = allowed.filter(
        (t, k) => k + 1 < allowed.length && allowed[k + 1]!.total < t.total,
      );
      if (moves.length) return r.pick(moves).total - 1n;
      return allowed.length ? allowed[allowed.length - 1]!.total : piti * 2n;
    }
    if (!allowed.length) return piti * 2n;
    const target =
      c.target === "smallest" ? allowed[0]! : r.chance(0.3) ? allowed[0]! : r.pick(allowed);
    if (c.exact) return target.total;
    const shorter = table[target.m - 2];
    const gap = shorter && shorter.allowed ? shorter.total - target.total - 1n : 60_000n;
    return target.total + BigInt(r.int(0, Math.max(0, Number(gap))));
  })();

  // The forbearance asked for.
  const requested_months =
    aim.hardship === "temporary_unresolved"
      ? (aim.requested ??
        r.weighted([
          [1, 15],
          [2, 25],
          [3, 60],
        ]))
      : null;

  // A sale is scheduled only once a first notice could have preceded the complete application
  // (SALE_FROM_DAY), with no forbearance plan running, and never in New York, whose courts take years.
  const saleAllowed =
    daysBetween(next_due_date, evaluation_date) >= SALE_FROM_DAY &&
    !(aim.hardship === "temporary_unresolved" && forborne > 0);
  const saleAim = saleAllowed
    ? r.weighted([
        ["none", 40],
        ["far", 30],
        ["near", 22],
        ["boundary", 8],
      ])
    : "none";
  const scheduled_sale_on =
    saleAim === "none"
      ? null
      : addDays(
          evaluation_date,
          saleAim === "far"
            ? r.chance(0.1)
              ? 90
              : r.int(91, 240)
            : saleAim === "near"
              ? r.int(38, 89)
              : r.pick([90, 89, 38]),
        );
  const state =
    scheduled_sale_on !== null ? r.pick(NONJUDICIAL) : r.chance(0.15) ? "NY" : r.pick(OTHER_STATES);

  // The notice, within the 30 days, mostly mailed on a business day.
  const window = Array.from({ length: 30 }, (_, k) => addDays(evaluation_date, k + 1));
  const business = window.filter((d) => federal.isBusinessDay(d));
  const notice_provided_on = r.chance(0.85) && business.length ? r.pick(business) : r.pick(window);

  return {
    ...coordinates,
    evaluation_date,
    notice_provided_on,
    scheduled_sale_on,
    state,
    loan: {
      origination_date,
      maturity_date,
      pi_cents,
      escrow_cents,
      late_charge_cents,
      next_due_date,
      unpaid_late_charges,
    },
    borrower: { hardship: aim.hardship, funds_available_cents, capacity_cents },
    forbearance: { forborne_months: forborne, requested_months },
    history: {
      cumulative_deferred_months: cumulative,
      last_deferral_effective,
      last_disaster_deferral_effective,
      last_failed_trial_on,
      last_modification_effective,
      active_arrangements: [],
    },
    deferral: {
      escrow_advances_cents,
      servicing_advances_cents,
      escrow_shortage_cents,
      processing_month_elected,
    },
    flexmod_eligible: true,
  };
}

/* ── the guard ──────────────────────────────────────────────────────────── */

const within12 = (task: LossmitTask, d: PlainDate | null) =>
  d !== null && addMonths(d, 12) > task.evaluation_date;

/**
 * The day the delinquency reached Fannie Mae's 60 days, as Section 12 counts
 * them: its README counts the eligibility windows in `fnma_delinquency_status`
 * months, the installments due through the day (12.6 rule 1, 12.8's worked
 * example), so two installments are 60 days. That is the day the oldest
 * unpaid installment's next one fell due.
 */
export const sixtyDaysOn = (task: LossmitTask): PlainDate => addMonths(task.loan.next_due_date, 1);

/**
 * The Flex Modification's own criteria that a file carries whatever it is
 * offered (12.8, D2-3.2-06): originated a year before the evaluation, no
 * conflicting arrangement, no failed trial within 12 months, no modification
 * within 12 months, and no modification that went 60 days delinquent in its
 * first year without reinstatement. The last modification of a Fannie Mae
 * loan in these years is a Flex Modification, and an unpaid installment has
 * never been reinstated, so it is barred when the delinquency reached 60 days
 * before the modification's first anniversary. v1 draws no file that fails
 * one, so flexmod_eligible is true on every file and never contradicts what
 * the file shows.
 */
export function flexFactsHold(task: LossmitTask): boolean {
  const modified = task.history.last_modification_effective;
  const sixty = sixtyDaysOn(task);
  return (
    addMonths(task.loan.origination_date, 12) <= task.evaluation_date &&
    task.history.active_arrangements.length === 0 &&
    !within12(task, task.history.last_failed_trial_on) &&
    !within12(task, modified) &&
    !(modified !== null && sixty <= task.evaluation_date && sixty < addMonths(modified, 12))
  );
}

/**
 * And at the Flex Modification rung, 60 days delinquent: two installments
 * behind or more (sixtyDaysOn). A file the walk takes there without them
 * would go on to the liquidation options, which the engine offers with no
 * test.
 */
export const flexCriteriaHold = (task: LossmitTask): boolean =>
  flexFactsHold(task) && monthsDelinquent(task.loan.next_due_date, task.evaluation_date) >= 2;

/**
 * Whether the workout history is one the loan could have had (12.6, 12.8;
 * DEFERRAL_SEASONED): a deferral with months deferred and none without, the
 * last of them late enough for the deferrals its months took; a modification
 * after its seasoning and trial; a failed trial on a month's last day, after
 * its seasoning; each deferral or modification on a day of its own; and none
 * that its own evaluation would have refused for the one before it
 * (LATER_DEFERRAL_AFTER).
 */
export function historyCoheres(task: LossmitTask): boolean {
  const h = task.history;
  const originated = startOfMonth(task.loan.origination_date);
  const deferrals = deferralsFor(h.cumulative_deferred_months);
  if ((h.last_deferral_effective === null) !== (deferrals === 0)) return false;
  if (
    h.last_deferral_effective !== null &&
    h.last_deferral_effective < addMonths(originated, DEFERRAL_SEASONED * deferrals)
  )
    return false;
  if (
    h.last_modification_effective !== null &&
    h.last_modification_effective < addMonths(originated, MODIFICATION_SEASONED)
  )
    return false;
  const trial = h.last_failed_trial_on;
  if (
    trial !== null &&
    (trial !== endOfMonth(trial) || trial < endOfMonth(addMonths(originated, TRIAL_SEASONED)))
  )
    return false;
  const follows = (later: PlainDate | null, earlier: PlainDate | null, gap: number) =>
    later !== null &&
    earlier !== null &&
    earlier < later &&
    later < addMonths(startOfMonth(earlier), gap);
  const deferral = h.last_deferral_effective;
  const modified = h.last_modification_effective;
  if (
    follows(deferral, modified, LATER_DEFERRAL_AFTER) ||
    follows(deferral, trial, LATER_DEFERRAL_AFTER) ||
    follows(modified, trial, LATER_MODIFICATION_AFTER)
  )
    return false;
  const dated = [deferral, h.last_disaster_deferral_effective, modified].filter((x) => x !== null);
  return new Set(dated).size === dated.length;
}

/**
 * v1's guard, run on the engine's own outputs: a file is kept only when the
 * engine does nothing in it that its spec calls wrong, and its facts agree
 * with each other.
 *   - the walk offers one of the five retention options, never the short
 *     sale it offers with no test when they all fail (D5), and Flex
 *     Modification only to a file that meets its own criteria (12.8);
 *   - no sale is 37 days or less away, where there is no (c)(1) duty but the
 *     engine still sets a 7-day window;
 *   - the decision date is a business day: the spec's timer row moves a day
 *     30 on a weekend to the business day before, and the engine never moves
 *     it (D7);
 *   - a forbearance offered is at least a month (the servicing app's own
 *     createForbearanceTerm refuses a shorter one);
 *   - a deferral offered defers at least 2 months (D1: the screen calls 0 and
 *     1 eligible) and leaves at most one installment to pay, the one
 *     contractual payment the spec's gate names;
 *   - wherever the screen decides, the loan is not exactly 36 months from
 *     maturity, where the spec's gate rows (> 36) and the engine (≥ 36)
 *     disagree, and the borrower can make the deferral's new payment
 *     (criterion 2, which the screen does not test);
 *   - a deferral offered is not entered by 2026-11-30, whose reporting
 *     deadline the spec disputes (larDisputed);
 *   - a processing month is elected only where the engine permits it, and
 *     the notice goes out within the 30 days;
 *   - the inputs cohere: Flex Modification eligible on every file and its
 *     criteria met by every file, a sale only from day 122 of the
 *     delinquency with no plan running (SALE_FROM_DAY), a forbearance never
 *     past either 12-month cap, and a workout history the loan could have
 *     had (historyCoheres).
 */
export function lossmitInScope(task: LossmitTask): boolean {
  let a: ReturnType<typeof analyzeLossmit>;
  let want: ReturnType<typeof expectedLossmit>;
  try {
    a = analyzeLossmit(task);
    want = expectedLossmit(task);
  } catch {
    return false;
  }
  const offered = a.walk.offered;
  if (offered === "flex_mod" && !flexCriteriaHold(task)) return false;
  if (!task.flexmod_eligible || !flexFactsHold(task)) return false;
  if (a.tier === "le_37") return false;
  if (!federal.isBusinessDay(a.deadlines.decision_due)) return false;
  if (
    task.notice_provided_on < task.evaluation_date ||
    task.notice_provided_on > a.deadlines.decision_due
  )
    return false;
  if (offered === "forbearance" && a.forbearance.months < 1) return false;
  if (
    task.borrower.hardship === "temporary_unresolved" &&
    (task.forbearance.forborne_months > 11 || a.months_delinquent > 11)
  )
    return false;
  if (offered === "payment_deferral") {
    if (!a.screen.eligible || a.screen.months_deferred < 2) return false;
    if (installmentsToPay(task.history.cumulative_deferred_months, a.months_delinquent) > 1)
      return false;
    if (larDisputed(want.deferral_timeline!.entry_deadline as PlainDate)) return false;
  }
  if (!historyCoheres(task)) return false;
  if (a.screen_reached) {
    if (monthsToMaturity(task) === 36) return false;
    if (task.borrower.capacity_cents < a.new_payment.payment_cents) return false;
  }
  if (task.scheduled_sale_on !== null) {
    if (daysBetween(task.loan.next_due_date, task.evaluation_date) < SALE_FROM_DAY) return false;
    if (task.state === "NY") return false;
    if (task.borrower.hardship === "temporary_unresolved" && task.forbearance.forborne_months > 0)
      return false;
  }
  return want.offered === offered;
}

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
export function lossmitFairToGrade(task: LossmitTask): boolean {
  const payload = JSON.parse(JSON.stringify(lossmitPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(lossmitSteps, payload, executeLossmitTool);
  } catch {
    return false;
  }
  const parsed = parseLossmitSubmission(byRules);
  return parsed.ok && gradeLossmitAgainst(expectedLossmit(task), parsed.answer).pass;
}

const ATTEMPTS = 40;

export function drawLossmitTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: LossmitTask; attempts: number } {
  const id = lossmitTaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const task = drawLossmitCandidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (lossmitInScope(task) && lossmitFairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no file fair to grade in ${ATTEMPTS} draws`);
}

export const generateLossmitTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
) => drawLossmitTask(split, suiteSeed, index).task;

export function generateLossmitSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): LossmitTask[] {
  return Array.from({ length: n }, (_, i) => generateLossmitTask(split, suiteSeed, i));
}

export const LOSSMIT_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's worked examples ─────────────────────────────────────────── */

type SpecFile = Omit<LossmitTask, "id" | "split" | "suite_seed" | "index">;

/**
 * 12.6's worked loan: 30-year fixed at 6.5% on $250,000, P&I $1,580.17, T&I
 * $520.00, originated 2021-10 with its first payment 2021-11-01, so it
 * matures 2051-10-01 (300 whole months from 2026-09-20; the spec's "348" is
 * its own slip, and either passes). Four installments, June to September,
 * unpaid on the 2026-09-20 evaluation, with a $63.00 late charge each; a
 * $1,050.00 county tax advance; a $1,860.00 escrow shortage. The borrower's
 * stated capacity is not in the example; $2,500.00 covers the new payment
 * and no repayment plan, as the example's walk to the deferral requires.
 */
const WORKED: SpecFile = {
  evaluation_date: plainDate("2026-09-20"),
  // 12.6-T7: the offer on a complete application, provided 2026-10-02.
  notice_provided_on: plainDate("2026-10-02"),
  scheduled_sale_on: null,
  state: "OH",
  loan: {
    origination_date: plainDate("2021-10-01"),
    maturity_date: plainDate("2051-10-01"),
    pi_cents: 158_017n,
    escrow_cents: 52_000n,
    late_charge_cents: 6_300n,
    next_due_date: plainDate("2026-06-01"),
    unpaid_late_charges: 4,
  },
  borrower: { hardship: "resolved", funds_available_cents: 150_000n, capacity_cents: 250_000n },
  forbearance: { forborne_months: 0, requested_months: null },
  history: {
    cumulative_deferred_months: 0,
    last_deferral_effective: null,
    last_disaster_deferral_effective: null,
    last_failed_trial_on: null,
    last_modification_effective: null,
    active_arrangements: [],
  },
  deferral: {
    escrow_advances_cents: 105_000n,
    servicing_advances_cents: 0n,
    escrow_shortage_cents: 186_000n,
    processing_month_elected: false,
  },
  flexmod_eligible: true,
};

type Over = {
  [K in keyof SpecFile]?: SpecFile[K] extends Record<string, unknown>
    ? Partial<SpecFile[K]>
    : SpecFile[K];
};
const worked = (over: Over, base: SpecFile = WORKED): SpecFile => ({
  ...base,
  ...over,
  loan: { ...base.loan, ...over.loan },
  borrower: { ...base.borrower, ...over.borrower },
  forbearance: { ...base.forbearance, ...over.forbearance },
  history: { ...base.history, ...over.history },
  deferral: { ...base.deferral, ...over.deferral },
});

/**
 * 12.5's worked plan on 12.2's dates: PITI $2,100.00 (the same P&I, T&I
 * $519.83), August to October unpaid on the 2026-10-07 completion with two
 * $63.00 late charges ($6,426.00), the notice mailed Monday 2026-11-02, and a
 * stated capacity of $2,950.00.
 */
const PLAN = worked({
  evaluation_date: plainDate("2026-10-07"),
  notice_provided_on: plainDate("2026-11-02"),
  loan: { escrow_cents: 51_983n, next_due_date: plainDate("2026-08-01"), unpaid_late_charges: 2 },
  borrower: { capacity_cents: 295_000n },
});

/** §12.4's 3 + 3 + 3: two installments unpaid at the first term, each later term decided in the last month of the one before. */
const term = (evaluation: string, provided: string, forborne: number, lateCharges: number) =>
  worked({
    evaluation_date: plainDate(evaluation),
    notice_provided_on: plainDate(provided),
    loan: { next_due_date: plainDate("2026-08-01"), unpaid_late_charges: lateCharges },
    borrower: { hardship: "temporary_unresolved", funds_available_cents: 50_000n },
    forbearance: { forborne_months: forborne, requested_months: 3 },
  });

export const LOSSMIT_SPEC_CASES: readonly { readonly name: string; readonly file: SpecFile }[] = [
  {
    name: "12.6 worked example: four payments deferred, offered on a complete application (12.6-T1, T7)",
    file: WORKED,
  },
  {
    name: "12.6-T2: the same loan 6 months delinquent, with the contractual payment required",
    file: worked({ loan: { next_due_date: plainDate("2026-04-01"), unpaid_late_charges: 6 } }),
  },
  {
    name: "12.6-T2: 7 months delinquent, outside the window: Flex Modification",
    file: worked({ loan: { next_due_date: plainDate("2026-03-01"), unpaid_late_charges: 7 } }),
  },
  {
    name: "12.6-T3: a deferral effective 2025-11-01, evaluated 2026-09-20: Flex Modification",
    file: worked({
      history: { cumulative_deferred_months: 3, last_deferral_effective: plainDate("2025-11-01") },
    }),
  },
  {
    name: "12.6-T3: a disaster deferral effective 2025-11-01 does not count",
    file: worked({ history: { last_disaster_deferral_effective: plainDate("2025-11-01") } }),
  },
  {
    name: "12.6-T4: 9 months deferred before and 4 now: 3 deferred, 1 to pay",
    file: worked({
      history: { cumulative_deferred_months: 9, last_deferral_effective: plainDate("2024-06-01") },
    }),
  },
  {
    name: "12.5 worked example: $6,426.00 over 8 months within $2,950.00 (on 12.2's dates)",
    file: PLAN,
  },
  {
    name: "12.5 worked example: $2,500.00 a month affords no plan: a 3-month deferral",
    file: worked(
      {
        borrower: { capacity_cents: 250_000n },
        deferral: { escrow_advances_cents: 0n, escrow_shortage_cents: 0n },
      },
      PLAN,
    ),
  },
  {
    name: "12.2 rule 7: the same plan in New York, accepted by 2026-12-02",
    file: worked({ state: "NY" }, PLAN),
  },
  {
    // A permanent hardship, so the walk stops at Flex Modification: the worked loan's deferral would
    // be entered by 2026-11-30, whose reporting deadline the spec disputes (larDisputed).
    name: "12.2-T2: complete 2026-11-01 with a sale on 2027-01-15: 7 days, no appeal",
    file: worked({
      evaluation_date: plainDate("2026-11-01"),
      notice_provided_on: plainDate("2026-11-05"),
      scheduled_sale_on: plainDate("2027-01-15"),
      state: "TX",
      loan: { unpaid_late_charges: 5 },
      borrower: { hardship: "permanent" },
    }),
  },
  {
    name: "12.4 worked example, term 1: 2026-10-01 to 2026-12-31",
    file: term("2026-09-15", "2026-09-18", 0, 1),
  },
  {
    name: "12.4 worked example, term 2: 2027-01-01 to 2027-03-31, six forborne",
    file: term("2026-12-08", "2026-12-11", 3, 2),
  },
  {
    name: "12.4 worked example, term 3: 2027-04-01 to 2027-06-30, past six forborne",
    file: term("2027-03-09", "2027-03-12", 6, 2),
  },
  {
    name: "12.4 worked example, term 4: one month to 2027-07-31, the exception required (12.4-T2)",
    file: term("2027-06-14", "2027-06-17", 9, 2),
  },
];

export function lossmitSpecTasks(): LossmitTask[] {
  return LOSSMIT_SPEC_CASES.map((c, index) => ({
    id: `${LOSSMIT_ENVIRONMENT_NAME}/${LOSSMIT_ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec",
    suite_seed: 0,
    index,
    ...c.file,
  }));
}
