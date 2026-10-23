/**
 * The rates the life generator draws from, read from `calibration.json`.
 *
 * The file is another builder's, shaped
 * `{ version, rates: { "<key>": { value, unit, kind, source, fetched, terms, note } } }`
 * over exactly the keys in `CALIBRATION_KEYS`. This module reads it and never
 * writes it. Each key has its own reader. It takes the value as the file
 * writes it, a figure or an object holding the figure beside what it was
 * derived from, picks the part the generator draws from, and converts it to
 * the unit the generator draws in. Each conversion is stated at its reader,
 * and docs/environments.md, "Calibration", lists them. The readers also take
 * the simpler shapes the defaults are written in: a bare figure normalized by
 * its unit (a percent becomes a share, an annual rate a monthly one where a
 * monthly one is drawn, dollars become cents), bins ("3.5-4.5", "<3", "7+",
 * "lt_3", "4_to_7y"), an array of rows, or a dated series. A key the file
 * lacks, or whose value cannot be read, takes the typed default below, and
 * the reason is kept in `warnings`; the generator never stops on a
 * calibration it cannot read. Without the file every key is its default.
 *
 * Every default is a design choice with no source: the public figures are the
 * calibration builder's to fetch, and none was fetched here. Each says why it
 * is the number it is.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { plainDate, type PlainDate } from "@hm/kernel/calendar";
import { GRACE_DAYS } from "./draw.js";

export const CALIBRATION_KEYS = [
  "delinquency.conventional_30plus_share",
  "delinquency.all_loans_30plus_share_sa",
  "delinquency.roll_current_to_30",
  "delinquency.cure_from_30",
  "delinquency.roll_30_to_60",
  "payment.day_of_month",
  "payment.late_within_grace_share",
  "payment.late_after_grace_share",
  "payment.partial_share",
  "payment.curtailment_share",
  "payment.missed_month_share",
  "contacts.per_loan_year",
  "contacts.handle_time_minutes",
  "contacts.inbound_reason_mix",
  "escrow.share_of_loans",
  "escrow.tax_annual_median",
  "escrow.insurance_annual_median",
  "escrow.tax_growth_yoy",
  "escrow.insurance_growth_yoy",
  "arm.share_of_outstanding",
  "mi.share_of_loans",
  "book.note_rate_distribution",
  "book.ltv_distribution",
  "book.loan_age_distribution",
  "refi.pmms_30y_series",
  "disaster.declarations_by_month",
  "transfer.annual_rate",
  "defects.field_error_rates",
] as const;
export type CalibrationKey = (typeof CALIBRATION_KEYS)[number];

export interface CalibrationEntry {
  readonly value: unknown;
  readonly unit: string;
  readonly kind: "public" | "design_choice";
  readonly source: string;
  readonly fetched: string | null;
  readonly terms: string;
  readonly note: string;
}

export interface CalibrationFile {
  readonly version: string;
  readonly rates: Partial<Record<string, CalibrationEntry>>;
}

/** A bin of a distribution: a value drawn uniformly in [lo, hi) with the bin's weight. */
export interface Bin {
  readonly lo: number;
  readonly hi: number;
  readonly weight: number;
}

/** The normalized rates, in the units the generator draws in. */
export interface Rates {
  readonly delinquency: {
    /** Share of conventional loans one payment or more past due at a month-end: a check, never a draw. */
    readonly conventional_30plus_share: number;
    /** The same for all loans, seasonally adjusted: reported beside the check. */
    readonly all_loans_30plus_share_sa: number;
    /** Monthly probability that a current borrower misses the month's payment. */
    readonly roll_current_to_30: number;
    /** Monthly probability that a borrower who is behind pays everything owed. */
    readonly cure_from_30: number;
    /** Monthly probability that a borrower who is behind misses again. */
    readonly roll_30_to_60: number;
  };
  readonly payment: {
    /** Weights over days 2 to 16 of the due month, for a payment made inside the grace period. */
    readonly day_of_month: readonly number[];
    /**
     * The runs of days, first and last, that `day_of_month` spreads each of the file's bins over, clipped to days 2
     * to 16: a payment drawn for a day off moves to a business day of its own bin (simulate.ts).
     */
    readonly day_of_month_bins: readonly (readonly [number, number])[];
    /** Of installments paid by the due day, the share paid before it: the share of borrowers who pay early. */
    readonly early_share: number;
    /** Share of installments, on loans current at the due date, received after the due day and within grace. */
    readonly late_within_grace_share: number;
    /**
     * Share of installments, on loans current at the due date, not received by the end of grace (each a late
     * charge), those never received in the month included.
     */
    readonly late_after_grace_share: number;
    /** Share of receipts short of the installment due. */
    readonly partial_share: number;
    /** Share of receipts returned after posting: read, and not drawn, because the generator returns no payment yet. */
    readonly returned_share: number;
    readonly curtailment_share: number;
    /** Share of loan-months, on loans current at the due date, with nothing received by month end: a check. */
    readonly missed_month_share: number;
  };
  readonly contacts: {
    readonly per_loan_year: number;
    readonly handle_time_minutes: number;
    readonly inbound_reason_mix: readonly (readonly [string, number])[];
  };
  readonly escrow: {
    readonly share_of_loans: number;
    readonly tax_annual_median_cents: number;
    readonly insurance_annual_median_cents: number;
    /** Year-over-year growth, as a share (0.04 = 4 %). */
    readonly tax_growth_yoy: number;
    readonly insurance_growth_yoy: number;
  };
  readonly arm: { readonly share_of_outstanding: number };
  readonly mi: { readonly share_of_loans: number };
  readonly book: {
    /** Note rate in percent. */
    readonly note_rate: readonly Bin[];
    /** Loan-to-value at origination, in percent. */
    readonly ltv: readonly Bin[];
    /** Loan age in months. */
    readonly loan_age_months: readonly Bin[];
  };
  readonly refi: {
    /** The Primary Mortgage Market Survey 30-year rate, percent, oldest first. */
    readonly pmms_30y: readonly { readonly on: PlainDate; readonly rate: number }[];
  };
  readonly disaster: {
    /** Probability per loan-month of a declaration covering the loan, by calendar month (index 0 = January). */
    readonly by_calendar_month: readonly number[];
  };
  readonly transfer: { readonly annual_rate: number };
  readonly defects: { readonly field_error_rates: Readonly<Record<string, number>> };
}

export interface Calibration {
  readonly version: string;
  /** Where the file was read from, or null when every key is its default. */
  readonly path: string | null;
  readonly rates: Rates;
  /** Per key: whether the file's value or the default was used, and the entry's own provenance. */
  readonly entries: Readonly<
    Record<
      CalibrationKey,
      {
        readonly used: "file" | "default";
        readonly kind: "public" | "design_choice";
        readonly source: string;
        readonly unit: string;
      }
    >
  >;
  readonly warnings: readonly string[];
}

const DESIGN = (value: unknown, unit: string, note: string): CalibrationEntry => ({
  value,
  unit,
  kind: "design_choice",
  source: "none",
  fetched: null,
  terms: "none: a design choice, not data",
  note,
});

