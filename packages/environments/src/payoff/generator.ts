/**
 * Synthetic loans and their payoffs, seeded: no borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). A loan is a Fannie
 * Mae note due on the 1st, with a balance, a rate, its last paid
 * installment and the components a payoff carries; a written request
 * arrives between January 2026 and November 2028, a statement is issued
 * within a few business days and is good through a date at most thirty-one
 * days after the request (the cap the servicing app's ops layer puts on a
 * good-through, ops-16-1.ts:215-220); the borrower's wire then arrives on a
 * business day. Then the task is aimed, in turn by index, at one edge of the payoff:
 *   - first_of_month: a good-through on the 1st, a full month and no
 *     partial days (or no interest at all on the loan's own due date);
 *   - end_of_month: a good-through on the last day of a month, and late
 *     funds that cross into the next one;
 *   - daily_simple: daily simple interest, its statement across a month end;
 *   - leap_day: a payoff in February and March 2028, across February 29;
 *   - nib_and_fees: deferred and forborne principal, late charges, fees,
 *     advances, the recording fee and MI, and the two credits, in and out;
 *   - early_funds: funds a day before the good-through, and more;
 *   - late_funds: funds a day after it, and more, a day's interest either
 *     side of the $50.00 tolerance;
 *   - tolerance: funds at the exact figure, $0.01 and $50.00 short (kept),
 *     $50.01 short (demanded) and $1.01 over (refunded);
 *   - reliance: more than $50.00 short in Florida or Texas within the
 *     good-through, in California within it, in any of the three on the
 *     good-through itself (absorbed), and after it or in a state that relies
 *     on nothing (demanded);
 *   - deemed_date: an installment due on a weekend or holiday, the funds the
 *     next business day (deemed received on the due date) or the one after;
 *     or due on a business day, the funds the next;
 *   - deadline_holiday: a request received in the days before a federal
 *     holiday, or on one, or on a weekend, against each state's clock, with
 *     Connecticut's payoff date before its floor and Massachusetts' statement
 *     good past thirty days;
 *   - alternative: the next installment due inside the window, on the
 *     statement date, on the good-through date, and after it;
 *   - remittance: an S/S payoff on the month's first Fannie Mae business day,
 *     where the 1st is one and where it is not, in an MBS pool reported on
 *     the first, second or third business day, and a portfolio loan's.
 * Where an edge has cases every suite must hold, it takes them in turn by
 * the edge's own count, so the held-out suite carries each: tolerance's five
 * thresholds, reliance's five, remittance's five, the state clocks' two and
 * deemed_date's four.
 *
 * What v1 leaves out is in docs/environments.md. `payoffInScope` runs on the
 * engine's own figures and keeps a payoff only when the engine does nothing
 * in it that its spec calls wrong. A payoff is then kept only once the
 * reference, working through the tools, lands exactly where the engine
 * does; the tests hold both to zero misses on unfiltered draws.
 */

