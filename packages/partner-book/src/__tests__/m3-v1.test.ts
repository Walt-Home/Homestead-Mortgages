/**
 * The parsers, cell by cell. Doug's worked cases from §33.1 rule 1 are the
 * ones reproduced here; the rest are the edges a partner's export finds.
 */

import { describe, expect, it } from "vitest";
import {
  luhnCheckDigit,
  luhnValidMin,
  M3_V1,
  mapTapeRow,
  parseBool,
  parseDateIso,
  parseIntCell,
  parseMoneyCents,
  parsePctDecimal,
  parseRatePct,
  profileHeadersPresent,
  resolveColumns,
} from "../m3-v1.js";

describe("money", () => {
  it("reads dollars in the forms a servicer writes them, half-up to the cent", () => {
    expect(parseMoneyCents("$441,366.13")).toBe("44136613");
    expect(parseMoneyCents("441366.13")).toBe("44136613");
    expect(parseMoneyCents("(1,234.50)")).toBe("-123450");
    expect(parseMoneyCents("1,234.50-")).toBe("-123450");
    expect(parseMoneyCents("-$12")).toBe("-1200");
    expect(parseMoneyCents("0.005")).toBe("1");
    expect(parseMoneyCents("0.004")).toBe("0");
    expect(parseMoneyCents("0")).toBe("0");
  });

  it("answers null for what it cannot read, never a number", () => {
    expect(parseMoneyCents("")).toBe(null);
    expect(parseMoneyCents("n/a")).toBe(null);
    expect(parseMoneyCents("$")).toBe(null);
    expect(parseMoneyCents("1.2.3")).toBe(null);
  });
});

describe("rates", () => {
  it("keeps three decimals, so an eighth survives", () => {
    expect(parseRatePct("7.25")).toBe("7.250");
    expect(parseRatePct("6.375")).toBe("6.375");
    expect(parseRatePct("7.250%")).toBe("7.250");
    expect(parseRatePct("0.0725")).toBe("7.250");
    expect(parseRatePct("1")).toBe("100.000");
    expect(parseRatePct("-1")).toBe(null);
    expect(parseRatePct("seven")).toBe(null);
  });

  it("keeps a percentage as written and never rescales it", () => {
    expect(parsePctDecimal("80.00")).toBe("80.000");
    expect(parsePctDecimal("80%")).toBe("80.000");
    expect(parsePctDecimal("2.5")).toBe("2.500");
    expect(parsePctDecimal(".5")).toBe("0.500");
  });
});

describe("dates", () => {
  it("reads every form the partner's export has used", () => {
    expect(parseDateIso("2026-09-01")).toBe("2026-09-01");
    expect(parseDateIso("2026-09-01T00:00:00")).toBe("2026-09-01");
    expect(parseDateIso("2026/9/1")).toBe("2026-09-01");
    expect(parseDateIso("9/1/2026")).toBe("2026-09-01");
    expect(parseDateIso("9-1-2026")).toBe("2026-09-01");
    expect(parseDateIso("9/1/26")).toBe("2026-09-01");
    expect(parseDateIso("9/1/49")).toBe("2049-09-01");
    expect(parseDateIso("9/1/50")).toBe("1950-09-01");
    expect(parseDateIso("20260901")).toBe("2026-09-01");
  });

  it("reads an Excel serial, phantom leap day included", () => {
    expect(parseDateIso("60")).toBe("1900-02-29");
    expect(parseDateIso("61")).toBe("1900-03-01");
    expect(parseDateIso("46266")).toBe("2026-09-01");
    expect(parseDateIso("0")).toBe(null);
  });

  it("refuses a day the month does not have", () => {
    expect(parseDateIso("2026-02-30")).toBe(null);
    expect(parseDateIso("2024-02-29")).toBe("2024-02-29");
    expect(parseDateIso("2023-02-29")).toBe(null);
  });
});

describe("integers and booleans", () => {
  it("reads counts", () => {
    expect(parseIntCell("748")).toBe(748);
    expect(parseIntCell("748.0")).toBe(748);
    expect(parseIntCell("1,200")).toBe(1200);
    expect(parseIntCell("748.5")).toBe(null);
    expect(parseIntCell("")).toBe(null);
  });

  it("reads flags", () => {
    for (const yes of ["Y", "yes", "1", "TRUE", "t"]) expect(parseBool(yes)).toBe(true);
    for (const no of ["N", "no", "0", "FALSE", "f"]) expect(parseBool(no)).toBe(false);
    expect(parseBool("maybe")).toBe(null);
  });
});

