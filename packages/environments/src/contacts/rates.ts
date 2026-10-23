/**
 * The contact center's three rates, read from the life generator's
 * calibration through `loadCalibration`.
 *
 * The calibration file states `contacts.per_loan_year`,
 * `contacts.handle_time_minutes` and `contacts.inbound_reason_mix` as
 * objects (the CFPB's figures with their derivation), and the reader that
 * turns the file into `Rates` is changing on another branch. So this module
 * takes whatever `cal.rates.contacts` holds, a scalar or an object, and reads
 * each figure out of it:
 *
 *   - per loan-year: a number, or an object's `inquiries_per_loan_year`
 *     (`per_loan_year`, `value`, `mean`), or the midpoint of its
 *     `monthly_range_per_loan_year`;
 *   - handle time: a number (the mean), or an object's `mean` (`average`,
 *     `value`) with its `min` and `max`, and with only a range the geometric
 *     mean of its ends, since the range spans a factor of more than four and
 *     a midpoint would sit above most of it;
 *   - the reason mix: an array of pairs, an object of shares, or an object
 *     whose `shares` (or `counts`) are. It is a complaint mix, so it weights
 *     which calls carry a voiced complaint and never why people call
 *     (docs/environments.md, "The contact center").
 *
 * A figure that cannot be read takes the default below, with a warning.
 */

import type { Calibration, CalibrationKey } from "../life/calibration.js";

export interface ContactRates {
  /** Inbound inquiries (calls, IVR sessions, e-mails, texts and letters that ask something) per loan-year, all loans. */
  readonly per_loan_year: number;
  readonly handle_minutes: {
    /** The mean handle time of a call an agent handled. */
    readonly mean: number;
    /** The range a month's average should sit in, when the calibration gives one. */
    readonly min: number | null;
    readonly max: number | null;
  };
  /** Shares of complaints by the calibration's own reason keys, summing to 1. */
  readonly complaint_mix: readonly (readonly [string, number])[];
  /** Per key: whether the calibration's file or its default stood behind the figure. */
  readonly provenance: Readonly<Record<string, "file" | "default">>;
  readonly warnings: readonly string[];
}

/** The figures used when the calibration has none this module can read: design choices, each with its reason. */
export const CONTACT_DEFAULTS = {
  /** The CFPB's 2021 pooled figure, rounded (calibration.json, contacts.per_loan_year). */
  per_loan_year: 2,
  /** The geometric mean of the CFPB's 4.3 to 19.8 minutes. */
  handle_mean_minutes: Math.sqrt(4.3 * 19.8),
} as const;

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Inquiries per loan-year from a scalar or one of the object shapes. */
export function readPerLoanYear(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n >= 0 ? n : null;
  const o = obj(v);
  if (!o) return null;
  for (const k of ["inquiries_per_loan_year", "per_loan_year", "value", "mean", "rate"]) {
    const x = num(o[k]);
    if (x !== null && x >= 0) return x;
  }
  const range = o["monthly_range_per_loan_year"] ?? o["range"];
  if (Array.isArray(range) && range.length === 2) {
    const a = num(range[0]);
    const b = num(range[1]);
    if (a !== null && b !== null && a >= 0 && b >= a) return (a + b) / 2;
  }
  return null;
}

/** Handle time in minutes, from a scalar (the mean) or an object with a mean and a range. */
export function readHandleMinutes(
  v: unknown,
): { mean: number; min: number | null; max: number | null } | null {
  const n = num(v);
  if (n !== null) return n > 0 ? { mean: n, min: null, max: null } : null;
  const o = obj(v);
  if (!o) return null;
  let min = num(o["min"]);
  let max = num(o["max"]);
  const range = o["range"];
  if ((min === null || max === null) && Array.isArray(range) && range.length === 2) {
    min = num(range[0]);
    max = num(range[1]);
  }
  if (min !== null && max !== null && !(min > 0 && max >= min)) {
    min = null;
    max = null;
  }
  let mean: number | null = null;
  for (const k of ["mean", "average", "value", "median"]) {
    const x = num(o[k]);
    if (x !== null && x > 0) {
      mean = x;
      break;
    }
  }
  if (mean === null && min !== null && max !== null) mean = Math.sqrt(min * max);
  return mean === null ? null : { mean, min, max };
}

/** A mix as normalized pairs, from pairs, an object of numbers, or an object whose `shares` or `counts` are. */
export function readMix(v: unknown): [string, number][] | null {
  let pairs: [string, number][] = [];
  if (Array.isArray(v)) {
    for (const row of v) {
      if (Array.isArray(row) && typeof row[0] === "string" && num(row[1]) !== null)
        pairs.push([row[0], num(row[1])!]);
      else return null;
    }
  } else {
    const o = obj(v);
    if (!o) return null;
    const inner = obj(o["shares"]) ?? obj(o["counts"]);
    const src = inner ?? o;
    for (const [k, w] of Object.entries(src)) {
      const x = num(w);
      // An object of figures carries its year and its total beside the shares; only a share or a count is a reason.
      if (x === null || (inner === null && (k === "year" || k === "complaints"))) continue;
      if (x < 0) return null;
      pairs.push([k, x]);
    }
  }
  pairs = pairs.filter(([, w]) => w > 0);
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  return pairs.length && total > 0 ? pairs.map(([k, w]) => [k, w / total]) : null;
}

/** The contact center's rates from a calibration, scalar or object shaped. */
export function contactRates(cal: Calibration): ContactRates {
  const raw = cal.rates.contacts as unknown as Record<string, unknown>;
  const warnings: string[] = [];
  const provenance: Record<string, "file" | "default"> = {};
  const used = (key: CalibrationKey): "file" | "default" => cal.entries[key]?.used ?? "default";
  const take = <T>(key: CalibrationKey, field: string, parse: (v: unknown) => T | null, fallback: T): T => {
    const v = parse(raw[field]);
    if (v === null) {
      warnings.push(`${key}: ${JSON.stringify(raw[field])} could not be read; the contact center's default is used`);
      provenance[key] = "default";
      return fallback;
    }
    provenance[key] = used(key);
    if (used(key) === "default")
      warnings.push(`${key}: the calibration reader used its own default for this key`);
    return v;
  };
  const per = take("contacts.per_loan_year", "per_loan_year", readPerLoanYear, CONTACT_DEFAULTS.per_loan_year);
  const handle = take("contacts.handle_time_minutes", "handle_time_minutes", readHandleMinutes, {
    mean: CONTACT_DEFAULTS.handle_mean_minutes,
    min: 4.3,
    max: 19.8,
  });
  const mix = take("contacts.inbound_reason_mix", "inbound_reason_mix", readMix, [] as [string, number][]);
  return {
    per_loan_year: per,
    handle_minutes: handle,
    complaint_mix: mix,
    provenance,
    warnings,
  };
}