import {
  addBusinessDays,
  addDays,
  addMonths,
  dayOfWeek,
  daysBetween,
  endOfMonth,
  federalHolidays,
  parts,
  plainDate,
  servicer,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";
import {
  Decimal,
  divRound,
  levelPayment,
  monthlyInterest,
  ratePercent,
  type Cents,
} from "@hm/kernel/money";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import {
  analyzePayoff,
  componentsOf,
  expectedPayoff,
  gradePayoffAgainst,
  parsePayoffSubmission,
} from "./grader.js";
import { deemedPayoffDate, interest, quote, type Accrual } from "./ported/quote.js";
import type { RemittanceType } from "./ported/types.js";
import { payoffSteps } from "./reference.js";
import {
  PAYOFF_ENVIRONMENT_NAME,
  PAYOFF_ENVIRONMENT_VERSION,
  payoffPayload,
  type PayoffLoan,
  type PayoffTask,
} from "./task.js";
import { executePayoffTool } from "./tools.js";

export const payoffTaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${PAYOFF_ENVIRONMENT_NAME}/${PAYOFF_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const PAYOFF_EDGES = [
  "first_of_month",
  "end_of_month",
  "daily_simple",
  "leap_day",
  "nib_and_fees",
  "early_funds",
  "late_funds",
  "tolerance",
  "reliance",
  "deemed_date",
  "deadline_holiday",
  "alternative",
  "remittance",
] as const;
export type PayoffEdge = (typeof PAYOFF_EDGES)[number];
export const payoffEdgeOf = (index: number): PayoffEdge =>
  PAYOFF_EDGES[index % PAYOFF_EDGES.length]!;

const RULE_STATES = ["CA", "FL", "NY", "NC", "MA", "TX", "CT"] as const;
const STATES: readonly (readonly [string, number])[] = [
  ...RULE_STATES.map((s) => [s, 9] as const),
  ["OH", 12],
  ["PA", 6],
  ["GA", 6],
  ["AZ", 6],
];

const FIRST_REQUEST = plainDate("2026-01-05");
const LAST_REQUEST = plainDate("2028-11-20");
const REQUEST_SPAN = daysBetween(FIRST_REQUEST, LAST_REQUEST);
const isBd = (d: PlainDate) => servicer.isBusinessDay(d);
const firstOf = (d: PlainDate): PlainDate => {
  const { y, m } = parts(d);
  return ymd(y, m, 1);
};
const cents = (r: Rng, loDollars: number, hiDollars: number): Cents =>
  BigInt(r.int(loDollars, hiDollars)) * 100n + BigInt(r.int(0, 99));
const maybe = (r: Rng, p: number, lo: number, hi: number): Cents =>
  r.chance(p) ? cents(r, lo, hi) : 0n;

/** Every 1st in range that is not a servicer business day (a weekend, or New Year's Day). */
const NON_BUSINESS_FIRSTS: readonly PlainDate[] = (() => {
  const out: PlainDate[] = [];
  for (let d = plainDate("2026-02-01"); d <= plainDate("2028-12-01"); d = addMonths(d, 1))
    if (!isBd(d)) out.push(d);
  return out;
})();
/** Every 1st in range that is a business day: the month's first Fannie Mae business day itself. */
const BUSINESS_FIRSTS: readonly PlainDate[] = (() => {
  const out: PlainDate[] = [];
  for (let d = plainDate("2026-02-01"); d <= plainDate("2028-12-01"); d = addMonths(d, 1))
    if (isBd(d)) out.push(d);
  return out;
})();
/** The federal holidays as observed on a weekday, 2026 to 2028. */
const HOLIDAYS: readonly PlainDate[] = [2026, 2027, 2028]
  .flatMap((y) => federalHolidays(y).map((h) => h.observed))
  .filter((d) => d >= FIRST_REQUEST && d <= LAST_REQUEST)
  .sort();

/** A loan's balance, rates and remittance type, drawn before anything is computed from them. */
interface Money {
  upb_cents: Cents;
  rate_pct: string;
  /**
   * The pass-through rate: the note rate less the servicing fee, and on an
   * MBS loan less the guaranty fee too.
   */
  ptr: (mbs: boolean) => string;
  type: RemittanceType;
  term: number;
}

/**
 * The rate stack, in thousandths of a percent. The servicing fee is inside
 * Fannie Mae's band for a fixed-rate loan, 0.25 % to 0.50 % (Servicing Guide
 * F-2-09, quoted in spec 29.1); an MBS loan also pays the guaranty fee out of
 * the note rate (spec 5.2's rate stack, `ptr = note_rate − servicing_fee −
 * gfee`), and its worked S/S loan's is 0.25 %.
 */
const SERVICING_FEES: readonly (readonly [number, number])[] = [
  [250, 70],
  [375, 12],
  [500, 10],
  [300, 8],
];
const GUARANTY_FEES: readonly number[] = [250, 300, 375, 450, 500];

function moneyOf(r: Rng, type: RemittanceType): Money {
  const rate_pct = r.chance(0.85)
    ? (r.int(2.5 * 8, 8 * 8) / 8).toFixed(3)
    : (r.int(2_500, 8_000) / 1000).toFixed(3);
  const fee = r.weighted<number>(SERVICING_FEES);
  const gfee = r.pick(GUARANTY_FEES);
  const ptr = (mbs: boolean) =>
    ((Math.round(Number(rate_pct) * 1000) - fee - (mbs ? gfee : 0)) / 1000).toFixed(3);
  let upb_cents = cents(r, 50_000, 850_000);
  if (type === "SA") {
    // S/A is half a month at PTR. The engine rounds the month and then the half; the spec rounds
    // once (÷24). v1 draws only balances where the two agree.
    const once = (u: Cents) =>
      divRound(u * Decimal.parse(ptr(false)).unscaled, 2400n * Decimal.ONE.unscaled);
    while (divRound(monthlyInterest(upb_cents, ratePercent(ptr(false))), 2n) !== once(upb_cents))
      upb_cents += 1n;
  }
  return { upb_cents, rate_pct, ptr, type, term: r.int(120, 350) };
}

/**
 * What else the payoff carries. Most loans carry a recording fee and an
 * escrow balance and little more; the nib_and_fees edge draws each line
 * more often than not, so every one is in some payoffs and out of others.
 */
function componentsFor(
  r: Rng,
  m: Money,
  heavy: boolean,
): Omit<PayoffLoan, "upb_cents" | "rate_pct" | "accrual_method" | "lpi_due"> {
  const pi = levelPayment(m.upb_cents, ratePercent(m.rate_pct), m.term);
  const often = (p: number) => (heavy ? 0.6 : p);
  // A negative escrow balance is advanced; an account carrying one has no balance to refund.
  const escrowAdvance = maybe(r, often(0.08), 100, 3_000);
  return {
    nib_deferred_cents: maybe(r, heavy ? 0.7 : 0.1, 2_000, 40_000),
    nib_forborne_cents: maybe(r, heavy ? 0.5 : 0.06, 1_000, 60_000),
    // One or two months' charges at the note's 3 to 5 % of P&I.
    late_charges_cents: r.chance(often(0.25))
      ? divRound(pi * BigInt(r.pick([3, 4, 5])), 100n) * BigInt(r.int(1, 2))
      : 0n,
    fees_cents: maybe(r, often(0.1), 15, 300),
    corporate_advances_cents: maybe(r, often(0.08), 50, 2_500),
    escrow_advance_cents: escrowAdvance,
    recording_fee_cents: maybe(r, often(0.45), 15, 150),
    mi_premium_cents: maybe(r, often(0.1), 30, 250),
    buydown_credit_cents: maybe(r, heavy ? 0.5 : 0.05, 100, 5_000),
    suspense_credit_cents: maybe(r, heavy ? 0.5 : 0.08, 5, 1_500),
    escrow_balance_cents: escrowAdvance > 0n ? 0n : maybe(r, 0.8, 200, 6_000),
  };
}

/** A written request some days before the good-through date, and the statement a few business days after it. */
function requestBefore(
  r: Rng,
  gt: PlainDate,
  lead: number,
): { received: PlainDate; issued: PlainDate } {
  let received = addDays(gt, -Math.min(31, Math.max(0, lead)));
  let k = r.weighted<number>([
    [0, 25],
    [1, 45],
    [2, 20],
    [3, 10],
  ]);
  if (k === 0 && !isBd(received)) k = 1;
  let issued = k === 0 ? received : addBusinessDays(received, k, servicer);
  // The statement is issued on a business day, on or before the good-through: the last one there
  // is, or, when the request and the good-through share a weekend, the business day before them.
  if (issued > gt) issued = bdOnOrBefore(gt);
  if (issued < received) received = issued;
  return { received, issued };
}

/** The latest business day on or before a date, and the earliest on or after one. */
const bdOnOrBefore = (d: PlainDate) => (isBd(d) ? d : addBusinessDays(d, -1, servicer));
const bdOnOrAfter = (d: PlainDate) => (isBd(d) ? d : addBusinessDays(d, 1, servicer));

/** One candidate; the caller keeps it only if it is in scope and fair to grade. */
export function drawPayoffCandidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): PayoffTask {
  const edge = payoffEdgeOf(index);
  // How many times this edge has come round before. An edge with cases every suite must hold takes
  // them in turn by it, so even the held-out suite's fifteen or sixteen of an edge carry each.
  const turn = Math.floor(index / PAYOFF_EDGES.length);
  let state = r.weighted(STATES);
  let type: RemittanceType = r.weighted<RemittanceType>([
    ["AA", 40],
    ["SA", 25],
    ["SS", 35],
  ]);
  if (edge === "remittance") type = "SS";
  const method: Accrual =
    edge === "daily_simple"
      ? "daily_simple_365"
      : edge === "leap_day"
        ? r.chance(0.45)
          ? "daily_simple_365"
          : "monthly_30_360_partial_365"
        : edge === "deemed_date" ||
            edge === "alternative" ||
            edge === "remittance" ||
            edge === "reliance"
          ? "monthly_30_360_partial_365"
          : r.chance(0.12)
            ? "daily_simple_365"
            : "monthly_30_360_partial_365";
  const money = moneyOf(r, type);
  const dsi = () => method === "daily_simple_365";

  // ── the dates: the good-through and the request, the last paid installment, the funds' day ──
  let gt: PlainDate = FIRST_REQUEST;
  let received: PlainDate = FIRST_REQUEST;
  let issued: PlainDate = FIRST_REQUEST;
  let back = r.chance(0.55) ? 1 : 0;
  let fundsTarget: PlainDate | null = null;
  // An S/S payoff on the month's first Fannie Mae business day: in a pool or not, and reported
  // 0, 1 or 2 business days after it.
  let onBd1: { mbs: boolean; lag: number } | null = null;

  const anyGoodThrough = () => addDays(FIRST_REQUEST, r.int(20, REQUEST_SPAN + 20));
  const lead = () =>
    r.weighted<number>([
      [r.int(1, 9), 20],
      [r.int(10, 22), 55],
      [r.int(23, 31), 25],
    ]);
  /** The good-through, and a request `l` days before it. */
  const fromGoodThrough = (g: PlainDate, l = lead()) => {
    gt = g;
    ({ received, issued } = requestBefore(r, g, l));
  };
  /** A good-through `g`, and a request received on `from`. */
  const requestedFrom = (from: PlainDate, g: PlainDate) => fromGoodThrough(g, daysBetween(from, g));

  switch (edge) {
    case "first_of_month": {
      fromGoodThrough(firstOf(addMonths(anyGoodThrough(), 1)));
      back = r.chance(0.8) ? 1 : 0;
      break;
    }
    case "end_of_month": {
      fromGoodThrough(endOfMonth(anyGoodThrough()));
      if (r.chance(0.35)) {
        // Late into the next month: paid through the good-through's month, so the funds stay
        // within the month after it.
        fundsTarget = addDays(gt, r.int(1, 4));
        back = 0;
      }
      break;
    }
    case "daily_simple": {
      // Across a month end: last paid in month M, good through early in M+1, the funds still in M.
      const first = firstOf(addMonths(anyGoodThrough(), 1));
      if (r.chance(0.7)) {
        const g = addDays(first, r.int(0, 12));
        requestedFrom(addDays(first, -r.int(8, 30 - daysBetween(first, g))), g);
        back = 1;
        fundsTarget = addDays(first, -r.int(1, 6));
      } else {
        fromGoodThrough(addDays(first, r.int(0, 25)));
        back = 0;
      }
      break;
    }
    case "leap_day": {
      const g = r.pick([
        plainDate("2028-02-29"),
        plainDate("2028-03-01"),
        addDays(plainDate("2028-02-20"), r.int(0, 25)),
      ]);
      fundsTarget = addDays(g, r.pick([-3, -1, 0, 0, 1, 2]));
      if (dsi()) {
        // Daily simple across February 29: last paid February 1, the funds before March.
        back = g >= plainDate("2028-03-01") ? 1 : 0;
        if (back === 1) fundsTarget = addDays(plainDate("2028-02-29"), -r.int(0, 6));
        requestedFrom(addDays(plainDate("2028-02-01"), r.int(0, 10)), g);
      } else {
        fromGoodThrough(g, r.int(12, 30));
      }
      break;
    }
    case "deemed_date": {
      // The installment after the last paid one falls due on a weekend or New Year's Day; by turn,
      // the funds arrive the next business day (deemed received on the due date, two turns in
      // four) or the one after; or the due date is a business day and the funds arrive the next,
      // which the rule does not reach.
      const sub = turn % 4;
      const due = r.pick(sub === 3 ? BUSINESS_FIRSTS : NON_BUSINESS_FIRSTS);
      fundsTarget = addBusinessDays(due, sub === 2 ? 2 : 1, servicer);
      // Never deemed back across the good-through: it is before the due date or on or after the funds.
      const before = r.chance(0.5);
      const g = before ? addDays(due, -r.int(1, 10)) : addDays(fundsTarget, r.int(0, 12));
      requestedFrom(addDays(due, -r.int(8, 18)), g);
      back = before ? 0 : 1;
      break;
    }
    case "deadline_holiday": {
      const h = r.pick(HOLIDAYS);
      received = addDays(
        h,
        -r.weighted<number>([
          [0, 15],
          [r.int(1, 4), 45],
          [r.int(5, 9), 40],
        ]),
      );
      // Or on the weekend before the holiday.
      if (r.chance(0.2)) received = addDays(h, -(dayOfWeek(h) + r.int(0, 1)));
      state = r.weighted<string>([
        ["FL", 30],
        ["NC", 15],
        ["MA", 15],
        ["TX", 10],
        ["CT", 10],
        ["CA", 5],
        ["NY", 5],
        ["OH", 10],
      ]);
      // One turn in five, Connecticut with a payoff date before its seven-business-day floor;
      // and one, Massachusetts issued the day the request arrives and good through the
      // thirty-first day after it, the one way a good-through outlasts thirty days from issue.
      const sub = turn % 5;
      if (sub === 3) state = "CT";
      if (sub === 4) {
        state = "MA";
        received = bdOnOrBefore(received);
      }
      let k = sub === 4 ? 0 : r.int(0, 3);
      if (k === 0 && !isBd(received)) k = 1;
      issued = k === 0 ? received : addBusinessDays(received, k, servicer);
      const room = 31 - daysBetween(received, issued);
      if (sub === 3) {
        const floor = addDays(addBusinessDays(received, 7, servicer), -1);
        const g = addDays(issued, r.int(1, 6));
        gt = g < floor ? g : floor;
      } else if (sub === 4) {
        gt = addDays(received, 31);
      } else {
        gt = addDays(issued, state === "CT" && r.chance(0.5) ? r.int(1, 10) : r.int(1, room));
      }
      break;
    }
    case "alternative": {
      // The last paid installment is the 1st of M, so the next falls due on the 1st of M+1.
      const due = firstOf(addMonths(anyGoodThrough(), 1));
      const where = r.weighted<string>([
        ["inside", 45],
        ["on_issue", 20],
        ["on_good_through", 20],
        ["after", 15],
      ]);
      back = 1;
      if (where === "inside") {
        requestedFrom(addDays(due, -r.int(8, 12)), addDays(due, r.int(1, 18)));
      } else if (where === "on_issue") {
        // Issued on the due date itself: a 1st that is a business day. February and March 2026
        // both begin on a Sunday, so one month on is not always enough.
        let first = due;
        while (!isBd(first)) first = addMonths(first, 1);
        gt = addDays(first, r.int(3, 20));
        received = addDays(first, -r.int(0, 3));
        issued = first;
      } else if (where === "on_good_through") {
        fromGoodThrough(due);
      } else {
        fromGoodThrough(addDays(due, -r.int(1, 12)));
        back = 0;
      }
      break;
    }
    case "remittance": {
      // An S/S payoff on the month's first Fannie Mae business day. By turn: in an MBS pool where
      // the 1st is not a business day, reported on the second business day; a portfolio loan,
      // which owes the month whenever it is reported; in a pool where the 1st is not a business
      // day, reported on the first; in a pool where the 1st is one, reported on it or the next;
      // and in a pool, reported on the third. (A/A and S/A shares come from every other edge.)
      const sub = turn % 5;
      const onFirst = sub === 3 || ((sub === 1 || sub === 4) && r.chance(0.5));
      const bd1 = onFirst
        ? r.pick(BUSINESS_FIRSTS)
        : addBusinessDays(r.pick(NON_BUSINESS_FIRSTS), 1, servicer);
      fundsTarget = bd1;
      onBd1 = {
        mbs: sub !== 1,
        lag: sub === 0 ? 1 : sub === 2 ? 0 : sub === 4 ? 2 : r.int(0, 1),
      };
      requestedFrom(addDays(bd1, -r.int(9, 20)), addDays(bd1, r.int(0, 6)));
      // An installment due on a 1st that is not a business day would deem these funds received on
      // it, which takes the payoff off the first business day: that loan is paid through the
      // payoff's own month instead.
      back = onFirst && r.chance(0.6) ? 1 : 0;
      break;
    }
    case "early_funds": {
      // A day early: the good-through follows a business day.
      let g = anyGoodThrough();
      while (!isBd(addDays(g, -1))) g = addDays(g, 1);
      fromGoodThrough(g, r.int(16, 30));
      back = 1;
      fundsTarget = r.chance(0.55) ? addDays(gt, -1) : addDays(gt, -r.int(2, 12));
      break;
    }
    case "late_funds": {
      let g = anyGoodThrough();
      while (!isBd(addDays(g, 1))) g = addDays(g, 1);
      fromGoodThrough(g);
      back = 0;
      fundsTarget = r.chance(0.55) ? addDays(gt, 1) : addDays(gt, r.int(2, 12));
      break;
    }
    case "reliance": {
      // By turn, more than $50.00 short: in Florida or Texas before the good-through, in
      // California before it, in any of the three on the good-through itself, in a state that
      // relies on nothing before it, and in any of the three after it.
      const sub = turn % 5;
      state =
        sub === 0
          ? r.pick(["FL", "TX"])
          : sub === 1
            ? "CA"
            : sub === 3
              ? r.pick(["OH", "NY", "MA", "NC", "CT", "PA", "GA", "AZ"])
              : r.pick(["FL", "TX", "CA"]);
      let g = anyGoodThrough();
      // On the good-through: a business day past the 4th, which no due date's deeming reaches.
      if (sub === 2) while (!isBd(g) || parts(g).d < 5) g = addDays(g, 1);
      const within = sub !== 4;
      fromGoodThrough(g, within ? r.int(12, 30) : lead());
      back = within ? 1 : 0;
      fundsTarget =
        sub === 2 ? g : within ? bdOnOrBefore(addDays(g, -r.int(1, 8))) : addDays(g, r.int(1, 10));
      break;
    }
    default:
      fromGoodThrough(anyGoodThrough());
  }

  // The last paid installment: the 1st of the good-through's month, or of the month before.
  let lpi = addMonths(firstOf(gt), -back);
  // Daily simple interest is paid off in its last paid installment's month (where the share's
  // 30/360 walk is the statement's day count), so that month must still be open when the
  // statement is issued.
  if (dsi() && back === 1 && issued > endOfMonth(lpi)) {
    back = 0;
    lpi = firstOf(gt);
  }
  // The funds arrive after the statement and no earlier than the last paid installment, within the
  // month after it (daily simple: within its own month).
  const lo = issued > lpi ? issued : lpi;
  const hi = endOfMonth(addMonths(lpi, dsi() ? 0 : 1));

  // The funds' day: aimed by the edge, otherwise around the good-through.
  let target =
    fundsTarget ??
    r.weighted<PlainDate>([
      [gt, 40],
      [addDays(gt, -r.int(1, 10)), 30],
      [addDays(gt, r.int(1, 10)), 30],
    ]);
  if (target < lo) target = lo;
  if (target > hi) target = hi;
  let fundsOn = isBd(target)
    ? target
    : bdOnOrAfter(target) <= hi
      ? bdOnOrAfter(target)
      : bdOnOrBefore(target);
  if (fundsOn < lo) fundsOn = bdOnOrAfter(lo);
  // No business day after the floor before the window closes: the last business day it has.
  if (fundsOn > hi) fundsOn = bdOnOrBefore(hi);
  const installmentDue = addMonths(lpi, 1);
  // Never deemed back across the good-through.
  const deemed = deemedPayoffDate(fundsOn, installmentDue);
  if (deemed <= gt && gt < fundsOn) fundsOn = addBusinessDays(fundsOn, 1, servicer);

  // ── the loan ──
  const heavy = edge === "nib_and_fees";
  const loan: PayoffLoan = {
    upb_cents: money.upb_cents,
    rate_pct: money.rate_pct,
    accrual_method: method,
    lpi_due: lpi,
    ...componentsFor(r, money, heavy),
  };
  const nextPrincipal =
    levelPayment(money.upb_cents, ratePercent(money.rate_pct), money.term) -
    monthlyInterest(money.upb_cents, ratePercent(money.rate_pct));
  // 16.1 rule 7: an installment falling due after the statement date and by the good-through is
  // printed beside the statement, so the statement carries it. One outside that window changes
  // no figure, and the statement may carry it or not.
  const inWindow = installmentDue > issued && installmentDue <= gt;
  const next_installment =
    edge === "alternative" || inWindow || r.chance(0.7)
      ? { due_on: installmentDue, principal_cents: nextPrincipal, autodraft: r.chance(0.35) }
      : null;
  const mbsDrawn = type === "SS" && (onBd1 ? onBd1.mbs : r.chance(0.6));

  const base: PayoffTask = {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    request: { received_on: received, state, issued_on: issued, good_through: gt },
    loan,
    next_installment,
    funds: { received_on: fundsOn, amount_cents: 0n, installment_due_on: installmentDue },
    investor: {
      remittance_type: type,
      ptr_pct: money.ptr(mbsDrawn),
      mbs_pool: mbsDrawn,
      reported_on: fundsOn,
    },
  };

  // ── the amount wired, against the statement and the exact figure ──
  const statement = quote(componentsOf(base, gt)).total_cents;
  const payoffOn = deemedPayoffDate(fundsOn, installmentDue);
  const exact = quote(componentsOf(base, payoffOn)).total_cents;
  let amount: Cents;
  switch (edge) {
    case "tolerance":
      // By turn, on each threshold: exact, a cent short and $50.00 short (kept), $50.01 short
      // (demanded) and $1.01 over (refunded). The figures between come from every other edge.
      amount = exact + ([0n, -1n, -5_000n, -5_001n, 101n] as const)[turn % 5]!;
      break;
    case "reliance":
      amount = exact - BigInt(r.int(5_001, 60_000));
      break;
    case "early_funds":
    case "late_funds":
      amount = statement;
      break;
    default:
      amount = r.weighted<Cents>([
        [statement, 60],
        [exact, 15],
        [statement + BigInt(r.int(-3_000, 20_000)), 25],
      ]);
  }
  // A variance of $0.01 to $1.00 over is where the engine's two layers disagree: never drawn.
  if (amount - exact >= 1n && amount - exact <= 100n) amount += 100n;

  // ── Fannie Mae's terms: reported the day the payoff is processed or a business day or two after ──
  const reportLag = onBd1 ? onBd1.lag : r.int(isBd(payoffOn) ? 0 : 1, 2);
  let mbs = base.investor.mbs_pool;
  // An S/S MBS payoff deemed received on its due date: which day it was processed is in doubt.
  if (type === "SS" && mbs && payoffOn !== fundsOn) mbs = false;
  return {
    ...base,
    funds: { ...base.funds, amount_cents: amount },
    investor: {
      ...base.investor,
      ptr_pct: money.ptr(mbs),
      mbs_pool: mbs,
      reported_on: addBusinessDays(payoffOn, reportLag, servicer),
    },
  };
}

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
export function payoffFairToGrade(task: PayoffTask): boolean {
  const payload = JSON.parse(JSON.stringify(payoffPayload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(payoffSteps, payload, executePayoffTool);
  } catch {
    return false;
  }
  const parsed = parsePayoffSubmission(byRules);
  return parsed.ok && gradePayoffAgainst(expectedPayoff(task), parsed.answer).pass;
}

const sOnce = (upb: Cents, ptr: string) =>
  divRound(upb * Decimal.parse(ptr).unscaled, 2400n * Decimal.ONE.unscaled, "HALF_UP");

/**
 * v1's guard, run on the engine's own figures: a payoff is kept only when the
 * engine does nothing in it that its spec calls wrong, and nothing depends on
 * a convention v1 does not settle.
 *   - D1/D2: the loan is due on the 1st, and no day count (the statement's,
 *     the exact figure's, or the 30/360 walk Fannie Mae's share takes) reaches
 *     two full months, where the engine rounds each month and the spec rounds
 *     the block once;
 *   - D3: the next installment is the one after the last paid one, so the
 *     alternative figure never skips arrears;
 *   - the share's collected interest is the exact figure's: on a daily-simple
 *     loan the share takes the 30/360 walk instead, and the A/A fee would be
 *     wrong;
 *   - D6: an S/A half month rounded twice equals one rounded once;
 *   - D9: no variance from $0.01 to $1.00 over, which the two layers dispose
 *     of differently;
 *   - no loan paid ahead of its payoff, which the engine accrues as negative
 *     interest;
 *   - no S/S MBS payoff deemed received on a non-business due date, whose
 *     processing day is in doubt; and no payoff deemed back across the
 *     good-through, where "within good-through" is in doubt;
 *   - the request, the statement and the funds in order: the statement on
 *     a business day on or after the request and good through a date on or
 *     after it, the funds on a business day on or after the statement, the
 *     report on or after the payoff. (How far ahead a good-through may be
 *     is the ops layer's policy, not the engine's: the generator keeps it
 *     within thirty-one days of the request, and the spec's own examples
 *     run to 38.)
 */
export function payoffInScope(task: PayoffTask): boolean {
  const a = analyzePayoff(task);
  const { request: rq, loan: l, funds: f, investor: inv } = task;
  if (parts(l.lpi_due).d !== 1) return false;
  if (l.lpi_due > rq.good_through || l.lpi_due > a.payoff_on) return false;
  if (a.statement.interest.months_full > 1 || a.exact.interest.months_full > 1) return false;
  if (interest(l.upb_cents, l.rate_pct, l.lpi_due, a.payoff_on).months_full > 1) return false;
  if (f.installment_due_on !== addMonths(l.lpi_due, 1)) return false;
  if (task.next_installment && task.next_installment.due_on !== f.installment_due_on) return false;
  if (a.share.collected_interest_cents !== a.exact.interest.total_cents) return false;
  if (inv.remittance_type === "SA" && a.share.interest_cents !== sOnce(l.upb_cents, inv.ptr_pct))
    return false;
  const v = a.reconciled.variance_cents;
  if (v >= 1n && v <= 100n) return false;
  if (inv.remittance_type === "SS" && inv.mbs_pool && a.payoff_on !== f.received_on) return false;
  if (a.payoff_on <= rq.good_through && rq.good_through < f.received_on) return false;
  if (rq.issued_on < rq.received_on || rq.good_through < rq.issued_on) return false;
  if (!isBd(rq.issued_on)) return false;
  if (!isBd(f.received_on) || f.received_on < rq.issued_on) return false;
  if (inv.reported_on < a.payoff_on || f.amount_cents <= 0n) return false;
  return true;
}

const ATTEMPTS = 40;

export function drawPayoffTask(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: PayoffTask; attempts: number } {
  const id = payoffTaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const task = drawPayoffCandidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (payoffInScope(task) && payoffFairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no payoff fair to grade in ${ATTEMPTS} draws`);
}

export const generatePayoffTask = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
) => drawPayoffTask(split, suiteSeed, index).task;

export function generatePayoffSuite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): PayoffTask[] {
  return Array.from({ length: n }, (_, i) => generatePayoffTask(split, suiteSeed, i));
}

export const PAYOFF_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's worked examples ─────────────────────────────────────────── */

const NONE = {
  nib_deferred_cents: 0n,
  nib_forborne_cents: 0n,
  late_charges_cents: 0n,
  fees_cents: 0n,
  corporate_advances_cents: 0n,
  escrow_advance_cents: 0n,
  recording_fee_cents: 0n,
  mi_premium_cents: 0n,
  buydown_credit_cents: 0n,
  suspense_credit_cents: 0n,
  escrow_balance_cents: 0n,
};
const d = plainDate;

/** §16.1 example A: Ohio, $248,310.55 at 6.500 %, LPI 09/01, a late charge and the recording fee. */
const EXAMPLE_A: PayoffLoan = {
  ...NONE,
  upb_cents: 24_831_055n,
  rate_pct: "6.500",
  accrual_method: "monthly_30_360_partial_365",
  lpi_due: d("2026-09-01"),
  late_charges_cents: 8_217n,
  recording_fee_cents: 3_400n,
  escrow_balance_cents: 241_290n,
};
/** §16.2's worked loan: $199,500.00 at 6.250 %, PTR 6.000 %, LPI 09/01, paid off 10/16. */
const WORKED_16_2: PayoffLoan = {
  ...NONE,
  upb_cents: 19_950_000n,
  rate_pct: "6.250",
  accrual_method: "monthly_30_360_partial_365",
  lpi_due: d("2026-09-01"),
  escrow_balance_cents: 241_290n,
};
/** §7.6's Texas loan: $371,048.86 at 6.375 % from the November 1 change date, LPI 11/01. */
const TEXAS_7_6: PayoffLoan = {
  ...NONE,
  upb_cents: 37_104_886n,
  rate_pct: "6.375",
  accrual_method: "monthly_30_360_partial_365",
  lpi_due: d("2026-11-01"),
  escrow_balance_cents: 183_000n,
};

type SpecCase = Omit<PayoffTask, "id" | "split" | "suite_seed" | "index">;
const aa = (ptr: string, reported: string) => ({
  remittance_type: "AA" as const,
  ptr_pct: ptr,
  mbs_pool: false,
  reported_on: d(reported),
});

/**
 * The spec's worked examples, as tasks:
 *   0. §16.1 A, the funds early on 10/09 (spec: $353.76, over $265.32);
 *   1. §16.1 A, the statement amount late on 10/20 (16.1-T2's $221.10 short
 *      is the per-diem instruction; the exact shortage is $221.09, 16.2 rule 2);
 *   2. §16.1 B, deferred principal, paid on the good-through (16.1-T6, 16.2-T8);
 *   3. §16.2's A/A worked example (16.2-T1), 4. its S/A variant (16.2-T3),
 *   5. its S/S variant in an MBS pool (16.2-T2), 6. the S/S MBS payoff
 *      processed on Mon 11/02 (BD1) and reported 11/03 (16.2-T2), on a loan
 *      whose November installment is paid;
 *   7. §7.6's Texas statement (7.6-T1, 7.6-T8), 8. the same in Florida (7.6-T3);
 *   9. 16.1-T7, Massachusetts; 10. 16.1-T11, Connecticut five business days ahead;
 *   11. 16.2-T4, $30.00 short; 12. 16.2-T5, Florida, short within the good-through;
 *   13. 16.1-T3, the Sunday 11/01 due date and Monday's funds;
 *   14. 16.1-T4, example A on daily simple interest, paid in September.
 * Where the spec gives no request date, state, PTR or funds, these are chosen
 * to stand beside its figures: the statement's own figure paid on its
 * good-through, a 25-basis-point servicing fee, a request two weeks before.
 */
export function payoffSpecTasks(): PayoffTask[] {
  const reqA = {
    received_on: d("2026-09-14"),
    state: "OH",
    issued_on: d("2026-09-15"),
    good_through: d("2026-10-15"),
  };
  const reqW = {
    received_on: d("2026-10-01"),
    state: "OH",
    issued_on: d("2026-10-02"),
    good_through: d("2026-10-16"),
  };
  const fundsW = {
    received_on: d("2026-10-16"),
    amount_cents: 20_105_147n,
    installment_due_on: d("2026-10-01"),
  };
  const reqTx = {
    received_on: d("2026-10-13"),
    state: "TX",
    issued_on: d("2026-10-15"),
    good_through: d("2026-11-20"),
  };
  const fundsTx = {
    received_on: d("2026-11-20"),
    amount_cents: 37_228_018n,
    installment_due_on: d("2026-12-01"),
  };
  const cases: SpecCase[] = [
    {
      request: reqA,
      loan: EXAMPLE_A,
      next_installment: null,
      funds: {
        received_on: d("2026-10-09"),
        amount_cents: 25_039_082n,
        installment_due_on: d("2026-10-01"),
      },
      investor: aa("6.250", "2026-10-12"),
    },
    {
      request: reqA,
      loan: EXAMPLE_A,
      next_installment: null,
      funds: {
        received_on: d("2026-10-20"),
        amount_cents: 25_039_082n,
        installment_due_on: d("2026-10-01"),
      },
      investor: aa("6.250", "2026-10-21"),
    },
    {
      request: {
        received_on: d("2026-11-02"),
        state: "OH",
        issued_on: d("2026-11-03"),
        good_through: d("2026-11-20"),
      },
      loan: {
        ...NONE,
        upb_cents: 18_000_000n,
        rate_pct: "5.000",
        accrual_method: "monthly_30_360_partial_365",
        lpi_due: d("2026-11-01"),
        nib_deferred_cents: 1_200_000n,
      },
      next_installment: null,
      funds: {
        received_on: d("2026-11-20"),
        amount_cents: 19_246_849n,
        installment_due_on: d("2026-12-01"),
      },
      investor: aa("4.750", "2026-11-23"),
    },
    {
      request: reqW,
      loan: WORKED_16_2,
      next_installment: null,
      funds: fundsW,
      investor: aa("6.000", "2026-10-19"),
    },
    {
      request: reqW,
      loan: WORKED_16_2,
      next_installment: null,
      funds: fundsW,
      investor: {
        remittance_type: "SA",
        ptr_pct: "6.000",
        mbs_pool: false,
        reported_on: d("2026-10-19"),
      },
    },
    {
      request: reqW,
      loan: WORKED_16_2,
      next_installment: null,
      funds: fundsW,
      investor: {
        remittance_type: "SS",
        ptr_pct: "6.000",
        mbs_pool: true,
        reported_on: d("2026-10-19"),
      },
    },
    {
      request: {
        received_on: d("2026-10-26"),
        state: "OH",
        issued_on: d("2026-10-27"),
        good_through: d("2026-11-02"),
      },
      loan: { ...WORKED_16_2, lpi_due: d("2026-11-01") },
      next_installment: null,
      funds: {
        received_on: d("2026-11-02"),
        amount_cents: 19_953_416n,
        installment_due_on: d("2026-12-01"),
      },
      investor: {
        remittance_type: "SS",
        ptr_pct: "6.000",
        mbs_pool: true,
        reported_on: d("2026-11-03"),
      },
    },
    {
      request: reqTx,
      loan: TEXAS_7_6,
      next_installment: null,
      funds: fundsTx,
      investor: aa("6.125", "2026-11-23"),
    },
    {
      request: { ...reqTx, state: "FL" },
      loan: TEXAS_7_6,
      next_installment: null,
      funds: fundsTx,
      investor: aa("6.125", "2026-11-23"),
    },
    {
      request: {
        received_on: d("2026-09-14"),
        state: "MA",
        issued_on: d("2026-09-14"),
        good_through: d("2026-10-01"),
      },
      loan: EXAMPLE_A,
      next_installment: null,
      funds: {
        received_on: d("2026-10-01"),
        amount_cents: 24_977_174n,
        installment_due_on: d("2026-10-01"),
      },
      investor: aa("6.250", "2026-10-02"),
    },
    {
      request: {
        received_on: d("2026-09-14"),
        state: "CT",
        issued_on: d("2026-09-15"),
        good_through: d("2026-09-21"),
      },
      loan: EXAMPLE_A,
      next_installment: null,
      funds: {
        received_on: d("2026-09-21"),
        amount_cents: 24_931_111n,
        installment_due_on: d("2026-10-01"),
      },
      investor: aa("6.250", "2026-09-22"),
    },
    {
      request: reqW,
      loan: WORKED_16_2,
      next_installment: null,
      funds: { ...fundsW, amount_cents: 20_102_147n },
      investor: aa("6.000", "2026-10-19"),
    },
    {
      request: { ...reqA, state: "FL" },
      loan: EXAMPLE_A,
      next_installment: null,
      funds: {
        received_on: d("2026-10-15"),
        amount_cents: 25_039_082n - 22_110n,
        installment_due_on: d("2026-10-01"),
      },
      investor: aa("6.250", "2026-10-16"),
    },
    {
      request: {
        received_on: d("2026-10-19"),
        state: "OH",
        issued_on: d("2026-10-20"),
        good_through: d("2026-11-02"),
      },
      loan: { ...EXAMPLE_A, lpi_due: d("2026-10-01") },
      next_installment: null,
      funds: {
        received_on: d("2026-11-02"),
        amount_cents: 24_981_596n,
        installment_due_on: d("2026-11-01"),
      },
      investor: aa("6.250", "2026-11-02"),
    },
    {
      request: reqA,
      loan: { ...EXAMPLE_A, accrual_method: "daily_simple_365" },
      next_installment: null,
      funds: {
        received_on: d("2026-09-30"),
        amount_cents: 25_037_239n,
        installment_due_on: d("2026-10-01"),
      },
      investor: aa("6.250", "2026-09-30"),
    },
  ];
  return cases.map((c, index) => ({
    id: `${PAYOFF_ENVIRONMENT_NAME}/${PAYOFF_ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec",
    suite_seed: 0,
    index,
    ...c,
  }));
}
