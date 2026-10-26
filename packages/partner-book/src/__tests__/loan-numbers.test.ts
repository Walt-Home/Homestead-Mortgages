/**
 * A loan number as a writer stores it. On 26 October 2026 a partner's
 * workbook from a Java spreadsheet writer carried every ten-digit loan number
 * as a numeric cell whose stored text was "1.002938533E9"; the reader kept
 * the text, nothing matched the loans the same tape had made before, and
 * every one was made again. These are the cases that decide what the reader
 * does with that text, from a workbook and from a CSV.
 */

import { describe, expect, it } from "vitest";
import { M3_V1, expandScientific, mapTapeRow, plainLoanNumber } from "../m3-v1.js";
import { readBook } from "../book.js";
import { readTabular, toCsv } from "../tabular.js";
import { unzip, writeXlsx, zip } from "../vendored/xlsx.js";
import { NORTHLIGHT, NORTHLIGHT_AS_OF, sampleBook } from "../fixtures/northlight.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * A workbook as a Java writer leaves it: each number in `java` written by
 * the vendored writer as JavaScript prints it, then its `<v>` rewritten to
 * the text Java's Double.toString prints for the same double.
 */
function asJavaWrote(
  rows: readonly (string | number | boolean | null)[][],
  java: Readonly<Record<string, string>>,
): Uint8Array {
  const parts = unzip(writeXlsx(rows));
  const path = "xl/worksheets/sheet1.xml";
  let sheet = new TextDecoder().decode(parts.get(path));
  for (const [plain, stored] of Object.entries(java)) {
    const from = `<v>${plain}</v>`;
    expect(sheet.includes(from), plain).toBe(true);
    sheet = sheet.replaceAll(from, `<v>${stored}</v>`);
  }
  parts.set(path, utf8(sheet));
  return zip([...parts].map(([name, data]) => ({ name, data })));
}

const NUMBERS: Readonly<Record<number, string | number>> = {
  1: 1002938533,
  2: 1003083160,
  3: 158906842,
  4: "4E2",
  5: 1234567,
};

/** The sample book with loans 1–5 renumbered, and one jumbo appraisal and a tiny PMI rate on loan 1. */
const renumbered = (numbers: Readonly<Record<number, string | number>> = NUMBERS) =>
  sampleBook((l) => ({
    servicer_loan_number: numbers[l.n],
    ...(l.n === 1
      ? { appraised_value_cents: 12500000, pmi_rate_pct: 0.0005, property_lot_size: "4E2" }
      : {}),
  }));

const tapeOf = (book: ReturnType<typeof sampleBook>, java: Record<string, string> = {}) =>
  asJavaWrote(book.tapeRows, java);

const JAVA: Readonly<Record<string, string>> = {
  "1002938533": "1.002938533E9",
  "1003083160": "1.00308316E9",
  "158906842": "1.58906842E8",
  "1234567": "1234567.0",
  "12500000": "1.25E7",
  "0.0005": "5.0E-4",
};

function read(tape: Uint8Array, supplement: { filename: string; bytes: Uint8Array } | null) {
  return readBook(
    M3_V1,
    NORTHLIGHT.slug,
    NORTHLIGHT_AS_OF,
    { filename: "grander.xlsx", bytes: tape },
    supplement,
  );
}