/** The typed defaults: every one a design choice with no source, each with its reason. */
export const DEFAULT_CALIBRATION: CalibrationFile = {
  version: "2026-10-23",
  rates: {
    "delinquency.conventional_30plus_share": DESIGN(
      0.02,
      "share",
      "A placeholder near the low single digits a conventional book shows; read only as a check.",
    ),
    "delinquency.all_loans_30plus_share_sa": DESIGN(
      0.04,
      "share",
      "A placeholder above the conventional share, as an all-loans figure that includes FHA and VA would be; reported only.",
    ),
    "delinquency.roll_current_to_30": DESIGN(
      0.012,
      "share per month",
      "Chosen with the two below so the chain settles near the conventional check.",
    ),
    "delinquency.cure_from_30": DESIGN(
      0.45,
      "share per month",
      "Most borrowers who miss one payment catch up within two months.",
    ),
    "delinquency.roll_30_to_60": DESIGN(
      0.2,
      "share per month",
      "A minority of borrowers who are behind miss again.",
    ),
    "payment.day_of_month": DESIGN(
      {
        due_day: 1,
        grace_days: 15,
        arrival_share: {
          before_due: 0.23205,
          due_day: 0.43095,
          day_2: 0.036,
          day_3: 0.03,
          day_4: 0.027,
          day_5: 0.027,
          day_6: 0.024,
          day_7: 0.021,
          day_8: 0.021,
          day_9: 0.018,
          day_10: 0.018,
          day_11: 0.015,
          day_12: 0.015,
          day_13: 0.012,
          day_14: 0.012,
          day_15: 0.012,
          day_16: 0.012,
          days_17_to_month_end: 0.025,
          not_in_month: 0.012,
        },
      },
      "share of installments, on loans current at the due date, by the day of the due month the payment arrives",
      "Payments inside the grace period bunch early in it, and of those paid by the due day about a third are paid before it. The bins add to one; the three payment shares below are sums of them.",
    ),
    "payment.late_within_grace_share": DESIGN(
      0.3,
      "share of installments, on loans current at the due date",
      "Paid after the due date and inside the 15-day grace period.",
    ),
    "payment.late_after_grace_share": DESIGN(
      0.037,
      "share of installments, on loans current at the due date, not received by the end of the grace period",
      "A late charge on each: 2.5 % paid later in the month and the 1.2 % never paid in it.",
    ),
    "payment.partial_share": DESIGN(
      { partial_receipt_share: 0.01, returned_receipt_share: 0.003 },
      "share of receipts: short of the installment due, and returned after posting",
      "A payment sent in two pieces a few weeks apart; about one receipt in three hundred bounces, which is not drawn yet.",
    ),
    "payment.curtailment_share": DESIGN(
      0.02,
      "share of payments",
      "A payment carrying extra principal.",
    ),
    "payment.missed_month_share": DESIGN(
      0.012,
      "share of loan-months",
      "Equal to the roll rate from current; read only as a check.",
    ),
    "contacts.per_loan_year": DESIGN(
      1.5,
      "inbound contacts per loan per year",
      "A borrower calls or writes about once or twice a year.",
    ),
    "contacts.handle_time_minutes": DESIGN(7, "minutes", "A typical inbound call."),
    "contacts.inbound_reason_mix": DESIGN(
      {
        payment: 0.3,
        escrow: 0.15,
        payoff: 0.1,
        statement: 0.1,
        insurance: 0.08,
        tax: 0.07,
        hardship: 0.08,
        other: 0.12,
      },
      "share of inbound contacts",
      "Payments and escrow lead; hardship calls are a minority.",
    ),
    "escrow.share_of_loans": DESIGN(
      0.8,
      "share of loans",
      "Most loans escrow taxes and insurance.",
    ),
    "escrow.tax_annual_median": DESIGN(
      4000,
      "USD per year",
      "A middle-of-the-road property tax bill.",
    ),
    "escrow.insurance_annual_median": DESIGN(
      2000,
      "USD per year",
      "A middle-of-the-road homeowners premium.",
    ),
    "escrow.tax_growth_yoy": DESIGN(0.035, "share per year", "Taxes rise a few percent a year."),
    "escrow.insurance_growth_yoy": DESIGN(
      0.06,
      "share per year",
      "Premiums have risen faster than taxes.",
    ),
    "arm.share_of_outstanding": DESIGN(
      0.05,
      "share of loans",
      "Adjustable-rate loans are a small minority.",
    ),
    "mi.share_of_loans": DESIGN(
      0.3,
      "share of loans",
      "Borrower-paid mortgage insurance on loans above 80 % loan-to-value.",
    ),
    "book.note_rate_distribution": DESIGN(
      { "2.5-3.5": 0.2, "3.5-4.5": 0.2, "4.5-5.5": 0.15, "5.5-6.5": 0.25, "6.5-7.5": 0.2 },
      "share of loans by note rate, percent",
      "A book holding both low-rate loans and recent ones.",
    ),
    "book.ltv_distribution": DESIGN(
      { "40-60": 0.15, "60-80": 0.45, "80-90": 0.15, "90-95": 0.15, "95-97": 0.1 },
      "share of loans by original loan-to-value, percent",
      "Most loans at or under 80; Fannie Mae's ceiling is 97.",
    ),
    "book.loan_age_distribution": DESIGN(
      { "0-12": 0.2, "12-36": 0.3, "36-60": 0.2, "60-120": 0.3 },
      "share of loans by age in months",
      "Read only when a scenario boards a book by transfer.",
    ),
    "refi.pmms_30y_series": DESIGN(
      { "2026-01-01": 6.25 },
      "percent",
      "One starting point; the path forward is drawn.",
    ),
    "disaster.declarations_by_month": DESIGN(
      {
        "01": 0.002,
        "02": 0.002,
        "03": 0.003,
        "04": 0.003,
        "05": 0.003,
        "06": 0.004,
        "07": 0.004,
        "08": 0.006,
        "09": 0.006,
        "10": 0.004,
        "11": 0.002,
        "12": 0.002,
      },
      "probability per loan-month",
      "Declarations peak in the hurricane months.",
    ),
    "transfer.annual_rate": DESIGN(
      0.05,
      "share per year",
      "A loan's servicing moves every twenty years or so.",
    ),
    "defects.field_error_rates": DESIGN(
      { "D-03": 0.05 },
      "share of eligible loans",
      "How often a field is wrong is not public; docs/synthetic-data-defects.md says so.",
    ),
  },
};

/* ── what the generator's notes fix ─────────────────────────────────────── */

/** Every note the generator draws is due on the first, with `GRACE_DAYS` of grace (draw.ts). */
const DUE_DAY = 1;
/** Fannie Mae's highest loan-to-value, and the generator's: an open bin above it is a point at it. */
const LTV_CEILING = 97;
/**
 * Counties and county-equivalents in the fifty states and the District of
 * Columbia (U.S. Census Bureau). FEMA designates disaster areas by county, so
 * a county's chance of a designation in a month is the month's designations
 * over this. It treats every county alike, and loans crowd into populous ones.
 */
export const COUNTIES = 3_143;

