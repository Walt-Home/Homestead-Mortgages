/**
 * Synthetic loans and their months of credit reporting, seeded: no
 * borrower's data, ever.
 *
 * Each task is a function of (split, suite seed, index). A loan is a
 * monthly fixed-rate note due on the 1st, with a P&I, an escrow payment and
 * a history: paid on time up to a point, then whatever the edge asks for.
 * The ledger lists its installments from a few months before the first
 * month to one after the last, and every receipt from the first listed
 * installment on; the books at each month-end are what that history makes
 * them (the balance after the installments paid, the term left), changed
 * only by a workout. The last record before the window is the engine's own,
 * run from the ledger's start, as we furnished it, or a prior servicer's
 * hand-off (sometimes with a short PHP), or none. Then the window is aimed,
 * in turn by index, at one edge of the furnishing:
 *   - buckets: a borrower who stops paying, pays one installment a month two
 *     or three behind, or pays part of one, walking the month-ends across
 *     29/30, 59/60 (February 2028 included), 89/90, 119/120 and 149/150 days,
 *     sometimes into a foreclosure referral;
 *   - dofd: the date of first delinquency set, kept through a partial
 *     catch-up that leaves 30 days or more, and reset by a cure and a new
 *     delinquency;
 *   - pool: a part payment waiting in the pool, completed after the
 *     month-end, a prepayment, a double payment, an overpayment that builds
 *     up, and an installment paid in two halves;
 *   - forbearance: entered current, at 1 to 29 days, or at 30 to 149, under
 *     the freeze and under contractual aging, with payments suspended or
 *     reduced, ending with the window, a reinstatement, or a payment
 *     deferral (spec 8.1-T4 and T5);
 *   - repayment_plan: a plan that repays the arrears in two to four months,
 *     and one paying less than the installment (AC), with and without a
 *     foreclosure referral;
 *   - trial: a trial plan (AC, aging), with or without a referral, then a
 *     modification or a failed trial;
 *   - workout: a modification or a payment deferral from delinquency, with
 *     forborne principal or none (K4), and with a referral (BO);
 *   - foreclosure: a referral, then a foreclosure sale (at 179 or 180 days
 *     every other time) or a deed in lieu (on each side of 59/60 through
 *     149/150 in turn), with and without a deficiency, rated at the closing
 *     date, or the referral alone;
 *   - closing: a payoff current at its date, a payoff of a delinquent loan
 *     (by refinance or not), a short sale with no foreclosure started (13)
 *     and one after a referral (65), in turn, each rated at the closing date
 *     on each side of a bucket's edge, in turn;
 *   - boarding: a prior servicer's hand-off, its PHP full or short, and a
 *     loan boarded with no history (24 B's);
 *   - identifiers: a month whose MIN or Fannie Mae number is missing or
 *     malformed, omitted, and D in the next month's PHP;
 *   - consumers: joint borrowers at the same and another address, a
 *     guarantor, a released borrower (T, H), a deceased one (X), one never
 *     liable (Z), and a successor who is not furnished.
 * Every task also draws the policy (truncate or round, original or remaining
 * terms, the freeze or contractual aging) and sometimes an installment
 * ending in 50 or 49 cents, which rounding turns on.
 *
 * What v1 leaves out is in docs/environments.md. `metro2InScope` runs on
 * the engine's own outputs and keeps a window only when the engine does
 * nothing in it that its spec calls wrong; the generator aims around every
 * one, so it is a guard rather than a filter. A window is then kept only
 * once the reference, working through the tools, lands exactly where the
 * engine does; the tests hold both to zero misses on unfiltered draws.
 */

import {
  addDays,
  addMonths,
  daysBetween,
  endOfMonth,
  parts,
  plainDate,
  type PlainDate,
} from "@hm/kernel/calendar";
import { levelPayment, ratePercent, type Cents } from "@hm/kernel/money";
import { balanceAfter } from "@hm/refi-review";
import { rngFor, type Rng } from "../rng.js";
import { solveNow } from "../refi/reference.js";
import type { Split } from "../refi/task.js";
import { applyFifo } from "../pmi/ported/delinquency.js";
import { deriveDelinquency } from "./ported/metro2.js";
import type { CreditConsumer, CreditPolicy } from "./ported/types.js";
import {
  asOfOf,
  expectedMetro2,
  furnish,
  gradeMetro2Against,
  ledgerAsOf,
  parseMetro2Submission,
} from "./grader.js";
import { metro2Steps } from "./reference.js";
import {
  CLOSINGS,
  METRO2_ENVIRONMENT_NAME,
  METRO2_ENVIRONMENT_VERSION,
  metro2Payload,
  type InForce,
  type LastRecord,
  type Metro2Month,
  type Metro2Task,
  type MonthBooks,
} from "./task.js";
import { executeMetro2Tool } from "./tools.js";

export const metro2TaskId = (split: Split, suiteSeed: number, index: number): string =>
  `${METRO2_ENVIRONMENT_NAME}/${METRO2_ENVIRONMENT_VERSION}/${split}/${suiteSeed}/${index}`;

export const METRO2_EDGES = [
  "buckets",
  "dofd",
  "pool",
  "forbearance",
  "repayment_plan",
  "trial",
  "workout",
  "foreclosure",
  "closing",
  "boarding",
  "identifiers",
  "consumers",
] as const;
export type Metro2Edge = (typeof METRO2_EDGES)[number];
export const metro2EdgeOf = (index: number): Metro2Edge =>
  METRO2_EDGES[index % METRO2_EDGES.length]!;

/**
 * The days past due a closing is aimed at: each side of every bucket's edge but the first (a
 * closing at 29 days with an installment unpaid is out of scope) and the last, which the
 * foreclosure sales take. A short sale after a referral (made past 120 days) takes its own.
 */
const CLOSING_EDGES = [59, 60, 89, 90, 119, 120, 149, 150];
const REFERRED_EDGES = [149, 150, 179, 180];

const FIRST_WINDOW = plainDate("2026-02-01");
const dollars = (r: Rng, lo: number, hi: number): Cents =>
  BigInt(r.int(lo, hi)) * 100n + BigInt(r.int(0, 99));
const eighths = (r: Rng, lo: number, hi: number) => (r.int(lo * 8, hi * 8) / 8).toFixed(3);
const digits = (r: Rng, n: number) => Array.from({ length: n }, () => String(r.int(0, 9))).join("");
const firstOf = (d: PlainDate) => plainDate(`${d.slice(0, 7)}-01`);
const monthsFrom = (a: PlainDate, b: PlainDate) => {
  const x = parts(a);
  const y = parts(b);
  return (y.y - x.y) * 12 + (y.m - x.m);
};

interface Receipt {
  received_on: PlainDate;
  amount_cents: Cents;
}

/** What a script builds: the history, the window and what is in force, by month index (0 = the first month). */
interface Script {
  W0: PlainDate;
  K: number;
  /** The ledger lists installments from month −h. */
  h: number;
  receipts: Receipt[];
  cond: Map<number, InForce>;
  referral: PlainDate | null;
  /** A workout's books, by month index. */
  books: Map<number, (base: MonthBooks) => MonthBooks>;
  /** Malformed identifiers, by month index. */
  ids: Map<number, { fnma_loan_number?: string; min?: string | null }>;
  last: "us" | "prior_servicer" | "none";
  /** A prior servicer's PHP length. */
  handoffLength: number;
  consumers: CreditConsumer[];
  policy: CreditPolicy;
}

