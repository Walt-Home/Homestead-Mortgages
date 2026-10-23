/**
 * What each borrower's draws are made at, from the book's rates.
 *
 * The calibration gives the book's shares: of installments on loans current
 * at the due date, how many arrive within grace, how many after it (each a
 * late charge, the month missed included), and how often a current borrower
 * misses. A borrower's own probability is a base times their habit, drawn
 * once per loan (draw.ts: `lateness` for when they pay, `fragility` for
 * whether they miss, each lognormal with mean one), and capped: a borrower
 * misses at most half the time, pays after grace at most half the time, and
 * pays on time at least one time in twenty. A large enough habit hits its
 * cap, so a base equal to the book's share would leave the book short of it:
 * by 0.08 at the file's within-grace share of a half. Each base is therefore the
 * one whose capped mean, over the habit's distribution, is the book's share:
 * found by bisection, the mean taken over 4,096 equally likely habits.
 *
 * The book's shares are conditional the way the generator draws them. A
 * current borrower first misses or not; one who pays is then late after
 * grace, late within it, or on time. So with m the monthly miss from current,
 * a share of installments after grace s_after (the month missed included) and
 * within grace s_within become, for a borrower who pays,
 *   after + π(after) = (s_after − m) / (1 − m)
 *   within           = s_within / (1 − m),
 * where π is the third way an installment is not in by the end of grace: a
 * partial payment whose rest comes after it (`partialLate`), which is linear in
 * `after`. Without it the book's late charges would run a tenth over the share.
 */

import type { Rates } from "./calibration.js";
import { GRACE_DAYS, HABIT_SIGMA } from "./draw.js";

/** How many days before the due date an early payer pays (simulate.ts draws it, uniform). */
export const EARLY_DAYS: readonly [number, number] = [1, 6];
/** How many days after the first piece of a partial payment the rest comes (simulate.ts draws it, uniform). */
export const PARTIAL_LAG_DAYS: readonly [number, number] = [5, 25];

/** The caps on a borrower's own probabilities. */
export const MISS_CAP = 0.5;
export const AFTER_GRACE_CAP = 0.5;
/** A borrower pays on time at least this often, however late their habit. */
export const ON_TIME_FLOOR = 0.05;

/** The bases each borrower's habit multiplies, and the two the habit does not touch. */
export interface BehaviorBase {
  /** Monthly probability that a current borrower misses, before their fragility. */
  readonly miss: number;
  /** Monthly probability that a borrower who is behind pays everything owed. */
  readonly cure: number;
  /** Probability that a borrower who is behind and does not cure misses again: roll from behind / (1 − cure). */
  readonly miss_again: number;
  /** For a current borrower who pays: the probability of paying after grace, before their lateness. */
  readonly after_grace: number;
  /** For a current borrower who pays: the probability of paying within grace, before their lateness. */
  readonly within_grace: number;
}

/** One borrower's probabilities, from the bases and their two habits. */
export function borrowerRates(
  b: BehaviorBase,
  lateness: number,
  fragility: number,
): { readonly miss: number; readonly after_grace: number; readonly within_grace: number } {
  const after = clamp(b.after_grace * lateness, AFTER_GRACE_CAP);
  return {
    miss: clamp(b.miss * fragility, MISS_CAP),
    after_grace: after,
    within_grace: clamp(b.within_grace * lateness, 1 - ON_TIME_FLOOR - after),
  };
}

const clamp = (x: number, hi = 1) => (x < 0 ? 0 : x > hi ? hi : x);

/**
 * The standard normal quantile (Acklam's rational approximation, relative
 * error under 1.2e-9): the habit's quadrature nodes are its values at the
 * midpoints of equal slices of probability.
 */