describe("a workbook from a Java writer", () => {
  it("reads each stored loan number as its plain digits, and nothing else as a number", () => {
    const r = read(tapeOf(renumbered(), JAVA), null);
    expect(r.exceptions).toEqual([]);
    expect(r.records).toHaveLength(12);
    const keys = r.records.map((x) => x.record.sourceLoanKey);
    expect(keys.slice(0, 5)).toEqual(["1002938533", "1003083160", "158906842", "4E2", "1234567"]);
    expect(r.records[0]!.row.servicer_loan_number).toBe("1002938533");
    expect(r.records[0]!.facts["servicer_loan_number"]).toBe("1002938533");
    // The numeric columns read the same notation to the digit.
    expect(r.records[0]!.facts["appraised_value_cents"]).toBe("1250000000");
    expect(r.records[0]!.facts["pmi_rate_pct"]).toBe("0.050");
    // A text column is never rewritten, whatever it looks like.
    expect(r.records[0]!.facts["property_lot_size"]).toBe("4E2");
  });

  it("joins a supplement from the same writer, and still reads nothing from its phone column", () => {
    const supplement = asJavaWrote(
      [
        ["servicer_loan_number", "borrower_name", "date_of_birth", "borrower_phone"],
        [1002938533, "Maria Garcia", "1984-03-14", 5551234567],
        [1003083160, "James Okafor", "1979-11-02", 5559876543],
      ],
      {
        "1002938533": "1.002938533E9",
        "1003083160": "1.00308316E9",
        "5551234567": "5.551234567E9",
        "5559876543": "5.559876543E9",
      },
    );
    const r = read(tapeOf(renumbered(), JAVA), { filename: "supplement.xlsx", bytes: supplement });
    expect(r.exceptions).toEqual([]);
    expect(r.supplement).toEqual({ rows: 2, ignored_columns: ["borrower_phone"] });
    expect(r.records[0]!.record.parties[0]!.dateOfBirth).toBe("1984-03-14");
    expect(r.records[1]!.record.parties[0]!.dateOfBirth).toBe("1979-11-02");
    const text = JSON.stringify(r.records, (_, x: unknown) =>
      typeof x === "bigint" ? x.toString() : x,
    );
    expect(text).not.toMatch(/5551234567|5559876543|5\.55\d*E9/);
  });

  it("refuses a stored number that names no whole number exactly, rather than guess its digits", () => {
    const r = read(
      tapeOf(
        renumbered({
          1: 9007199254740992, // 2^53, past which a double holds no longer every integer
          2: 1002938533.5,
          3: "1.00294E+11", // a display's rounding, typed into the workbook as text
          4: 9007199254740991, // 2^53 − 1, the last that is exact
        }),
        {
          "9007199254740992": "9.007199254740992E15",
          "1002938533.5": "1.0029385335E9",
          "9007199254740991": "9.007199254740991E15",
        },
      ),
      null,
    );
    expect(r.records).toHaveLength(9);
    expect(r.records.map((x) => x.record.sourceLoanKey)).toContain("9007199254740991");
    expect(r.exceptions.map((e) => [e.row, e.servicer_loan_number, e.code, e.column])).toEqual([
      [1, "9.007199254740992E15", "loan_number_not_exact", "Servicer Loan Number"],
      [2, "1.0029385335E9", "loan_number_not_exact", "Servicer Loan Number"],
      [3, "1.00294E+11", "loan_number_not_exact", "Servicer Loan Number"],
    ]);
    for (const e of r.exceptions) expect(e.detail).toMatch(/as text/);
  });

  it("says which file the book came from, and what kind it was", () => {
    const book = renumbered();
    const tape = tapeOf(book, JAVA);
    const r = read(tape, { filename: "supplement.csv", bytes: utf8(book.supplement) });
    expect(r.tape_filename).toBe("grander.xlsx");
    expect(r.supplement_filename).toBe("supplement.csv");
    expect(read(tape, null).supplement_filename).toBe(null);
    expect(readTabular("tape.bin", tape).kind).toBe("xlsx");
    expect(readTabular("tape.csv", utf8(book.tapeCsv)).kind).toBe("csv");
  });
});

describe("a CSV", () => {
  const csv = (numbers: Readonly<Record<number, string>>) =>
    readBook(
      M3_V1,
      NORTHLIGHT.slug,
      NORTHLIGHT_AS_OF,
      { filename: "tape.csv", bytes: utf8(toCsv(renumbered(numbers).tapeRows)) },
      null,
    );

  it("never writes out a loan number in scientific notation, and says to save the column as text", () => {
    const r = csv({ 1: "1.00294E+11", 2: "1.002938533E9", 3: "1E+11", 4: "4E2" });
    expect(r.records.map((x) => x.record.sourceLoanKey).slice(0, 1)).toEqual(["4E2"]);
    expect(r.exceptions.map((e) => [e.row, e.servicer_loan_number, e.code, e.column])).toEqual([
      [1, "1.00294E+11", "loan_number_scientific", "Servicer Loan Number"],
      [2, "1.002938533E9", "loan_number_scientific", "Servicer Loan Number"],
      [3, "1E+11", "loan_number_scientific", "Servicer Loan Number"],
    ]);
    expect(r.exceptions[0]!.detail).toBe(
      'The loan number reads "1.00294E+11", a number in scientific notation, the way a ' +
        "spreadsheet shows a long one, and the digits it did not show may be gone. Format the " +
        "loan-number column as text and export the file again.",
    );
  });

  it("keeps a loan number with a .0 as written, since a CSV's text is not a stored number", () => {
    const r = csv({ 1: "1234567.0", 2: "001002938533" });
    expect(r.exceptions).toEqual([]);
    expect(r.records.map((x) => x.record.sourceLoanKey).slice(0, 2)).toEqual([
      "1234567.0",
      "001002938533",
    ]);
  });

  it("reports a supplement row it cannot join for the notation, and why", () => {
    const book = renumbered({ 1: "1002938533" });
    const r = readBook(
      M3_V1,
      NORTHLIGHT.slug,
      NORTHLIGHT_AS_OF,
      { filename: "tape.csv", bytes: utf8(toCsv(book.tapeRows)) },
      {
        filename: "supplement.csv",
        bytes: utf8("servicer_loan_number,borrower_name\r\n1.00294E+09,Maria Garcia\r\n"),
      },
    );
    expect(r.exceptions).toEqual([
      {
        row: 1,
        servicer_loan_number: "1.00294E+09",
        code: "supplement_orphan",
        column: "servicer_loan_number",
        detail: expect.stringMatching(/scientific notation/),
      },
    ]);
  });
});