interface Loan {
  orig: Cents;
  rate: string;
  term: number;
  pi: Cents;
  escrow: Cents;
  P: Cents;
}

function loanOf(r: Rng): Loan {
  const term = r.weighted<number>([
    [360, 85],
    [300, 4],
    [240, 4],
    [180, 7],
  ]);
  const rate = r.chance(0.85) ? eighths(r, 2.75, 7.75) : (r.int(2_750, 7_750) / 1000).toFixed(3);
  const orig = BigInt(r.int(600, 8_500)) * 10_000n + (r.chance(0.2) ? dollars(r, 0, 9_999) : 0n);
  const pi = levelPayment(orig, ratePercent(rate), term);
  let escrow = dollars(r, 150, 1_400);
  // An installment ending in 50 or 49 cents: where rounding half up turns, or does not.
  const ending = r.weighted<number | null>([
    [null, 75],
    [50, 15],
    [49, 10],
  ]);
  if (ending !== null) escrow = escrow - ((pi + escrow) % 100n) + BigInt(ending);
  return { orig, rate, term, pi, escrow, P: pi + escrow };
}

const singleOrJoint = (r: Rng): CreditConsumer[] =>
  r.chance(0.7)
    ? [{ party_id: "C1", position: 1, same_address_as_base: true, liability: "individual" }]
    : [
        { party_id: "C1", position: 1, same_address_as_base: true, liability: "joint" },
        {
          party_id: "C2",
          position: 2,
          same_address_as_base: r.chance(0.7),
          liability: "joint",
        },
      ];

/** Consumers with the flags each segment rule turns on. */
function manyConsumers(r: Rng): CreditConsumer[] {
  const n = r.int(2, 4);
  const out: CreditConsumer[] = [];
  for (let p = 1; p <= n; p++) {
    const flags: Partial<CreditConsumer> = {};
    // Released after an assumption: the assuming party is the base, so never position 1.
    if (p > 1 && r.chance(0.25)) Object.assign(flags, { released: true });
    if (r.chance(0.16)) Object.assign(flags, { deceased: true });
    if (r.chance(0.12)) Object.assign(flags, { never_liable: true });
    if (p > 1 && r.chance(0.16)) Object.assign(flags, { successor_in_interest: true });
    out.push({
      party_id: `C${p}`,
      position: p,
      same_address_as_base: p === 1 || r.chance(0.55),
      liability: p > 1 && r.chance(0.15) ? "guarantor" : "joint",
      ...flags,
    });
  }
  // A base consumer and at least one other furnished.
  return out.some((c, k) => k > 0 && !c.successor_in_interest)
    ? out
    : out.map((c, k) => (k === 1 ? { ...c, successor_in_interest: false } : c));
}

function policyOf(r: Rng): CreditPolicy {
  return {
    metro2_rounding: r.chance(0.35) ? "round" : "truncate",
    forbearance_status: r.chance(0.6) ? "freeze" : "contractual_aging",
    terms_duration: r.chance(0.3) ? "remaining" : "original",
  };
}

/** The building blocks a script uses, over one loan and one window start. */
class Builder {
  readonly s: Script;
  constructor(
    readonly r: Rng,
    readonly loan: Loan,
    W0: PlainDate,
    /** Installments from the note's first to the ledger's first, all paid on time. */
    readonly age: number,
    /** The edge's own count: how many windows of this edge came before, for the arms taken in turn. */
    readonly turn: number,
  ) {
    this.s = {
      W0,
      K: 3,
      h: 3,
      receipts: [],
      cond: new Map(),
      referral: null,
      books: new Map(),
      ids: new Map(),
      last: "us",
      handoffLength: 24,
      consumers: singleOrJoint(r),
      policy: policyOf(r),
    };
  }
  due = (t: number) => addMonths(this.s.W0, t);
  eom = (t: number) => endOfMonth(this.due(t));
  /** The d-th day of month t, never past its end. */
  on = (t: number, d: number) => {
    const e = this.eom(t);
    const x = addDays(this.due(t), d - 1);
    return x > e ? e : x;
  };
  pay = (on: PlainDate, amount: Cents) =>
    this.s.receipts.push({ received_on: on, amount_cents: amount });
  /** Each installment from..to paid on time, early in its own month. */
  onTime(from: number, to: number) {
    for (let t = from; t <= to; t++) this.pay(this.on(t, this.r.int(1, 10)), this.loan.P);
  }
  /** One installment a month, at any day of it. */
  oneAMonth(from: number, to: number) {
    for (let t = from; t <= to; t++) this.pay(this.on(t, this.r.int(1, 26)), this.loan.P);
  }
  /** The installments listed, from month −h to one after the window. */
  installments() {
    const out: { due_date: PlainDate; amount_cents: Cents }[] = [];
    for (let t = -this.s.h; t <= this.s.K; t++)
      out.push({ due_date: this.due(t), amount_cents: this.loan.P });
    return out;
  }
  /** The ledger's unpaid installments at a date, over the receipts so far. */
  unpaidAt(on: PlainDate): number {
    const applied = applyFifo(
      this.installments(),
      this.s.receipts.filter((x) => x.received_on <= on),
    ).installments;
    return applied.filter(
      (i) => i.due_date <= on && (i.satisfied_on === null || i.satisfied_on > on),
    ).length;
  }
  firstDue = () => addMonths(this.s.W0, -(this.s.h + this.age));
  /** The note's balance after every installment satisfied by a date. */
  upbAt(on: PlainDate): Cents {
    const applied = applyFifo(
      this.installments(),
      this.s.receipts.filter((x) => x.received_on <= on),
    ).installments;
    const n = applied.filter((i) => i.satisfied_on !== null && i.satisfied_on <= on).length;
    return balanceAfter(this.loan.orig, this.loan.rate, this.loan.pi, this.age + n);
  }
  poolAt(on: PlainDate): Cents {
    return applyFifo(
      this.installments(),
      this.s.receipts.filter((x) => x.received_on <= on),
    ).unapplied_cents;
  }
  inForce(from: number, to: number, e: InForce) {
    for (let t = from; t <= to; t++) this.s.cond.set(t, e);
  }
  /** The window and its history: K months, the ledger from month −h (never fewer than 3 months back). */
  span(K: number, h: number) {
    this.s.K = Math.max(3, Math.min(6, K));
    this.s.h = Math.max(3, h);
  }
  /** A referral at E + 121 to E + `upTo` days, the earliest Regulation X allows past 120. */
  refer(E: PlainDate, upTo: number) {
    this.s.referral = addDays(E, this.r.int(121, Math.max(121, upTo)));
  }
  /** A month's index from its date. */
  indexOf = (d: PlainDate) => monthsFrom(this.s.W0, d);
}

/** A modification's terms off the loan's state: capitalized arrears, sometimes forborne principal, 480 months. */
function modTerms(
  b: Builder,
  upb: Cents,
  unpaid: number,
): { newUpb: Cents; forborne: Cents; term: number; newPiti: Cents } {
  const { r, loan } = b;
  const capitalized = (BigInt(unpaid) * loan.P * 85n) / 100n;
  const gross = upb + capitalized;
  const term = r.weighted<number>([
    [480, 75],
    [360, 25],
  ]);
  let forborne = r.chance(0.5) ? 0n : (gross * BigInt(r.int(5, 30))) / 100n;
  let rate = Number(loan.rate);
  let newPiti = 0n;
  // Lowered until the modified payment is below the old one, as a Flex Modification's is.
  for (let i = 0; i < 12; i++) {
    newPiti = levelPayment(gross - forborne, ratePercent(rate.toFixed(3)), term) + loan.escrow;
    if (newPiti < loan.P) break;
    if (rate > 2.5) rate -= 0.5;
    else forborne = (gross * 30n) / 100n;
  }
  if (newPiti >= loan.P) newPiti = loan.P - 100n;
  return { newUpb: gross - forborne, forborne, term, newPiti };
}