/* ── unit handling ───────────────────────────────────────────────────────── */

const isPercentUnit = (u: string) => /percent|pct|%|basis|bps/i.test(u);
const isAnnualUnit = (u: string) => /year|annual|yoy|per\s*yr/i.test(u);
const isMonthlyUnit = (u: string) => /month/i.test(u);
const isQuarterlyUnit = (u: string) => /quarter/i.test(u);

/** A finite number, or a string holding one; anything else, objects included, is not. */
const toNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim())))
    return Number(v.trim());
  return null;
};
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const within01 = (n: number | null): number | null => (n !== null && n >= 0 && n <= 1 ? n : null);

/** A share in [0, 1]: a percent is divided by 100, basis points by 10,000, and a bare number above 1 is read as a percent. */
function share(v: unknown, unit: string): number | null {
  const n = toNumber(v);
  if (n === null || n < 0) return null;
  if (/bps|basis/i.test(unit)) return n / 10_000;
  if (isPercentUnit(unit) || n > 1) return n / 100;
  return n;
}

/** A monthly probability from a share stated per month or per year: 1 − (1 − annual)^(1/12), a constant hazard. */
function monthly(v: unknown, unit: string): number | null {
  const s = share(v, unit);
  if (s === null || s > 1) return null;
  return isAnnualUnit(unit) && !isMonthlyUnit(unit) ? 1 - Math.pow(1 - s, 1 / 12) : s;
}

/** An annual probability from a share stated per year or per month: 1 − (1 − monthly)^12. */
function annual(v: unknown, unit: string): number | null {
  const s = share(v, unit);
  if (s === null || s > 1) return null;
  return isMonthlyUnit(unit) && !isAnnualUnit(unit) ? 1 - Math.pow(1 - s, 12) : s;
}

/** Cents from dollars (the default) or cents. */
function cents(v: unknown, unit: string): number | null {
  const n = toNumber(v);
  if (n === null || n <= 0) return null;
  return /cent/i.test(unit) ? Math.round(n) : Math.round(n * 100);
}

/** A year-over-year change as a share: a percent, or a bare number above one, is divided by 100. */
function growthShare(v: unknown, unit: string): number | null {
  const n = toNumber(v);
  if (n === null || n <= -1) return null;
  return isPercentUnit(unit) || Math.abs(n) > 1 ? n / 100 : n;
}

/* ── bins ────────────────────────────────────────────────────────────────── */

/** A bin as written: either bound may be open. */
interface RawBin {
  readonly lo: number | null;
  readonly hi: number | null;
  readonly weight: number;
}

/**
 * One bin's bounds from its key: "3.5-4.5", "3.5 to 4.5", "4.25", the open
 * "<3", "<=3", "under 3", "7+", ">7", and the file's spelling of the same,
 * "lt_3", "le_60", "3_to_4", "ge_6", "gt_10y" (a trailing unit letter, the
 * "y" of years, is the key's unit, which the reader takes from the entry).
 */
function binOf(key: string): { lo: number | null; hi: number | null } | null {
  const k = key
    .trim()
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/^(?:lt|le)_/, "<")
    .replace(/^(?:gt|ge)_/, ">")
    .replace(/_to_/, "-")
    .replace(/(\d)[a-z]+$/, "$1")
    .replace(/\s+/g, " ");
  const N = "(-?\\d+(?:\\.\\d+)?)";
  let m = new RegExp(`^${N}\\s*(?:-|to)\\s*${N}$`, "i").exec(k);
  if (m) return { lo: Number(m[1]), hi: Number(m[2]) };
  m = new RegExp(`^(?:<=?|under |below |up to )\\s*${N}$`, "i").exec(k);
  if (m) return { lo: null, hi: Number(m[1]) };
  m = new RegExp(`^(?:>=?|over |above )\\s*${N}$`, "i").exec(k);
  if (m) return { lo: Number(m[1]), hi: null };
  m = new RegExp(`^${N}\\s*\\+$`).exec(k);
  if (m) return { lo: Number(m[1]), hi: null };
  m = new RegExp(`^${N}$`).exec(k);
  if (m) return { lo: Number(m[1]), hi: Number(m[1]) };
  return null;
}

/** A distribution's bins as written, from an object of bin → weight or an array of rows. */
function rawBins(v: unknown): RawBin[] | null {
  const out: RawBin[] = [];
  const push = (lo: number | null, hi: number | null, w: unknown): boolean => {
    const n = toNumber(w);
    if (n === null || n < 0) return false;
    if (lo !== null && hi !== null && hi < lo) return false;
    out.push({ lo, hi, weight: n });
    return true;
  };
  if (Array.isArray(v)) {
    for (const row of v) {
      const o = record(row);
      if (!o) return null;
      const w = o["share"] ?? o["weight"] ?? o["value"] ?? o["pct"] ?? o["percent"];
      if (o["lo"] !== undefined || o["min"] !== undefined) {
        const lo = toNumber(o["lo"] ?? o["min"]);
        const hi = toNumber(o["hi"] ?? o["max"]);
        if (lo === null || hi === null || !push(lo, hi, w)) return null;
      } else {
        const b = binOf(String(o["bucket"] ?? o["bin"] ?? o["range"] ?? o["label"] ?? ""));
        if (!b || !push(b.lo, b.hi, w)) return null;
      }
    }
  } else {
    const o = record(v);
    if (!o) return null;
    for (const [k, w] of Object.entries(o)) {
      const b = binOf(k);
      if (!b || !push(b.lo, b.hi, w)) return null;
    }
  }
  return out.length > 0 ? out : null;
}

/** How a distribution's open bins are closed (`closeBins`). */
interface OpenRule {
  /** The least the quantity can be: a bin open below starts here (a loan's age starts at zero). */
  readonly floor?: number;
  /** The most it can be: a bin open above is a point here (Fannie Mae lends to 97 % loan-to-value). */
  readonly cap?: number;
  /** The distribution's mean as the file states it, which a single bin left open is stretched to give. */
  readonly average?: number | null;
}

const mid = (b: { lo: number; hi: number }) => (b.lo + b.hi) / 2;

/**
 * Closed bins, weights normalized to one. An open bin is closed in this
 * order: by the quantity's own limit where it has one (`floor`, `cap`);
 * then, when one bin is still open and the file states the distribution's
 * mean, by the bound that makes the bins' mean that average (each bin's mass
 * at its midpoint, so the bound is linear in the mean); otherwise as wide as
 * the nearest closed bin. Null when the bins cannot be closed, or the stated
 * mean cannot be reached by stretching the open bin outward.
 */
