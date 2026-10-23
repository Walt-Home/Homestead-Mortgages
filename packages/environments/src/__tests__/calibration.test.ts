/**
 * The calibration file the life generator reads, and the acceptance tests its
 * validation sample is held to: every key is there and nothing else, every
 * public figure says where it came from and when, every design choice says
 * so, and no number is NaN.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Both sides use exactly these: the file, and the generator that reads it. */
const CALIBRATION_KEYS = [
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

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Entry = {
  value: Json;
  unit: string;
  kind: "public" | "design_choice";
  source: string;
  fetched: string | null;
  terms: string;
  note: string;
};
type Calibration = { version: string; rates: Record<string, Entry> };
type Acceptance = {
  version: string;
  calibration_version: string;
  sample: string;
  tests: {
    id: string;
    measure: string;
    key: string;
    reads?: string[];
    target: { path?: string; also?: string; formula?: string; expected?: number; compare: string };
    sample_floor: { count: number; of: string };
    tolerance: { value: number; unit: string; kind: string; reason: string };
  }[];
};

// Parsed from the text, not imported: the test is of the file as written.
const raw = readFileSync(here("../life/calibration.json"), "utf8");
const calibration = JSON.parse(raw) as Calibration;
const acceptance = JSON.parse(
  readFileSync(here("../life/calibration-acceptance.json"), "utf8"),
) as Acceptance;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s: unknown): s is string =>
  typeof s === "string" &&
  ISO_DATE.test(s) &&
  new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

const entry = (key: string): Entry => {
  const e = calibration.rates[key];
  if (!e) throw new Error(`no calibration key ${key}`);
  return e;
};

/** A dot path into a value; "" is the value itself. */
const at = (value: Json, path: string): Json | undefined =>
  path === ""
    ? value
    : path.split(".").reduce<Json | undefined>((v, k) => {
        if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
        return v[k];
      }, value);

const num = (key: string, path = ""): number => {
  const v = at(entry(key).value, path);
  if (typeof v !== "number") throw new Error(`${key} ${path} is not a number`);
  return v;
};