/* ── the edges ─────────────────────────────────────────────────────────── */

function buckets(b: Builder) {
  const { r } = b;
  const K = r.int(3, 6);
  // February 2028 makes 59 days at a month-end possible: Jan-1 at Feb-29, or Feb-1 at Mar-31.
  if (r.chance(0.2)) {
    const missed = plainDate(r.chance(0.5) ? "2028-01-01" : "2028-02-01");
    b.s.W0 = addMonths(missed, -r.int(0, 1));
    const s = b.indexOf(missed);
    b.span(K, -s + r.int(1, 3));
    b.onTime(-b.s.h, s - 1);
    return;
  }
  const s = r.int(-3, 1);
  b.span(K, -s + r.int(1, 3));
  b.onTime(-b.s.h, s - 1);
  const pattern = r.weighted<string>([
    ["stop", 55],
    ["rolling", 25],
    ["partial", 20],
  ]);
  if (pattern === "rolling") {
    // Two or three behind, then one a month: never down to one unpaid, which would blank the DOFD.
    const behind = r.int(2, 3);
    b.oneAMonth(s + behind, b.s.K - 1);
  } else if (pattern === "partial") {
    // Nothing the first month, then part payments that wait in the pool.
    for (let t = s + 1; t < b.s.K; t++)
      if (r.chance(0.7)) b.pay(b.on(t, r.int(1, 26)), (b.loan.P * BigInt(r.int(30, 80))) / 100n);
  } else if (r.chance(0.4)) {
    const upTo = daysBetween(b.due(s), b.eom(b.s.K - 1));
    if (upTo >= 121) b.refer(b.due(s), Math.min(upTo, 170));
  }
}

function dofd(b: Builder) {
  const { r } = b;
  const variant = r.pick(["set", "kept", "reset"]);
  if (variant === "set") {
    b.span(r.int(4, 6), r.int(3, 6));
    const s = r.int(0, b.s.K - 2);
    b.onTime(-b.s.h, s - 1);
    return;
  }
  if (variant === "kept") {
    // Behind three or more, a catch-up at month j that leaves two or more unpaid: the first DOFD stays.
    const s = r.int(-4, -2);
    b.span(r.int(4, 6), -s + r.int(1, 3));
    b.onTime(-b.s.h, s - 1);
    const j = r.int(0, b.s.K - 2);
    const unpaid = j - s + 1;
    const c = r.int(1, Math.max(1, unpaid - 2));
    b.pay(b.on(j, r.int(2, 26)), b.loan.P * BigInt(c));
    if (r.chance(0.5)) b.oneAMonth(j + 1, b.s.K - 1);
    return;
  }
  // Reset: two or more behind (a DOFD furnished), cured in full at month j, then a new delinquency.
  const s = r.int(-3, -2);
  b.span(r.int(4, 6), -s + r.int(1, 3));
  b.onTime(-b.s.h, s - 1);
  // Cured from the second month on, so the window shows the first DOFD, the cure and the new one.
  const j = r.int(1, b.s.K - 3);
  b.pay(b.on(j, r.int(2, 26)), b.loan.P * BigInt(j - s + 1));
  const again = r.int(j + 1, b.s.K - 2);
  b.onTime(j + 1, again - 1);
}

function pool(b: Builder) {
  const { r, loan } = b;
  const P = loan.P;
  b.span(r.int(3, 6), r.int(3, 5));
  const K = b.s.K;
  const variant = r.weighted<string>([
    ["completed_later", 30],
    ["prepaid", 20],
    ["double", 20],
    ["overpaid", 15],
    ["halves", 15],
  ]);
  if (variant === "completed_later") {
    // Part of month j's installment, the rest with month j+1's after the month-end: j's month-end counts it unpaid.
    const j = r.int(0, K - 2);
    b.onTime(-b.s.h, j - 1);
    const part = (P * BigInt(r.int(30, 80))) / 100n;
    b.pay(b.on(j, r.int(3, 20)), part);
    b.pay(b.on(j + 1, r.chance(0.5) ? r.int(1, 5) : r.int(6, 25)), P - part + P);
    b.onTime(j + 2, K - 1);
  } else if (variant === "prepaid") {
    const j = r.int(-1, K - 2);
    b.onTime(-b.s.h, j - 1);
    b.pay(b.on(j, r.int(1, 15)), P * 2n);
    b.onTime(j + 2, K - 1);
  } else if (variant === "double") {
    const j = r.int(0, K - 2);
    b.onTime(-b.s.h, j - 1);
    b.pay(b.on(j + 1, r.int(1, 25)), P * 2n);
    b.onTime(j + 2, K - 1);
  } else if (variant === "overpaid") {
    const from = r.int(-3, 0);
    b.onTime(-b.s.h, from - 1);
    const extra = (P * BigInt(r.int(5, 25))) / 100n;
    for (let t = from; t < K; t++) b.pay(b.on(t, r.int(1, 10)), P + extra);
  } else {
    const from = r.int(-2, 0);
    b.onTime(-b.s.h, from - 1);
    for (let t = from; t < K; t++) {
      const half = (P * BigInt(r.int(35, 65))) / 100n;
      b.pay(b.on(t, r.int(1, 8)), half);
      b.pay(b.on(t, r.int(9, 25)), P - half);
    }
  }
}

function forbearance(b: Builder) {
  const { r, loan } = b;
  b.s.policy = {
    ...b.s.policy,
    forbearance_status: r.chance(0.55) ? "freeze" : "contractual_aging",
  };
  const entryBehind = r.weighted<number>([
    [0, 15],
    [1, 20],
    [2, 25],
    [3, 25],
    [4, 15],
  ]);
  const end = r.weighted<string>([
    ["window", 40],
    ["reinstated", 25],
    ["deferral", 35],
  ]);
  const j = r.int(-2, 1);
  let d = r.int(3, 6);
  let K: number;
  if (end === "window") {
    if (j + d < 3) d = 3 - j;
    K = r.int(3, Math.min(6, j + d));
  } else {
    // The month after the plan: reinstated (and current after), or deferred as the last month.
    if (j + d + 1 < 3) d = 3 - j - 1;
    if (j + d + 1 > 6) d = Math.max(3, 6 - j - 1);
    K = end === "deferral" ? j + d + 1 : r.int(j + d + 1, 6);
  }
  const s = j - entryBehind;
  b.span(K, Math.max(-s, -j) + r.int(1, 2));
  b.onTime(-b.s.h, s - 1);
  // Reduced payments under half the installment: from the plan's second month the loan is two or more
  // behind, never back to one, which would blank the DOFD in a short month.
  const plan: InForce = {
    kind: "forbearance_plan",
    effective_on: b.due(j),
    plan_payment_cents: r.chance(0.6) ? 0n : (loan.P * BigInt(r.int(25, 45))) / 100n,
  };
  if (plan.plan_payment_cents > 0n)
    for (let t = j; t < j + d; t++) b.pay(b.on(t, r.int(1, 20)), plan.plan_payment_cents);
  b.inForce(j, Math.min(j + d - 1, b.s.K - 1), plan);
  if (end === "window") return;
  const e = j + d;
  if (end === "reinstated") {
    // Every installment due by then, less what waits in the pool: nothing unpaid at the month-end.
    const on = b.on(e, r.int(3, 20));
    const due = b.unpaidAt(on);
    b.pay(on, loan.P * BigInt(due) - b.poolAt(on));
    b.onTime(e + 1, b.s.K - 1);
    return;
  }
  if (r.chance(0.7)) b.pay(b.on(e, r.int(2, 10)), loan.P);
  const completed = b.on(e, r.int(11, 27));
  const deferred = BigInt(b.unpaidAt(completed)) * loan.P;
  b.s.cond.set(e, { kind: "payment_deferral", completed_on: completed });
  b.s.books.set(e, (base) => ({ ...base, deferred_principal_cents: deferred }));
}

