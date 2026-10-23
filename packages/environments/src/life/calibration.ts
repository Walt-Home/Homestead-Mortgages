/**
 * The rates the life generator draws from, read from `calibration.json`.
 *
 * The file is another builder's, shaped
 * `{ version, rates: { "<key>": { value, unit, kind, source, fetched, terms, note } } }`
 * over exactly the keys in `CALIBRATION_KEYS`. This module reads it and never
 * writes it. A value is normalized by its unit (a percent becomes a share, an
 * annual rate a monthly one where a monthly one is drawn, dollars become
 * cents), and a distribution may be written as bins ("3.5-4.5"), open bins
 * ("<3", "7+"), single points, or an array of rows. A key the file lacks, or
 * whose value cannot be read, takes the typed default below, and the reason
 * is kept in `warnings`; the generator never stops on a calibration it cannot
 * read. Without the file every key is its default.
 *
 * Every default is a design choice with no source: the public figures are the
 * calibration builder's to fetch, and none was fetched here. Each says why it
 * is the number it is.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { plainDate, type PlainDate } from "@hm/kernel/calendar";

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
    /** Share of conventional loans 30+ days delinquent at a month-end: a check, never a draw. */
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
    readonly late_within_grace_share: number;
    readonly late_after_grace_share: number;
    readonly partial_share: number;
    readonly curtailment_share: number;
    /** Share of loan-months with no payment: a check, never a draw. */
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
    /** Loan-to-value in percent. */
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
        "2": 12,
        "3": 10,
        "4": 9,
        "5": 9,
        "6": 8,
        "7": 7,
        "8": 7,
        "9": 6,
        "10": 6,
        "11": 5,
        "12": 5,
        "13": 4,
        "14": 4,
        "15": 4,
        "16": 4,
      },
      "relative weight by day of the due month",
      "Payments inside the grace period bunch early in it.",
    ),
    "payment.late_within_grace_share": DESIGN(
      0.3,
      "share of payments",
      "Paid after the due date and inside the 15-day grace period.",
    ),
    "payment.late_after_grace_share": DESIGN(
      0.025,
      "share of payments",
      "Paid after the grace period, so a late charge is assessed.",
    ),
    "payment.partial_share": DESIGN(
      0.01,
      "share of payments",
      "A payment sent in two pieces a few weeks apart.",
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

/* ── unit handling ───────────────────────────────────────────────────────── */

const isPercentUnit = (u: string) => /percent|pct|%|basis|bps/i.test(u);
const isAnnualUnit = (u: string) => /year|annual|yoy|per\s*yr/i.test(u);
const isMonthlyUnit = (u: string) => /month/i.test(u);
const toNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim())))
    return Number(v.trim());
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["value", "share", "rate", "weight", "mean", "median", "p50"]) {
      const n = toNumber(o[k]);
      if (n !== null) return n;
    }
  }
  return null;
};

/** A share in [0, 1]: a percent is divided by 100, basis points by 10,000, and a bare number above 1 is read as a percent. */
function share(v: unknown, unit: string): number | null {
  const n = toNumber(v);
  if (n === null || n < 0) return null;
  if (/bps|basis/i.test(unit)) return n / 10_000;
  if (isPercentUnit(unit) || n > 1) return n / 100;
  return n;
}

/** A monthly probability from a share stated per month or per year. */
function monthly(v: unknown, unit: string): number | null {
  const s = share(v, unit);
  if (s === null || s > 1) return null;
  return isAnnualUnit(unit) && !isMonthlyUnit(unit) ? 1 - Math.pow(1 - s, 1 / 12) : s;
}

/** An annual probability from a share stated per year or per month. */
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

/** One bin from a key such as "3.5-4.5", "3.5 to 4.5", "<3", "<=3", "7+", ">7", "4.25". */
function binOf(key: string, step: number): { lo: number; hi: number } | null {
  const k = key.trim().replace(/[–—]/g, "-").replace(/\s+/g, " ");
  let m = /^(-?[\d.]+)\s*(?:-|to)\s*(-?[\d.]+)$/i.exec(k);
  if (m) return { lo: Number(m[1]), hi: Number(m[2]) };
  m = /^(?:<=?|under |below |up to )\s*(-?[\d.]+)$/i.exec(k);
  if (m) return { lo: Number(m[1]) - step, hi: Number(m[1]) };
  m = /^(?:>=?|over |above )\s*(-?[\d.]+)$/i.exec(k);
  if (m) return { lo: Number(m[1]), hi: Number(m[1]) + step };
  m = /^(-?[\d.]+)\s*\+$/.exec(k);
  if (m) return { lo: Number(m[1]), hi: Number(m[1]) + step };
  m = /^(-?[\d.]+)$/.exec(k);
  if (m) return { lo: Number(m[1]), hi: Number(m[1]) };
  return null;
}