describe("one row, by where it came from", () => {
  const headers = M3_V1.columns.map((c) => c.header);
  const row = (loan: string): string[] => {
    const at = (key: string) => M3_V1.columns.findIndex((c) => c.key === key);
    const r = headers.map(() => "");
    r[at("servicer_loan_number")] = loan;
    r[at("property_state")] = "AZ";
    r[at("upb_cents")] = "441366.13";
    r[at("note_rate_pct")] = "7.250";
    return r;
  };

  it("reads a row as a CSV's when the caller does not say", () => {
    expect(mapTapeRow(M3_V1, headers, row("1.002938533E9"), 1).skip).toBe("loan_number_scientific");
    const m = mapTapeRow(M3_V1, headers, row("1.002938533E9"), 1, "xlsx");
    expect(m.skip).toBe(null);
    expect(m.facts["servicer_loan_number"]).toBe("1002938533");
  });
});

describe("plainLoanNumber", () => {
  it("is the same key for every spelling of one loan's number", () => {
    for (const spelling of [
      "1002938533",
      "1.002938533E9",
      "1.002938533e9",
      " 001002938533 ",
      "1002-938533",
      "1002 938 533",
      "1002938533.0",
    ]) {
      expect(plainLoanNumber(spelling), spelling).toBe("1002938533");
    }
    expect(plainLoanNumber("1.58906842E8")).toBe("158906842");
    expect(plainLoanNumber("9.007199254740991E15")).toBe("9007199254740991");
    expect(plainLoanNumber("0000")).toBe("0");
  });

  it("keeps an identifier with letters, dashes and spaces gone", () => {
    expect(plainLoanNumber("NL-100001")).toBe("NL100001");
    expect(plainLoanNumber("4E2")).toBe("4E2");
    expect(plainLoanNumber("2019E0012")).toBe("2019E0012");
  });

  it("answers null when the notation names no whole number exactly, or nothing is there", () => {
    expect(plainLoanNumber("1.00294E+11")).toBe(null);
    expect(plainLoanNumber("1E+11")).toBe(null);
    expect(plainLoanNumber("9.007199254740992E15")).toBe(null);
    expect(plainLoanNumber("1.0029385335E9")).toBe(null);
    expect(plainLoanNumber("-1.002938533E9")).toBe(null);
    expect(plainLoanNumber("")).toBe(null);
    expect(plainLoanNumber(" - ")).toBe(null);
  });
});

describe("expandScientific", () => {
  it("moves the point and keeps every digit written", () => {
    expect(expandScientific("1.002938533E9")).toBe("1002938533");
    expect(expandScientific("1.25E7")).toBe("12500000");
    expect(expandScientific("5.0E-4")).toBe("0.0005");
    expect(expandScientific("-1.5E2")).toBe("-150");
    expect(expandScientific("4.4999999999999998E-2")).toBe("0.044999999999999998");
    expect(expandScientific("1.0029385335E9")).toBe("1002938533.5");
    expect(expandScientific("0.0E0")).toBe("0");
    expect(expandScientific("4E2")).toBe("400");
  });

  it("answers null for a display's plus sign, an exponent past a double's, and plain text", () => {
    expect(expandScientific("1.00294E+11")).toBe(null);
    expect(expandScientific("1E999")).toBe(null);
    expect(expandScientific("1.23")).toBe(null);
    expect(expandScientific("E5")).toBe(null);
    expect(expandScientific("n/a")).toBe(null);
  });
});