function repaymentPlan(b: Builder) {
  const { r, loan } = b;
  const P = loan.P;
  const referred = r.chance(0.25);
  const ac = r.chance(0.25);
  const k = referred ? r.int(5, 6) : r.int(2, 4);
  const j = r.int(-1, 1);
  const s = j - k;
  b.span(r.int(3, 6), -s + r.int(1, 2));
  b.onTime(-b.s.h, s - 1);
  if (referred) b.refer(b.due(s), daysBetween(b.due(s), b.eom(j - 1)));
  const A0 = P * BigInt(k);
  if (ac) {
    // Less than the installment: a partial payment agreement, the arrears growing.
    const pay = (P * BigInt(r.int(50, 95))) / 100n;
    let arrears = A0;
    for (let t = j; t < b.s.K; t++) {
      b.pay(b.on(t, r.int(1, 20)), pay);
      arrears += P - pay;
      b.s.cond.set(t, {
        kind: "repayment_plan",
        plan_payment_cents: pay,
        remaining_arrears_cents: arrears,
      });
    }
    return;
  }
  // The arrears in N months, N from half the installments behind to all of them: two installments or more a month.
  const N = r.int(Math.ceil(k / 2), k);
  const share = (A0 + BigInt(N) - 1n) / BigInt(N);
  const pay = P + share;
  let arrears = A0;
  for (let t = j; t < j + N; t++) {
    b.pay(b.on(t, r.int(1, 20)), pay);
    arrears = arrears > share ? arrears - share : 0n;
    if (arrears > 0n)
      b.s.cond.set(t, {
        kind: "repayment_plan",
        plan_payment_cents: pay,
        remaining_arrears_cents: arrears,
      });
  }
  b.onTime(j + N, b.s.K - 1);
}

function trial(b: Builder) {
  const { r } = b;
  const referred = r.chance(0.35);
  const k = referred ? r.int(5, 6) : r.int(2, 6);
  const modified = r.chance(0.6);
  const j = r.int(-1, 1);
  const K = modified ? j + 4 : r.int(Math.max(3, j + 1), 6);
  const s = j - k;
  b.span(K, -s + r.int(1, 2));
  b.onTime(-b.s.h, s - 1);
  if (referred) b.refer(b.due(s), daysBetween(b.due(s), b.eom(j - 1)));
  // The trial payment is the modification's payment, set when the trial is offered.
  const before = b.eom(j - 1);
  const terms = modTerms(b, b.upbAt(before), b.unpaidAt(before));
  const plan: InForce = { kind: "trial_plan", trial_payment_cents: terms.newPiti };
  for (let t = j; t <= j + 2; t++) b.pay(b.on(t, r.int(1, 25)), terms.newPiti);
  b.inForce(j, Math.min(j + 2, b.s.K - 1), plan);
  if (!modified) return;
  const m = j + 3;
  modify(b, m, terms);
}

/** The modification effective on month m's 1st, its first payment made in that month. */
function modify(
  b: Builder,
  m: number,
  terms: { newUpb: Cents; forborne: Cents; term: number; newPiti: Cents },
) {
  b.pay(b.on(m, b.r.int(1, 12)), terms.newPiti);
  b.s.cond.set(m, {
    kind: "modification",
    effective_on: b.due(m),
    new_term_months: terms.term,
    new_piti_cents: terms.newPiti,
  });
  b.s.books.set(m, (base) => ({
    ...base,
    upb_cents: terms.newUpb,
    forborne_principal_cents: terms.forborne,
    remaining_term_months: terms.term,
    maturity_date: addMonths(b.due(m), terms.term - 1),
  }));
}

function workout(b: Builder) {
  const { r, loan } = b;
  const referred = r.chance(0.3);
  const k = referred ? r.int(5, 6) : r.int(2, 6);
  const K = r.int(3, 6);
  const m = K - 1;
  const s = m - k;
  b.span(K, -s + r.int(1, 2));
  b.onTime(-b.s.h, s - 1);
  if (referred) b.refer(b.due(s), daysBetween(b.due(s), b.eom(m - 1)));
  if (r.chance(0.6)) {
    if (r.chance(0.7)) b.pay(b.on(m, r.int(2, 10)), loan.P);
    const completed = b.on(m, r.int(11, 27));
    const deferred = BigInt(b.unpaidAt(completed)) * loan.P;
    b.s.cond.set(m, { kind: "payment_deferral", completed_on: completed });
    b.s.books.set(m, (base) => ({ ...base, deferred_principal_cents: deferred }));
    return;
  }
  const before = b.eom(m - 1);
  modify(b, m, modTerms(b, b.upbAt(before), b.unpaidAt(before)));
}

/**
 * A closing on a delinquent loan, E + `target` days after the first installment missed: the
 * window is placed so the closing falls in its last month.
 */
function placeClosing(
  b: Builder,
  target: number,
  K: number,
): { E: PlainDate; closed: PlainDate; s: number } {
  const { r } = b;
  const E = addMonths(FIRST_WINDOW, r.int(-6, 30));
  const closed = addDays(E, target);
  b.s.W0 = addMonths(firstOf(closed), -(K - 1));
  const s = b.indexOf(E);
  b.span(K, -s + r.int(1, 2));
  b.onTime(-b.s.h, s - 1);
  return { E, closed, s };
}

/** Each side of each bucket's edge at a deed in lieu, taken in turn. */
const DEED_EDGES = CLOSING_EDGES;

function foreclosure(b: Builder) {
  const { r } = b;
  // In turn: a sale, a deed in lieu, a sale, a referral alone.
  const kind = (["foreclosure_sale", "deed_in_lieu", "foreclosure_sale", "referral"] as const)[
    b.turn % 4
  ]!;
  const K = r.int(3, 6);
  if (kind === "referral") {
    const s = r.int(-6, -3);
    b.span(K, -s + r.int(1, 2));
    b.onTime(-b.s.h, s - 1);
    b.refer(b.due(s), Math.min(200, daysBetween(b.due(s), b.eom(b.s.K - 1))));
    return;
  }
  const sale = kind === "foreclosure_sale";
  const nth = Math.floor(b.turn / 4);
  // A sale at 179 or 180 days every other time, else anywhere from 181 to 420; a deed in lieu on each edge in turn,
  // or (one time in three) anywhere from 61 to 300.
  const target = sale
    ? nth % 2 === 0
      ? r.pick([179, 180])
      : r.int(181, 420)
    : nth % 3 === 2
      ? r.int(61, 300)
      : DEED_EDGES[nth % DEED_EDGES.length]!;
  const { E, closed } = placeClosing(b, target, K);
  if (sale || (target >= 141 && r.chance(0.6))) b.refer(E, Math.min(target - 20, 300));
  b.s.cond.set(b.s.K - 1, {
    kind: sale ? "foreclosure_sale" : "deed_in_lieu",
    closed_on: closed,
    deficiency_pursued: r.chance(0.2),
  });
}