const shares = (key: string, path: string): number[] => {
  const v = at(entry(key).value, path);
  if (v === null || typeof v !== "object") throw new Error(`${key} ${path} is not a distribution`);
  const list = Array.isArray(v) ? v.map((b) => at(b, "share")) : Object.values(v);
  return list.map((s) => {
    if (typeof s !== "number") throw new Error(`${key} ${path} holds a share that is not a number`);
    return s;
  });
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Every number anywhere under a value, with where it sits. */
function* numbers(v: Json, where: string): Generator<[string, number]> {
  if (typeof v === "number") yield [where, v];
  else if (Array.isArray(v)) for (const [i, x] of v.entries()) yield* numbers(x, `${where}[${i}]`);
  else if (v !== null && typeof v === "object")
    for (const [k, x] of Object.entries(v)) yield* numbers(x, `${where}.${k}`);
}

describe("the calibration file", () => {
  it("parses, and is dated", () => {
    expect(isIsoDate(calibration.version)).toBe(true);
    expect(Object.keys(calibration)).toEqual(["version", "rates"]);
  });

  it("holds every key in the list and no other", () => {
    expect(Object.keys(calibration.rates).sort()).toEqual([...CALIBRATION_KEYS].sort());
  });

  it("gives every key the same seven fields", () => {
    for (const key of CALIBRATION_KEYS) {
      const e = entry(key);
      expect(Object.keys(e).sort(), key).toEqual(
        ["fetched", "kind", "note", "source", "terms", "unit", "value"].sort(),
      );
      for (const field of ["unit", "terms", "note"] as const)
        expect(e[field].trim().length, `${key} ${field}`).toBeGreaterThan(0);
      expect(["public", "design_choice"], key).toContain(e.kind);
    }
  });

  it("says where every public value came from, and when it was fetched", () => {
    const pub = CALIBRATION_KEYS.filter((k) => entry(k).kind === "public");
    expect(pub.length).toBeGreaterThan(0);
    for (const key of pub) {
      const e = entry(key);
      expect(e.source, key).toMatch(/^https:\/\/[^\s]+$/);
      expect(isIsoDate(e.fetched), `${key} fetched`).toBe(true);
      expect(e.fetched! <= calibration.version, `${key} fetched after the file's version`).toBe(
        true,
      );
    }
  });

  it("marks every design choice as one, with no source and a stated reason", () => {
    for (const key of CALIBRATION_KEYS.filter((k) => entry(k).kind === "design_choice")) {
      const e = entry(key);
      expect(e.source, key).toBe("none");
      expect(e.fetched, key).toBeNull();
      expect(e.note.length, key).toBeGreaterThan(40);
    }
  });

  it("holds no NaN, no infinity and nothing standing in for them", () => {
    // JSON.parse cannot produce NaN, so the check is on what the text could carry instead.
    expect(raw).not.toMatch(/\b(NaN|Infinity)\b/);
    for (const key of CALIBRATION_KEYS) {
      const found = [...numbers(entry(key).value, key)];
      expect(found.length, key).toBeGreaterThan(0);
      for (const [where, n] of found) expect(Number.isFinite(n), where).toBe(true);
    }
  });

  it("keeps every share between zero and one, and every distribution summing to one", () => {
    for (const [key, paths] of [
      ["payment.day_of_month", ["arrival_share"]],
      ["contacts.inbound_reason_mix", ["shares"]],
      ["escrow.insurance_annual_median", ["distribution"]],
      ["book.note_rate_distribution", ["loans", "upb"]],
      [
        "book.ltv_distribution",
        ["mark_to_market.loans", "mark_to_market.upb", "at_origination_enterprise_2025.cltv_loans"],
      ],
      ["book.loan_age_distribution", ["loans", "upb"]],
    ] as const) {
      for (const path of paths) {
        const s = shares(key, path);
        for (const x of s) expect(x >= 0 && x <= 1, `${key} ${path}`).toBe(true);
        // Published shares are rounded to a tenth of a point, so a bucket set may miss by 0.001.
        expect(Math.abs(sum(s) - 1), `${key} ${path}`).toBeLessThanOrEqual(0.0015);
      }
    }
    expect(sum(shares("payment.day_of_month", "arrival_share"))).toBeCloseTo(1, 9);
  });

  it("derives the payment shares from the arrival-day bins they are sums of", () => {
    const bin = (b: string) => num("payment.day_of_month", `arrival_share.${b}`);
    expect(num("payment.late_within_grace_share")).toBeCloseTo(
      bin("days_2_to_5") + bin("days_6_to_10") + bin("days_11_to_16"),
      9,
    );
    expect(num("payment.late_after_grace_share")).toBeCloseTo(
      bin("days_17_to_month_end") + bin("not_in_month"),
      9,
    );
    expect(num("payment.missed_month_share")).toBe(bin("not_in_month"));
  });

  it("keeps MBA's delinquency buckets adding to its total", () => {
    const k = "delinquency.all_loans_30plus_share_sa";
    expect(
      num(k, "by_bucket.d30") + num(k, "by_bucket.d60") + num(k, "by_bucket.d90_plus"),
    ).toBeCloseTo(num(k, "total"), 9);
    expect(num(k, "by_type.conventional")).toBe(num("delinquency.conventional_30plus_share"));
  });

  it("carries the 30-year PMMS series week by week from 2016, as published", () => {
    const v = entry("refi.pmms_30y_series").value as {
      columns: string[];
      first_week: string;
      last_week: string;
      rows: [string, number][];
    };
    expect(v.columns).toEqual(["week", "rate_pct"]);
    const days = v.rows.map(([week]) => {
      const [m, d, y] = week.split("/").map(Number);
      return Date.UTC(y!, m! - 1, d!) / 86_400_000;
    });
    expect(v.rows[0]![0]).toBe(v.first_week);
    expect(v.rows.at(-1)![0]).toBe(v.last_week);
    expect(v.first_week).toMatch(/^1\/\d+\/2016$/);
    // One row a week: a holiday moves a release a day early, never drops or doubles one.
    for (let i = 1; i < days.length; i++)
      expect([6, 7, 8], v.rows[i]![0]).toContain(days[i]! - days[i - 1]!);
    expect(v.rows.length).toBe((days.at(-1)! - days[0]!) / 7 + 1);
    for (const [week, rate] of v.rows) expect(rate > 0 && rate < 20, week).toBe(true);
  });

  it("counts disasters for every month it names", () => {
    const v = entry("disaster.declarations_by_month").value as Record<string, Json>;
    const months = v.months as string[];
    expect(months[0]).toBe(v.first_month);
    expect(months.at(-1)).toBe(v.last_month);
    for (const series of [
      "major_disaster",
      "emergency",
      "fire_management",
      "major_disaster_individual_assistance_areas",
    ]) {
      const counts = v[series] as number[];
      expect(counts.length, series).toBe(months.length);
      for (const c of counts) expect(Number.isInteger(c) && c >= 0, series).toBe(true);
    }
  });
});

describe("the acceptance tests", () => {
  const tests = acceptance.tests;

  it("are dated, and written against this calibration", () => {
    expect(isIsoDate(acceptance.version)).toBe(true);
    expect(acceptance.calibration_version).toBe(calibration.version);
    expect(new Set(tests.map((t) => t.id)).size).toBe(tests.length);
  });

  it("cover every measure the validation sample is checked on", () => {
    expect(tests.map((t) => t.id)).toEqual(
      expect.arrayContaining([
        "payment-arrival-day",
        "late-fees-per-loan-year",
        "partial-payments",
        "returned-payments",
        "contacts-per-loan-year-by-status",
        "contact-reason-mix",
        "call-note-length",
        "transactions-per-loan-year",
        "defect-rates-by-field",
      ]),
    );
  });

  it("each check a calibration key, and read targets that are there", () => {
    for (const t of tests) {
      for (const key of [t.key, ...(t.reads ?? [])])
        expect(CALIBRATION_KEYS as readonly string[], `${t.id} ${key}`).toContain(key);
      if (t.target.path !== undefined)
        expect(at(entry(t.key).value, t.target.path), `${t.id} ${t.target.path}`).toBeDefined();
      if (t.target.also !== undefined) {
        const [key, path] = t.target.also.split(" ") as [string, string];
        expect(t.reads, t.id).toContain(key);
        expect(at(entry(key).value, path), `${t.id} ${t.target.also}`).toBeDefined();
      }
      expect(t.sample_floor.count > 0 && Number.isInteger(t.sample_floor.count), t.id).toBe(true);
    }
  });

  it("each mark its tolerance as a design choice, with the reason", () => {
    for (const t of tests) {
      expect(t.tolerance.kind, t.id).toBe("design_choice");
      expect(Number.isFinite(t.tolerance.value) && t.tolerance.value > 0, t.id).toBe(true);
      expect(t.tolerance.reason.length, t.id).toBeGreaterThan(20);
    }
  });

  it("state the targets the calibration gives today", () => {
    const test = (id: string) => {
      const t = tests.find((x) => x.id === id);
      if (!t) throw new Error(`no acceptance test ${id}`);
      return t;
    };
    expect(test("late-fees-per-loan-year").target.expected).toBeCloseTo(
      12 * num("payment.late_after_grace_share"),
      9,
    );
    expect(test("transactions-per-loan-year").target.expected).toBeCloseTo(
      12 *
        (1 +
          num("payment.curtailment_share") +
          num("payment.partial_share", "partial_receipt_share") +
          2 * num("payment.partial_share", "returned_receipt_share") +
          num("payment.late_after_grace_share")) +
        3 * num("escrow.share_of_loans"),
      9,
    );
  });

  it("split contacts by status so the book still averages the public figure", () => {
    const t = tests.find((x) => x.id === "contacts-per-loan-year-by-status")!;
    const rates = (t.target as unknown as { by_status_per_loan_year: Record<string, number> })
      .by_status_per_loan_year;
    const k = "delinquency.all_loans_30plus_share_sa";
    const foreclosure = num(k, "foreclosure_inventory");
    const mix: Record<string, number> = {
      current: 1 - num(k, "total") - foreclosure,
      d30: num(k, "by_bucket.d30"),
      d60: num(k, "by_bucket.d60"),
      d90_plus: num(k, "by_bucket.d90_plus"),
      foreclosure,
    };
    expect(Object.keys(rates).sort()).toEqual(Object.keys(mix).sort());
    const average = sum(Object.keys(mix).map((s) => mix[s]! * rates[s]!));
    expect(
      Math.abs(average - num("contacts.per_loan_year", "inquiries_per_loan_year")),
    ).toBeLessThan(t.tolerance.value);
    expect(
      rates.current! < rates.d30! && rates.d30! < rates.d60! && rates.d60! <= rates.d90_plus!,
    ).toBe(true);
  });
});
