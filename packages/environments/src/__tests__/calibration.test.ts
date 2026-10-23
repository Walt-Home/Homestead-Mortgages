/**
 * The calibration file the life generator reads, the acceptance tests its
 * validation sample is held to, and the generator's reading of it: every key
 * is there and nothing else, every public figure says where it came from and
 * when, every design choice says so, and no number is NaN; the reader takes
 * every key as written, with no warning, and each figure it hands the
 * generator is the derivation docs/environments.md states; and a book drawn
 * from the file comes out at the file's figures where the generator draws them,
 * and apart from a book drawn from the defaults wherever the file moves one.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PlainDate } from "@hm/kernel/calendar";
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_KEYS,
  COUNTIES,
  arrivals,
  calibrationCheck,
  defaultCalibration,
  generate,
  loadCalibration,
  type ArrivalRow,
  type CalibrationFile,
  type CalibrationKey,
  type CheckRow,
  type LifeBook,
  withinGraceDay,
} from "../life/index.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

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

  it("keeps every derived figure equal to what it is derived from", () => {
    // The New York Fed's latest quarter and eight-quarter means are the rows
    // beside them. Means are of the unrounded percents, so they may differ
    // from a mean of the rounded rows by a rounding of each.
    for (const [key, fields] of [
      ["delinquency.roll_current_to_30", ["to_30_60_late", "to_90_plus_late"]],
      ["delinquency.cure_from_30", ["to_current", "to_90_plus_late"]],
    ] as const) {
      const v = entry(key).value as {
        latest: Record<string, Json>;
        trailing_8_quarters: Record<string, Json>[];
        trailing_8_quarter_mean: Record<string, number>;
      };
      expect(v.trailing_8_quarters.length, key).toBe(8);
      expect(v.trailing_8_quarters.at(-1), key).toEqual(v.latest);
      for (const f of fields) {
        const mean = sum(v.trailing_8_quarters.map((q) => q[f] as number)) / 8;
        expect(Math.abs(mean - v.trailing_8_quarter_mean[f]!), `${key} ${f}`).toBeLessThanOrEqual(
          0.00001,
        );
      }
    }

    // MBA's 60-day bucket over its 30-day bucket.
    const mba = "delinquency.all_loans_30plus_share_sa";
    expect(num("delinquency.roll_30_to_60")).toBeCloseTo(
      num(mba, "by_bucket.d60") / num(mba, "by_bucket.d30"),
      2,
    );

    // The CFPB's inquiries over its loans, over eight months, made a year.
    const c = "contacts.per_loan_year";
    expect(num(c, "inquiries_per_loan_year")).toBeCloseTo(
      (num(c, "inquiries_may_to_dec_2021") / num(c, "loans")) * (12 / 8),
      2,
    );

    // The complaint shares are the counts over their total to four places,
    // the largest taking what the rounding leaves.
    const mix = entry("contacts.inbound_reason_mix").value as {
      complaints: number;
      counts: Record<string, number>;
      shares: Record<string, number>;
    };
    const reasons = Object.keys(mix.counts);
    expect(sum(Object.values(mix.counts))).toBe(mix.complaints);
    expect(Object.keys(mix.shares).sort()).toEqual([...reasons].sort());
    const largest = reasons.reduce((a, b) => (mix.counts[b]! > mix.counts[a]! ? b : a));
    for (const reason of reasons)
      expect(
        Math.abs(mix.shares[reason]! - mix.counts[reason]! / mix.complaints),
        reason,
      ).toBeLessThanOrEqual(0.00005 * (reason === largest ? reasons.length : 1) + 1e-12);

    // Tax growth is the ratio of the medians it lists, and the newest is the level.
    const tax = entry("escrow.tax_growth_yoy").value as {
      by_year: Record<string, number>;
      annualized_2021_to_2024: number;
      medians_with_mortgage_usd: Record<string, number>;
    };
    const tm = tax.medians_with_mortgage_usd;
    for (const [year, growth] of Object.entries(tax.by_year))
      expect(growth, year).toBeCloseTo(tm[year]! / tm[String(Number(year) - 1)]! - 1, 4);
    expect(tax.annualized_2021_to_2024).toBeCloseTo((tm["2024"]! / tm["2021"]!) ** (1 / 3) - 1, 4);
    expect(tm["2024"]).toBe(num("escrow.tax_annual_median", "with_mortgage_usd"));

    // Insurance: the median is interpolated inside the bin holding the middle
    // unit, and its growth is the ratio of two such medians.
    const bins = at(entry("escrow.insurance_annual_median").value, "distribution") as {
      from_usd: number;
      to_usd: number | null;
      share: number;
    }[];
    let below = 0;
    const middle = bins.find((b) => {
      if (below + b.share >= 0.5) return true;
      below += b.share;
      return false;
    })!;
    expect(middle.to_usd).not.toBeNull();
    const median =
      middle.from_usd + ((0.5 - below) / middle.share) * (middle.to_usd! + 1 - middle.from_usd);
    const insuranceMedian = num("escrow.insurance_annual_median", "with_mortgage_usd");
    expect(Math.abs(median - insuranceMedian)).toBeLessThan(2);
    const ins = entry("escrow.insurance_growth_yoy").value as {
      by_year: Record<string, number>;
      medians_with_mortgage_usd: Record<string, number>;
    };
    const im = ins.medians_with_mortgage_usd;
    expect(im["2024"]).toBe(insuranceMedian);
    expect(ins.by_year["2024"]).toBeCloseTo(im["2024"]! / im["2023"]! - 1, 3);

    // Enterprise originations over 80 CLTV are the bins above 80.
    const cltv = "at_origination_enterprise_2025.cltv_loans";
    expect(num("mi.share_of_loans", "enterprise_originations_2025_cltv_over_80")).toBeCloseTo(
      sum(
        ["80_to_90", "90_to_95", "95_to_97", "gt_97"].map((b) =>
          num("book.ltv_distribution", `${cltv}.${b}`),
        ),
      ),
      9,
    );
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
    expect(
      days.at(-1)! * 86_400_000,
      "the last week, against the file's version",
    ).toBeLessThanOrEqual(Date.parse(`${calibration.version}T00:00:00Z`));
    for (const [week, rate] of v.rows) expect(rate > 0 && rate < 20, week).toBe(true);
  });

  it("counts disasters for every month it names", () => {
    const v = entry("disaster.declarations_by_month").value as Record<string, Json>;
    const months = v.months as string[];
    expect(months[0]).toBe(v.first_month);
    expect(months.at(-1)).toBe(v.last_month);
    // Complete months only, one after another.
    expect(months.at(-1)! < calibration.version.slice(0, 7)).toBe(true);
    for (let i = 1; i < months.length; i++) {
      const [y, m] = months[i - 1]!.split("-").map(Number);
      const next = m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, "0")}`;
      expect(months[i], months[i - 1]).toBe(next);
    }
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
    // On a loan current at every due date no month is missed, so its late
    // charges are the day-17-to-month-end bin alone.
    expect(test("transactions-per-loan-year").target.expected).toBeCloseTo(
      12 *
        (1 +
          num("payment.curtailment_share") +
          num("payment.partial_share", "partial_receipt_share") +
          2 * num("payment.partial_share", "returned_receipt_share") +
          num("payment.day_of_month", "arrival_share.days_17_to_month_end")) +
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

describe("the generator's reading of the file", () => {
  const read = loadCalibration();
  const R = read.rates;

  it("reads every key of the committed file as written, with no warning", () => {
    expect(read.path).toBe(here("../life/calibration.json"));
    expect(read.warnings).toEqual([]);
    expect(read.version).toBe(calibration.version);
    for (const key of CALIBRATION_KEYS) {
      expect(read.entries[key].used, key).toBe("file");
      expect(read.entries[key].kind, key).toBe(entry(key).kind);
    }
  });

  it("converts the quarterly roll and cure to the monthly chain whose quarter they are", () => {
    // The chain: current → behind at the roll, behind → current at the cure, one further behind at the roll from
    // behind. Its three-month step, as docs/environments.md states it.
    const quarter = (p: number, c: number, r2: number) => {
      const reach = (1 - (1 - p - c) ** 3) / (p + c);
      return { late: p * reach - p * r2 * r2, current: c * reach };
    };
    const r2 = num("delinquency.roll_30_to_60");
    expect(R.delinquency.roll_30_to_60).toBe(r2);
    const q = quarter(R.delinquency.roll_current_to_30, R.delinquency.cure_from_30, r2);
    const mean = (key: string, f: string) => num(key, `trailing_8_quarter_mean.${f}`);
    expect(q.late).toBeCloseTo(mean("delinquency.roll_current_to_30", "to_30_60_late"), 12);
    expect(q.current).toBeCloseTo(mean("delinquency.cure_from_30", "to_current"), 12);
    // A loan that falls behind and catches up inside a quarter is in neither count, so the monthly roll is more
    // than a third of the quarter's (the file's own floor), and the monthly cure well under the quarter's.
    expect(R.delinquency.roll_current_to_30).toBeGreaterThan(
      mean("delinquency.roll_current_to_30", "to_30_60_late") / 3,
    );
    expect(R.delinquency.roll_current_to_30).toBeCloseTo(0.00357, 5);
    expect(R.delinquency.cure_from_30).toBeCloseTo(0.1628, 4);
  });

  it("hands the generator each other figure as its derivation says", () => {
    const k = (key: string, path = "") => num(key, path);
    expect(R.delinquency.conventional_30plus_share).toBe(
      k("delinquency.conventional_30plus_share"),
    );
    expect(R.delinquency.all_loans_30plus_share_sa).toBe(
      k("delinquency.all_loans_30plus_share_sa", "total"),
    );

    // Arrival day: each bin's share spread over its days, days 2 to 16 normalized; the split around the due day.
    const bin = (b: string) => k("payment.day_of_month", `arrival_share.${b}`);
    const inGrace = bin("days_2_to_5") + bin("days_6_to_10") + bin("days_11_to_16");
    const days = Array.from({ length: 15 }, (_, i) => i + 2).map(
      (d) =>
        (d <= 5
          ? bin("days_2_to_5") / 4
          : d <= 10
            ? bin("days_6_to_10") / 5
            : bin("days_11_to_16") / 6) / inGrace,
    );
    R.payment.day_of_month.forEach((w, i) => expect(w, `day ${i + 2}`).toBeCloseTo(days[i]!, 12));
    // Each bin's run of days inside grace, kept so a payment drawn for a day off stays in its bin.
    expect(R.payment.day_of_month_bins).toEqual([
      [2, 5],
      [6, 10],
      [11, 16],
    ]);
    expect(R.payment.early_share).toBeCloseTo(
      bin("before_due") / (bin("before_due") + bin("due_day")),
      12,
    );
    expect(R.payment.late_within_grace_share).toBe(k("payment.late_within_grace_share"));
    expect(R.payment.late_after_grace_share).toBe(k("payment.late_after_grace_share"));
    expect(R.payment.missed_month_share).toBe(k("payment.missed_month_share"));
    expect(R.payment.partial_share).toBe(k("payment.partial_share", "partial_receipt_share"));
    expect(R.payment.returned_share).toBe(k("payment.partial_share", "returned_receipt_share"));
    expect(R.payment.curtailment_share).toBe(k("payment.curtailment_share"));

    // Contacts: the stated rate; the geometric midpoint of the range of averages; the complaint counts over their total.
    expect(R.contacts.per_loan_year).toBe(k("contacts.per_loan_year", "inquiries_per_loan_year"));
    expect(R.contacts.handle_time_minutes).toBeCloseTo(
      Math.sqrt(
        k("contacts.handle_time_minutes", "min") * k("contacts.handle_time_minutes", "max"),
      ),
      12,
    );
    const counts = at(entry("contacts.inbound_reason_mix").value, "counts") as Record<
      string,
      number
    >;
    const complaints = k("contacts.inbound_reason_mix", "complaints");
    expect(R.contacts.inbound_reason_mix.map(([r]) => r)).toEqual(Object.keys(counts));
    for (const [reason, w] of R.contacts.inbound_reason_mix)
      expect(w, reason).toBeCloseTo(counts[reason]! / complaints, 12);

    // Escrow: the medians for units with a mortgage, in cents; growth compounded between the oldest and newest medians.
    expect(R.escrow.share_of_loans).toBe(k("escrow.share_of_loans"));
    expect(R.escrow.tax_annual_median_cents).toBe(
      k("escrow.tax_annual_median", "with_mortgage_usd") * 100,
    );
    expect(R.escrow.insurance_annual_median_cents).toBe(
      k("escrow.insurance_annual_median", "with_mortgage_usd") * 100,
    );
    const tm = at(entry("escrow.tax_growth_yoy").value, "medians_with_mortgage_usd") as Record<
      string,
      number
    >;
    expect(R.escrow.tax_growth_yoy).toBeCloseTo((tm["2024"]! / tm["2021"]!) ** (1 / 3) - 1, 12);
    expect(R.escrow.tax_growth_yoy).toBeCloseTo(
      k("escrow.tax_growth_yoy", "annualized_2021_to_2024"),
      4,
    );
    const im = at(
      entry("escrow.insurance_growth_yoy").value,
      "medians_with_mortgage_usd",
    ) as Record<string, number>;
    expect(R.escrow.insurance_growth_yoy).toBeCloseTo(im["2024"]! / im["2023"]! - 1, 12);

    expect(R.arm.share_of_outstanding).toBe(k("arm.share_of_outstanding", "loans"));
    expect(R.mi.share_of_loans).toBe(
      k("mi.share_of_loans", "enterprise_originations_2025_cltv_over_80"),
    );
    expect(R.transfer.annual_rate).toBe(k("transfer.annual_rate"));
    const defects = entry("defects.field_error_rates").value as Record<string, { rate: number }>;
    expect(R.defects.field_error_rates).toEqual(
      Object.fromEntries(Object.entries(defects).map(([id, d]) => [id, d.rate])),
    );
  });

  it("closes each distribution's open bins by the rule docs/environments.md states", () => {
    const mean = (bins: readonly { lo: number; hi: number; weight: number }[]) =>
      bins.reduce((s, b) => s + b.weight * ((b.lo + b.hi) / 2), 0);
    const weights = (key: string, path: string) => {
      const v = Object.values(at(entry(key).value, path) as Record<string, number>);
      return v.map((w) => w / sum(v));
    };
    // Note rates: both open bins a point wide, like their neighbors; the mean is the stated average to its rounding.
    expect(R.book.note_rate.map((b) => [b.lo, b.hi])).toEqual([
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
    ]);
    const rateWeights = weights("book.note_rate_distribution", "loans");
    R.book.note_rate.forEach((b, i) => expect(b.weight).toBeCloseTo(rateWeights[i]!, 12));
    expect(
      Math.abs(mean(R.book.note_rate) - num("book.note_rate_distribution", "average_pct")),
    ).toBeLessThan(0.05);
    // LTV at origination: above 97 is a point at 97; the bin at or under 70 runs down to the stated average.
    const ltv = R.book.ltv;
    expect(ltv.map((b) => b.hi)).toEqual([70, 80, 90, 95, 97, 97]);
    expect(ltv.slice(1).map((b) => b.lo)).toEqual([70, 80, 90, 95, 97]);
    const ltvWeights = weights(
      "book.ltv_distribution",
      "at_origination_enterprise_2025.cltv_loans",
    );
    ltv.forEach((b, i) => expect(b.weight).toBeCloseTo(ltvWeights[i]!, 12));
    expect(mean(ltv)).toBeCloseTo(
      num("book.ltv_distribution", "at_origination_enterprise_2025.average_ltv_pct"),
      9,
    );
    expect(ltv[0]!.lo).toBeCloseTo(39.7, 1);
    // Loan age in months: an age starts at zero, and the bin over ten years runs up to the stated average.
    const age = R.book.loan_age_months;
    expect(age.map((b) => b.lo)).toEqual([0, 48, 84, 120]);
    expect(age.slice(0, 3).map((b) => b.hi)).toEqual([48, 84, 120]);
    expect(mean(age)).toBeCloseTo(num("book.loan_age_distribution", "average_months.loans"), 9);
  });

  it("reads the rate series as published, and the disaster series a county at a time", () => {
    const rows = at(entry("refi.pmms_30y_series").value, "rows") as [string, number][];
    expect(R.refi.pmms_30y.length).toBe(rows.length);
    R.refi.pmms_30y.forEach((o, i) => {
      const [m, d, y] = rows[i]![0].split("/");
      expect(o.on).toBe(`${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`);
      expect(o.rate).toBe(rows[i]![1]);
    });

    const v = entry("disaster.declarations_by_month").value as Record<string, Json>;
    const months = v.months as string[];
    const areas = v.major_disaster_individual_assistance_areas as number[];
    // The months left out are the nationwide ones, more than a fifth of the counties at once: COVID-19 in 2020.
    expect(months.filter((_, i) => areas[i]! > COUNTIES / 5)).toEqual(["2020-03", "2020-04"]);
    for (let m = 1; m <= 12; m++) {
      const kept = months
        .map((x, i) => [x, areas[i]!] as const)
        .filter(([x, a]) => Number(x.slice(5)) === m && a <= COUNTIES / 5)
        .map(([, a]) => a / COUNTIES);
      expect(R.disaster.by_calendar_month[m - 1], `month ${m}`).toBeCloseTo(
        sum(kept) / kept.length,
        12,
      );
    }
  });

  it("places a payment drawn for a day off on a business day of its own bin", () => {
    // 1 September 2026 is a Tuesday: the 5th is a Saturday, the 6th a Sunday and the 7th Labor Day.
    const bins = R.payment.day_of_month_bins;
    expect(withinGraceDay("2026-09-01" as PlainDate, 3, bins)).toBe("2026-09-03");
    // The last day of days 2 to 5 falls back to the Friday rather than roll into days 6 to 10.
    expect(withinGraceDay("2026-09-01" as PlainDate, 5, bins)).toBe("2026-09-04");
    // The first of days 6 to 10 moves on past the weekend and the holiday, inside the bin.
    expect(withinGraceDay("2026-09-01" as PlainDate, 6, bins)).toBe("2026-09-08");
    // A bin of one day has no other day to move to, and the payment rolls forward as any does.
    expect(withinGraceDay("2026-09-01" as PlainDate, 5, [[5, 5]])).toBe("2026-09-05");
  });

  it("refuses a value it cannot place on the generator's notes, by name", () => {
    const copy = JSON.parse(raw) as CalibrationFile & { rates: Record<string, Entry> };
    (copy.rates["payment.day_of_month"]!.value as { due_day: number }).due_day = 5;
    const r = loadCalibration({ file: copy });
    expect(r.warnings).toEqual([
      expect.stringMatching(/^payment\.day_of_month: value .* could not be read/),
    ]);
    expect(r.entries["payment.day_of_month"].used).toBe("default");
    expect(r.entries["payment.late_within_grace_share"].used).toBe("file");
  });
});

describe("a book drawn from the file", () => {
  // Four years of 1,500 loans: enough loan-months that each share sits within a few of its sampling errors.
  const scenario = { loans: 1500, months: 48 };
  const file = loadCalibration();
  const defaults = defaultCalibration();
  const fromFile = generate("calibration", scenario, { calibration: file }).clean;
  const fromDefaults = generate("calibration", scenario, { calibration: defaults }).clean;
  const fileRows = calibrationCheck(fromFile, file);
  const defaultRows = calibrationCheck(fromDefaults, defaults);
  const row = (
    rows: readonly CheckRow[],
    key: CalibrationKey,
    use: CheckRow["use"] = "drawn",
  ): CheckRow => {
    const r = rows.find((x) => x.key === key && x.use === use);
    if (!r) throw new Error(`no ${use} row for ${key}`);
    return r;
  };
  const disasterMonths = (book: LifeBook) =>
    book.loans.reduce((s, l) => s + l.behavior.filter((b) => b.kind === "disaster").length, 0);

  it("carries the file's version and no warnings", () => {
    expect(fromFile.calibration).toEqual({
      version: calibration.version,
      path: file.path,
      warnings: [],
    });
  });

  // Each tolerance is the acceptance test's where one reads the same measure, else a few sampling errors.
  const DRAWN: readonly [CalibrationKey, number, "absolute" | "relative"][] = [
    ["delinquency.roll_current_to_30", 0.15, "relative"],
    ["delinquency.cure_from_30", 0.15, "relative"],
    ["payment.late_within_grace_share", 0.02, "absolute"],
    ["payment.late_after_grace_share", 0.15, "relative"],
    ["payment.day_of_month", 0.03, "absolute"],
    ["payment.partial_share", 0.3, "relative"],
    ["payment.curtailment_share", 0.15, "relative"],
    ["escrow.share_of_loans", 0.03, "absolute"],
    ["arm.share_of_outstanding", 0.015, "absolute"],
    ["mi.share_of_loans", 0.03, "absolute"],
    ["contacts.per_loan_year", 0.3, "absolute"],
    ["contacts.handle_time_minutes", 0.05, "relative"],
  ];

  it("comes out at the file's figures where the generator draws them", () => {
    expect(
      fileRows
        .filter((r) => r.use === "drawn")
        .map((r) => r.key)
        .sort(),
    ).toEqual(DRAWN.map(([k]) => k).sort());
    for (const [key, tol, kind] of DRAWN) {
      const r = row(fileRows, key);
      const off =
        kind === "absolute" ? Math.abs(r.realized - r.target) : Math.abs(r.realized / r.target - 1);
      expect(off, `${key}: ${r.realized} against ${r.target}`).toBeLessThanOrEqual(tol);
    }
  });

  it("lands every arrival bin within the acceptance test's tolerance, and the defaults' book does not", () => {
    // Read on due dates that are a business day following one, as calibrationCheck reads the shares within grace and
    // before the due day. A payment drawn for a weekend inside grace arrives on a business day of its own bin; rolled
    // forward alone, days 2 to 5 came out near 0.21 against the file's 0.27.
    const bins = at(entry("payment.day_of_month").value, "arrival_share") as Record<string, number>;
    const tolerance = acceptance.tests.find((t) => t.id === "payment-arrival-day")!.tolerance.value;
    const measure = (book: LifeBook): Record<string, number> => {
      const rows = arrivals(book).filter((a) => a.clear);
      const share = (f: (a: ArrivalRow) => boolean) => rows.filter(f).length / rows.length;
      const inGrace = (lo: number, hi: number) => (a: ArrivalRow) => {
        if (a.arrival !== "within_grace") return false;
        const day = Number(a.on!.slice(8, 10));
        return day >= lo && day <= hi;
      };
      return {
        before_due: share((a) => a.arrival === "before_due"),
        due_day: share((a) => a.arrival === "due_day"),
        days_2_to_5: share(inGrace(2, 5)),
        days_6_to_10: share(inGrace(6, 10)),
        // Grace that ends on a day off runs to the next business day, and a payment then is still within it.
        days_11_to_16: share(inGrace(11, 31)),
        days_17_to_month_end: share((a) => a.arrival === "after_grace"),
        not_in_month: share((a) => a.arrival === "not_in_month"),
      };
    };
    const fromFileBins = measure(fromFile);
    expect(Object.keys(fromFileBins).sort()).toEqual(Object.keys(bins).sort());
    for (const [bin, target] of Object.entries(bins))
      expect(
        Math.abs(fromFileBins[bin]! - target),
        `${bin}: ${fromFileBins[bin]} against ${target}`,
      ).toBeLessThanOrEqual(tolerance);
    const fromDefaultBins = measure(fromDefaults);
    expect(
      Math.max(
        ...Object.entries(bins).map(([bin, target]) => Math.abs(fromDefaultBins[bin]! - target)),
      ),
    ).toBeGreaterThan(3 * tolerance);
  });

  it("moves away from the defaults' book wherever the file moves the figure", () => {
    // Every drawn figure the file moves by more than one and a half times its tolerance moves the book at least half
    // as far, the same way: late payment, delinquency, curtailments, contacts and mortgage insurance among them.
    const moved: CalibrationKey[] = [];
    for (const [key, tol, kind] of DRAWN) {
      const f = row(fileRows, key);
      const d = row(defaultRows, key);
      const gap = f.target - d.target;
      const scale = kind === "absolute" ? tol : tol * Math.max(f.target, d.target);
      if (Math.abs(gap) <= 1.5 * scale) continue;
      moved.push(key);
      expect(
        (f.realized - d.realized) / gap,
        `${key}: ${f.realized} against ${d.realized}`,
      ).toBeGreaterThan(0.5);
    }
    expect(moved).toEqual(
      expect.arrayContaining([
        "delinquency.roll_current_to_30",
        "delinquency.cure_from_30",
        "payment.late_within_grace_share",
        "payment.curtailment_share",
        "contacts.per_loan_year",
        "contacts.handle_time_minutes",
        "mi.share_of_loans",
      ]),
    );
    // The missed-month share is a check the roll makes, not a draw: the file's roll leaves fewer months missed.
    expect(row(fileRows, "payment.missed_month_share", "check").realized).toBeLessThan(
      row(defaultRows, "payment.missed_month_share", "check").realized / 2,
    );
    // A late charge on every installment not in by the end of grace: the file's share is above the defaults'.
    expect(row(fileRows, "payment.late_after_grace_share").realized).toBeGreaterThan(
      row(defaultRows, "payment.late_after_grace_share").realized,
    );
    // Disaster months at the county rate, near twice the defaults'.
    expect(disasterMonths(fromFile)).toBeGreaterThan(disasterMonths(fromDefaults) * 1.4);
  });

  it("lands near each quarter the file states, and the defaults' book does not", () => {
    // A quarter's end also finds a loan behind that missed nothing (a partial payment's rest still to come), so the
    // roll reads above the chain's, by about a fifth. The acceptance test allows 30 % on the roll and 0.08 on the
    // cure over 10,000 loans; this book's quarter-ends find a few hundred loans behind, so the cure is held to 0.15
    // and the roll to 40 %. The defaults' book misses both by a multiple.
    const roll = row(fileRows, "delinquency.roll_current_to_30", "check");
    const cure = row(fileRows, "delinquency.cure_from_30", "check");
    expect(roll.target).toBeCloseTo(
      num("delinquency.roll_current_to_30", "trailing_8_quarter_mean.to_30_60_late"),
      12,
    );
    expect(cure.target).toBeCloseTo(
      num("delinquency.cure_from_30", "trailing_8_quarter_mean.to_current"),
      12,
    );
    expect(Math.abs(roll.realized / roll.target - 1)).toBeLessThanOrEqual(0.4);
    expect(Math.abs(cure.realized - cure.target)).toBeLessThanOrEqual(0.15);
    const defaultRoll = row(defaultRows, "delinquency.roll_current_to_30", "check");
    const defaultCure = row(defaultRows, "delinquency.cure_from_30", "check");
    expect(defaultRoll.realized / roll.target).toBeGreaterThan(1.5);
    expect(defaultCure.realized - cure.target).toBeGreaterThan(0.2);
  });

  it("draws the partial share from the file, which happens to equal the default's", () => {
    // The committed file's short-receipt share is the default's 1 %, so the two books cannot differ in it. A copy
    // of the file with the share moved shows the draw follows the file.
    expect(file.entries["payment.partial_share"].used).toBe("file");
    expect(file.rates.payment.partial_share).toBe(defaults.rates.payment.partial_share);
    const copy = JSON.parse(raw) as CalibrationFile & { rates: Record<string, Entry> };
    const partial = copy.rates["payment.partial_share"]!.value as { partial_receipt_share: number };
    partial.partial_receipt_share = 0.05;
    const moved = loadCalibration({ file: copy });
    expect(moved.warnings).toEqual([]);
    const small = { loans: 400, months: 24 };
    const share = (cal: typeof file) =>
      row(
        calibrationCheck(generate("partial", small, { calibration: cal }).clean, cal),
        "payment.partial_share",
      ).realized;
    const at5 = share(moved);
    expect(Math.abs(at5 / 0.05 - 1)).toBeLessThanOrEqual(0.3);
    expect(at5 / share(file)).toBeGreaterThan(3);
  });

  it("draws contact reasons, note rates, loan-to-values, escrow bills, disasters and the market from the file", () => {
    const loans = fromFile.loans;
    // Contact reasons, against the complaint shares, each within the acceptance test's 0.03.
    const reasons = loans.flatMap((l) => l.contacts.map((c) => c.reason));
    for (const [reason, share] of file.rates.contacts.inbound_reason_mix)
      expect(
        Math.abs(reasons.filter((r) => r === reason).length / reasons.length - share),
        reason,
      ).toBeLessThan(0.03);
    // Note rates by the file's buckets, within 0.03: the acceptance test's 0.02 and the sampling error at 1,500 loans.
    const rates = loans.map((l) => Number(l.draw.note_rate_pct));
    for (const b of file.rates.book.note_rate) {
      const share = rates.filter((x) => x >= b.lo && x < b.hi).length / rates.length;
      expect(Math.abs(share - b.weight), `${b.lo}-${b.hi}`).toBeLessThan(0.03);
    }
    // Loan-to-value above 80, where mortgage insurance starts.
    const above80 = loans.filter((l) => l.draw.ltv_pct > 80).length / loans.length;
    expect(
      Math.abs(above80 - num("mi.share_of_loans", "enterprise_originations_2025_cltv_over_80")),
    ).toBeLessThan(0.03);
    // The first year's tax and premium per escrowed loan, within the acceptance test's tenth of the ACS medians.
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const escrowed = loans.filter((l) => l.draw.escrowed);
    const firstYear = (l: LifeBook["loans"][number], basis: string) =>
      l.draw.line_specs.filter((s) => s.basis === basis).reduce((s, x) => s + x.first_annual, 0);
    const tax = median(escrowed.map((l) => firstYear(l, "tax")));
    const hazard = median(escrowed.map((l) => firstYear(l, "hazard")));
    expect(Math.abs(tax / file.rates.escrow.tax_annual_median_cents - 1)).toBeLessThan(0.1);
    expect(Math.abs(hazard / file.rates.escrow.insurance_annual_median_cents - 1)).toBeLessThan(
      0.1,
    );
    // Each year's growth is drawn around the file's.
    const growth = (basis: string) => {
      const g = escrowed.flatMap((l) =>
        l.draw.line_specs.filter((s) => s.basis === basis).flatMap((s) => s.growth),
      );
      return sum(g) / g.length;
    };
    expect(Math.abs(growth("tax") - file.rates.escrow.tax_growth_yoy)).toBeLessThan(0.002);
    expect(Math.abs(growth("hazard") - file.rates.escrow.insurance_growth_yoy)).toBeLessThan(0.003);
    // Disaster months at the county rate, against what the book's own calendar months give.
    const loanMonths = loans.flatMap((l) => l.months.map((m) => Number(m.month.slice(5)) - 1));
    const expected = sum(loanMonths.map((m) => file.rates.disaster.by_calendar_month[m]!));
    expect(Math.abs(disasterMonths(fromFile) / expected - 1)).toBeLessThan(0.15);
    // The mortgage rate starts at the survey's newest print.
    const rows = at(entry("refi.pmms_30y_series").value, "rows") as [string, number][];
    expect(fromFile.market[0]!.rate).toBe(rows.at(-1)![1]);
    expect(fromDefaults.market[0]!.rate).toBe(6.25);
  });
});