function closing(b: Builder) {
  const { r, loan } = b;
  // Each kind in turn, and on a delinquent loan each side of each bucket's edge in turn.
  const kind = (
    ["payoff_current", "payoff_delinquent", "short_sale", "short_sale_referred"] as const
  )[b.turn % 4]!;
  const nth = Math.floor(b.turn / 4);
  const K = r.int(3, 6);
  if (kind === "payoff_current") {
    b.span(K, r.int(3, 5));
    b.onTime(-b.s.h, b.s.K - 2);
    const paid = r.int(1, 8);
    b.pay(b.on(b.s.K - 1, paid), loan.P);
    const closed = b.on(b.s.K - 1, r.int(paid + 1, 28));
    b.s.cond.set(b.s.K - 1, {
      kind: "payoff",
      closed_on: closed,
      by_refinance: r.chance(0.5),
      payoff_funds_cents: 0n,
    });
    return;
  }
  // A referral is made past 120 days, so a short sale after one closes at 149 days or more.
  const referred = kind === "short_sale_referred";
  const edges = referred ? REFERRED_EDGES : CLOSING_EDGES;
  const target = edges[nth % edges.length]!;
  const { E, closed } = placeClosing(b, target, K);
  if (referred) b.refer(E, target - 5);
  b.s.cond.set(
    b.s.K - 1,
    kind === "payoff_delinquent"
      ? { kind: "payoff", closed_on: closed, by_refinance: r.chance(0.5), payoff_funds_cents: 0n }
      : { kind: "short_sale", closed_on: closed },
  );
}

/** A loan's history for an edge that is about something else: current, stopped, or two behind and paying. */
function anyHistory(b: Builder, allowRolling: boolean) {
  const { r } = b;
  b.span(r.int(3, 6), r.int(3, 6));
  const pattern = r.weighted<string>([
    ["current", 40],
    ["stopped", 35],
    ["rolling", allowRolling ? 25 : 0],
  ]);
  if (pattern === "current") {
    b.onTime(-b.s.h, b.s.K - 1);
    return;
  }
  const s = r.int(-b.s.h + 1, b.s.K - 1);
  b.onTime(-b.s.h, s - 1);
  if (pattern === "rolling") b.oneAMonth(s + 2, b.s.K - 1);
}

function boarding(b: Builder) {
  const { r } = b;
  const handedOff = r.chance(0.6);
  anyHistory(b, handedOff);
  b.s.last = handedOff ? "prior_servicer" : "none";
  b.s.handoffLength = handedOff && r.chance(0.5) ? r.int(1, 23) : 24;
}

const BAD_IDS: readonly [string, number][] = [
  ["min_17", 15],
  ["min_19", 10],
  ["min_letter", 10],
  ["min_missing", 20],
  ["fnma_9", 15],
  ["fnma_11", 10],
  ["fnma_letter", 10],
  ["both", 10],
];

function identifiers(b: Builder) {
  const { r } = b;
  anyHistory(b, true);
  const j = r.int(0, b.s.K - 2);
  const months = r.chance(0.25) && j + 1 <= b.s.K - 2 ? [j, j + 1] : [j];
  const bad = r.weighted<string>(BAD_IDS);
  const ids: { fnma_loan_number?: string; min?: string | null } = {};
  if (bad === "min_17") ids.min = `100${digits(r, 14)}`;
  if (bad === "min_19") ids.min = `100${digits(r, 16)}`;
  if (bad === "min_letter") ids.min = `100${digits(r, 8)}O${digits(r, 6)}`;
  if (bad === "min_missing" || bad === "both") ids.min = null;
  if (bad === "fnma_9") ids.fnma_loan_number = digits(r, 9);
  if (bad === "fnma_11" || bad === "both") ids.fnma_loan_number = digits(r, 11);
  if (bad === "fnma_letter") ids.fnma_loan_number = `${digits(r, 4)}-${digits(r, 5)}`;
  for (const t of months) b.s.ids.set(t, ids);
}

function consumers(b: Builder) {
  anyHistory(b, true);
  b.s.consumers = manyConsumers(b.r);
}

const SCRIPTS: Readonly<Record<Metro2Edge, (b: Builder) => void>> = {
  buckets,
  dofd,
  pool,
  forbearance,
  repayment_plan: repaymentPlan,
  trial,
  workout,
  foreclosure,
  closing,
  boarding,
  identifiers,
  consumers,
};

/* ── assembling the task ───────────────────────────────────────────────── */

/** One candidate; the caller keeps it only if it is in scope and fair to grade. */
export function drawMetro2Candidate(
  r: Rng,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): Metro2Task {
  const edge = metro2EdgeOf(index);
  const loan = loanOf(r);
  // The note's first payment comes `age` months before the ledger's first installment, all paid on time.
  const b = new Builder(
    r,
    loan,
    addMonths(FIRST_WINDOW, r.int(0, 44)),
    r.int(2, 90),
    Math.floor(index / METRO2_EDGES.length),
  );
  SCRIPTS[edge](b);
  return assemble(b, id, split, suiteSeed, index);
}

