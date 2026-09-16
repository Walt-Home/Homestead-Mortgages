/**
 * The CFPB's survey, through their method.
 *
 * This is a test of the ARITHMETIC: that `apor-survey.ts` does to a survey row
 * what the CFPB's methodology page says it does, checked against the worked
 * example on that page. Whether the result matches the table the CFPB actually
 * put in force is a different question — it does on every week they followed
 * their method and does not on the weeks they announced otherwise — and that
 * one is answered in `apor-yield.test.ts`, across the whole vendored year.
 */

import { describe, expect, it } from "vitest";
import { FFIEC_SURVEY } from "@hm/shared";
import { aporFor, aporTableFromSurvey, effectiveMonday, parseSurveyCsv } from "../apor-survey.js";

const survey = parseSurveyCsv(FFIEC_SURVEY.csv);
const table = aporTableFromSurvey(survey, "test");

describe("what Appendix J makes of the survey", () => {
  it("computes the numerical example on the CFPB's methodology page to the cent", () => {
    // The methodology page works the week of 2023-03-05: survey rates and
    // points for the four fixed products, and the APRs they compute to. This
    // is the CFPB showing its arithmetic, and ours lands on every figure.
    expect(aporFor({ rate: 6.54, points: 1.21 }, 30)).toBe(6.66);
    expect(aporFor({ rate: 6.29, points: 0.87 }, 20)).toBe(6.4);
    expect(aporFor({ rate: 5.98, points: 1.21 }, 15)).toBe(6.17);
    expect(aporFor({ rate: 5.63, points: 1.59 }, 10)).toBe(5.98);
  });

  it("is the survey's own Thursday row, four days later", () => {
    const row = survey.find((r) => r.surveyDate === "2026-01-01")!;
    expect(row).toBeDefined();
    expect(effectiveMonday(row.surveyDate)).toBe("2026-01-05");
  });

  it("carries one week per survey row, all four terms, in the survey's term order", () => {
    expect(table.weeks.length).toBe(survey.length);
    expect(table.termYears).toEqual([30, 20, 15, 10]);
    for (const week of table.weeks) expect(week.fixed.length).toBe(4);
  });

  it("puts the points into the APR rather than ignoring them", () => {
    // The APOR is above the survey's contract rate by exactly the points'
    // worth — which is the whole reason it is an APR and not a rate.
    const row = survey[survey.length - 1]!;
    expect(aporFor(row.fixed[30], 30)).toBeGreaterThan(row.fixed[30].rate);
    expect(aporFor({ rate: row.fixed[30].rate, points: 0 }, 30)).toBeCloseTo(row.fixed[30].rate, 2);
  });

  it("rounds once, from the unrounded solve, to the two places the CFPB publishes", () => {
    // 2026-09-03's 30-year computes to 6.784722…: 6.78 rounded once, 6.79
    // rounded through three places first. The CFPB published 6.78. Nine of
    // the 208 figures in the vendored year sit in that band.
    const row = survey.find((r) => r.surveyDate === "2026-09-03")!;
    expect(aporFor(row.fixed[30], 30)).toBe(6.78);
  });

  it("reads the columns it needs by name and ignores the rest", () => {
    // An added column cannot shift a lookup by name; a renamed required one
    // fails the required check. Enumerating every column bought nothing but an
    // outage the day the CFPB adds one.
    const lines = FFIEC_SURVEY.csv.split(/\r?\n/);
    const widened = [
      `${lines[0]},40-Year Fixed Rates`,
      ...lines
        .slice(1)
        .filter(Boolean)
        .map((l) => `${l},6.9`),
    ].join("\n");
    expect(parseSurveyCsv(widened).length).toBe(survey.length);
  });
});

describe("what the parser refuses", () => {
  const header = FFIEC_SURVEY.csv.split(/\r?\n/)[0]!;
  const rows = FFIEC_SURVEY.csv
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim() !== "");
  const csvOf = (lines: string[]) => [header, ...lines].join("\n");

  it("a required column renamed, because that IS a reshaped file", () => {
    const renamed = FFIEC_SURVEY.csv.replace("30-Year Fixed Rates", "30-Year Fixed Rate");
    expect(() => parseSurveyCsv(renamed)).toThrow(/no "30-Year Fixed Rates" column/);
  });

  it("a survey dated on anything but a Thursday", () => {
    const wednesday = rows[0]!.replace(
      /^(\d{4}-\d{2}-)(\d{2})/,
      (_, ym: string, d: string) => `${ym}${String(Number(d) - 1).padStart(2, "0")}`,
    );
    expect(() => parseSurveyCsv(csvOf([wednesday]))).toThrow(/not a Thursday/);
  });

  it("a series with a week missing, because the hole would answer the week before it", () => {
    expect(() => parseSurveyCsv(csvOf([rows[0]!, rows[2]!]))).toThrow(/jumps from/);
  });

  it("a rate that is not a rate", () => {
    const cells = rows[0]!.split(",");
    const at = header.split(",").indexOf("30-Year Fixed Rates");
    cells[at] = "66.5";
    expect(() => parseSurveyCsv(csvOf([cells.join(",")]))).toThrow(/outside/);
  });

  it("a row with the wrong number of cells", () => {
    expect(() => parseSurveyCsv(csvOf([`${rows[0]!},1.0`]))).toThrow(/cells against/);
  });

  it("a header and nothing under it", () => {
    expect(() => parseSurveyCsv(`${header}\n`)).toThrow(/no rows/);
  });

  it("tolerates a byte-order mark and CRLF, both of which that server has sent", () => {
    const crlf = `\uFEFF${[header, rows[0]!, rows[1]!].join("\r\n")}\r\n`;
    expect(parseSurveyCsv(crlf).length).toBe(2);
  });
});
