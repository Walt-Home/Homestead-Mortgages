/**
 * The two market series a book runs over, both invented and both drawn from
 * the book's own stream: the ARM index feed and the 30-year mortgage rate.
 *
 * The index is the 30-day average SOFR a Fannie Mae ARM adjusts on. Its
 * policy rate moves a quarter point at a time, at most once a month, pulled
 * toward 3 %; each day's SOFR prints a few basis points around it; and the
 * feed publishes the trailing 30 calendar days' average on business days,
 * five decimals, as the ARM port's `selectIndex` reads it. None of it is a
 * forecast.
 *
 * The mortgage rate starts at the calibration's last Primary Mortgage Market
 * Survey observation and walks monthly, pulled toward the series' own mean,
 * with the month-to-month spread the series shows (0.18 points when it is too
 * short to show one). The refinance hazard reads it; nothing else does.
 */

import {
  addDays,
  addMonths,
  isFederalHoliday,
  isWeekend,
  parts,
  ymd,
  type PlainDate,
} from "@hm/kernel/calendar";
import type { IndexObs } from "../arm/ported/arm.js";
import { rngFor, type Rng } from "../rng.js";
import type { Rates } from "./calibration.js";

export const INDEX_NAME = "30-day average SOFR";

/** A standard normal draw (Box–Muller), two uniforms from `r`. */
export function normal(r: Rng): number {
  const u = Math.max(r.next(), 1e-12);
  const v = r.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** The feed's business-day prints from `from` through `through`. */
export function indexFeed(key: string, from: PlainDate, through: PlainDate): IndexObs[] {
  const r = rngFor(`${key}/index`);
  let policy = 3.5 + r.int(0, 4) * 0.125;
  const window: number[] = [];
  let sum = 0;
  const out: IndexObs[] = [];
  let month = "";
  let sofr = policy;
  // Thirty days of history before the first print, so the first average is a full one.
  for (let d = addDays(from, -30); d <= through; d = addDays(d, 1)) {
    const m = d.slice(0, 7);
    if (m !== month) {
      month = m;
      const u = r.next();
      const up = Math.min(0.9, Math.max(0.1, 0.5 + (3 - policy) / 4));
      const move = r.next();
      if (u < 0.3) policy = Math.max(0.125, policy + (move < up ? 0.25 : -0.25));
    }
    const business = !isWeekend(d) && !isFederalHoliday(d);
    if (business) sofr = policy + (r.next() - 0.5) * 0.06;
    window.push(sofr);
    sum += sofr;
    if (window.length > 30) sum -= window.shift()!;
    if (business && d >= from)
      out.push({ effective_date: d, value: (sum / window.length).toFixed(5) });
  }
  return out;
}

/** The prints a feed query around an index date returns (60 days before it, 5 after), by binary search. */
export function printsAround(feed: readonly IndexObs[], d: PlainDate): IndexObs[] {
  const lo = addDays(d, -60);
  const hi = addDays(d, 5);
  let a = 0;
  let b = feed.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (feed[m]!.effective_date < lo) a = m + 1;
    else b = m;
  }
  const out: IndexObs[] = [];
  for (let i = a; i < feed.length && feed[i]!.effective_date <= hi; i++) out.push(feed[i]!);
  return out;
}

export interface MarketMonth {
  /** The first of the month. */
  readonly month: PlainDate;
  /** The 30-year rate that month, percent. */
  readonly rate: number;
}

/** The monthly 30-year mortgage rate from `from` (a first of the month) for `months` months. */
export function marketPath(
  key: string,
  rates: Rates,
  from: PlainDate,
  months: number,
): MarketMonth[] {
  const r = rngFor(`${key}/market`);
  const obs = rates.refi.pmms_30y;
  // The last print of each month, so a weekly survey and a monthly one read alike.
  const byMonth = new Map<string, number>();
  for (const o of obs) byMonth.set(o.on.slice(0, 7), o.rate);
  const monthly = [...byMonth.values()];
  const recent = monthly.slice(-120);
  const anchor = recent.reduce((s, x) => s + x, 0) / Math.max(1, recent.length);
  let sd = 0.18;
  if (monthly.length >= 7) {
    const diffs = monthly.slice(1).map((x, i) => x - monthly[i]!);
    const mean = diffs.reduce((s, x) => s + x, 0) / diffs.length;
    sd = Math.sqrt(diffs.reduce((s, x) => s + (x - mean) ** 2, 0) / (diffs.length - 1));
  }
  let rate = monthly.at(-1) ?? 6.25;
  const p = parts(from);
  const out: MarketMonth[] = [];
  for (let k = 0; k < months; k++) {
    out.push({ month: addMonths(ymd(p.y, p.m, 1), k), rate: Math.round(rate * 1000) / 1000 });
    rate = Math.min(12, Math.max(2, rate + 0.04 * (anchor - rate) + sd * normal(r)));
  }
  return out;
}

/** The rate in force in the month containing `d` (the path's first or last month outside it). */
export function marketRateOn(path: readonly MarketMonth[], d: PlainDate): number {
  if (path.length === 0) return 6.25;
  const p0 = parts(path[0]!.month);
  const pd = parts(d);
  const k = (pd.y - p0.y) * 12 + (pd.m - p0.m);
  return path[Math.min(path.length - 1, Math.max(0, k))]!.rate;
}