describe("the MERS MIN", () => {
  it("checks the Luhn digit over the first seventeen", () => {
    const body = "1000123" + "0000001001";
    const min = body + String(luhnCheckDigit(body));
    expect(luhnValidMin(min)).toBe(true);
    const wrong = body + String((luhnCheckDigit(body) + 1) % 10);
    expect(luhnValidMin(wrong)).toBe(false);
    expect(luhnValidMin("12345")).toBe(false);
  });
});

describe("headers", () => {
  it("compares trimmed, collapsed and case-insensitively", () => {
    const headers = M3_V1.columns.map((c) => `  ${c.header.toUpperCase().replace(/ /g, "  ")}  `);
    expect(profileHeadersPresent(M3_V1, headers).ok).toBe(true);
  });

  it("names every required header a tape lacks", () => {
    const without = M3_V1.columns
      .map((c) => c.header)
      .filter((h) => h !== "Servicer Loan Number" && h !== "Term");
    expect(profileHeadersPresent(M3_V1, without)).toEqual({
      ok: false,
      missing: ["Servicer Loan Number", "Term"],
    });
  });

  it("maps a repeated header to the profile's columns in order", () => {
    const cols = resolveColumns(M3_V1, ["Current Occupancy", "Current Occupancy", "Nothing"]);
    expect(cols.map((c) => c?.key ?? null)).toEqual(["occupancy", "occupancy_current", null]);
  });
});

describe("one row", () => {
  const headers = M3_V1.columns.map((c) => c.header);
  const at = (key: string) => M3_V1.columns.findIndex((c) => c.key === key);
  const row = (over: Record<string, string>): string[] => {
    const r = headers.map(() => "");
    r[at("servicer_loan_number")] = "NL-100001";
    r[at("property_state")] = "AZ";
    r[at("upb_cents")] = "441366.13";
    r[at("note_rate_pct")] = "7.250";
    r[at("original_upb_cents")] = "450000.00";
    for (const [k, v] of Object.entries(over)) r[at(k)] = v;
    return r;
  };

  it("keeps every fact but the investor's, and keeps unknown headers verbatim", () => {
    const m = mapTapeRow(M3_V1, [...headers, "Partner Note"], [...row({}), "hello"], 1);
    expect(m.skip).toBe(null);
    expect(m.facts["upb_cents"]).toBe("44136613");
    expect(m.facts["note_rate_pct"]).toBe("7.250");
    expect("servicer_retained_rate_pct" in m.facts).toBe(false);
    expect("mers_min" in m.facts).toBe(false);
    expect("agency_remittance_type" in m.facts).toBe(false);
    expect(m.raw).toEqual({ "Partner Note": "hello" });
  });

  it("skips only for no loan number, no state, or no balance and rate", () => {
    expect(mapTapeRow(M3_V1, headers, row({ servicer_loan_number: "" }), 1).skip).toBe(
      "no_loan_number",
    );
    expect(mapTapeRow(M3_V1, headers, row({ property_state: "" }), 1).skip).toBe("no_state");
    expect(mapTapeRow(M3_V1, headers, row({ note_rate_pct: "" }), 1).skip).toBe(
      "no_balance_or_rate",
    );
    expect(mapTapeRow(M3_V1, headers, row({ upb_cents: "x" }), 1).skip).toBe("no_balance_or_rate");
  });

  it("keeps a row with an unreadable cell and names the column", () => {
    const m = mapTapeRow(M3_V1, headers, row({ fico_current: "seven" }), 3);
    expect(m.skip).toBe(null);
    expect(m.facts["fico_current"]).toBe(null);
    expect(m.exceptions).toEqual([
      {
        row: 3,
        servicer_loan_number: "NL-100001",
        code: "unreadable_cell",
        column: "Current Fico",
      },
    ]);
  });

  it("loads an implausible figure and says so", () => {
    const m = mapTapeRow(M3_V1, headers, row({ note_rate_pct: "26", upb_cents: "600000" }), 4);
    expect(m.skip).toBe(null);
    expect(m.exceptions.map((e) => e.column)).toEqual([
      "Current Interest Rate",
      "Interest Bearing UPB",
    ]);
  });
});