export function normalQuantile(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

const NODES = 4096;
let habits: readonly number[] | null = null;
/** The habit's distribution as 4,096 equally likely values: exp(σ·z − σ²/2) at the midpoint quantiles. */
export function habitNodes(): readonly number[] {
  if (!habits) {
    const s = HABIT_SIGMA;
    habits = Array.from({ length: NODES }, (_, k) =>
      Math.exp(s * normalQuantile((k + 0.5) / NODES) - (s * s) / 2),
    );
  }
  return habits;
}

/** The mean of f over the habit's distribution. */
export const overHabits = (f: (habit: number) => number): number => {
  const h = habitNodes();
  let s = 0;
  for (const x of h) s += f(x);
  return s / h.length;
};

/**
 * The base whose capped mean over the habit is `target`. The mean rises with
 * the base, so bisection finds it; a target the caps cannot reach takes the
 * base that comes closest.
 */
function baseFor(target: number, share: (base: number, habit: number) => number): number {
  if (!(target > 0)) return 0;
  let lo = 0;
  let hi = target;
  for (let i = 0; i < 60 && overHabits((h) => share(hi, h)) < target; i++) hi *= 2;
  for (let i = 0; i < 64; i++) {
    const m = (lo + hi) / 2;
    if (overHabits((h) => share(m, h)) < target) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/**
 * Of a paying borrower's installments, the share a partial payment leaves
 * short at the end of grace: the partial share, times the chance its rest
 * comes after grace given when the first piece came. The first piece comes
 * when the borrower pays: on the due date (an early payer 1 to 6 days before
 * it), or within grace on a day drawn from the day weights, or after grace,
 * when the installment is late already. Days are counted on the calendar; a
 * weekend moves the rest and the end of grace alike.
 */
export function partialLate(P: Rates["payment"], afterGrace: number, withinGrace: number): number {
  const [lo, hi] = PARTIAL_LAG_DAYS;
  /** The chance the rest comes after grace when the first piece came `offset` days after the due date. */
  const late = (offset: number) => {
    const first = Math.max(lo, GRACE_DAYS + 1 - offset);
    return Math.max(0, hi - first + 1) / (hi - lo + 1);
  };
  let early = 0;
  for (let k = EARLY_DAYS[0]; k <= EARLY_DAYS[1]; k++) early += late(-k);
  early /= EARLY_DAYS[1] - EARLY_DAYS[0] + 1;
  const onTime = (1 - P.early_share) * late(0) + P.early_share * early;
  const inGrace = P.day_of_month.reduce((s, w, i) => s + w * late(i + 1), 0);
  return P.partial_share * ((1 - afterGrace - withinGrace) * onTime + withinGrace * inGrace);
}

const memo = new WeakMap<Rates, BehaviorBase>();

/** The bases for a book's rates, computed once per `Rates`. */
export function behaviorBase(R: Rates): BehaviorBase {
  const hit = memo.get(R);
  if (hit) return hit;
  const D = R.delinquency;
  const P = R.payment;
  const miss = baseFor(D.roll_current_to_30, (b, h) => clamp(b * h, MISS_CAP));
  const m = D.roll_current_to_30;
  const lateTarget = m < 1 ? Math.max(0, P.late_after_grace_share - m) / (1 - m) : 0;
  const withinTarget = m < 1 ? P.late_within_grace_share / (1 - m) : 0;
  // late = after + π(after), and π is linear in after: π(a) = π(0) − a · (π(0) − π(1 − within)) / (1 − within).
  const pi0 = partialLate(P, 0, withinTarget);
  const slope =
    withinTarget < 1
      ? (pi0 - partialLate(P, 1 - withinTarget, withinTarget)) / (1 - withinTarget)
      : 0;
  const afterTarget = Math.max(0, (lateTarget - pi0) / (1 - slope));
  const after = baseFor(afterTarget, (b, h) => clamp(b * h, AFTER_GRACE_CAP));
  const within = baseFor(withinTarget, (b, h) =>
    clamp(b * h, 1 - ON_TIME_FLOOR - clamp(after * h, AFTER_GRACE_CAP)),
  );
  const cure = clamp(D.cure_from_30);
  const base: BehaviorBase = {
    miss,
    cure,
    miss_again: cure < 1 ? clamp(D.roll_30_to_60 / (1 - cure)) : 0,
    after_grace: after,
    within_grace: within,
  };
  memo.set(R, base);
  return base;
}