/** A distribution as bins, from an object of bin → weight or an array of rows. */
function bins(v: unknown, step: number): Bin[] | null {
  const out: Bin[] = [];
  const add = (key: string, w: unknown) => {
    const b = binOf(key, step);
    const n = toNumber(w);
    if (
      !b ||
      n === null ||
      n < 0 ||
      !Number.isFinite(b.lo) ||
      !Number.isFinite(b.hi) ||
      b.hi < b.lo
    )
      return false;
    out.push({ ...b, weight: n });
    return true;
  };
  if (Array.isArray(v)) {
    for (const row of v) {
      if (!row || typeof row !== "object") return null;
      const o = row as Record<string, unknown>;
      const w = o["share"] ?? o["weight"] ?? o["value"] ?? o["pct"] ?? o["percent"];
      if (o["lo"] !== undefined || o["min"] !== undefined) {
        const lo = toNumber(o["lo"] ?? o["min"]);
        const hi = toNumber(o["hi"] ?? o["max"]);
        const n = toNumber(w);
        if (lo === null || hi === null || n === null || hi < lo) return null;
        out.push({ lo, hi, weight: n });
      } else if (!add(String(o["bucket"] ?? o["bin"] ?? o["range"] ?? o["label"] ?? ""), w))
        return null;
    }
  } else if (v && typeof v === "object") {
    for (const [k, w] of Object.entries(v as Record<string, unknown>)) if (!add(k, w)) return null;
  } else return null;
  const total = out.reduce((s, b) => s + b.weight, 0);
  if (out.length === 0 || !(total > 0)) return null;
  return out.map((b) => ({ ...b, weight: b.weight / total }));
}

/** Scale bins given as ratios (0.6-0.8) or as decimals (0.035) up to percent. */
const scaled = (bs: Bin[] | null, below: number, by: number): Bin[] | null =>
  bs && bs.every((b) => b.hi <= below)
    ? bs.map((b) => ({ ...b, lo: b.lo * by, hi: b.hi * by }))
    : bs;

/** A dated series, oldest first, from an object of date → value or an array of rows or pairs. */
function series(v: unknown): { on: PlainDate; rate: number }[] | null {
  const out: { on: PlainDate; rate: number }[] = [];
  const add = (d: unknown, r: unknown): boolean => {
    const n = toNumber(r);
    if (typeof d !== "string" || n === null) return false;
    const iso = /^\d{4}-\d{2}$/.test(d) ? `${d}-01` : d.slice(0, 10);
    try {
      out.push({ on: plainDate(iso), rate: n });
      return true;
    } catch {
      return false;
    }
  };
  if (Array.isArray(v)) {
    for (const row of v) {
      if (Array.isArray(row)) {
        if (!add(row[0], row[1])) return null;
      } else if (row && typeof row === "object") {
        const o = row as Record<string, unknown>;
        if (!add(o["date"] ?? o["week"] ?? o["on"] ?? o["month"], o["rate"] ?? o["value"]))
          return null;
      } else return null;
    }
  } else if (v && typeof v === "object") {
    for (const [d, r] of Object.entries(v as Record<string, unknown>)) if (!add(d, r)) return null;
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
 * Twelve probabilities per loan-month by calendar month. Keys are months
 * ("01", "Jan") or year-months ("2024-08"), averaged by calendar month. Values
 * read as probabilities when the unit says so; otherwise they are counts, and
 * only their seasonal shape is kept, scaled to the default's yearly mean.
 */
function seasonal(v: unknown, unit: string, fallbackMean: number): number[] | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const sums = new Array<number>(12).fill(0);
  const counts = new Array<number>(12).fill(0);
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
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

/** Weights over the days 2 to 16 of the due month (index 0 = day 2). */
function dayWeights(v: unknown): number[] | null {
  if (!v || typeof v !== "object") return null;
  const w = new Array<number>(15).fill(0);
  const bs = bins(v, 1);
  if (!bs) return null;
  // A bin of whole days ("1-5") holds each of its days; its weight is spread over all of them, and only days 2 to 16 are kept.
  for (const b of bs) {
    const first = Math.ceil(b.lo);
    const last = Math.floor(b.hi);
    if (last < first) continue;
    const per = b.weight / (last - first + 1);
    for (let d = Math.max(2, first); d <= Math.min(16, last); d++) w[d - 2]! += per;
  }
  const total = w.reduce((s, x) => s + x, 0);
  return total > 0 ? w.map((x) => x / total) : null;
}

/** A mix of reasons and their shares. */
function mix(v: unknown): [string, number][] | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: [string, number][] = [];
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
    const n = toNumber(w);
    if (n === null || n < 0) return null;
    out.push([k, n]);
  }
  const total = out.reduce((s, [, w]) => s + w, 0);
  return out.length && total > 0 ? out.map(([k, w]) => [k, w / total]) : null;
}