function closeBins(raw: readonly RawBin[] | null, rule: OpenRule = {}): Bin[] | null {
  if (!raw || raw.length === 0) return null;
  const bins = raw.map((b) => ({
    lo: b.lo ?? (rule.floor !== undefined ? rule.floor : null),
    hi: b.hi ?? (rule.cap !== undefined && b.lo !== null ? Math.max(rule.cap, b.lo) : null),
    weight: b.weight,
  }));
  const total = bins.reduce((s, b) => s + b.weight, 0);
  if (!(total > 0)) return null;
  const open = bins.filter((b) => b.lo === null || b.hi === null);
  const closed = bins.filter(
    (b): b is { lo: number; hi: number; weight: number } => b.lo !== null && b.hi !== null,
  );
  const average = rule.average ?? null;
  if (open.length === 1 && average !== null) {
    const b = open[0]!;
    const rest = closed.reduce((s, x) => s + x.weight * mid(x), 0);
    // average · total = rest + weight · (fixed + free) / 2, solved for the free bound.
    const fixed = (b.lo ?? b.hi)!;
    const free = (2 * (average * total - rest)) / b.weight - fixed;
    if (!Number.isFinite(free)) return null;
    if (b.lo === null) {
      if (!(free <= fixed)) return null;
      b.lo = free;
    } else {
      if (!(free >= fixed)) return null;
      b.hi = free;
    }
  } else if (open.length > 0) {
    // Widths are read before any open bin is closed, so the order they are closed in does not matter.
    const sorted = [...bins].sort((a, b) => (a.lo ?? a.hi)! - (b.lo ?? b.hi)!);
    const widths = sorted.map((n) =>
      n.lo !== null && n.hi !== null && n.hi > n.lo ? n.hi - n.lo : null,
    );
    for (const b of open) {
      const at = sorted.indexOf(b);
      let width: number | null = null;
      for (let d = 1; d < sorted.length && width === null; d++)
        width = widths[at - d] ?? widths[at + d] ?? null;
      if (width === null) return null;
      if (b.lo === null) b.lo = b.hi! - width;
      else b.hi = b.lo + width;
    }
  }
  return bins.map((b) => ({ lo: b.lo!, hi: b.hi!, weight: b.weight / total }));
}

/** Bins given as ratios (0.6-0.8) or as decimals (0.035) scaled up to percent. */
function scaled(raw: RawBin[] | null, below: number, by: number): RawBin[] | null {
  if (!raw) return null;
  const bounds = raw.flatMap((b) => [b.lo, b.hi]).filter((x): x is number => x !== null);
  if (!bounds.every((x) => x <= below)) return raw;
  return raw.map((b) => ({
    lo: b.lo === null ? null : b.lo * by,
    hi: b.hi === null ? null : b.hi * by,
    weight: b.weight,
  }));
}

/* ── the readers, one per kind of value ──────────────────────────────────── */

/** A date written as an ISO date, an ISO month, or the PMMS file's M/D/YYYY. */
function dateOf(d: unknown): PlainDate | null {
  if (typeof d !== "string") return null;
  const s = d.trim();
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  const iso = us
    ? `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`
    : /^\d{4}-\d{2}$/.test(s)
      ? `${s}-01`
      : s.slice(0, 10);
  try {
    return plainDate(iso);
  } catch {
    return null;
  }
}

/**
 * A dated series, oldest first: an object of date → value, an array of rows
 * or pairs, or the file's `{ columns, rows }`, where the columns name which
 * field of each row is the date ("week", "date") and which the rate.
 */
