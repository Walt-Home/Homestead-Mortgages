/**
 * The book end to end: the sample partner's twelve loans, as .xlsx and as
 * CSV, through the profile and onto the contract.
 */

import { describe, expect, it } from "vitest";
import { ImportedLoanRecordSchema, canonicalRecordHash } from "@hm/shared/portfolio";
import { M3_V1 } from "../m3-v1.js";
import { deriveRecord, parseBook, readBook, splitName } from "../book.js";
import { readTabular, toCsv } from "../tabular.js";
import { NORTHLIGHT, NORTHLIGHT_AS_OF, sampleBook } from "../fixtures/northlight.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

function read(book = sampleBook(), supplement = true) {
  return readBook(
    M3_V1,
    NORTHLIGHT.slug,
    NORTHLIGHT_AS_OF,
    { filename: "northlight.xlsx", bytes: book.tape },
    supplement ? { filename: "supplement.csv", bytes: utf8(book.supplement) } : null,
  );
}

describe("the sample book", () => {
  it("reads twelve loans from the workbook and every one passes the contract", () => {
    const r = read();
    expect(r.rejected).toBe(null);
    expect(r.rows_total).toBe(12);
    expect(r.records).toHaveLength(12);
    expect(r.exceptions).toEqual([]);
    for (const { record } of r.records) {
      expect(() => ImportedLoanRecordSchema.parse(record)).not.toThrow();
      expect(record.servicerSlug).toBe("northlight");
    }
  });

  it("reproduces the worked example on loan 1", () => {
    const one = read().records[0]!;
    expect(one.record.sourceLoanKey).toBe("NL-100001");
    expect(one.record.parties[0]!.legalName).toEqual({
      given: "Maria",
      middle: null,
      surname: "Garcia",
    });
    expect(one.record.parties[0]!.dateOfBirth).toBe("1984-03-14");
    expect(one.record.terms).toMatchObject({
      objective: "purchase",
      program: "conventional",
      lienPosition: "first",
      occupancy: "primary_residence",
      rateType: "fixed",
      originalPrincipalCents: 45_000_000n,
      noteRatePct: "7.250",
      termMonths: 360,
      originatedOn: "2024-09-20",
      firstPaymentOn: "2024-11-01",
      maturityOn: "2054-10-01",
    });
    expect(one.record.servicing).toMatchObject({
      asOf: "2026-09-01T00:00:00.000Z",
      status: "current",
      principalBalanceCents: 44_136_613n,
      scheduledPaymentCents: 306_979n + 61_250n,
      currentRatePct: "7.250",
      nextPaymentDueOn: "2026-10-01",
      delinquencyDays: 0,
    });
  });

  it("reads the delinquency the tape states, and says nothing about a bankruptcy's payments", () => {
    const by = Object.fromEntries(read().records.map((x) => [x.record.sourceLoanKey, x.record]));
    expect(by["NL-100008"]!.servicing).toMatchObject({ status: "delinquent", delinquencyDays: 30 });
    expect(by["NL-100010"]!.servicing).toMatchObject({
      status: "delinquent",
      delinquencyDays: null,
    });
    expect(by["NL-100011"]!.servicing.status).toBe("current");
  });

  it("maps the axes the tape states and leaves the ones it does not as null", () => {
    const by = Object.fromEntries(read().records.map((x) => [x.record.sourceLoanKey, x.record]));
    expect(by["NL-100005"]!.terms.occupancy).toBe("second_home");
    expect(by["NL-100006"]!.terms.occupancy).toBe("investment");
    // "R" is a refinance the tape cannot tell from a cash-out one.
    expect(by["NL-100003"]!.terms.objective).toBe(null);
    expect(by["NL-100009"]!.terms.objective).toBe(null);
  });

  it("takes the supplement's date of birth and ignores its contact by name", () => {
    const r = read();
    expect(r.supplement).toEqual({
      rows: 11,
      ignored_columns: ["borrower_email", "borrower_phone"],
    });
    const twelve = r.records.find((x) => x.record.sourceLoanKey === "NL-100012")!;
    expect(twelve.record.parties[0]!.dateOfBirth).toBe(null);
    expect(r.gaps).toEqual({ dob: 1, mailing_address: 12, coborrower: 12 });
    // And nothing anywhere in a record or its facts is an address or a number.
    const asText = (v: unknown) =>
      JSON.stringify(v, (_, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
    for (const { record, facts } of r.records) {
      const text = asText(record) + asText(facts);
      expect(text).not.toMatch(/@example\.com/);
      expect(text).not.toMatch(/555-01|5550/);
    }
  });

  it("carries no investor economics in the facts", () => {
    for (const { facts } of read().records) {
      for (const k of Object.keys(facts)) {
        expect(k).not.toMatch(/retained|investor|remittance|reconciled|mers_min|servicer_name/);
      }
    }
  });

  it("reads the same records from CSV as from the workbook", () => {
    const book = sampleBook();
    const xlsx = read(book);
    const csv = readBook(
      M3_V1,
      NORTHLIGHT.slug,
      NORTHLIGHT_AS_OF,
      { filename: "northlight.csv", bytes: utf8(book.tapeCsv) },
      { filename: "supplement.csv", bytes: utf8(book.supplement) },
    );
    expect(csv.records.map((x) => canonicalRecordHash(x.record))).toEqual(
      xlsx.records.map((x) => canonicalRecordHash(x.record)),
    );
  });

  it("fingerprints a record the same way twice, and differently when a balance moves", () => {
    const a = read().records[0]!.record;
    const b = read().records[0]!.record;
    expect(canonicalRecordHash(a)).toBe(canonicalRecordHash(b));
    const later = read(sampleBook((l) => (l.n === 1 ? { upb_cents: 440000 } : {}))).records[0]!
      .record;
    expect(canonicalRecordHash(later)).not.toBe(canonicalRecordHash(a));
  });

  it("reads a later tape that retires a loan", () => {
    const r = read(
      sampleBook((l) => (l.n === 2 ? { servicing_status: "Paid Off", upb_cents: 0 } : {})),
    );
    const two = r.records.find((x) => x.record.sourceLoanKey === "NL-100002")!;
    expect(two.record.servicing.status).toBe("paid_off");
    expect(two.record.servicing.principalBalanceCents).toBe(0n);
  });
});

describe("what the parser refuses and what it reports", () => {
  it("rejects the whole file when a required header is missing, and writes nothing else", () => {
    const rows = sampleBook().tapeRows.map((r) =>
      r.filter((_, i) => M3_V1.columns[i]!.key !== "original_term_months"),
    );
    const r = readBook(
      M3_V1,
      "northlight",
      NORTHLIGHT_AS_OF,
      { filename: "t.csv", bytes: utf8(toCsv(rows)) },
      null,
    );
    expect(r.rejected).toEqual({ missing_headers: ["Term"] });
    expect(r.records).toEqual([]);
  });

  it("loads a loan number seen twice once, and reports the second", () => {
    const book = sampleBook();
    const rows = [...book.tapeRows, book.tapeRows[1]!];
    const r = readBook(
      M3_V1,
      "northlight",
      NORTHLIGHT_AS_OF,
      { filename: "t.csv", bytes: utf8(toCsv(rows)) },
      null,
    );
    expect(r.records).toHaveLength(12);
    expect(r.exceptions).toEqual([
      { row: 13, servicer_loan_number: "NL-100001", code: "duplicate_row" },
    ]);
  });

  it("reports a supplement row for a loan that is not on the tape", () => {
    const book = sampleBook();
    const supplement = book.supplement + "NL-999999,,,Nobody Here,1990-01-01\r\n";
    const r = readBook(
      M3_V1,
      "northlight",
      NORTHLIGHT_AS_OF,
      { filename: "t.xlsx", bytes: book.tape },
      { filename: "s.csv", bytes: utf8(supplement) },
    );
    expect(r.exceptions).toEqual([
      {
        row: 12,
        servicer_loan_number: "NL-999999",
        code: "supplement_orphan",
        column: "servicer_loan_number",
      },
    ]);
  });

  it("rejects a row whose name it cannot split rather than guessing", () => {
    // No supplement, so the tape's name is the only one there is.
    const r = read(
      sampleBook((l) => (l.n === 4 ? { borrower_name: "Cher" } : {})),
      false,
    );
    expect(r.records).toHaveLength(11);
    expect(r.exceptions).toEqual([
      {
        row: 4,
        servicer_loan_number: "NL-100004",
        code: "name_unsplit",
        column: "Name Borrower Primary",
      },
    ]);
  });

  it("prefers the supplement's name when it carries one", () => {
    const book = sampleBook();
    const tape = readTabular("t.xlsx", book.tape);
    const supp = readTabular(
      "s.csv",
      utf8(book.supplement.replace("Maria Garcia", '"GARCIA, MARIA J"')),
    );
    const parsed = parseBook(M3_V1, tape, supp);
    const d = deriveRecord(parsed.rows[0]!, "northlight", NORTHLIGHT_AS_OF);
    expect(d.record?.parties[0]!.legalName).toEqual({
      given: "MARIA",
      middle: "J",
      surname: "GARCIA",
    });
  });
});

describe("splitting a name", () => {
  it("handles the shapes a tape carries and refuses the one it should", () => {
    expect(splitName("Maria Garcia")).toEqual({ given: "Maria", middle: null, surname: "Garcia" });
    expect(splitName("John Q Smith")).toEqual({ given: "John", middle: "Q", surname: "Smith" });
    expect(splitName("Maria de la Cruz")).toEqual({
      given: "Maria",
      middle: "de la",
      surname: "Cruz",
    });
    expect(splitName("SMITH, JOHN Q")).toEqual({ given: "JOHN", middle: "Q", surname: "SMITH" });
    expect(splitName("Robert Kim Jr.")).toEqual({ given: "Robert", middle: null, surname: "Kim" });
    expect(splitName("Kevin O'Connell")).toEqual({
      given: "Kevin",
      middle: null,
      surname: "O'Connell",
    });
    expect(splitName("Cher")).toBe(null);
    expect(splitName("")).toBe(null);
    expect(splitName("Smith,")).toBe(null);
  });
});
