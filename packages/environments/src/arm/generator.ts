/**
 * Synthetic adjustable-rate loans on one change date each, seeded: no
 * borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). A loan is made the
 * way a servicer boards one: a product (a Fannie Mae SOFR plan, 4926 to 4929;
 * a legacy one-year Treasury, Term SOFR or monthly Cost of Funds note; an
 * interest-only ARM; a short-teaser or one-year ARM), a closing, its first
 * payment two months on, its change dates on the schedule, and the change
 * being worked, the first or a later one. On a later change the current rate,
 * payment and schedule basis are what the servicing app's makeEffective
 * leaves (ops-7-2.ts:484): the scheduled balance at the last change, at the
 * rate it set, with the payment the engine's own newPayment gives. The index
 * is a run of business-day prints around the index date, with prints after
 * it. Then the change is aimed, in turn by index, at one edge:
 *   - standard: a Fannie Mae plan or a legacy note, nothing aimed;
 *   - midpoint: index + margin exactly halfway between two eighths, or one
 *     hundred-thousandth either side, under either rounding rule;
 *   - initial_cap: the first change above or below its cap, exactly on it,
 *     and a midpoint that lands on the cap rounding down and passes it up;
 *   - periodic_cap: the same on a later change;
 *   - lifetime_cap: a later change near the ceiling, exactly on it, and the
 *     tie where prior + cap is the ceiling (the cap is named, not lifetime);
 *     and a 7/6 or 10/6 plan whose 5 % initial cap is its lifetime cap;
 *   - floor: an off-grid margin (2.800) whose eighth falls below it, and an
 *     on-grid one an index of 0 lands on exactly;
 *   - index_lookup: no print on the index date (a weekend, a holiday, or a
 *     missing print), with a print after it that would round otherwise;
 *   - interest_only: interest only through the change, ending with it, and
 *     ended at an earlier change;
 *   - legacy: closed before 2015-01-10 with a look-back under 45 days, the
 *     2015-01-09 and 2015-01-10 closings, monthly adjusters, and a pre-2015
 *     note with a 45-day look-back;
 *   - initial_notice: the first change's (d) duty: the servicer's, the
 *     originator's (210 days or fewer from closing, at 209, 210 and 211),
 *     exempt on a one-year term; and the (c) exemptions with them: the
 *     non-estimate first change, and the first change within 60 days of
 *     closing after an estimate (at 60 and 61);
 *   - send_window: a send the day before the window opens, on the index
 *     date, on the deadline, the day after, and a month late;
 *   - no_change: an index that rounds back to the current rate, where the
 *     scheduled balance re-amortized may or may not move the payment a cent,
 *     and an FDCPA cease on file with a debt collector or without one.
 *
 * What v1 leaves out is in docs/environments.md; `armInScope` runs on the
 * engine's own results and keeps a change only where the engine does
 * nothing its spec calls wrong. A change is then kept only once the
 * reference, working through the tools, lands exactly where the engine does;
 * the tests hold both to zero misses on unfiltered draws.
 */