function series(v: unknown): { on: PlainDate; rate: number }[] | null {
  const out: { on: PlainDate; rate: number }[] = [];
  const add = (d: unknown, r: unknown): boolean => {
    const n = toNumber(r);
    const on = dateOf(d);
    if (on === null || n === null) return false;
    out.push({ on, rate: n });
    return true;
  };
  const o = record(v);
  if (o && Array.isArray(o["rows"])) {
    const cols = Array.isArray(o["columns"])
      ? o["columns"].map((c) => String(c))
      : ["date", "rate"];
    const di = cols.findIndex((c) => /week|date|month|^on$/i.test(c));
    const ri = cols.findIndex((c) => /rate|value/i.test(c));
    if (di < 0 || ri < 0) return null;
    for (const row of o["rows"] as unknown[])
      if (!Array.isArray(row) || !add(row[di], row[ri])) return null;
  } else if (Array.isArray(v)) {
    for (const row of v) {
      if (Array.isArray(row)) {
        if (!add(row[0], row[1])) return null;
      } else {
        const x = record(row);
        if (!x || !add(x["date"] ?? x["week"] ?? x["on"] ?? x["month"], x["rate"] ?? x["value"]))
          return null;
      }
    }
  } else if (o) {
    for (const [d, r] of Object.entries(o)) if (!add(d, r)) return null;
  } else return null;
  if (out.length === 0) return null;
  out.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  return out.every((x) => x.rate < 0.5) ? out.map((x) => ({ ...x, rate: x.rate * 100 })) : out;
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/**
 * Twelve probabilities per loan-month by calendar month, from an object keyed
 * by month ("01", "Jan") or year-month ("2024-08"), averaged by calendar
 * month. Values read as probabilities when the unit says so; otherwise they
 * are counts, and only their seasonal shape is kept, scaled to the default's
 * yearly mean.
 */
function seasonal(v: unknown, unit: string, fallbackMean: number): number[] | null {
  const o = record(v);
  if (!o) return null;
  const sums = new Array<number>(12).fill(0);
  const counts = new Array<number>(12).fill(0);
  for (const [k, w] of Object.entries(o)) {
    const n = toNumber(w);
    if (n === null || n < 0) return null;
    let m = -1;
    const key = k.trim().toLowerCase();
    if (/^\d{4}-\d{2}/.test(key)) m = Number(key.slice(5, 7)) - 1;
    else if (/^\d{1,2}$/.test(key)) m = Number(key) - 1;
    else m = MONTH_NAMES.indexOf(key.slice(0, 3));
    if (m < 0 || m > 11) return null;
    sums[m]! += n;
    counts[m]! += 1;
  }
  if (counts.some((c) => c === 0)) return null;
  const avg = sums.map((s, i) => s / counts[i]!);
  if (/share|probab|fraction|per loan/i.test(unit) && avg.every((x) => x <= 1))
    return avg.map((x) => (isPercentUnit(unit) ? x / 100 : x));
  const mean = avg.reduce((s, x) => s + x, 0) / 12;
  if (!(mean > 0)) return null;
  return avg.map((x) => (x / mean) * fallbackMean);
}

/**
 * The file's OpenFEMA counts, `{ months, major_disaster_individual_assistance_areas, … }`,
 * as a probability per loan-month by calendar month.
 *
 * The hazard the generator draws is a declaration covering the loan, which
 * is what opens disaster relief on a Fannie Mae loan: a major disaster with
 * Individual Assistance in the loan's county. So the series read is the
 * designated areas under such declarations, and the rest (declarations
 * counted by state, emergencies, fire management) are not. A county's chance
 * of a designation in a month is that month's designated areas over
 * `COUNTIES`, averaged over the years by calendar month. A month in which
 * more than a fifth of the counties were designated at once is a nationwide
 * declaration and not a hazard to a house, and is left out: in this series,
 * March and April 2020, the COVID-19 declarations, 2,077 and 2,045 areas
 * against a largest other month of 199.
 */
function declarationAreas(v: unknown): number[] | null {
  const o = record(v);
  if (!o || !Array.isArray(o["months"])) return null;
  const months = o["months"] as unknown[];
  const areas = o["major_disaster_individual_assistance_areas"];
  if (!Array.isArray(areas) || areas.length !== months.length) return null;
  const sums = new Array<number>(12).fill(0);
  const counts = new Array<number>(12).fill(0);
  for (let i = 0; i < months.length; i++) {
    const m = typeof months[i] === "string" ? /^\d{4}-(\d{2})$/.exec(months[i] as string) : null;
    const n = toNumber(areas[i]);
    if (!m || n === null || n < 0) return null;
    if (n > COUNTIES / 5) continue;
    const k = Number(m[1]) - 1;
    if (k < 0 || k > 11) return null;
    sums[k]! += n / COUNTIES;
    counts[k]! += 1;
  }
  if (counts.some((c) => c === 0)) return null;
  return sums.map((s, k) => s / counts[k]!);
}

/** The days inside grace, as `payment.day_of_month` reads them: each bin's share and its run of days. */
interface WithinGrace {
  /** Weights over the days 2 to 16 of the due month (index 0 = day 2). */
  readonly within: number[];
  /** Each bin's run of days, clipped to days 2 to 16, in order. */
  readonly bins: (readonly [number, number])[];
}

/**
 * Days 2 to 16 from bins of whole days, each `[first, last, share]`. A bin
 * holds each of its days, and its share is spread evenly over all of them;
 * only days 2 to 16 are kept, normalized to one, and each bin's run inside
 * them is kept beside the weights.
 */
function withinGrace(days: readonly (readonly [number, number, number])[]): WithinGrace | null {
  const w = new Array<number>(15).fill(0);
  const bins: [number, number][] = [];
  for (const [first, last, share] of days) {
    if (last < first) continue;
    const per = share / (last - first + 1);
    const a = Math.max(2, first);
    const b = Math.min(16, last);
    for (let d = a; d <= b; d++) w[d - 2]! += per;
    if (a <= b) bins.push([a, b]);
  }
  const total = w.reduce((s, x) => s + x, 0);
  if (!(total > 0)) return null;
  bins.sort((x, y) => x[0] - y[0]);
  return { within: w.map((x) => x / total), bins };
}

/** Days 2 to 16 from bins of plain days ("1-5", "6-10"). */
function dayWeights(v: unknown): WithinGrace | null {
  const raw = rawBins(v);
  if (!raw || raw.some((b) => b.lo === null || b.hi === null)) return null;
  return withinGrace(raw.map((b) => [Math.ceil(b.lo!), Math.floor(b.hi!), b.weight] as const));
}

/** Where a named arrival bin falls: before the due day, on it, a run of days of the due month, or not in it. */
function arrivalBin(
  key: string,
): { kind: "before" | "due" | "missed" } | { kind: "days"; first: number; last: number } | null {
  const k = key.trim().toLowerCase();
  if (k === "before_due") return { kind: "before" };
  if (k === "due_day") return { kind: "due" };
  if (k === "not_in_month") return { kind: "missed" };
  let m = /^days?_(\d+)$/.exec(k);
  if (m) return { kind: "days", first: Number(m[1]), last: Number(m[1]) };
  m = /^days_(\d+)_to_(\d+)$/.exec(k);
  if (m && Number(m[1]) <= Number(m[2]))
    return { kind: "days", first: Number(m[1]), last: Number(m[2]) };
  m = /^days_(\d+)_to_month_end$/.exec(k);
  if (m) return { kind: "days", first: Number(m[1]), last: 31 };
  return null;
}

interface DayOfMonth extends WithinGrace {
  readonly early_share: number | null;
}

/**
 * `payment.day_of_month`. The file's shape is
 * `{ due_day, grace_days, arrival_share: { before_due, due_day, days_2_to_5, …, not_in_month } }`:
 * the share of installments arriving in each bin. The generator reads two
 * things from it. The shape inside grace: each bin's share spread evenly over
 * its days, and days 2 to 16 normalized to one, with each bin's run of days
 * kept so a payment drawn for a day off arrives on a business day of the
 * same bin and the book's bins stay the file's. And the split around the due
 * day: of the installments paid by it, the share paid before it,
 * before_due / (before_due + due_day), which is the share of borrowers drawn
 * in the habit of paying early. The bins from day 17 on, and the month
 * missed, it does not draw from: the late and missed shares have keys of
 * their own, which the file holds equal to sums of these bins. A due day
 * other than the first, or grace other than fifteen days, is not the
 * generator's note and is not read. Bins of plain days ("1-5") give the shape
 * inside grace and no split.
 */
function dayOfMonth(v: unknown): DayOfMonth | null {
  const o = record(v);
  const bins = o ? record(o["arrival_share"]) : null;
  if (!o || !bins) {
    const plain = dayWeights(v);
    return plain ? { ...plain, early_share: null } : null;
  }
  if (o["due_day"] !== undefined && toNumber(o["due_day"]) !== DUE_DAY) return null;
  if (o["grace_days"] !== undefined && toNumber(o["grace_days"]) !== GRACE_DAYS) return null;
  const days: [number, number, number][] = [];
  let before: number | null = null;
  let due: number | null = null;
  for (const [k, x] of Object.entries(bins)) {
    const b = arrivalBin(k);
    const n = toNumber(x);
    if (!b || n === null || n < 0) return null;
    if (b.kind === "before") before = n;
    else if (b.kind === "due") due = n;
    else if (b.kind === "days") days.push([b.first, b.last, n]);
  }
  const grace = withinGrace(days);
  if (!grace) return null;
  const early =
    before !== null && due !== null && before + due > 0 ? before / (before + due) : null;
  return { ...grace, early_share: early };
}

/** A mix of reasons and their shares, normalized to one. */
function mix(v: unknown): [string, number][] | null {
  const o = record(v);
  if (!o) return null;
  const out: [string, number][] = [];
  for (const [k, w] of Object.entries(o)) {
    const n = toNumber(w);
    if (n === null || n < 0) return null;
    out.push([k, n]);
  }
  const total = out.reduce((s, [, w]) => s + w, 0);
  return out.length && total > 0 ? out.map(([k, w]) => [k, w / total]) : null;
}

/** Per field: a share, or the file's `{ rate, per, field }`, whose rate is per unit `per` names. */
function rateMap(v: unknown, unit: string): Record<string, number> | null {
  if (typeof v === "number") return { "*": share(v, unit) ?? 0 };
  const o = record(v);
  if (!o) return null;
  const out: Record<string, number> = {};
  for (const [k, w] of Object.entries(o)) {
    const row = record(w);
    const s = within01(share(row ? row["rate"] : w, unit));
    if (s === null) return null;
    out[k] = s;
  }
  return out;
}

/* ── delinquency: the monthly chain and its quarter ──────────────────────── */

/** A transition as the file states it: over one month or over a quarter. */
interface Stated {
  readonly months: 1 | 3;
  readonly value: number;
}

/**
 * What the generator's monthly chain gives a quarter later, from a month-end.
 *
 * The chain: each month a current borrower misses with `roll` and falls one
 * payment behind; a borrower who is behind pays everything owed with `cure`,
 * misses again with `rollAgain` (one further behind), and otherwise pays the
 * oldest installment and stays as far behind (simulate.ts). Whether a loan is
 * current or behind is then a two-state chain leaving current at `roll` and
 * behind at `cure`, and its three-month step is the standard one:
 *
 *   behind → current   = cure / (roll + cure) · (1 − (1 − roll − cure)³)
 *   current → behind   = roll / (roll + cure) · (1 − (1 − roll − cure)³)
 *
 * Of the loans current → behind, the ones three payments behind missed all
 * three months, roll · rollAgain², and the rest are one or two behind: 30 to
 * 60 days late, the bucket the New York Fed reports.
 */
export function quarterAhead(
  roll: number,
  cure: number,
  rollAgain: number,
): { current_to_30_60: number; behind_to_current: number; current_to_90_plus: number } {
  const x = roll + cure;
  const reach = x > 1e-12 ? (1 - Math.pow(1 - x, 3)) / x : 3;
  return {
    current_to_30_60: roll * reach - roll * rollAgain * rollAgain,
    behind_to_current: cure * reach,
    current_to_90_plus: roll * rollAgain * rollAgain,
  };
}

/** The x in [lo, hi] where an increasing f crosses zero, or null when it does not. */
function bisect(f: (x: number) => number, lo: number, hi: number): number | null {
  if (f(lo) > 0 || f(hi) < 0) return null;
  for (let i = 0; i < 200 && hi - lo > 1e-17; i++) {
    const m = (lo + hi) / 2;
    if (f(m) < 0) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/**
 * The monthly roll and cure the generator draws, from the file's figures.
 *
 * A monthly figure is used as it is. A quarterly one (the New York Fed's
 * transition rates: the share of accounts current at one quarter end that are
 * 30 to 60 days late at the next, and the share 30 to 60 days late that are
 * current) is the monthly value whose quarter, by `quarterAhead`, is the
 * stated figure, with the roll from behind (`rollAgain`, monthly) as given.
 * Dividing by three would be wrong: a loan that falls behind and catches up
 * inside the quarter is in neither quarter-end count, so the monthly roll is
 * more than a third of the quarterly one, and the monthly cure that leaves
 * 41 % current a quarter later is near 16 %, more than a third of 41 %. With
 * both quarterly, each is solved holding the other, by bisection, until
 * neither moves.
 */
export function monthlyChain(
  roll: Stated,
  cure: Stated,
  rollAgain: number,
): { roll: number; cure: number } | null {
  let p = roll.months === 1 ? roll.value : roll.value / 3;
  let c = cure.months === 1 ? cure.value : 1 - Math.pow(1 - cure.value, 1 / 3);
  for (let k = 0; k < 200; k++) {
    const p0 = p;
    const c0 = c;
    if (cure.months === 3) {
      const pp = p;
      const next = bisect(
        (x) => quarterAhead(pp, x, rollAgain).behind_to_current - cure.value,
        0,
        1 - p,
      );
      if (next === null) return null;
      c = next;
    }
    if (roll.months === 3) {
      const cc = c;
      const next = bisect(
        (x) => quarterAhead(x, cc, rollAgain).current_to_30_60 - roll.value,
        0,
        1 - c,
      );
      if (next === null) return null;
      p = next;
    }
    if (Math.abs(p - p0) < 1e-15 && Math.abs(c - c0) < 1e-15) break;
  }
  const q = quarterAhead(p, c, rollAgain);
  if (roll.months === 3 && Math.abs(q.current_to_30_60 - roll.value) > 1e-9) return null;
  if (cure.months === 3 && Math.abs(q.behind_to_current - cure.value) > 1e-9) return null;
  return { roll: p, cure: c };
}

/**
 * A transition as stated: a bare share per month (or per year, made monthly),
 * or the file's quarterly object
 * `{ horizon: "one quarter", latest, trailing_8_quarters, trailing_8_quarter_mean }`,
 * from which the field `field` is read: the eight-quarter mean, else the
 * mean of the quarters listed, else the latest. The mean and not the latest,
 * because one quarter moves (0.69 % to 1.00 % over the eight for the roll),
 * and the acceptance test holds a book to the mean.
 */
function transition(field: RegExp) {
  return (v: unknown, unit: string): Stated | null => {
    const o = record(v);
    if (!o) {
      if (isQuarterlyUnit(unit)) {
        const s = within01(share(v, unit));
        return s === null ? null : { months: 3, value: s };
      }
      const m = monthly(v, unit);
      return m === null ? null : { months: 1, value: m };
    }
    const horizon = typeof o["horizon"] === "string" ? (o["horizon"] as string) : unit;
    const months = isQuarterlyUnit(horizon) ? 3 : isMonthlyUnit(horizon) ? 1 : null;
    if (months === null) return null;
    const pick = (row: unknown): number | null => {
      const r = record(row);
      if (!r) return null;
      const k = Object.keys(r).find((x) => field.test(x));
      return k === undefined ? null : within01(toNumber(r[k]));
    };
    const meanKey = Object.keys(o).find((k) => /^trailing_\d+_quarter_mean$/.test(k));
    let x = meanKey !== undefined ? pick(o[meanKey]) : null;
    if (x === null) {
      const rowsKey = Object.keys(o).find((k) => /^trailing_\d+_quarters$/.test(k));
      const rows =
        rowsKey !== undefined && Array.isArray(o[rowsKey]) ? (o[rowsKey] as unknown[]) : [];
      const picked = rows.map(pick);
      if (picked.length > 0 && picked.every((p) => p !== null))
        x = (picked as number[]).reduce((s, p) => s + p, 0) / picked.length;
    }
    if (x === null) x = pick(o["latest"]);
    return x === null ? null : { months, value: x };
  };
}

/* ── the reader ──────────────────────────────────────────────────────────── */

/** The default path: beside this module in src, and from dist the source file it was built from. */
function defaultPaths(): string[] {
  const here = import.meta.url;
  return [
    new URL("./calibration.json", here),
    new URL("../../src/life/calibration.json", here),
  ].map((u) => fileURLToPath(u));
}

export interface LoadOptions {
  /** A file to read instead of the default path; a path that does not exist means every default. */
  readonly path?: string;
  /** A calibration already in memory, read as the file would be. */
  readonly file?: CalibrationFile;
}

const DEFAULT_ARRIVAL = record(
  record(DEFAULT_CALIBRATION.rates["payment.day_of_month"]!.value)!["arrival_share"],
)!;
/** The default's split around the due day, for a value that does not say how on-time payments fall around it. */
const DEFAULT_EARLY_SHARE =
  (DEFAULT_ARRIVAL["before_due"] as number) /
  ((DEFAULT_ARRIVAL["before_due"] as number) + (DEFAULT_ARRIVAL["due_day"] as number));

/** Read the calibration: the file when present, each unreadable or missing key replaced by its default. */
export function loadCalibration(o: LoadOptions = {}): Calibration {
  const warnings: string[] = [];
  let file: CalibrationFile | null = o.file ?? null;
  let path: string | null = null;
  if (!file) {
    for (const p of o.path !== undefined ? [o.path] : defaultPaths()) {
      let text: string;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      try {
        const parsed = JSON.parse(text) as unknown;
        if (
          !parsed ||
          typeof parsed !== "object" ||
          typeof (parsed as CalibrationFile).rates !== "object"
        )
          throw new Error("no rates object");
        file = parsed as CalibrationFile;
        path = p;
      } catch (e) {
        warnings.push(
          `${p}: not a calibration file (${(e as Error).message}); every key is its default`,
        );
      }
      break;
    }
  }
  const rates = file?.rates ?? {};
  for (const k of Object.keys(rates))
    if (!(CALIBRATION_KEYS as readonly string[]).includes(k))
      warnings.push(`${k}: not a calibration key; ignored`);

  const entries = {} as Record<
    CalibrationKey,
    { used: "file" | "default"; kind: "public" | "design_choice"; source: string; unit: string }
  >;
  const useDefault = (key: CalibrationKey) => {
    entries[key] = {
      used: "default",
      kind: "design_choice",
      source: "none",
      unit: DEFAULT_CALIBRATION.rates[key]!.unit,
    };
  };
  const fromDefault = <T>(
    key: CalibrationKey,
    parse: (v: unknown, unit: string) => T | null,
  ): T => {
    const d = DEFAULT_CALIBRATION.rates[key]!;
    const v = parse(d.value, d.unit);
    if (v === null) throw new Error(`the default for ${key} does not parse`);
    return v;
  };
  const read = <T>(key: CalibrationKey, parse: (v: unknown, unit: string) => T | null): T => {
    const e = rates[key];
    if (e && typeof e === "object") {
      const unit = typeof e.unit === "string" ? e.unit : "";
      const v = parse(e.value, unit);
      if (v !== null) {
        entries[key] = {
          used: "file",
          kind: e.kind === "public" ? "public" : "design_choice",
          source: typeof e.source === "string" ? e.source : "none",
          unit,
        };
        return v;
      }
      warnings.push(
        `${key}: value ${JSON.stringify(e.value)} in "${unit}" could not be read; the default is used`,
      );
    } else if (file) warnings.push(`${key}: missing from the file; the default is used`);
    useDefault(key);
    return fromDefault(key, parse);
  };

  const shareIn01 = (v: unknown, u: string) => within01(share(v, u));
  /** A figure, or the named field of an object holding it. */
  const field =
    <T>(name: string, inner: (v: unknown, u: string) => T | null) =>
    (v: unknown, u: string): T | null => {
      const r = record(v);
      return inner(r ? r[name] : v, u);
    };
  const minutes = (n: number | null, u: string) =>
    n !== null && n > 0 ? (/second/i.test(u) ? n / 60 : n) : null;

  // The roll and cure are read as stated and converted together, because a quarter's figure depends on both.
  const rollStated = read("delinquency.roll_current_to_30", transition(/^to_30/));
  const cureStated = read("delinquency.cure_from_30", transition(/^to_current$/));
  const rollAgain = read("delinquency.roll_30_to_60", monthly);
  let chain = monthlyChain(rollStated, cureStated, rollAgain);
  if (chain === null) {
    warnings.push(
      `delinquency.roll_current_to_30, delinquency.cure_from_30: no monthly roll and cure give the quarter stated beside a roll from behind of ${rollAgain}; the defaults are used`,
    );
    useDefault("delinquency.roll_current_to_30");
    useDefault("delinquency.cure_from_30");
    chain = monthlyChain(
      fromDefault("delinquency.roll_current_to_30", transition(/^to_30/)),
      fromDefault("delinquency.cure_from_30", transition(/^to_current$/)),
      rollAgain,
    )!;
  }

  const day = read("payment.day_of_month", dayOfMonth);
  const partial = read("payment.partial_share", (v, u) => {
    // The file's `{ partial_receipt_share, returned_receipt_share }`: short receipts are drawn, returned ones kept.
    const r = record(v);
    if (!r) {
      const s = shareIn01(v, u);
      return s === null ? null : { partial: s, returned: 0 };
    }
    const s = shareIn01(r["partial_receipt_share"], u);
    const ret =
      r["returned_receipt_share"] === undefined ? 0 : shareIn01(r["returned_receipt_share"], u);
    return s === null || ret === null ? null : { partial: s, returned: ret };
  });

  const defaultDisasterMean =
    Object.values(
      DEFAULT_CALIBRATION.rates["disaster.declarations_by_month"]!.value as Record<string, number>,
    ).reduce((s, x) => s + x, 0) / 12;

  const r: Rates = {
    delinquency: {
      conventional_30plus_share: read("delinquency.conventional_30plus_share", shareIn01),
      // MBA's object: its seasonally adjusted total (the buckets add to it), or their sum when no total is given.
      all_loans_30plus_share_sa: read("delinquency.all_loans_30plus_share_sa", (v, u) => {
        const o = record(v);
        if (!o) return shareIn01(v, u);
        if (o["total"] !== undefined) return shareIn01(o["total"], u);
        const b = record(o["by_bucket"]);
        const parts = b ? Object.values(b).map((x) => shareIn01(x, u)) : [];
        return parts.length > 0 && parts.every((x) => x !== null)
          ? within01((parts as number[]).reduce((s, x) => s + x, 0))
          : null;
      }),
      roll_current_to_30: chain.roll,
      cure_from_30: chain.cure,
      roll_30_to_60: rollAgain,
    },
    payment: {
      day_of_month: day.within,
      day_of_month_bins: day.bins,
      early_share: day.early_share ?? DEFAULT_EARLY_SHARE,
      late_within_grace_share: read("payment.late_within_grace_share", shareIn01),
      late_after_grace_share: read("payment.late_after_grace_share", shareIn01),
      partial_share: partial.partial,
      returned_share: partial.returned,
      curtailment_share: read("payment.curtailment_share", shareIn01),
      missed_month_share: read("payment.missed_month_share", shareIn01),
    },
    contacts: {
      // The CFPB's inquiries per loan-year, `inquiries_per_loan_year`, as stated: 28 million inquiries over 21
      // million loans in eight months, made a year.
      per_loan_year: read("contacts.per_loan_year", (v, u) => {
        const o = record(v);
        const n = toNumber(o ? (o["inquiries_per_loan_year"] ?? o["per_loan_year"]) : v);
        if (n === null || n < 0) return null;
        return isMonthlyUnit(u) && !isAnnualUnit(u) ? n * 12 : n;
      }),
      // A range of averages, `{ min, max }`, is centered at its geometric midpoint √(min · max): a call's time is
      // spread multiplicatively around it (simulate.ts), and the midpoint is as far from each end by ratio.
      handle_time_minutes: read("contacts.handle_time_minutes", (v, u) => {
        const o = record(v);
        if (!o) return minutes(toNumber(v), u);
        const lo = toNumber(o["min"]);
        const hi = toNumber(o["max"]);
        if (lo !== null && hi !== null)
          return lo > 0 && hi >= lo ? minutes(Math.sqrt(lo * hi), u) : null;
        return minutes(toNumber(o["mean"] ?? o["average"] ?? o["median"]), u);
      }),
      // The complaint database's `counts` over their total (its `shares` are those rounded to four places), else
      // the shares, else a flat mix.
      inbound_reason_mix: read("contacts.inbound_reason_mix", (v) => {
        const o = record(v);
        if (!o) return null;
        return mix(record(o["counts"]) ?? record(o["shares"]) ?? o);
      }),
    },
    escrow: {
      share_of_loans: read("escrow.share_of_loans", shareIn01),
      // The ACS medians for units with a mortgage, `with_mortgage_usd`: every loan the generator draws has one.
      tax_annual_median_cents: read("escrow.tax_annual_median", field("with_mortgage_usd", cents)),
      insurance_annual_median_cents: read(
        "escrow.insurance_annual_median",
        field("with_mortgage_usd", cents),
      ),
      tax_growth_yoy: read("escrow.tax_growth_yoy", growthOf),
      insurance_growth_yoy: read("escrow.insurance_growth_yoy", growthOf),
    },
    // NMDB's share of loans by count, `loans`: the acceptance test holds the book to it. The Enterprise share alone
    // (`loans_by_market.enterprise`) is lower; the generator's ARMs are Fannie Mae's, and the book follows the test.
    arm: { share_of_outstanding: read("arm.share_of_outstanding", field("loans", shareIn01)) },
    mi: { share_of_loans: read("mi.share_of_loans", miShare) },
    book: {
      // NMDB's outstanding loans by count, `loans`. Its two open bins (under 3, 6 and over) are a point wide like their
      // neighbors; the bins' mean is then 4.39, the stated average 4.4 to its rounding.
      note_rate: read("book.note_rate_distribution", (v) => {
        const o = record(v);
        const nested = o ? record(o["loans"]) : null;
        if (nested) return closeBins(rawBins(nested), { average: toNumber(o!["average_pct"]) });
        return closeBins(scaled(rawBins(v), 0.5, 100));
      }),
      ltv: read("book.ltv_distribution", ltvAtOrigination),
      loan_age_months: read("book.loan_age_distribution", (v, u) => {
        const years = /year/i.test(u);
        const o = record(v);
        const nested = o ? record(o["loans"]) : null;
        const raw = rawBins(nested ?? v);
        const months = raw?.map((b) =>
          years
            ? {
                lo: b.lo === null ? null : b.lo * 12,
                hi: b.hi === null ? null : b.hi * 12,
                weight: b.weight,
              }
            : b,
        );
        const avg = nested ? toNumber(record(o!["average_months"])?.["loans"]) : null;
        return closeBins(months ?? null, { floor: 0, average: avg });
      }),
    },
    refi: { pmms_30y: read("refi.pmms_30y_series", (v) => series(v)) },
    disaster: {
      by_calendar_month: read("disaster.declarations_by_month", (v, u) =>
        record(v)?.["months"] !== undefined
          ? declarationAreas(v)
          : seasonal(v, u, defaultDisasterMean),
      ),
    },
    transfer: { annual_rate: read("transfer.annual_rate", annual) },
    defects: { field_error_rates: read("defects.field_error_rates", rateMap) },
  };
  const version =
    file && typeof file.version === "string" ? file.version : DEFAULT_CALIBRATION.version;
  return { version, path, rates: r, entries, warnings };
}

/**
 * A year-over-year change. From the file's object, the compound annual change
 * between the oldest and newest medians it lists,
 * (newest / oldest)^(1 / years) − 1: the ACS medians are of different
 * households each year, so the span says more than the latest year alone.
 * Without medians, an `annualized_…` figure, else the mean of `by_year`.
 */
function growthOf(v: unknown, unit: string): number | null {
  const o = record(v);
  if (!o) return growthShare(v, unit);
  const mk = Object.keys(o).find((k) => /^medians/.test(k) && record(o[k]));
  if (mk !== undefined) {
    const pts = Object.entries(record(o[mk])!)
      .map(([y, x]) => [Number(y), toNumber(x)] as const)
      .filter(
        (p): p is readonly [number, number] => Number.isInteger(p[0]) && p[1] !== null && p[1] > 0,
      )
      .sort((a, b) => a[0] - b[0]);
    if (pts.length >= 2) {
      const [y0, m0] = pts[0]!;
      const [y1, m1] = pts.at(-1)!;
      if (y1 > y0) return Math.pow(m1 / m0, 1 / (y1 - y0)) - 1;
    }
  }
  const ak = Object.keys(o).find((k) => /^annualized/.test(k));
  if (ak !== undefined) return growthShare(o[ak], unit);
  const by = record(o["by_year"]);
  if (by) {
    const xs = Object.values(by).map((x) => growthShare(x, unit));
    if (xs.length > 0 && xs.every((x) => x !== null))
      return (xs as number[]).reduce((s, x) => s + x, 0) / xs.length;
  }
  return null;
}

/**
 * The share of loans carrying mortgage insurance when they are drawn. The
 * generator originates Fannie Mae loans, and every one above 80 %
 * loan-to-value needs mortgage insurance at origination, so the file's figure
 * for that is the share of the newest year's Enterprise originations over 80
 * CLTV, `enterprise_originations_<year>_cltv_over_80`. Its other figures are
 * of seasoned books by balance, whose insurance has partly been canceled; the
 * generator's own termination sweep does that over a loan's life.
 */
function miShare(v: unknown, unit: string): number | null {
  const o = record(v);
  if (!o) return within01(share(v, unit));
  const keys = Object.keys(o)
    .map((k) => [k, /^enterprise_originations_(\d{4})_cltv_over_80$/.exec(k)?.[1]] as const)
    .filter((p): p is readonly [string, string] => p[1] !== undefined)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const k = keys.at(-1)?.[0];
  return k === undefined ? null : within01(share(o[k], unit));
}

/**
 * Loan-to-value at origination, which is what the generator draws (the value
 * is the balance over it, and insurance is required above 80). From the
 * file's object, the `at_origination_…` bins (`cltv_loans`, 2025 Enterprise
 * acquisitions by count); its mark-to-market bins are of a seasoned book after
 * house prices moved, which the generator does not model. The open bin above
 * 97 is a point at 97, Fannie Mae's ceiling; the open bin at or under 70 runs
 * down to the bound that makes the bins' mean the stated average LTV (73.3,
 * which puts it near 39.7). The bins are combined LTV and the average is LTV,
 * which a second lien sets apart; few new loans carry one.
 */
function ltvAtOrigination(v: unknown): Bin[] | null {
  const o = record(v);
  const at = o
    ? Object.keys(o)
        .filter((k) => /^at_origination/.test(k))
        .map((k) => record(o[k]))
        .find((x) => x !== null)
    : undefined;
  // Not the file's shape: plain bins or rows, as percents or ratios.
  if (!at) return closeBins(scaled(rawBins(v), 2, 100), { cap: LTV_CEILING });
  const bk = Object.keys(at).find((k) => /ltv_loans$/.test(k) && record(at[k]));
  if (bk === undefined) return null;
  return closeBins(scaled(rawBins(at[bk]), 2, 100), {
    cap: LTV_CEILING,
    average: toNumber(at["average_ltv_pct"] ?? at["average_pct"]),
  });
}

/** The calibration with every key at its default, whatever is on disk. */
export const defaultCalibration = (): Calibration => loadCalibration({ path: "" });
