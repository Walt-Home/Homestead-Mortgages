/**
 * The published table, the survey's arithmetic, and exactly where they differ.
 *
 * The strongest claim this package makes about the APOR is the sweep below:
 * across a whole vendored year, Appendix J on the CFPB's survey reproduces the
 * CFPB's published table to the cent on every week they followed their own
 * method, and the weeks where it does not are precisely the ones they
 * announced — a Christmas carry-forward and a per-term revision. The set is
 * asserted exactly, so a new divergence is a failing test and a question, not
 * a number nobody measured.
 */

import { describe, expect, it } from "vitest";
import { FFIEC_SURVEY, FFIEC_YIELD_TABLE_FIXED } from "@hm/shared";
import { parseSurveyCsv } from "../apor-survey.js";
import { APOR_TABLE, aporTableFromYieldRows, crossCheck, parseYieldTable } from "../apor-yield.js";
import { lookupApor } from "../apor.js";

const rows = parseYieldTable(FFIEC_YIELD_TABLE_FIXED.body);
const survey = parseSurveyCsv(FFIEC_SURVEY.csv);

describe("the published table", () => {
  it("parses: one Monday per row, fifty terms, contiguous since 2017", () => {
    expect(rows[0]!.weekOf).toBe("2017-01-02");
    expect(rows.length).toBeGreaterThan(500);
    for (const row of rows) expect(row.byTerm.length).toBe(51);
  });

  it("is what APOR_TABLE is built from, on the four modeled terms", () => {
    expect(APOR_TABLE.termYears).toEqual([30, 20, 15, 10]);
    expect(APOR_TABLE.weeks.length).toBe(rows.length);
    const last = rows[rows.length - 1]!;
    expect(APOR_TABLE.weeks[APOR_TABLE.weeks.length - 1]).toEqual({
      weekOf: last.weekOf,
      fixed: [last.byTerm[30], last.byTerm[20], last.byTerm[15], last.byTerm[10]],
    });
  });

  it("answers the week of 2026-09-14 with the figures the CFPB's calculator gives", () => {
    // Checked live against POST https://ffiec.cfpb.gov/public/rateSpread at an
    // APR of 10.000: rateSpread 3.160 for the 30-year, so the APOR is 6.84.
    expect(lookupApor(APOR_TABLE, new Date("2026-09-16T12:00:00Z"), 360, "Fixed")).toMatchObject({
      found: true,
      rate: 6.84,
    });
  });
});

describe("the survey against the published table, across the vendored year", () => {
  const { echoes, divergences } = crossCheck(rows, survey);

  it("cross-checks every week the survey reaches", () => {
    expect(echoes.length).toBe(survey.length);
  });

  it("agrees to the cent on every week the CFPB followed its method, and differs on exactly the announced ones", () => {
    const where = divergences.map((d) => `${d.weekOf}/${d.termYears}`).sort();
    expect(where).toEqual(
      [
        // Christmas Thursday: footnote 2 of the methodology, the prior week's
        // figures republished. The survey file carries a 2025-12-25 row the
        // CFPB never used.
        "2025-12-29/30",
        "2025-12-29/20",
        "2025-12-29/15",
        "2025-12-29/10",
        // Two sets published for the week; the calculator kept the higher per
        // term, and for these three the first set was higher.
        "2026-01-05/20",
        "2026-01-05/15",
        "2026-01-05/10",
      ].sort(),
    );
  });

  it("names the carry-forward for what it is: the prior week's published figures", () => {
    const before = rows.find((r) => r.weekOf === "2025-12-22")!;
    const holiday = rows.find((r) => r.weekOf === "2025-12-29")!;
    for (const term of [30, 20, 15, 10]) expect(holiday.byTerm[term]).toBe(before.byTerm[term]);
    expect(divergences.find((d) => d.weekOf === "2025-12-29" && d.termYears === 30)).toMatchObject({
      published: 6.25,
      computed: 6.18,
      deltaBps: 7,
    });
  });

  it("names the revision for what it is: the higher of two publications, per term", () => {
    // From https://files.ffiec.cfpb.gov/apor/01_09_2026_APOR_tables.csv: first
    // set 6.18/5.88/5.69/5.75, revised set 6.19/5.87/5.61/5.74, and the footer
    // says the higher of each was put on the calculator.
    const week = rows.find((r) => r.weekOf === "2026-01-05")!;
    expect([week.byTerm[30], week.byTerm[20], week.byTerm[15], week.byTerm[10]]).toEqual([
      6.19, 5.88, 5.69, 5.75,
    ]);
    expect(divergences.find((d) => d.weekOf === "2026-01-05" && d.termYears === 15)).toMatchObject({
      published: 5.69,
      computed: 5.61,
      deltaBps: 8,
    });
    expect(divergences.some((d) => d.weekOf === "2026-01-05" && d.termYears === 30)).toBe(false);
  });
});

describe("what the table parser refuses", () => {
  const lines = FFIEC_YIELD_TABLE_FIXED.body.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines[0]!;
  const tableOf = (body: string[]) => [header, ...body].join("\n");

  it("a header that is not exactly the fifty terms", () => {
    expect(() => parseYieldTable(tableOf(lines.slice(1)).replace("|49|50", "|49"))).toThrow(
      /header/,
    );
  });

  it("a week that is not a Monday", () => {
    expect(() => parseYieldTable(tableOf([lines[1]!.replace("01/02/2017", "01/03/2017")]))).toThrow(
      /not a Monday/,
    );
  });

  it("a hole in the series", () => {
    expect(() => parseYieldTable(tableOf([lines[1]!, lines[3]!]))).toThrow(/jumps from/);
  });

  it("a rate that is not a rate", () => {
    const cells = lines[1]!.split("|");
    cells[30] = "63.6";
    expect(() => parseYieldTable(tableOf([cells.join("|")]))).toThrow(/not a rate/);
  });

  it("a row with the wrong number of cells", () => {
    expect(() => parseYieldTable(tableOf([`${lines[1]!}|1.0`]))).toThrow(/cells against/);
  });

  it("builds a table through the same loader every other table goes through", () => {
    const table = aporTableFromYieldRows(rows.slice(0, 3), "t");
    expect(table.weeks.length).toBe(3);
    expect(() => aporTableFromYieldRows([rows[0]!, rows[2]!], "t")).toThrow(/jumps/);
  });
});