function assemble(
  b: Builder,
  id: string,
  split: Split,
  suiteSeed: number,
  index: number,
): Metro2Task {
  const { s, loan, r } = b;
  const F = b.firstDue();
  const before = b.age; // installments paid before the ledger's first
  const installments = b.installments();
  // Every receipt through the last month's end, in the order received: nothing after it is known.
  const receipts = s.receipts
    .filter((x) => x.received_on <= b.eom(s.K - 1))
    .sort((x, y) => (x.received_on < y.received_on ? -1 : x.received_on > y.received_on ? 1 : 0));
  const fnma = digits(r, 10);
  const min = `100${digits(r, 15)}`;
  const monthOf = (t: number): Metro2Month => {
    const asOf = b.eom(t);
    const applied = applyFifo(
      installments,
      receipts.filter((x) => x.received_on <= asOf),
    ).installments;
    const paid = applied.filter((i) => i.satisfied_on !== null && i.satisfied_on <= asOf).length;
    const upb = balanceAfter(loan.orig, loan.rate, loan.pi, before + paid);
    const base: MonthBooks = {
      upb_cents: upb,
      deferred_principal_cents: 0n,
      forborne_principal_cents: 0n,
      remaining_term_months: loan.term - (monthsFrom(F, b.due(t)) + 1),
      maturity_date: addMonths(F, loan.term - 1),
      fnma_loan_number: fnma,
      min,
      ...s.ids.get(t),
    };
    const books = s.books.get(t)?.(base) ?? base;
    const inForce: InForce[] = [];
    let c = s.cond.get(t);
    // Payoff funds: the balance, the P&I unpaid, and a month's interest.
    if (c?.kind === "payoff") {
      const unpaid = applied.filter(
        (i) => i.due_date <= asOf && (i.satisfied_on === null || i.satisfied_on > asOf),
      ).length;
      c = {
        ...c,
        payoff_funds_cents:
          upb +
          BigInt(unpaid) * loan.pi +
          (upb * BigInt(Math.round(Number(loan.rate) * 1000))) / 1_200_000n,
      };
    }
    if (c) inForce.push(c);
    if (s.referral && s.referral <= asOf)
      inForce.push({ kind: "foreclosure_referral", referred_on: s.referral });
    return { month: b.due(t).slice(0, 7), books, in_force: inForce };
  };

  const base = {
    id,
    split,
    suite_seed: suiteSeed,
    index,
    policy: s.policy,
    loan: {
      loan_id: `SM-${r.int(100_000, 999_999)}`,
      note_date: addDays(addMonths(F, -1), r.int(0, 27)),
      original_amount_cents: loan.orig,
      original_term_months: loan.term,
      note_rate_pct: loan.rate,
      pi_cents: loan.pi,
      escrow_cents: loan.escrow,
      interest_type: "F" as const,
    },
    consumers: s.consumers,
    installments,
    receipts,
  };

  // The engine's own history, from a record at the month before the ledger's first: current, as reported since F.
  const seedMonth = addMonths(b.due(-s.h), -1);
  const zeros = Math.min(24, monthsFrom(F, seedMonth));
  const seed: LastRecord = {
    month: seedMonth.slice(0, 7),
    furnished_by: "us",
    account_status: "11",
    special_comment: "",
    payment_history_profile: "0".repeat(zeros) + "B".repeat(24 - zeros),
    date_of_first_delinquency: "00000000",
  };
  const history: Metro2Month[] = [];
  for (let t = -s.h; t < 0; t++) history.push(monthOf(t));
  const prior = furnish({ ...base, last_record: seed, months: history }).records.at(-1)!;
  if (!prior.furnished) throw new Error(`${id}: the month before the window was not furnished`);
  const last: LastRecord | null =
    s.last === "none"
      ? null
      : {
          month: prior.month,
          furnished_by: s.last,
          account_status: prior.account_status as LastRecord["account_status"],
          special_comment: prior.special_comment,
          payment_history_profile: prior.payment_history_profile.slice(0, s.handoffLength),
          date_of_first_delinquency: prior.date_of_first_delinquency,
        };
  const months: Metro2Month[] = [];
  for (let t = 0; t < s.K; t++) months.push(monthOf(t));
  return { ...base, last_record: last, months };
}

/* ── the guard ─────────────────────────────────────────────────────────── */

/**
 * The due date that began the delinquency running at `on`: the first
 * installment, after the last receipt at which nothing was unpaid, that was
 * not paid by its own due date. Null when nothing is unpaid at `on`. Rule 3's
 * "commencement of the delinquency", which the DOFD must never move past.
 */
export function delinquencyBegan(task: Metro2Task, on: PlainDate): PlainDate | null {
  const ledger = ledgerAsOf(task, on);
  const unpaidAt = (d: PlainDate) =>
    ledger.some((i) => i.due_date <= d && (i.satisfied_on === null || i.satisfied_on > d));
  if (!unpaidAt(on)) return null;
  const current = task.receipts
    .map((x) => x.received_on)
    .filter((d) => d <= on && !unpaidAt(d))
    .sort()
    .at(-1);
  const missed = ledger.find(
    (i) =>
      (current === undefined || i.due_date > current) &&
      i.due_date <= on &&
      (i.satisfied_on === null || i.satisfied_on > i.due_date),
  );
  return missed?.due_date ?? null;
}

const IDENTIFIER_ERRORS = new Set(["K3_MIN_MISSING", "MIN_NOT_18_DIGITS", "K3_FNMA_LOAN_NUMBER"]);

/** Why a window is out of scope, or null when it is in: each a place the engine departs from its spec. */
export function metro2OutOfScope(task: Metro2Task): string | null {
  const months = task.months;
  const closingAt = months.findIndex((m) => m.in_force.some((e) => CLOSINGS.includes(e.kind)));
  if (closingAt >= 0 && closingAt !== months.length - 1) return "a closing before the last month";
  for (const m of months)
    if (m.in_force.filter((e) => e.kind !== "foreclosure_referral").length > 1)
      return "two plans, workouts or closings in force at once";
  // D13: nothing is received on or after a closing date; payoff funds are never in the ledger.
  if (closingAt >= 0) {
    const closed = (
      months[closingAt]!.in_force.find((e) => CLOSINGS.includes(e.kind)) as { closed_on: PlainDate }
    ).closed_on;
    if (task.receipts.some((x) => x.received_on >= closed))
      return "D13: a receipt on or after the closing date";
  }
  let why: string | null = null;
  furnish(task, {
    month(m, state, s, errors) {
      if (why) return;
      const i = months.indexOf(m);
      const asOf = state.as_of;
      const unpaid = deriveDelinquency(state.installments, asOf).earliest_unpaid !== null;
      const kinds = m.in_force.map((e) => e.kind);
      if (state.disaster_case_open) why = "D11: a disaster case open";
      // D15: the engine never furnishes E; a zero balance in a month that is not a closing would carry 0.
      else if (!s.final_reported && s.current_balance_cents === 0n)
        why = "D15: a zero balance before a closing";
      // DOFD_REQUIRED and the rest no input can satisfy: the engine would omit the record.
      else if (errors.some((e) => !IDENTIFIER_ERRORS.has(e)))
        why = `a hard error the books cannot cause: ${errors.join(",")}`;
      // D12: the DOFD moved later while the delinquency continued (or anything else off its commencement).
      else if (s.dofd !== null && s.dofd !== delinquencyBegan(task, asOf))
        why = `D12: DOFD ${s.dofd} where the delinquency began ${delinquencyBegan(task, asOf)}`;
      else if (kinds.includes("modification") || kinds.includes("payment_deferral")) {
        // D2: a workout forces 11 and no amount past due in every month it is carried; the installments
        // from its effective date must be paid, by the receipts from that date, to under 30 days.
        const e = m.in_force.find(
          (x) => x.kind === "modification" || x.kind === "payment_deferral",
        )!;
        const from =
          e.kind === "modification"
            ? e.effective_on
            : (e as { completed_on: PlainDate }).completed_on;
        const amount =
          e.kind === "modification"
            ? e.new_piti_cents
            : task.loan.pi_cents + task.loan.escrow_cents;
        const after = task.installments
          .filter((x) => x.due_date >= from)
          .map((x) => ({ ...x, amount_cents: amount }));
        const post = applyFifo(
          after,
          task.receipts.filter((x) => x.received_on >= from && x.received_on <= asOf),
        ).installments;
        if (deriveDelinquency(post, asOf).days >= 30)
          why = "D2: a workout carried over unpaid installments";
      } else if (s.special_comment === "CP" && state.condition.kind === "forbearance") {
        // The freeze over a loan whose arrears are paid: the engine's DOFD_REQUIRED, then a later DOFD.
        if (
          task.policy.forbearance_status === "freeze" &&
          state.condition.entry_status !== "11" &&
          !unpaid
        )
          why = "a freeze at 30 days or more with nothing unpaid";
      }
      if (why) return;
      // D3: after a forbearance, aging resumes from the frozen position (78 to 80), not from the ledger.
      const wasForbearance =
        i === 0
          ? task.last_record?.special_comment === "CP"
          : months[i - 1]!.in_force.some((e) => e.kind === "forbearance_plan");
      const contractual = ["none", "repayment_plan", "trial"].includes(state.condition.kind);
      if (wasForbearance && contractual && unpaid)
        why = "D3: a forbearance ended with installments unpaid";
      // A closing with an installment unpaid at the month-end and under 30 days at closing: 13 with a DOFD.
      const c = state.condition;
      if (
        "closed_on" in c &&
        deriveDelinquency(state.installments, c.closed_on).days < 30 &&
        unpaid
      )
        why = "a closing current at its date with an installment unpaid at the month-end";
    },
  });
  return why;
}