function rateMap(v: unknown, unit: string): Record<string, number> | null {
  if (typeof v === "number") return { "*": share(v, unit) ?? 0 };
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
    const s = share(w, unit);
    if (s === null) return null;
    out[k] = s;
  }
  return out;
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
  const read = <T>(key: CalibrationKey, parse: (v: unknown, unit: string) => T | null): T => {
    const d = DEFAULT_CALIBRATION.rates[key]!;
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
    entries[key] = { used: "default", kind: "design_choice", source: "none", unit: d.unit };
    const v = parse(d.value, d.unit);
    if (v === null) throw new Error(`the default for ${key} does not parse`);
    return v;
  };
  const shareIn01 = (v: unknown, u: string) => {
    const s = share(v, u);
    return s !== null && s <= 1 ? s : null;
  };
  const positive = (v: unknown, u: string) => {
    const n = toNumber(v);
    return n !== null && n > 0 ? (/second/i.test(u) ? n / 60 : n) : null;
  };
  const growth = (v: unknown, u: string) => {
    const n = toNumber(v);
    if (n === null || n <= -1) return null;
    return isPercentUnit(u) || Math.abs(n) > 1 ? n / 100 : n;
  };
  const defaultDisasterMean =
    Object.values(
      DEFAULT_CALIBRATION.rates["disaster.declarations_by_month"]!.value as Record<string, number>,
    ).reduce((s, x) => s + x, 0) / 12;

  const r: Rates = {
    delinquency: {
      conventional_30plus_share: read("delinquency.conventional_30plus_share", shareIn01),
      all_loans_30plus_share_sa: read("delinquency.all_loans_30plus_share_sa", shareIn01),
      roll_current_to_30: read("delinquency.roll_current_to_30", monthly),
      cure_from_30: read("delinquency.cure_from_30", monthly),
      roll_30_to_60: read("delinquency.roll_30_to_60", monthly),
    },
    payment: {
      day_of_month: read("payment.day_of_month", (v) => dayWeights(v)),
      late_within_grace_share: read("payment.late_within_grace_share", shareIn01),
      late_after_grace_share: read("payment.late_after_grace_share", shareIn01),
      partial_share: read("payment.partial_share", shareIn01),
      curtailment_share: read("payment.curtailment_share", shareIn01),
      missed_month_share: read("payment.missed_month_share", shareIn01),
    },
    contacts: {
      per_loan_year: read("contacts.per_loan_year", (v, u) => {
        const n = toNumber(v);
        if (n === null || n < 0) return null;
        return isMonthlyUnit(u) && !isAnnualUnit(u) ? n * 12 : n;
      }),
      handle_time_minutes: read("contacts.handle_time_minutes", positive),
      inbound_reason_mix: read("contacts.inbound_reason_mix", (v) => mix(v)),
    },
    escrow: {
      share_of_loans: read("escrow.share_of_loans", shareIn01),
      tax_annual_median_cents: read("escrow.tax_annual_median", cents),
      insurance_annual_median_cents: read("escrow.insurance_annual_median", cents),
      tax_growth_yoy: read("escrow.tax_growth_yoy", growth),
      insurance_growth_yoy: read("escrow.insurance_growth_yoy", growth),
    },
    arm: { share_of_outstanding: read("arm.share_of_outstanding", shareIn01) },
    mi: { share_of_loans: read("mi.share_of_loans", shareIn01) },
    book: {
      note_rate: read("book.note_rate_distribution", (v) => scaled(bins(v, 0.5), 0.5, 100)),
      ltv: read("book.ltv_distribution", (v) => scaled(bins(v, 5), 2, 100)),
      loan_age_months: read("book.loan_age_distribution", (v, u) => {
        const b = bins(v, /year/i.test(u) ? 2 : 24);
        return b && /year/i.test(u) ? b.map((x) => ({ ...x, lo: x.lo * 12, hi: x.hi * 12 })) : b;
      }),
    },
    refi: { pmms_30y: read("refi.pmms_30y_series", (v) => series(v)) },
    disaster: {
      by_calendar_month: read("disaster.declarations_by_month", (v, u) =>
        seasonal(v, u, defaultDisasterMean),
      ),
    },
    transfer: { annual_rate: read("transfer.annual_rate", annual) },
    defects: { field_error_rates: read("defects.field_error_rates", rateMap) },
  };
  const version =
    file && typeof file.version === "string" ? file.version : DEFAULT_CALIBRATION.version;
  return { version, path, rates: r, entries, warnings };
}

/** The calibration with every key at its default, whatever is on disk. */
export const defaultCalibration = (): Calibration => loadCalibration({ path: "" });