import { levelPayment, ratePercent, type Cents } from "@hm/kernel/money";
import {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  parts,
  plainDate,
  servicer,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import {
  analyzeArm,
  expectedArm,
  gradeArmAgainst,
  monthsBetween,
  parseArmSubmission,
  type ArmAnalysis,
} from "./grader.js";
import { newPayment, scheduledUpbAfter } from "./ported/arm.js";
import { armSteps } from "./reference.js";
import {
  ARM_ENVIRONMENT_NAME,
  ARM_ENVIRONMENT_VERSION,
  armPayload,
  type ArmLoan,
  type ArmTask,
  type IndexPrint,
  type IndexType,
} from "./task.js";
import { executeArmTool } from "./tools.js";

export const armTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${ARM_ENVIRONMENT_NAME}/${ARM_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const ARM_EDGES = [
  "standard",
  "midpoint",
  "initial_cap",
  "periodic_cap",
  "lifetime_cap",
  "floor",
  "index_lookup",
  "interest_only",
  "legacy",
  "initial_notice",
  "send_window",
  "no_change",
] as const;
export type ArmEdge = (typeof ARM_EDGES)[number];
export const armEdgeOf = (index: number): ArmEdge => ARM_EDGES[index % ARM_EDGES.length]!;

/* ── rates in hundred-thousandths of a percent, so nothing is a float ───── */

const UNIT = 100_000;
const EIGHTH = 12_500;
const units = (pct: string): number => {
  const [int, frac = ""] = pct.split(".");
  return Number(int) * UNIT + Number(frac.padEnd(5, "0"));
};
const pct5 = (u: number): string => {
  if (!Number.isInteger(u) || u < 0) throw new RangeError(`not a nonnegative rate: ${u}`);
  const s = String(u).padStart(6, "0");
  return `${s.slice(0, -5)}.${s.slice(-5)}`;
};
const pct3 = (u: number): string => {
  if (u % 100 !== 0) throw new RangeError(`${u} has more than three decimals`);
  return pct5(u).slice(0, -2);
};
/** An eighth from lo to hi; the eighth at or above lo when the range holds none. */
const eighthsBetween = (r: Rng, lo: number, hi: number): number => {
  const a = Math.ceil(lo / EIGHTH);
  return r.int(a, Math.max(a, Math.floor(hi / EIGHTH))) * EIGHTH;
};
/** A rate somewhere inside one eighth's rounding band, never on its midpoints. */
const insideBand = (r: Rng, eighth: number): number =>
  eighth + r.int(-(EIGHTH / 2) + 1, EIGHTH / 2 - 1);

/* ── products ─────────────────────────────────────────────────────────── */

interface Product {
  readonly plan: string | null;
  readonly index_type: IndexType;
  readonly period: number;
  /** The first change is on the payment this many payments in: first payment + (fixed − 1) months. */
  readonly fixed: number;
  readonly lookback: number;
  readonly caps: readonly [number, number, number];
  readonly term: number;
  /** The months a loan of this product closed in, both included. */
  readonly closed: readonly [PlainDate, PlainDate];
}

const PCT = (x: number) => Math.round(x * UNIT);
const SOFR_ERA = [plainDate("2020-07-01"), plainDate("2023-12-01")] as const;
const PRE_2015 = [plainDate("2003-01-01"), plainDate("2014-12-01")] as const;

const fannie = (r: Rng): Product => {
  const plan = r.pick(["4926", "4927", "4927", "4928", "4929"]);
  const fixed = { "4926": 36, "4927": 60, "4928": 84, "4929": 120 }[plan]!;
  return {
    plan,
    index_type: "SOFR_30D_AVG",
    period: 6,
    fixed,
    lookback: 45,
    caps: plan === "4928" || plan === "4929" ? [PCT(5), PCT(1), PCT(5)] : [PCT(2), PCT(1), PCT(5)],
    term: r.chance(0.9) ? 360 : r.pick([240, 300]),
    closed: SOFR_ERA,
  };
};
const cmt = (r: Rng, lookback = 45): Product => ({
  plan: null,
  index_type: "CMT_1Y",
  period: 12,
  fixed: r.pick([12, 36, 60, 84]),
  lookback,
  caps: r.pick([
    [PCT(2), PCT(2), PCT(6)],
    [PCT(5), PCT(2), PCT(5)],
    [PCT(2), PCT(2), PCT(5)],
  ] as const),
  term: 360,
  closed: PRE_2015,
});
const termSofr = (r: Rng): Product => ({
  plan: null,
  index_type: "TERM_SOFR_12M_PLUS_SPREAD",
  period: 12,
  fixed: r.pick([60, 84, 120]),
  lookback: 45,
  caps: r.pick([
    [PCT(5), PCT(2), PCT(5)],
    [PCT(2), PCT(2), PCT(5)],
  ] as const),
  term: 360,
  closed: [plainDate("2010-01-01"), plainDate("2021-06-01")],
});
const monthly = (r: Rng): Product => ({
  plan: null,
  index_type: "COFI",
  period: 1,
  fixed: r.pick([1, 3, 12]),
  lookback: r.pick([15, 30, 45]),
  caps: [PCT(1), PCT(1), PCT(r.pick([5, 6]))],
  term: 360,
  closed: [plainDate("2003-01-01"), plainDate("2019-12-01")],
});
const anyProduct = (r: Rng): Product =>
  r.weighted<() => Product>([
    [() => fannie(r), 70],
    [() => cmt(r), 12],
    [() => termSofr(r), 10],
    [() => monthly(r), 8],
  ])();

/* ── where the change falls ───────────────────────────────────────────── */

const WINDOW_FROM = plainDate("2026-02-01");
const WINDOW_TO = plainDate("2028-12-01");

interface Placement {
  readonly consummation: PlainDate;
  readonly first_payment_due: PlainDate;
  readonly first_change_date: PlainDate;
  readonly change_date: PlainDate;
}

/** A closing in a month: any day of it. The first payment is due the 1st of the month two on. */
const closingIn = (r: Rng, month: PlainDate): PlainDate => {
  const { y, m } = parts(month);
  return ymd(y, m, r.int(1, daysInMonth(y, m)));
};
const firstPaymentAfter = (consummation: PlainDate): PlainDate => {
  const { y, m } = parts(consummation);
  return addMonths(ymd(y, m, 1), 2);
};

function placeFirst(r: Rng, p: Product): Placement {
  const change_date = addMonths(WINDOW_FROM, r.int(0, monthsBetween(WINDOW_FROM, WINDOW_TO)));
  const first_payment_due = addMonths(change_date, -(p.fixed - 1));
  return {
    consummation: closingIn(r, addMonths(first_payment_due, -2)),
    first_payment_due,
    first_change_date: change_date,
    change_date,
  };
}

/** A later change: one at least a period after the first, by a loan that closed when the product says. */
function placeLater(r: Rng, p: Product, consummation?: PlainDate): Placement | null {
  for (let attempt = 0; attempt < 30; attempt++) {
    const closed =
      consummation ??
      closingIn(r, addMonths(p.closed[0], r.int(0, monthsBetween(p.closed[0], p.closed[1]))));
    const first_payment_due = firstPaymentAfter(closed);
    const first_change_date = addMonths(first_payment_due, p.fixed - 1);
    const maturity = addMonths(first_payment_due, p.term - 1);
    const changes: PlainDate[] = [];
    for (let k = 1; ; k++) {
      const c = addMonths(first_change_date, k * p.period);
      if (c > WINDOW_TO || monthsBetween(addMonths(c, 1), maturity) + 1 < 12) break;
      if (c >= WINDOW_FROM) changes.push(c);
    }
    if (changes.length) {
      return {
        consummation: closed,
        first_payment_due,
        first_change_date,
        change_date: r.pick(changes),
      };
    }
  }
  return null;
}

/* ── the loan on the change date ──────────────────────────────────────── */

interface Draft {
  product: Product;
  place: Placement;
  margin: number;
  note: number;
  /** The prior rate on a later change; the note rate on the first. */
  prior?: number;
  io_until: PlainDate | null;
  half_up: boolean;
  estimate: boolean;
  fdcpa: readonly [boolean, boolean];
  original: Cents;
}

function loanOf(r: Rng, d: Draft): ArmLoan {
  const p = d.product;
  const { consummation, first_payment_due, first_change_date, change_date } = d.place;
  const maturity = addMonths(first_payment_due, p.term - 1);
  const note = pct3(d.note);
  const initial = change_date === first_change_date;
  let current_rate_pct = note;
  let basis: ArmLoan["schedule_basis"];
  if (initial) {
    // The note: interest only from the first payment when the loan is interest-only at all.
    const pi = newPayment(d.original, note, p.term, d.io_until !== null);
    basis = {
      upb_cents: d.original,
      rate_pct: note,
      pi_cents: pi,
      from_due_date: first_payment_due,
    };
  } else {
    // What makeEffective left at the last change (ops-7-2.ts:484): the expected balance then, at
    // the rate it set, with the engine's own payment over the term left then.
    const last = addMonths(change_date, -p.period);
    const lastDue = addMonths(last, 1);
    const ioThen = d.io_until !== null && lastDue <= d.io_until;
    let upb: Cents = d.original;
    if (!(d.io_until !== null && last <= d.io_until)) {
      // Amortizing since the first payment, or since the interest-only period ended at a change.
      const from = d.io_until === null ? first_payment_due : addMonths(d.io_until, 1);
      const left = monthsBetween(from, maturity) + 1;
      const pi = levelPayment(d.original, ratePercent(note), left);
      upb = scheduledUpbAfter(d.original, note, pi, monthsBetween(from, last) + 1);
      // Earlier changes moved the rate about; the balance moved with it.
      upb = (upb * BigInt(r.int(9_850, 10_150))) / 10_000n;
    }
    const rate = pct3(d.prior ?? d.note);
    current_rate_pct = rate;
    basis = {
      upb_cents: upb,
      rate_pct: rate,
      pi_cents: newPayment(upb, rate, monthsBetween(lastDue, maturity) + 1, ioThen),
      from_due_date: lastDue,
    };
  }
  return {
    loan_id: `LN-${r.int(100_000, 999_999)}`,
    fnma_arm_plan: p.plan,
    index_type: p.index_type,
    margin_pct: pct3(d.margin),
    lookback_days: p.lookback,
    first_change_date,
    adjustment_period_months: p.period,
    initial_cap_pct: pct3(p.caps[0]),
    periodic_cap_pct: pct3(p.caps[1]),
    lifetime_cap_pct: pct3(p.caps[2]),
    initial_note_rate_pct: note,
    rounding_rule: d.half_up ? "nearest_eighth_half_up" : "nearest_eighth_half_down",
    original_upb_cents: d.original,
    first_payment_due,
    term_months: p.term,
    consummation_date: consummation,
    initial_disclosure_estimate: d.estimate,
    interest_only_until: d.io_until,
    escrow_cents: r.chance(0.8) ? BigInt(r.int(150, 1_400)) * 100n + BigInt(r.int(0, 99)) : 0n,
    fdcpa_cease_on_file: d.fdcpa[0],
    fdcpa_debt_collector: d.fdcpa[1],
    current_rate_pct,
    current_pi_cents: basis.pi_cents,
    schedule_basis: basis,
  };
}

/* ── the index as published ───────────────────────────────────────────── */

interface SeriesAim {
  /** The value of the print the note looks back to, in hundred-thousandths. */
  readonly value: number;
  /** Leave the index date itself without a print (it may have none anyway). */
  readonly missing: boolean;
  /** The first print after the index date jumps, so reading past it changes the rate. */
  readonly trap: boolean;
}

function seriesAround(r: Rng, indexDate: PlainDate, aim: SeriesAim): IndexPrint[] {
  const from = addDays(indexDate, -r.int(18, 30));
  const to = addDays(indexDate, r.int(4, 15));
  let days: PlainDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (servicer.isBusinessDay(d)) days.push(d);
  if (aim.missing) {
    days = days.filter((d) => d !== indexDate);
    if (r.chance(0.3)) {
      const before = days.filter((d) => d < indexDate);
      days = days.filter((d) => d !== before[before.length - 1]);
    }
  }
  const chosen = days.filter((d) => d <= indexDate).length - 1;
  const values = new Map<number, number>([[chosen, aim.value]]);
  const step = () => r.int(-250, 250);
  for (let i = chosen - 1; i >= 0; i--) values.set(i, Math.max(0, values.get(i + 1)! + step()));
  for (let i = chosen + 1; i < days.length; i++) {
    const jump =
      aim.trap && i === chosen + 1 ? r.pick([-1, 1]) * r.int(EIGHTH / 2, 3 * EIGHTH) : step();
    values.set(i, Math.max(0, values.get(i - 1)! + jump));
  }
  return days.map((effective_date, i) => ({ effective_date, value: pct5(values.get(i)!) }));
}

/* ── the send date, aimed once the engine has said what goes ──────────── */

type SendAim = "blocked" | "open_eve" | "index_date" | "deadline" | "day_after" | "late" | "inside";

function sendFor(r: Rng, task: ArmTask, x: ArmAnalysis, aim: SendAim): PlainDate {
  const fnmaBy = addDays(task.change_date, -25);
  if (x.template === null) return addDays(x.index_date, r.int(0, 20));
  if (x.template === "NTC_FNMA_C2_1_02_RATE_CHANGE") {
    // In place of a suppressed Reg Z notice, never after change − 25: the engine does not
    // mark that one late, and its spec does (armInScope).
    const lateOk = !x.regz_suppressed;
    const span = Math.max(0, daysBetween(x.index_date, fnmaBy));
    if (x.index_date > fnmaBy) return addDays(x.index_date, r.int(0, 10));
    const late = lateOk && (aim === "late" || aim === "day_after" || r.chance(0.3));
    if (late) return aim === "late" ? addDays(fnmaBy, r.int(2, 40)) : addDays(fnmaBy, 1);
    return aim === "deadline" || r.chance(0.3) ? fnmaBy : addDays(x.index_date, r.int(0, span));
  }
  const open = x.notice_window_open;
  const due = x.notice_due_by;
  const inside = () => addDays(x.index_date, r.int(0, Math.max(0, daysBetween(x.index_date, due))));
  // A deadline before the index date (a short look-back on a 60-day loan): it cannot be met, and
  // nothing is sent before the index is known, so the notice goes late or before the window opens.
  if (due < x.index_date && aim !== "blocked" && aim !== "open_eve")
    return addDays(x.index_date, r.int(0, 20));
  switch (aim) {
    case "blocked":
      return open ? addDays(open, -r.int(2, 30)) : inside();
    case "open_eve":
      return open ? addDays(open, -1) : inside();
    case "index_date":
      return x.index_date;
    case "deadline":
      return due;
    case "day_after":
      return addDays(due, 1);
    case "late":
      return addDays(due, r.int(2, 60));
    case "inside":
      return inside();
  }
}

const usualSend = (r: Rng): SendAim =>
  r.weighted<SendAim>([
    ["inside", 70],
    ["deadline", 6],
    ["late", 12],
    ["day_after", 4],
    ["blocked", 8],
  ]);

/* ── one candidate ────────────────────────────────────────────────────── */

const FLOOR_MARGINS = [2.3, 2.4, 2.55, 2.65, 2.8, 2.9, 3.05, 3.15].map(PCT);

/** One candidate; the caller keeps it only if it is in scope and fair to grade. */
export function drawArmCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): ArmTask {
  const edge = armEdgeOf(index);
  let product = edge === "standard" ? anyProduct(r) : fannie(r);
  let first = r.chance(0.4);
  let margin = r.chance(0.5) ? PCT(2.75) : eighthsBetween(r, PCT(2.25), PCT(3));
  let note = eighthsBetween(r, PCT(2.5), PCT(7.5));
  let prior: number | undefined;
  let io_until: PlainDate | null = null;
  let half_up = r.chance(0.15);
  let estimate = r.chance(0.3);
  let fdcpa: readonly [boolean, boolean] = r.chance(0.03) ? [true, r.chance(0.7)] : [false, false];
  let consummation: PlainDate | undefined;
  let missing = r.chance(0.15);
  let trap = r.chance(0.2);
  let send: SendAim = usualSend(r);
  // The unrounded rate the index is aimed at, given the loan: none leaves the index at a level.
  let aim: ((loan: ArmLoan, initial: boolean) => number) | null = null;
  let placed: Placement | null = null;

  const capOf = (initial: boolean) => (initial ? product.caps[0] : product.caps[1]);
  const lifeOf = () => note + product.caps[2];

  switch (edge) {
    case "standard":
      break;
    case "midpoint": {
      half_up = r.chance(0.5);
      note = eighthsBetween(r, margin + EIGHTH, PCT(7.5));
      const off = r.weighted<number>([
        [0, 60],
        [1, 20],
        [-1, 20],
      ]);
      aim = (loan, initial) => {
        // An eighth the caps leave alone, and the point halfway to the next.
        const p = units(loan.current_rate_pct);
        const reach = capOf(initial) - EIGHTH;
        const lo = Math.max(p - reach, margin + EIGHTH);
        const hi = Math.min(p + reach, lifeOf() - EIGHTH);
        return eighthsBetween(r, lo, hi) + EIGHTH / 2 + off;
      };
      break;
    }
    case "initial_cap":
    case "periodic_cap": {
      first = edge === "initial_cap";
      if (!first) product = r.chance(0.8) ? fannie(r) : cmt(r);
      const how = r.weighted<string>([
        ["above", 35],
        ["below", 20],
        ["equal_up", 12],
        ["equal_down", 8],
        ["mid_cap", 15],
        ["mid_cap_over", 10],
      ]);
      half_up = how.startsWith("mid_cap") ? r.chance(0.5) : half_up;
      const cap = first ? product.caps[0] : product.caps[1];
      // Room below for the floor and the index, above for the lifetime ceiling.
      if (how === "below" || how === "equal_down")
        note = eighthsBetween(r, margin + cap + 2 * EIGHTH, PCT(8));
      else note = eighthsBetween(r, PCT(2.5), PCT(6.5));
      if (!first) {
        const life = lifeOf();
        prior =
          how === "below" || how === "equal_down"
            ? eighthsBetween(r, Math.max(note - PCT(1), margin + cap + 2 * EIGHTH), note + PCT(2))
            : eighthsBetween(r, Math.max(margin, note - PCT(1)), life - cap - EIGHTH);
      }
      aim = (loan) => {
        const p = units(loan.current_rate_pct);
        switch (how) {
          case "above":
            return insideBand(r, p + cap + EIGHTH * r.int(1, 6));
          case "below":
            return insideBand(r, Math.max(p - cap - EIGHTH * r.int(1, 6), margin + EIGHTH));
          case "equal_up":
            return insideBand(r, p + cap);
          case "equal_down":
            return insideBand(r, p - cap);
          case "mid_cap":
            return p + cap + EIGHTH / 2;
          default:
            return p + cap + EIGHTH / 2 + 1;
        }
      };
      break;
    }
    case "lifetime_cap": {
      const tieAtFirst = r.chance(0.2);
      if (tieAtFirst) {
        // A 7/6 or 10/6 plan: the 5 % initial cap is the 5 % lifetime cap.
        product = { ...fannie(r), plan: r.pick(["4928", "4929"]) };
        product = {
          ...product,
          fixed: product.plan === "4928" ? 84 : 120,
          caps: [PCT(5), PCT(1), PCT(5)],
        };
        first = true;
      } else {
        product = r.chance(0.7) ? fannie(r) : cmt(r);
        first = false;
      }
      note = eighthsBetween(r, PCT(2.5), PCT(4.5));
      const life = lifeOf();
      const cap = first ? product.caps[0] : product.caps[1];
      const how = r.weighted<string>([
        ["over", 55],
        ["equal", 17],
        ["tie", 18],
        ["under", 10],
      ]);
      if (!first)
        prior =
          how === "tie" ? life - cap : life - EIGHTH * r.int(0, Math.max(0, cap / EIGHTH - 1));
      aim = () =>
        how === "over"
          ? insideBand(r, life + EIGHTH * r.int(1, 8))
          : how === "equal"
            ? insideBand(r, life)
            : how === "tie"
              ? insideBand(r, life + EIGHTH * r.int(1, 4))
              : insideBand(r, life - EIGHTH * r.int(1, 3));
      break;
    }
    case "floor": {
      const onGrid = r.chance(0.2);
      margin = onGrid ? PCT(2.75) : r.pick(FLOOR_MARGINS);
      const cap = first ? product.caps[0] : product.caps[1];
      // A rate near the margin: the cap reaches below it, so only the floor holds the rate up.
      note = eighthsBetween(r, Math.max(PCT(2), margin - PCT(0.5)), margin + cap - EIGHTH);
      if (!first)
        prior =
          r.chance(0.3) && !onGrid ? margin : eighthsBetween(r, margin, margin + cap - EIGHTH);
      // The eighth below the margin, reached by a small index; 0 on the grid lands on it exactly.
      aim = () => {
        const below = Math.floor(margin / EIGHTH) * EIGHTH;
        const room = below + EIGHTH / 2 - margin - 1;
        return onGrid ? margin : margin + r.int(0, Math.max(0, room));
      };
      break;
    }
    case "index_lookup":
      missing = true;
      trap = r.chance(0.7);
      break;
    case "interest_only": {
      product = {
        ...(r.chance(0.5) ? termSofr(r) : fannie(r)),
        plan: null,
        fixed: r.pick([60, 84, 120]),
      };
      const how = r.weighted<string>([
        ["through", 40],
        ["ends", 40],
        ["past", 20],
      ]);
      first = how === "past" ? false : r.chance(0.5);
      placed = first ? placeFirst(r, product) : placeLater(r, product);
      if (placed) {
        const { change_date, first_change_date } = placed;
        const periods = monthsBetween(first_change_date, change_date) / product.period;
        io_until =
          how === "through"
            ? addMonths(change_date, product.period * r.int(1, 4))
            : how === "ends"
              ? change_date
              : addMonths(first_change_date, product.period * r.int(0, Math.max(0, periods - 1)));
      }
      break;
    }
    case "legacy": {
      const how = r.weighted<string>([
        ["short_lookback", 35],
        ["boundary", 25],
        ["monthly", 25],
        ["lookback45", 15],
      ]);
      first = false;
      margin = eighthsBetween(r, PCT(2), PCT(2.875));
      note = eighthsBetween(r, PCT(3), PCT(7));
      if (how === "short_lookback") product = cmt(r, r.int(15, 44));
      if (how === "lookback45") product = cmt(r, 45);
      if (how === "monthly") product = monthly(r);
      if (how === "boundary") {
        product = cmt(r, r.chance(0.7) ? 44 : r.int(15, 43));
        consummation = r.pick([plainDate("2015-01-09"), plainDate("2015-01-10")]);
      }
      break;
    }
    case "initial_notice": {
      first = true;
      const how = r.weighted<string>([
        ["servicer", 20],
        ["originator", 40],
        ["first25", 25],
        ["short_term", 15],
      ]);
      if (how === "short_term") {
        product = {
          ...fannie(r),
          plan: null,
          period: r.pick([1, 6]),
          fixed: 6,
          term: 12,
        };
      } else if (how === "originator") {
        // The first payment at the new rate D days after closing: the closing, the first payment
        // and the first change all follow from D.
        const days = r.weighted<number>([
          [209, 25],
          [210, 30],
          [211, 25],
          [r.int(120, 240), 20],
        ]);
        const fnpd = addMonths(WINDOW_FROM, r.int(1, monthsBetween(WINDOW_FROM, WINDOW_TO)));
        const closed = addDays(fnpd, -days);
        const first_payment_due = firstPaymentAfter(closed);
        const fixed = monthsBetween(first_payment_due, fnpd);
        if (fixed >= 1) {
          product = { ...fannie(r), plan: null, period: r.pick([1, 6, 6]), fixed };
          const change_date = addMonths(fnpd, -1);
          placed = {
            consummation: closed,
            first_payment_due,
            first_change_date: change_date,
            change_date,
          };
        }
        estimate = r.chance(0.5);
      } else {
        // The first change X days after closing, after an estimate: within 60 days is c_first_25.
        const days = r.weighted<number>([
          [59, 20],
          [60, 25],
          [61, 25],
          [r.int(35, 90), 30],
        ]);
        const change_date = addMonths(WINDOW_FROM, r.int(0, monthsBetween(WINDOW_FROM, WINDOW_TO)));
        const closed = addDays(change_date, -days);
        const first_payment_due = firstPaymentAfter(closed);
        const fixed = monthsBetween(first_payment_due, change_date) + 1;
        if (fixed >= 1) {
          product = { ...fannie(r), plan: null, period: r.pick([1, 6, 6]), fixed };
          placed = {
            consummation: closed,
            first_payment_due,
            first_change_date: change_date,
            change_date,
          };
        }
        estimate = r.chance(0.85);
      }
      break;
    }
    case "send_window":
      if (r.chance(0.3)) {
        product = r.chance(0.5) ? cmt(r, r.int(15, 44)) : monthly(r);
        first = false;
      }
      send = r.weighted<SendAim>([
        ["open_eve", 18],
        ["blocked", 10],
        ["index_date", 18],
        ["deadline", 20],
        ["day_after", 20],
        ["late", 14],
      ]);
      break;
    case "no_change":
      if (r.chance(0.65)) {
        // A payment that moves a cent alone is Fannie Mae's notice, late after change − 25.
        send = r.pick<SendAim>(["deadline", "day_after", "late", "inside", "inside"]);
        // An index that rounds back to the current rate.
        aim = (loan) => insideBand(r, units(loan.current_rate_pct));
        note = eighthsBetween(r, margin + EIGHTH, PCT(7.5));
        if (!first)
          prior = eighthsBetween(r, Math.max(margin + EIGHTH, note - PCT(1)), note + PCT(1));
      } else {
        fdcpa = [true, r.chance(0.6)];
        if (r.chance(0.5)) send = r.pick(["late", "day_after", "deadline"]);
      }
      break;
  }

  placed ??= first
    ? placeFirst(r, product)
    : (placeLater(r, product, consummation) ?? placeFirst(r, product));
  // A later change's rate is where the changes before it left it.
  if (placed.change_date !== placed.first_change_date && prior === undefined)
    prior = eighthsBetween(
      r,
      Math.max(margin, note - PCT(1.5)),
      Math.min(note + product.caps[2], note + PCT(2.5)),
    );
  // A Fannie Mae notice in place of the Reg Z one is due at change − 25, which a look-back under 25
  // days could never meet: no cease on such a note, and a first change soon enough after closing to
  // be exempt looks back the standard 45 days.
  if (product.lookback < 25) fdcpa = [false, false];
  if (
    product.lookback < 25 &&
    placed.change_date === placed.first_change_date &&
    daysBetween(placed.consummation, addMonths(placed.change_date, 1)) <= 210
  )
    product = { ...product, lookback: 45 };
  const draft: Draft = {
    product,
    place: placed,
    margin,
    note,
    io_until,
    half_up,
    estimate,
    fdcpa,
    original: BigInt(r.int(80_000, 900_000)) * 100n,
  };
  if (prior !== undefined) draft.prior = Math.min(Math.max(prior, margin), note + product.caps[2]);
  const loan = loanOf(r, draft);
  const initial = placed.change_date === placed.first_change_date;
  const indexDate = addDays(placed.change_date, -product.lookback);

  // The print the note looks back to: aimed at an edge, or a level of the index.
  const unrounded = aim ? aim(loan, initial) : null;
  const value =
    unrounded !== null && unrounded - margin >= 0 ? unrounded - margin : r.int(PCT(0.3), PCT(5.5));
  const series = seriesAround(r, indexDate, { value, missing, trap });

  const task: ArmTask = {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    change_date: placed.change_date,
    loan,
    index_series: series,
    proposed_send_on: placed.change_date,
  };
  let x: ArmAnalysis;
  try {
    x = analyzeArm(task);
  } catch {
    return task;
  }
  return { ...task, proposed_send_on: sendFor(r, task, x, send) };
}

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
export function armFairToGrade(task: ArmTask): boolean {
  const payload = JSON.parse(JSON.stringify(armPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(armSteps, payload, executeArmTool);
  } catch {
    return false;
  }
  const parsed = parseArmSubmission(byRules);
  return parsed.ok && gradeArmAgainst(expectedArm(task), parsed.answer).pass;
}

const THREE = /^\d{1,2}\.\d{3}$/;
const FIVE = /^\d{1,2}\.\d{5}$/;

/**
 * v1's guard, run on the engine's own results: a change is kept only where
 * the engine does nothing its spec calls wrong, and nothing depends on a
 * figure the engine reads differently from how the task states it.
 *   - every rate has three decimals: the service compares the new rate with
 *     the current one as text (ops-7-2.ts:436), so "5.75" against "5.750"
 *     would be a rate change;
 *   - every index print has five decimals and none is negative: the two
 *     engines round a negative rate differently;
 *   - every date on the schedule falls on the 1st: a due day other than the
 *     change day counts one payment twice (expectedUpbAt and remainingTermAt
 *     read months without days), and the next change date is chained from
 *     this one (ops-7-2.ts:461) where the schedule steps from the first;
 *   - no two-month adjuster: the service classes one as adjusting every 60
 *     days or more often (ops-7-2.ts:192), and most two-month gaps are 61 or
 *     62 days;
 *   - the change is on the schedule, and an interest-only period ends with a
 *     change: the engine never recasts a payment between changes;
 *   - both engines agree (the spec's dual-calculation gate) and the balance
 *     and term left are positive;
 *   - no notice is proposed before the index date, unless it is a Reg Z
 *     notice proposed before its window opens (blocked, as engine and spec
 *     agree): the engine's send check passes one sent after the window opens,
 *     and the spec's sendable window starts at the index date (§7.2 rule 4),
 *     as the rate is not known before it;
 *   - a Fannie Mae notice sent in place of a suppressed Reg Z notice (both
 *     changed; an FDCPA cease or an exempt first change) is never proposed
 *     after change − 25: the engine never marks that one late (ops.ts:140,
 *     ops-7-2.ts:451), and its spec's 25 days apply to it.
 */
export function armInScope(task: ArmTask): boolean {
  const t = task.loan;
  const rates = [
    t.margin_pct,
    t.initial_cap_pct,
    t.periodic_cap_pct,
    t.lifetime_cap_pct,
    t.initial_note_rate_pct,
    t.current_rate_pct,
    t.schedule_basis.rate_pct,
  ];
  if (!rates.every((x) => THREE.test(x))) return false;
  if (!task.index_series.every((p) => FIVE.test(p.value))) return false;
  const firsts = [
    task.change_date,
    t.first_change_date,
    t.first_payment_due,
    t.schedule_basis.from_due_date,
  ];
  if (!firsts.every((d) => parts(d).d === 1)) return false;
  if (t.adjustment_period_months === 2) return false;
  const onSchedule = (d: PlainDate) =>
    d >= t.first_change_date &&
    monthsBetween(t.first_change_date, d) % t.adjustment_period_months === 0 &&
    parts(d).d === parts(t.first_change_date).d;
  if (!onSchedule(task.change_date)) return false;
  if (t.interest_only_until !== null && !onSchedule(t.interest_only_until)) return false;
  let x: ArmAnalysis;
  try {
    x = analyzeArm(task);
  } catch {
    return false;
  }
  if (x.b.agrees !== true || x.b.bound !== x.a.bound || x.b.unrounded_pct !== x.a.unrounded_pct)
    return false;
  if (x.input.expected_upb_cents <= 0n || x.input.remaining_term_months < 1) return false;
  const send = task.proposed_send_on;
  const blocked = x.send_outcome === "blocked";
  if (x.template !== null && send < x.index_date && !blocked) return false;
  if (x.regz_suppressed && send > addDays(task.change_date, -25)) return false;
  return true;
}

const ATTEMPTS = 40;

export function drawArmTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: ArmTask; attempts: number } {
  const id = armTaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const task = drawArmCandidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (armInScope(task) && armFairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no change fair to grade in ${ATTEMPTS} draws`);
}

export const generateArmTask = (split: Exclude<Split, "spec">, suiteSeed: number, index: number) =>
  drawArmTask(split, suiteSeed, index).task;

export function generateArmSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): ArmTask[] {
  return Array.from({ length: n }, (_, i) => generateArmTask(split, suiteSeed, i));
}

export const ARM_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's worked examples ───────────────────────────────────────── */

/** §7.2's Plan 4927 loan: 5.750 %, margin 2.750, $400,000.00 over 360 months, first payment 2021-12-01, first change 2026-11-01. */
const PLAN_4927: ArmLoan = {
  loan_id: "L-4927",
  fnma_arm_plan: "4927",
  index_type: "SOFR_30D_AVG",
  margin_pct: "2.750",
  lookback_days: 45,
  first_change_date: plainDate("2026-11-01"),
  adjustment_period_months: 6,
  initial_cap_pct: "2.000",
  periodic_cap_pct: "1.000",
  lifetime_cap_pct: "5.000",
  initial_note_rate_pct: "5.750",
  rounding_rule: "nearest_eighth_half_down",
  original_upb_cents: 40_000_000n,
  first_payment_due: plainDate("2021-12-01"),
  term_months: 360,
  consummation_date: plainDate("2021-10-15"),
  initial_disclosure_estimate: false,
  interest_only_until: null,
  escrow_cents: 61_250n,
  fdcpa_cease_on_file: false,
  fdcpa_debt_collector: false,
  current_rate_pct: "5.750",
  current_pi_cents: 233_429n,
  schedule_basis: {
    upb_cents: 40_000_000n,
    rate_pct: "5.750",
    pi_cents: 233_429n,
    from_due_date: plainDate("2021-12-01"),
  },
};

const prints = (...xs: [string, string][]): IndexPrint[] =>
  xs.map(([d, value]) => ({ effective_date: plainDate(d), value }));
/** The NY Fed prints the 7.2 tests capture around 2026-09-17. */
const SEPT = prints(
  ["2026-09-16", "3.64500"],
  ["2026-09-17", "3.64883"],
  ["2026-09-18", "3.65000"],
);

/**
 * §7.2's worked example and test cases on the Plan 4927 loan, as its tests
 * board it: the worked example sent inside its window (with §7.3's initial
 * notice on the same loan), no 2026-09-17 print (T1), the cap variant at
 * 5.10000 (T3), the midpoint 3.68750 under both rounding rules (T2), a send a
 * day late and one before the window opens (T5), the second change on
 * 2027-05-01 at 3.80000, the monthly legacy loan's 25-day deadline (T6), and
 * an FDCPA cease (T11).
 */
export function armSpecTasks(): ArmTask[] {
  const nov = plainDate("2026-11-01");
  const cases: Omit<ArmTask, "id" | "split" | "suite_seed" | "index">[] = [
    {
      change_date: nov,
      loan: PLAN_4927,
      index_series: SEPT,
      proposed_send_on: plainDate("2026-09-21"),
    },
    {
      change_date: nov,
      loan: PLAN_4927,
      index_series: SEPT.filter((p) => p.effective_date !== "2026-09-17"),
      proposed_send_on: plainDate("2026-09-21"),
    },
    {
      change_date: nov,
      loan: PLAN_4927,
      index_series: prints(["2026-09-17", "5.10000"]),
      proposed_send_on: plainDate("2026-09-21"),
    },
    {
      change_date: nov,
      loan: PLAN_4927,
      index_series: prints(["2026-09-17", "3.68750"]),
      proposed_send_on: plainDate("2026-09-21"),
    },
    {
      change_date: nov,
      loan: { ...PLAN_4927, rounding_rule: "nearest_eighth_half_up" },
      index_series: prints(["2026-09-17", "3.68750"]),
      proposed_send_on: plainDate("2026-09-21"),
    },
    {
      change_date: nov,
      loan: PLAN_4927,
      index_series: SEPT,
      proposed_send_on: plainDate("2026-10-03"),
    },
    {
      change_date: nov,
      loan: PLAN_4927,
      index_series: SEPT,
      proposed_send_on: plainDate("2026-08-02"),
    },
    {
      change_date: plainDate("2027-05-01"),
      loan: {
        ...PLAN_4927,
        current_rate_pct: "6.375",
        current_pi_cents: 247_644n,
        schedule_basis: {
          upb_cents: 37_104_886n,
          rate_pct: "6.375",
          pi_cents: 247_644n,
          from_due_date: plainDate("2026-12-01"),
        },
      },
      index_series: prints(["2027-03-17", "3.80000"]),
      proposed_send_on: plainDate("2027-03-22"),
    },
    {
      change_date: nov,
      loan: {
        ...PLAN_4927,
        fnma_arm_plan: null,
        index_type: "CMT_1Y",
        adjustment_period_months: 1,
        consummation_date: plainDate("2004-10-15"),
        first_payment_due: plainDate("2004-12-01"),
        schedule_basis: {
          upb_cents: 37_104_886n,
          rate_pct: "5.750",
          pi_cents: 233_429n,
          from_due_date: nov,
        },
      },
      index_series: prints(["2026-09-17", "3.70000"]),
      proposed_send_on: plainDate("2026-10-20"),
    },
    {
      change_date: nov,
      loan: { ...PLAN_4927, fdcpa_cease_on_file: true, fdcpa_debt_collector: true },
      index_series: SEPT,
      proposed_send_on: plainDate("2026-09-21"),
    },
  ];
  return cases.map((c, index) => ({
    id: `${ARM_ENVIRONMENT_NAME}/${ARM_ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec",
    suite_seed: 0,
    index,
    ...c,
  }));
}