export const metro2InScope = (task: Metro2Task): boolean => metro2OutOfScope(task) === null;

/** Whether the rulebook followed through the tools lands exactly where the engine does. */
export function metro2FairToGrade(task: Metro2Task): boolean {
  const payload = JSON.parse(JSON.stringify(metro2Payload(task))) as Record<string, unknown>;
  let byRules: unknown;
  try {
    byRules = solveNow(metro2Steps, payload, executeMetro2Tool);
  } catch {
    return false;
  }
  const parsed = parseMetro2Submission(byRules);
  return parsed.ok && gradeMetro2Against(expectedMetro2(task), parsed.answer).pass;
}

const ATTEMPTS = 40;

export function drawMetro2Task(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
): { task: Metro2Task; attempts: number } {
  const id = metro2TaskId(split, suiteSeed, index);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const task = drawMetro2Candidate(
      rngFor(attempt === 0 ? id : `${id}#${attempt}`),
      id,
      split,
      suiteSeed,
      index,
    );
    if (metro2InScope(task) && metro2FairToGrade(task)) return { task, attempts: attempt + 1 };
  }
  throw new Error(`${id}: no window fair to grade in ${ATTEMPTS} draws`);
}

export const generateMetro2Task = (
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  index: number,
) => drawMetro2Task(split, suiteSeed, index).task;

export function generateMetro2Suite(
  split: Exclude<Split, "spec">,
  suiteSeed: number,
  n: number,
): Metro2Task[] {
  return Array.from({ length: n }, (_, i) => generateMetro2Task(split, suiteSeed, i));
}

export const METRO2_HELDOUT_SUITE = { split: "heldout" as const, seed: 1, n: 200 };

/* ── the spec's worked examples ────────────────────────────────────────── */

/**
 * Loan SM-1001 (8.1 rule 13): $300,000.00 dated 2025-02-14 at 6.250% for 360
 * months, first payment 2025-03-01, P&I $1,847.15, escrow $612.40, maturity
 * 2055-02-01, Fannie Mae loan 1234567890, MIN 100012345678901234. The ledger
 * lists installments from 2026-10-01, paid on their due dates through
 * `paidThrough`; the record for December 2026 is the spec's (21 zeros and
 * BBB). Every month from January 2027 is run through the engine, and the
 * task is the window, its last record the engine's month before it.
 */
interface SmCase {
  readonly name: string;
  readonly paidThrough?: string;
  readonly receipts?: readonly (readonly [string, bigint])[];
  readonly window: readonly [string, string];
  readonly months?: Readonly<
    Record<string, { readonly books?: Partial<MonthBooks>; readonly in_force?: readonly InForce[] }>
  >;
  readonly policy?: Partial<CreditPolicy>;
  readonly consumers?: readonly CreditConsumer[];
  readonly last?: "chain" | "none" | Omit<LastRecord, "month">;
}

const SM_PITI = 245_955n;
const forbearanceMay: InForce = {
  kind: "forbearance_plan",
  effective_on: plainDate("2027-05-01"),
  plan_payment_cents: 0n,
};
const referredJune: InForce = {
  kind: "foreclosure_referral",
  referred_on: plainDate("2027-06-10"),
};

export const METRO2_SPEC_CASES: readonly SmCase[] = [
  {
    name: "8.1 rule 13: SM-1001 from January to April 2027 (8.1-T1, T2)",
    window: ["2027-01", "2027-04"],
  },
  {
    name: "8.1 rule 13: May to August under the freeze, cured by a Payment Deferral (8.1-T3, T4)",
    receipts: [["2027-08-10", SM_PITI]],
    window: ["2027-05", "2027-08"],
    months: {
      "2027-05": { in_force: [forbearanceMay] },
      "2027-06": { in_force: [forbearanceMay] },
      "2027-07": { in_force: [forbearanceMay] },
      "2027-08": {
        in_force: [{ kind: "payment_deferral", completed_on: plainDate("2027-08-15") }],
        books: { deferred_principal_cents: 1_475_730n },
      },
    },
  },
  {
    name: "8.1-T3: the same forbearance under contractual aging",
    window: ["2027-05", "2027-07"],
    policy: { forbearance_status: "contractual_aging" },
    months: {
      "2027-05": { in_force: [forbearanceMay] },
      "2027-06": { in_force: [forbearanceMay] },
      "2027-07": { in_force: [forbearanceMay] },
    },
  },
  {
    name: "8.1-T5: reinstated on 2027-08-10 instead",
    receipts: [["2027-08-10", SM_PITI * 7n]],
    window: ["2027-05", "2027-08"],
    months: {
      "2027-05": { in_force: [forbearanceMay] },
      "2027-06": { in_force: [forbearanceMay] },
      "2027-07": { in_force: [forbearanceMay] },
      // The spec's figure: the balance after the August installment.
      "2027-08": { books: { upb_cents: 29_274_316n } },
    },
  },
  {
    name: "8.1-T6: a Flex Modification effective 2027-09-01, $30,000 forborne, after a trial at $2,100.00",
    receipts: [
      ["2027-06-12", 210_000n],
      ["2027-07-12", 210_000n],
      ["2027-08-12", 210_000n],
      ["2027-09-03", 210_000n],
    ],
    window: ["2027-06", "2027-09"],
    months: {
      "2027-06": { in_force: [{ kind: "trial_plan", trial_payment_cents: 210_000n }] },
      "2027-07": { in_force: [{ kind: "trial_plan", trial_payment_cents: 210_000n }] },
      "2027-08": { in_force: [{ kind: "trial_plan", trial_payment_cents: 210_000n }] },
      "2027-09": {
        in_force: [
          {
            kind: "modification",
            effective_on: plainDate("2027-09-01"),
            new_term_months: 480,
            new_piti_cents: 210_000n,
          },
        ],
        books: {
          upb_cents: 28_000_000n,
          forborne_principal_cents: 3_000_000n,
          remaining_term_months: 480,
          maturity_date: plainDate("2067-08-01"),
        },
      },
    },
  },
  {
    name: "8.1-T7: a short sale on 2027-07-20 after a foreclosure referral",
    paidThrough: "2027-05-01",
    window: ["2027-05", "2027-07"],
    months: {
      "2027-06": {
        in_force: [{ kind: "foreclosure_referral", referred_on: plainDate("2027-06-25") }],
      },
      "2027-07": {
        in_force: [
          { kind: "short_sale", closed_on: plainDate("2027-07-20") },
          { kind: "foreclosure_referral", referred_on: plainDate("2027-06-25") },
        ],
      },
    },
  },
  {
    name: "8.1-T7: the same short sale with no foreclosure started",
    paidThrough: "2027-05-01",
    window: ["2027-05", "2027-07"],
    months: {
      "2027-07": { in_force: [{ kind: "short_sale", closed_on: plainDate("2027-07-20") }] },
    },
  },
  {
    name: "8.1-T8: a foreclosure sale on 2027-09-20",
    window: ["2027-05", "2027-09"],
    months: {
      "2027-06": { in_force: [referredJune] },
      "2027-07": { in_force: [referredJune] },
      "2027-08": { in_force: [referredJune] },
      "2027-09": {
        in_force: [
          {
            kind: "foreclosure_sale",
            closed_on: plainDate("2027-09-20"),
            deficiency_pursued: false,
          },
          referredJune,
        ],
      },
    },
  },
  {
    name: "8.1-T8: a deed in lieu recorded 2027-09-20",
    window: ["2027-07", "2027-09"],
    months: {
      "2027-09": {
        in_force: [
          { kind: "deed_in_lieu", closed_on: plainDate("2027-09-20"), deficiency_pursued: false },
        ],
      },
    },
  },
  {
    name: "8.1-T8: the same deed in lieu, a deficiency pursued",
    window: ["2027-07", "2027-09"],
    months: {
      "2027-09": {
        in_force: [
          { kind: "deed_in_lieu", closed_on: plainDate("2027-09-20"), deficiency_pursued: true },
        ],
      },
    },
  },
  {
    name: "8.1-T8: paid in full on 2027-09-10",
    paidThrough: "2027-09-01",
    window: ["2027-07", "2027-09"],
    months: {
      "2027-09": {
        in_force: [
          {
            kind: "payoff",
            closed_on: plainDate("2027-09-10"),
            by_refinance: false,
            // The balance after September's installment, $290,450.46, and nine days' interest.
            payoff_funds_cents: 29_089_807n,
          },
        ],
      },
    },
  },
  {
    name: "8.1-T15: a prior servicer's hand-off with PHP 000010000000000000000000",
    window: ["2027-01", "2027-03"],
    paidThrough: "2027-03-01",
    last: {
      furnished_by: "prior_servicer",
      account_status: "11",
      special_comment: "",
      payment_history_profile: "000010000000000000000000",
      date_of_first_delinquency: "00000000",
    },
  },
  {
    name: "8.1-T15: boarded with no hand-off",
    window: ["2027-01", "2027-03"],
    paidThrough: "2027-03-01",
    last: "none",
  },
  {
    name: "8.1-T16: a successor, a released borrower and a co-borrower at another address",
    window: ["2027-01", "2027-03"],
    paidThrough: "2027-03-01",
    consumers: [
      { party_id: "A", position: 1, same_address_as_base: true, liability: "joint" },
      { party_id: "B", position: 2, same_address_as_base: false, liability: "joint" },
      {
        party_id: "S",
        position: 3,
        same_address_as_base: true,
        liability: "joint",
        successor_in_interest: true,
      },
      {
        party_id: "R",
        position: 4,
        same_address_as_base: true,
        liability: "joint",
        released: true,
      },
    ],
  },
  {
    name: "8.1-T19: January to April under the round policy",
    window: ["2027-01", "2027-04"],
    policy: { metro2_rounding: "round" },
  },
  {
    name: "8.2 rule 10: the corrected variant, February's installment paid 2027-02-05",
    receipts: [["2027-02-05", SM_PITI]],
    window: ["2027-02", "2027-04"],
  },
  {
    name: "8.1-T9: a 17-digit MIN in February's books, omitted, and D in March",
    window: ["2027-01", "2027-04"],
    months: { "2027-02": { books: { min: "10001234567890123" } } },
  },
];

function smTask(c: SmCase, index: number): Metro2Task {
  const first = plainDate("2025-03-01");
  const ledgerFrom = plainDate("2026-10-01");
  const installments = Array.from({ length: 15 }, (_, k) => ({
    due_date: addMonths(ledgerFrom, k),
    amount_cents: SM_PITI,
  }));
  const paidThrough = c.paidThrough ?? "2027-01-01";
  const receipts = [
    ...installments
      .filter((i) => i.due_date <= paidThrough)
      .map((i) => ({ received_on: i.due_date, amount_cents: SM_PITI })),
    ...(c.receipts ?? []).map(([on, amount]) => ({
      received_on: plainDate(on),
      amount_cents: amount,
    })),
  ].sort((a, b) => (a.received_on < b.received_on ? -1 : a.received_on > b.received_on ? 1 : 0));
  const base = {
    id: `${METRO2_ENVIRONMENT_NAME}/${METRO2_ENVIRONMENT_VERSION}/spec/0/${index}`,
    split: "spec" as const,
    suite_seed: 0,
    index,
    policy: {
      metro2_rounding: "truncate",
      forbearance_status: "freeze",
      terms_duration: "original",
      ...c.policy,
    } as CreditPolicy,
    loan: {
      loan_id: "SM-1001",
      note_date: plainDate("2025-02-14"),
      original_amount_cents: 30_000_000n,
      original_term_months: 360,
      note_rate_pct: "6.250",
      pi_cents: 184_715n,
      escrow_cents: 61_240n,
      interest_type: "F" as const,
    },
    consumers: c.consumers ?? [
      { party_id: "A", position: 1, same_address_as_base: true, liability: "individual" as const },
    ],
    installments,
    receipts,
  };
  const monthOf = (month: string): Metro2Month => {
    const asOf = asOfOf(month);
    const ledger = applyFifo(
      installments,
      receipts.filter((x) => x.received_on <= asOf),
    ).installments;
    const paid = ledger.filter((i) => i.satisfied_on !== null && i.satisfied_on <= asOf).length;
    const cfg = c.months?.[month];
    return {
      month,
      books: {
        upb_cents: balanceAfter(30_000_000n, "6.250", 184_715n, 19 + paid),
        deferred_principal_cents: 0n,
        forborne_principal_cents: 0n,
        remaining_term_months: 360 - (monthsFrom(first, plainDate(`${month}-01`)) + 1),
        maturity_date: plainDate("2055-02-01"),
        fnma_loan_number: "1234567890",
        min: "100012345678901234",
        ...cfg?.books,
      },
      in_force: [...(cfg?.in_force ?? [])],
    };
  };
  const months: Metro2Month[] = [];
  for (let m = plainDate("2027-01-01"); m.slice(0, 7) <= c.window[1]; m = addMonths(m, 1))
    months.push(monthOf(m.slice(0, 7)));
  const december: LastRecord = {
    month: "2026-12",
    furnished_by: "us",
    account_status: "11",
    special_comment: "",
    payment_history_profile: `${"0".repeat(21)}BBB`,
    date_of_first_delinquency: "00000000",
  };
  const at = months.findIndex((m) => m.month === c.window[0]);
  let last: LastRecord | null = december;
  if (at > 0) {
    const before = furnish({
      ...base,
      last_record: december,
      months: months.slice(0, at),
    }).records.at(-1)!;
    if (!before.furnished)
      throw new Error(`${c.name}: the month before the window was not furnished`);
    last = {
      month: before.month,
      furnished_by: "us",
      account_status: before.account_status as LastRecord["account_status"],
      special_comment: before.special_comment,
      payment_history_profile: before.payment_history_profile,
      date_of_first_delinquency: before.date_of_first_delinquency,
    };
  }
  if (c.last === "none") last = null;
  else if (c.last && c.last !== "chain") last = { month: "2026-12", ...c.last };
  return { ...base, last_record: last, months: months.slice(at) };
}

/** The spec's worked examples on SM-1001 and its test cases, in METRO2_SPEC_CASES's order. */
export const metro2SpecTasks = (): Metro2Task[] => METRO2_SPEC_CASES.map(smTask);
