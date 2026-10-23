/**
 * The tape writer: a ten-year book of two hundred loans written as a
 * partner's monthly m3-v1 tapes and read back by the partner-book reader,
 * every fact and every field of the partner-feed contract equal to the
 * month-end projection's; and T-03, the first tape-stream defect, planted,
 * labeled, and followed through the reader to what it reaches; and the other
 * four with it, in every form, merged when two fall in one month.
 *
 * The reader is `@hm/partner-book`, a test-only import here: the writer
 * cannot import it (tape.ts says why), so this is where both are.
 */

import { describe, expect, it } from "vitest";
import { addMonths, parts, type PlainDate } from "@hm/kernel/calendar";
import { Decimal } from "@hm/kernel/money";
import {
  M3_V1,
  M3_V1_COLUMNS,
  readBook,
  writeXlsx,
  type Fact,
  type ReadBook,
} from "@hm/partner-book";
import {
  ImportedLoanRecordSchema,
  canonicalRecordHash,
  type ImportedLoanRecord,
} from "@hm/shared/portfolio";
import { toJsonLine } from "../record.js";
import {
  M3_NOTATION,
  READ_TABLES,
  T02,
  T02_RENAMES,
  TAPE_COLUMNS,
  defaultCalibration,
  excelSerial,
  generate,
  plantTapeDefects,
  tapeColumnIndex,
  tapeDate,
  tapeDefectById,
  tapeProjection,
  tapeStream,
  tapeSymptomLabels,
  toCsvText,
  writeSupplement,
  writeTape,
  type TapeFile,
  type TapeLoading,
  type TapeReading,
  type TapeRow,
} from "../life/index.js";

const SLUG = "life-partner";
const cal = defaultCalibration();
// Transfers out on, so a tape carries every status the projection has.
const book = generate(
  "tape",
  { loans: 200, random: { transfers_out: true } },
  { calibration: cal },
).clean;
const stream = tapeStream(book);
const utf8 = (s: string) => new TextEncoder().encode(s);

/** A tape read with the supplement the partner sends beside it. */
const read = (f: TapeFile, bytes: Uint8Array = utf8(toCsvText(f)), filename = f.filename) => {
  const s = writeSupplement(book, f.month);
  return readBook(
    M3_V1,
    SLUG,
    f.as_of,
    { filename, bytes },
    { filename: s.filename, bytes: utf8(toCsvText(s)) },
  );
};

let clean: Map<string, ReadBook> | null = null;
/** Every clean tape read once, by month. */
const readings = (): Map<string, ReadBook> =>
  (clean ??= new Map(stream.map((f) => [f.month, read(f)])));

/* ── what the round trip must give ───────────────────────────────────────── */

const NON_INVESTOR = M3_V1_COLUMNS.filter((c) => !c.investor);
const OCCUPANCY = { principal: "primary_residence" } as const;

/** The facts the reader should keep from a row: the projection's values in the reader's forms, null where the projection has none. */
function expectedFacts(r: TapeRow): Record<string, Fact> {
  const money = (c: bigint | null) => (c === null ? null : c.toString());
  const rate = (s: string | null) => (s === null ? null : Decimal.parse(s).toFixed(3));
  const pct = (n: number | null) => (n === null ? null : n.toFixed(3));
  const occ = M3_NOTATION.occupancy[r.property.occupancy as keyof typeof M3_NOTATION.occupancy];
  const type =
    M3_NOTATION.property_type[r.property.property_type as keyof typeof M3_NOTATION.property_type];
  const known: Record<string, Fact> = {
    as_of_date: r.as_of_date,
    servicer_loan_number: r.servicer_loan_number,
    lien_position: M3_NOTATION.lien_position[r.terms.lien_position],
    borrower_name: r.borrower.borrower_name,
    property_address: r.property.property_address,
    property_city: r.property.property_city,
    property_state: r.property.property_state,
    property_zip: r.property.property_zip,
    original_upb_cents: money(r.terms.original_upb_cents),
    upb_cents: money(r.balance.upb_cents),
    deferred_upb_cents: money(r.balance.deferred_upb_cents),
    total_upb_cents: money(r.balance.total_upb_cents),
    original_note_rate_pct: rate(r.terms.original_note_rate_pct),
    note_rate_pct: rate(r.terms.note_rate_pct),
    pi_cents: money(r.terms.pi_cents),
    ti_cents: money(r.terms.ti_cents),
    total_due_cents: money(r.terms.total_due_cents),
    interest_paid_to_date: r.status.interest_paid_to_date,
    next_due_date: r.status.next_due_date,
    last_payment_date: r.status.last_payment_date,
    pay_string: r.pay_string,
    appraised_value_cents: money(r.property.appraised_value_cents),
    original_occupancy_code: occ.code,
    occupancy: occ.text,
    property_type_code: type.code,
    loan_type: M3_NOTATION.loan_type[r.terms.loan_type],
    maturity_date: r.terms.maturity_date,
    first_payment_date: r.terms.first_payment_date,
    origination_date: r.terms.origination_date,
    arm_index: r.terms.arm_index,
    arm_margin_pct: rate(r.terms.arm_margin_pct),
    arm_fixed_period_months: r.terms.arm_fixed_period_months,
    arm_payment_adj_period_months: r.terms.arm_payment_adj_period_months,
    arm_rate_ceiling_pct: rate(r.terms.arm_rate_ceiling_pct),
    arm_rate_floor_pct: rate(r.terms.arm_rate_floor_pct),
    arm_adj_freq_months: r.terms.arm_adj_freq_months,
    arm_neg_am: r.terms.arm_neg_am,
    ltv_original_pct: pct(r.terms.ltv_original_pct),
    interest_only: r.terms.interest_only,
    balloon: r.terms.balloon,
    original_term_months: r.terms.original_term_months,
    remaining_term_months: r.terms.remaining_term_months,
    ...Object.fromEntries(
      r.cash_flow.map((c, i) => [`cash_flow_month_${String(i + 1).padStart(2, "0")}`, money(c)]),
    ),
    fc_status: r.foreclosure.fc_status,
    fc_referral_date: r.foreclosure.fc_referral_date,
    fc_sale_scheduled_date: r.foreclosure.fc_sale_scheduled_date,
    fc_sale_held_date: r.foreclosure.fc_sale_held_date,
    bk_status: r.bankruptcy.bk_status,
    bk_chapter: r.bankruptcy.bk_chapter,
    bk_filed_date: r.bankruptcy.bk_filed_date,
    bk_motion_for_relief_date: r.bankruptcy.bk_motion_for_relief_date,
    bk_discharged: r.bankruptcy.bk_discharged,
    bk_discharged_date: r.bankruptcy.bk_discharged_date,
    bk_dismissed_date: r.bankruptcy.bk_dismissed_date,
    servicing_status: M3_NOTATION.servicing_status[r.status.servicing_status],
    pmi_flag: r.pmi.pmi_flag,
    // In basis points on the tape, and the reader keeps the number it was given.
    pmi_rate_pct:
      r.pmi.pmi_rate_pct === null
        ? null
        : Decimal.parse(r.pmi.pmi_rate_pct).mul(Decimal.fromInt(100)).toFixed(3),
    pmi_homeowner_payment_pct: pct(r.pmi.pmi_homeowner_payment_pct),
    pmi_coverage_pct: pct(r.pmi.pmi_coverage_pct),
    pmi_company: r.pmi.pmi_company,
    occupancy_current: occ.short,
    property_type: type.text,
    contact_expected: r.contact.contact_expected,
    last_contact_date: r.contact.last_contact_date,
    accrued_interest_cents: money(r.balance.accrued_interest_cents),
    escrow_balance_cents: money(r.escrow.escrow_balance_cents),
    escrow_advances_cents: money(r.escrow.escrow_advances_cents),
    mba_delinquency_status: M3_NOTATION.mba_delinquency_status[r.status.mba_delinquency_status],
    mba_pay_string: r.mba_pay_string,
    orig_maturity_date: r.terms.maturity_date,
  };
  return Object.fromEntries(NON_INVESTOR.map((c) => [c.key, known[c.key] ?? null]));
}

/**
 * The contract's record for a row. Its status and days are the MBA status,
 * as the reader reads the tape's (`servicingStatusOf`): "C" is current at
 * zero days, a bucket is delinquent by its days, and a loan that closed has
 * none. The m3 layout carries the primary borrower only, with the date of
 * birth from the supplement and no mailing address, and no purpose code.
 */
function expectedRecord(r: TapeRow): ImportedLoanRecord {
  const b1 = r.borrower.parties.find((p) => p.role === "PRIMARY_BORROWER")!;
  const st = r.status.servicing_status;
  const ended = st === "paid_off" || st === "transferred";
  const mba = r.status.mba_delinquency_status;
  return {
    sourceLoanKey: r.servicer_loan_number,
    servicerSlug: SLUG,
    parties: [
      {
        sourcePartyKey: `${r.servicer_loan_number}-1`,
        role: "PRIMARY_BORROWER",
        legalName: { given: b1.given_name, middle: null, surname: b1.surname },
        dateOfBirth: b1.date_of_birth,
        mailingAddress: null,
      },
    ],
    property: {
      line1: r.property.property_address,
      line2: null,
      city: r.property.property_city,
      state: r.property.property_state,
      postalCode: r.property.property_zip,
      apn: null,
    },
    terms: {
      objective: null,
      program: r.terms.loan_type,
      lienPosition: r.terms.lien_position,
      occupancy: OCCUPANCY[r.property.occupancy as keyof typeof OCCUPANCY],
      rateType: r.terms.arm_index === null ? "fixed" : "arm",
      originalPrincipalCents: r.terms.original_upb_cents,
      noteRatePct: r.terms.original_note_rate_pct,
      termMonths: r.terms.original_term_months,
      originatedOn: r.terms.origination_date,
      firstPaymentOn: r.terms.first_payment_date,
      maturityOn: r.terms.maturity_date,
    },
    servicing: {
      asOf: `${r.as_of_date}T00:00:00.000Z`,
      status: ended ? st : mba === "current" ? "current" : "delinquent",
      principalBalanceCents: r.balance.upb_cents,
      escrowBalanceCents: r.escrow.escrow_balance_cents,
      scheduledPaymentCents: r.terms.pi_cents + r.terms.ti_cents,
      currentRatePct: r.terms.note_rate_pct,
      nextPaymentDueOn: r.status.next_due_date,
      delinquencyDays: ended ? null : mba === "current" ? 0 : Number(mba.replace("+", "")),
    },
  };
}

/** Every leaf by its dotted path, for a readable difference. */
function flat(v: unknown, path = "", out = new Map<string, string>()): Map<string, string> {
  if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) flat(x, path ? `${path}.${k}` : k, out);
  } else out.set(path, typeof v === "bigint" ? `${v}n` : JSON.stringify(v));
  return out;
}
function differences(got: unknown, want: unknown): string[] {
  const a = flat(got);
  const b = flat(want);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((k) => a.get(k) !== b.get(k))
    .map((k) => `${k}: read ${a.get(k)}, projected ${b.get(k)}`);
}

/* ── the writer ──────────────────────────────────────────────────────────── */

describe("the tape writer", () => {
  it("lays out the profile's 118 columns in its order, with its headers, keys and types", () => {
    expect(TAPE_COLUMNS.map(({ cell: _cell, ...c }) => c)).toEqual(M3_V1_COLUMNS);
    expect(TAPE_COLUMNS.length).toBe(118);
  });

  it("writes one row per loan per month, the month-end its as-of, through the decade", () => {
    expect(book.loans.length).toBeGreaterThanOrEqual(200);
    const first = stream[0]!;
    const last = stream.at(-1)!;
    expect([first.month, first.as_of]).toEqual(["2026-03", "2026-03-31"]);
    expect(stream.length).toBeGreaterThanOrEqual(120);
    expect(last.as_of > "2036-03-01").toBe(true);
    const asOf = tapeColumnIndex("as_of_date");
    let rows = 0;
    for (const f of stream) {
      expect(new Set(f.loans).size).toBe(f.loans.length);
      const loanNumbers = f.rows.map((r) => r[tapeColumnIndex("servicer_loan_number")]);
      expect(new Set(loanNumbers).size).toBe(loanNumbers.length);
      for (const r of f.rows) {
        expect(r.length).toBe(118);
        const [y, m, d] = f.as_of.split("-").map(Number);
        expect(r[asOf]).toBe(`${m}/${d}/${y}`);
      }
      rows += f.rows.length;
    }
    // Every loan-month on our books is on exactly one tape.
    const loanMonths = book.loans.reduce(
      (s, l) => s + l.months.filter((m) => m.servicer === "us").length,
      0,
    );
    expect(rows).toBe(loanMonths);
  });

  it("reads back onto the contract with every fact and field equal to the projection's", () => {
    const bad: string[] = [];
    const seen = {
      status: new Set<string>(),
      mba: new Set<string>(),
      arm: 0,
      mi: 0,
      zeroZip: 0,
      coborrower: 0,
      negativeEscrow: 0,
      mbaAhead: 0,
      paidAhead: 0,
    };
    let records = 0;
    for (const f of stream) {
      const proj = tapeProjection(book, f.month);
      const r = readings().get(f.month)!;
      if (r.rejected) bad.push(`${f.month}: rejected, ${r.rejected.missing_headers.join(", ")}`);
      for (const e of r.exceptions) bad.push(`${f.month}: ${toJsonLine(e)}`);
      if (r.records.length !== proj.length)
        bad.push(`${f.month}: ${r.records.length} records for ${proj.length} rows`);
      expect(r.gaps).toEqual({ dob: 0, mailing_address: proj.length, coborrower: proj.length });
      r.records.forEach((x, i) => {
        const p = proj[i]!;
        const want = expectedRecord(p);
        for (const d of differences(x.record, want)) bad.push(`${f.month} ${p.loan_id} ${d}`);
        for (const d of differences(x.facts, expectedFacts(p)))
          bad.push(`${f.month} ${p.loan_id} facts.${d}`);
        expect(canonicalRecordHash(ImportedLoanRecordSchema.parse(want))).toBe(
          canonicalRecordHash(x.record),
        );
        seen.status.add(x.record.servicing.status);
        seen.mba.add(p.status.mba_delinquency_status);
        if (p.terms.arm_index) seen.arm++;
        if (p.pmi.pmi_flag) seen.mi++;
        if (p.property.property_zip.startsWith("0")) seen.zeroZip++;
        if (p.borrower.parties.length > 1) seen.coborrower++;
        if (p.escrow.escrow_balance_cents < 0n) seen.negativeEscrow++;
        // A loan still being paid has a next due date, the installment after the one interest is paid to, and its
        // remaining term counts from it: on a borrower who paid next month's installment early too.
        const st = p.status.servicing_status;
        if (st === "current" || st === "delinquent") {
          const next = p.status.next_due_date;
          const ipd = p.status.interest_paid_to_date;
          if (next === null || ipd === null || next !== addMonths(ipd, 1))
            bad.push(`${f.month} ${p.loan_id} next due ${next}, interest paid to ${ipd}`);
          else {
            const [n, mat] = [parts(next), parts(p.terms.maturity_date)];
            const left = (mat.y - n.y) * 12 + mat.m - n.m + 1;
            if (p.terms.remaining_term_months !== left)
              bad.push(
                `${f.month} ${p.loan_id} ${p.terms.remaining_term_months} months, not ${left}`,
              );
          }
          if (ipd !== null && ipd > p.as_of_date) seen.paidAhead++;
        }
        if (p.status.servicing_status === "current" && x.record.servicing.status === "delinquent")
          seen.mbaAhead++;
        records++;
      });
    }
    expect(bad.slice(0, 20)).toEqual([]);
    expect(records).toBeGreaterThan(13_000);
    // The book reaches every status the contract has for it, and the rows the formats are hardest on.
    expect([...seen.status].sort()).toEqual(["current", "delinquent", "paid_off", "transferred"]);
    expect([...seen.mba].sort()).toEqual(expect.arrayContaining(["30", "60", "90", "current"]));
    expect(seen.arm).toBeGreaterThan(0);
    expect(seen.mi).toBeGreaterThan(0);
    expect(seen.zeroZip).toBeGreaterThan(0);
    expect(seen.coborrower).toBeGreaterThan(0);
    expect(seen.negativeEscrow).toBeGreaterThan(0);
    // A loan a payment behind at the end of a month shorter than 31 days: under 30 days by
    // Regulation X's count, which the projection's status follows, and 30 by the MBA's, which the
    // tape carries and the contract reads.
    expect(seen.mbaAhead).toBeGreaterThan(0);
    // Paid next month's installment before the month-end: the ledger holds nothing open for it.
    expect(seen.paidAhead).toBeGreaterThan(1_000);
  });

  it("reads the same tape the same from a workbook", () => {
    for (const f of [stream[0]!, stream[70]!, stream.at(-1)!]) {
      const csv = readings().get(f.month)!;
      const xlsx = read(
        f,
        writeXlsx([[...f.headers], ...f.rows.map((r) => [...r])], "M3"),
        "t.xlsx",
      );
      expect(xlsx.exceptions).toEqual([]);
      expect(xlsx.records.map((x) => canonicalRecordHash(x.record))).toEqual(
        csv.records.map((x) => canonicalRecordHash(x.record)),
      );
      expect(toJsonLine(xlsx.records.map((x) => x.facts))).toBe(
        toJsonLine(csv.records.map((x) => x.facts)),
      );
    }
  });

  it("puts a loan transferred in on the prior servicer's tape until the transfer, and on ours after", () => {
    const res = generate(
      "tape-prior",
      { loans: 2, random: false, events: [{ kind: "transfer_in", loan: 0, month: 12 }] },
      { calibration: cal },
    ).clean;
    const l = res.loans[0]!;
    const transfer = l.transfer_in_on!.slice(0, 7);
    const ours = tapeStream(res);
    const prior = tapeStream(res, { servicer: "prior" });
    const on = (fs: TapeFile[]) =>
      fs.filter((f) => f.loans.includes(l.loan_id)).map((f) => f.month);
    expect(on(prior).at(-1)! < transfer).toBe(true);
    expect(on(ours)[0]).toBe(transfer);
    expect(on(prior).length + on(ours).length).toBe(l.months.length);
    const n = tapeColumnIndex("servicer_loan_number");
    const row = (f: TapeFile) => f.rows[f.loans.indexOf(l.loan_id)]!;
    expect(row(prior[0]!)[n]).toBe(l.draw.prior_servicer_loan_number);
    expect(row(ours.find((f) => f.month === transfer)!)[n]).toBe(l.draw.servicer_loan_number);
    expect(prior[0]!.filename).toBe(`prior-tape-${prior[0]!.month}.csv`);
    const s = writeSupplement(res, prior[0]!.month, { servicer: "prior" });
    expect(s.rows.map((r) => r[0])).toContain(l.draw.prior_servicer_loan_number);
    expect(s.rows.length).toBe(prior[0]!.rows.length);
  });

  it("refuses a code it has no notation for rather than guessing", () => {
    const f = writeTape(book, "2030-06");
    expect(f.rows.length).toBeGreaterThan(0);
    const p = tapeProjection(book, "2030-06")[0]!;
    const odd = { ...p, property: { ...p.property, occupancy: "vacant" } };
    expect(() => TAPE_COLUMNS.map((c) => c.cell(odd))).toThrow(
      /no notation for occupancy "vacant"/,
    );
  });

  it("writes the same bytes from the same seed, and other bytes from another", () => {
    const text = (seed: string) => {
      const b = generate(seed, { loans: 30 }, { calibration: cal }).clean;
      return tapeStream(b).map((f) => toCsvText(f) + toCsvText(writeSupplement(b, f.month)));
    };
    const a = text("tape-again");
    expect(text("tape-again")).toEqual(a);
    expect(text("tape-other")).not.toEqual(a);
  });

  it("refuses two loans with one loan number on a tape rather than write a duplicate", () => {
    const two = generate("tape-dup", { loans: 2, random: false }, { calibration: cal }).clean;
    const a = two.loans[0]!;
    const b = two.loans[1]!;
    const month = a.months[3]!.month;
    expect(writeTape(two, month).rows.length).toBe(2);
    const dup = {
      ...two,
      loans: [a, { ...b, draw: { ...b.draw, servicer_loan_number: a.draw.servicer_loan_number } }],
    };
    expect(() => writeTape(dup, month)).toThrow(
      new RegExp(`${a.loan_id} and ${b.loan_id} both carry loan number`),
    );
    expect(() => writeSupplement(dup, month)).toThrow(/a clean tape carries each loan once/);
  });
});

/* ── tape-stream defects ─────────────────────────────────────────────────── */

/** The partner-book reader, as a `TapeReading`: the record, facts and raw cells of each row, its exceptions, a refusal. */
const reading = (f: TapeFile): TapeReading => {
  const r = read(f);
  return {
    rejected: r.rejected ? `missing ${r.rejected.missing_headers.join(", ")}` : null,
    rows: r.records.map((x) => ({
      servicer_loan_number: x.record.sourceLoanKey,
      tables: {
        [READ_TABLES.record]: x.record,
        [READ_TABLES.facts]: x.facts,
        [READ_TABLES.raw]: x.row.raw,
      },
    })),
    exceptions: r.exceptions.map((e) => ({
      servicer_loan_number: e.servicer_loan_number,
      code: e.code,
      ...(e.column ? { column: e.column } : {}),
    })),
  };
};

/** Every cell and header that differs between two files of one layout: [loan, header, the first's, the second's]. */
function cellsChanged(a: TapeFile, b: TapeFile): string[] {
  const out: string[] = [];
  a.headers.forEach((h, j) => {
    if (h !== b.headers[j]) out.push(toJsonLine(["*", TAPE_COLUMNS[j]!.header, h, b.headers[j]]));
  });
  a.rows.forEach((row, i) =>
    row.forEach((cell, j) => {
      if (cell !== b.rows[i]![j])
        out.push(toJsonLine([a.loans[i], TAPE_COLUMNS[j]!.header, cell, b.rows[i]![j]]));
    }),
  );
  return out;
}
const rootKey = (x: {
  loan: string;
  field: string;
  row: string;
  true_value: string | null;
  planted_value: string | null;
}) =>
  x.row === "header"
    ? toJsonLine(["*", x.field, x.true_value, x.planted_value])
    : toJsonLine([x.loan, x.field, x.true_value, x.planted_value]);

/** The facts a date column's cell feeds, and the contract's fields read from them. */
const READS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  "Next Due Date": [
    [READ_TABLES.facts, "next_due_date"],
    [READ_TABLES.record, "servicing.nextPaymentDueOn"],
  ],
  "Date Maturity": [
    [READ_TABLES.facts, "maturity_date"],
    [READ_TABLES.record, "terms.maturityOn"],
  ],
  "Date Payment Due First": [
    [READ_TABLES.facts, "first_payment_date"],
    [READ_TABLES.record, "terms.firstPaymentOn"],
  ],
  "Orig Date Closing": [
    [READ_TABLES.facts, "origination_date"],
    [READ_TABLES.record, "terms.originatedOn"],
  ],
  IPD: [[READ_TABLES.facts, "interest_paid_to_date"]],
  "Orig Maturity Date": [[READ_TABLES.facts, "orig_maturity_date"]],
  "As of Date": [
    [READ_TABLES.facts, "as_of_date"],
    [READ_TABLES.record, "servicing.asOf"],
  ],
};
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

describe("tape-stream defects", () => {
  const at = (k: number) => stream[k]!.month;
  /** Every defect in every form, one month each, two for day-first dates. */
  const plan = [
    { id: "T-01", months: [at(5)], variant: "missing" },
    { id: "T-01", months: [at(9)], variant: "resent" },
    { id: "T-01", months: [at(13)], variant: "relabeled" },
    { id: "T-02", months: [at(17)], variant: "required" },
    { id: "T-02", months: [at(21)], variant: "optional" },
    { id: "T-03", months: [at(25), at(61), at(stream.length - 2)] },
    { id: "T-04", months: [at(29)], variant: "two_digit_year" },
    { id: "T-04", months: [at(33)], variant: "serial" },
    { id: "T-04", months: [at(37)], variant: "day_first", column: "Orig Date Closing" },
    { id: "T-04", months: [at(41)], variant: "day_first", column: "Next Due Date" },
    { id: "T-05", months: [at(45)], variant: "export_date" },
    { id: "T-05", months: [at(49)], variant: "prior_month_end" },
  ];
  const p = plantTapeDefects(book, stream, plan);
  const symptoms = tapeSymptomLabels(p, reading);
  const clean = (m: string) => stream.find((f) => f.month === m)!;
  const delivered = (m: string) => p.planted.filter((f) => f.month === m);
  const symptomsAt = (m: string) => symptoms.filter((x) => x.on === clean(m).as_of);
  const rootsAt = (m: string) => p.labels.filter((l) => l.on === clean(m).as_of);

  it("plants each defect in every form where it is asked for, and labels every value it changed", () => {
    expect(p.clean).toBe(stream);
    expect(p.skipped).toEqual([]);
    expect(p.placed.map((x) => x.month)).toEqual(
      plan.flatMap((r) => r.months).sort((a, b) => (a < b ? -1 : 1)),
    );
    for (const x of p.placed) {
      const c = clean(x.month);
      const roots = rootsAt(x.month);
      for (const l of roots) {
        expect([l.defect_id, l.root_cause]).toEqual([x.defect_id, true]);
        expect(l.expected_handling).toBe(tapeDefectById(x.defect_id).handling(x.variant));
      }
      const got = delivered(x.month);
      if (x.defect_id === "T-01") {
        // The month's file missing, or last month's in its slot: under its own name, or this month's.
        const prior = stream[stream.indexOf(c) - 1]!;
        expect(roots.map((l) => [l.field, l.row, l.tape, l.true_value])).toEqual([
          ["file", x.month, c.filename, `${c.filename} as of ${c.as_of}`],
        ]);
        if (x.variant === "missing") {
          expect(got).toEqual([]);
          expect(roots[0]!.planted_value).toBeNull();
          continue;
        }
        expect(got.length).toBe(1);
        expect([got[0]!.rows, got[0]!.as_of, got[0]!.loans]).toEqual([
          prior.rows,
          prior.as_of,
          prior.loans,
        ]);
        expect(got[0]!.filename).toBe(x.variant === "resent" ? prior.filename : c.filename);
        expect(roots[0]!.planted_value).toBe(`${got[0]!.filename} as of ${prior.as_of}`);
        continue;
      }
      // Every other defect changes cells (or a header) of the month's file, each one labeled, and nothing else.
      expect(got.map((f) => f.filename)).toEqual([c.filename]);
      expect(roots.map(rootKey).sort()).toEqual(cellsChanged(c, got[0]!).sort());
      expect(roots.length).toBeGreaterThan(0);
      for (const l of roots) expect(l.tape).toBe(c.filename);
      if (x.column) for (const l of roots) expect(l.field).toBe(x.column);
    }
    // Every other file is the clean one, untouched.
    const planted = new Set(p.placed.map((x) => x.month));
    for (const f of p.planted) if (!planted.has(f.month)) expect(stream).toContain(f);
  });

  it("writes each form as a spreadsheet or an export does", () => {
    const one = (k: number) => rootsAt(at(k))[0]!;
    const parse = (s: string) => s.split("/").map(Number);
    // Two-digit years, Excel's serial day numbers, the day first; the as-of the export's day or last month's end.
    const two = one(29);
    expect(two.planted_value).toBe(two.true_value!.replace(/\/\d\d(\d\d)$/, "/$1"));
    const serial = one(33);
    const [sm, sd, sy] = parse(serial.true_value!);
    expect(serial.planted_value).toBe(String(excelSerial(iso(sy!, sm!, sd!) as PlainDate)));
    for (const k of [37, 41])
      for (const l of rootsAt(at(k))) {
        const [m, d, y] = parse(l.true_value!);
        expect(l.planted_value).toBe(`${d}/${m}/${y}`);
        expect(m).not.toBe(d);
      }
    const exported = one(45);
    const end = clean(at(45)).as_of;
    const [em, ed, ey] = parse(exported.planted_value!);
    const day = iso(ey!, em!, ed!);
    expect(day > end && day <= addMonths(end, 1)).toBe(true);
    expect(one(49).planted_value).toBe(tapeDate(clean(at(48)).as_of));
    // A rename is to other words for the column, never to another of the layout's headers.
    const norm = (h: string) => h.trim().replace(/\s+/g, " ").toLowerCase();
    const headers = new Set(M3_V1_COLUMNS.map((c) => norm(c.header)));
    for (const [header, names] of Object.entries(T02_RENAMES)) {
      expect(TAPE_COLUMNS.filter((c) => c.header === header).length).toBe(1);
      for (const n of names) expect(headers.has(norm(n)), n).toBe(false);
    }
    const required = (h: string) => TAPE_COLUMNS.find((c) => c.header === h)!.required === true;
    expect(T02.columns("required")!.every(required)).toBe(true);
    expect(T02.columns("optional")!.some(required)).toBe(false);
  });

  it("follows each defect through the reader to what it reaches, and to nothing else", () => {
    const where = (s: { file_or_table: string; field: string }) => `${s.file_or_table} ${s.field}`;
    for (const x of p.placed) {
      const c = clean(x.month);
      const got = symptomsAt(x.month);
      for (const s of got)
        expect([s.defect_id, s.root_cause], x.month).toEqual([x.defect_id, false]);
      const roots = rootsAt(x.month);
      if (x.defect_id === "T-01" && x.variant === "missing") {
        // Every row of the month's tape read from the clean stream and not the planted one.
        expect(got.map((s) => [where(s), s.planted_value])).toEqual(
          c.rows.map(() => [`${READ_TABLES.rows} *`, null]),
        );
      } else if (x.defect_id === "T-01") {
        // Last month's rows: the as-of moved back a month on every row read from both.
        const prior = stream[stream.indexOf(c) - 1]!;
        const asOf = got.filter((s) => s.field === "as_of_date");
        expect(asOf.length).toBeGreaterThan(c.rows.length / 2);
        for (const s of asOf) expect(s.planted_value).toBe(prior.as_of);
      } else if (x.defect_id === "T-02" && x.variant === "required") {
        // Refused by name, and so every row lost.
        expect(
          got.filter((s) => s.file_or_table === READ_TABLES.file).map((s) => s.planted_value),
        ).toEqual([`missing ${x.column}`]);
        expect(got.filter((s) => s.file_or_table === READ_TABLES.rows).length).toBe(c.rows.length);
        expect(got.length).toBe(c.rows.length + 1);
      } else if (x.defect_id === "T-02") {
        // Read, with the column's fact empty on every row and its cells kept under the renamed header.
        const renamed = roots[0]!.planted_value!;
        const key = TAPE_COLUMNS.find((col) => col.header === x.column)!.key;
        const kinds = new Set(got.map(where));
        expect(kinds.has(`${READ_TABLES.facts} ${key}`)).toBe(true);
        expect(kinds.has(`${READ_TABLES.raw} ${renamed}`)).toBe(true);
        for (const s of got)
          if (s.file_or_table !== READ_TABLES.record)
            expect([`${READ_TABLES.facts} ${key}`, `${READ_TABLES.raw} ${renamed}`]).toContain(
              where(s),
            );
      } else if (x.defect_id === "T-03") {
        // A ZIP code the contract's address and the fact, a pay string the fact alone.
        const reaches: Record<string, readonly (readonly [string, string])[]> = {
          "Property Zip Code": [
            [READ_TABLES.record, "property.postalCode"],
            [READ_TABLES.facts, "property_zip"],
          ],
          "Pay String": [[READ_TABLES.facts, "pay_string"]],
        };
        const predicted = roots.flatMap((l) =>
          reaches[l.field]!.map(([t, f]) =>
            toJsonLine([l.row, t, f, l.true_value, l.planted_value]),
          ),
        );
        const seen = got.map((s) =>
          toJsonLine([s.row, s.file_or_table, s.field, s.true_value, s.planted_value]),
        );
        expect(seen.sort()).toEqual(predicted.sort());
        expect(new Set(roots.map((l) => l.field)).has("Pay String")).toBe(true);
      } else if (x.defect_id === "T-04" && x.variant !== "day_first") {
        // The reader reads both forms right: nothing it made of the month differs.
        expect(got).toEqual([]);
      } else {
        // Day first, or the as-of: each changed cell reaches its fact and the contract's fields read from it, as the
        // reader reads the planted text (a day over 12, read as the month, is unreadable, and counted).
        const predicted = roots.flatMap((l) => {
          const [a, b, y] = l.planted_value!.split("/").map(Number);
          const read = a! <= 12 ? iso(y!, a!, b!) : null;
          const asRead = (t: string, f: string) =>
            t === READ_TABLES.record && f === "servicing.asOf" ? `${read}T00:00:00.000Z` : read;
          const want = (READS[l.field] ?? []).map(([t, f]) =>
            toJsonLine([l.row, t, f, asRead(t, f)]),
          );
          return read === null
            ? [
                ...want,
                toJsonLine([l.row, READ_TABLES.exceptions, `unreadable_cell:${l.field}`, "1"]),
              ]
            : want;
        });
        const seen = got.map((s) => toJsonLine([s.row, s.file_or_table, s.field, s.planted_value]));
        expect(seen.sort()).toEqual(predicted.sort());
        for (const s of got) expect(s.expected_handling).not.toMatch(/^Downstream/);
      }
    }
    // A day-first closing date over the 12th is one the reader refuses to read at all.
    expect(symptomsAt(at(37)).some((s) => s.file_or_table === READ_TABLES.exceptions)).toBe(true);
  });

  it("says how a delivery with each loads, as the reader bears out", () => {
    const loadings = new Map<string, TapeLoading>();
    for (const x of p.placed) {
      const loading = tapeDefectById(x.defect_id).loading(x.variant);
      loadings.set(`${x.defect_id} ${x.variant}`, loading);
      const got = symptomsAt(x.month);
      const refused = got.some((s) => s.file_or_table === READ_TABLES.file);
      if (loading === "as_delivered") expect(got, x.month).toEqual([]);
      if (loading === "corrected")
        expect([got.length > 0, refused], x.month).toEqual([true, false]);
      if (loading === "resend") expect(refused || x.defect_id === "T-01", x.month).toBe(true);
    }
    expect(Object.fromEntries(loadings)).toEqual({
      "T-01 missing": "resend",
      "T-01 resent": "resend",
      "T-01 relabeled": "resend",
      "T-02 required": "resend",
      "T-02 optional": "corrected",
      "T-03 stripped": "corrected",
      "T-04 two_digit_year": "as_delivered",
      "T-04 serial": "as_delivered",
      "T-04 day_first": "corrected",
      "T-05 export_date": "corrected",
      "T-05 prior_month_end": "corrected",
    });
  });

  it("merges defects drawn for one month, and tells their symptoms apart", () => {
    // A spreadsheet that strips zeros and turns a date column day first, over an export that renamed the MBA
    // status's header and wrote the day it ran as the as-of: four defects, one file.
    const m = at(70);
    const asked = [
      { id: "T-03", months: [m] },
      { id: "T-04", months: [m], variant: "day_first", column: "Date Maturity" },
      { id: "T-02", months: [m], variant: "optional", column: "MBA Delinquency Status" },
      { id: "T-05", months: [m], variant: "export_date" },
    ];
    const four = plantTapeDefects(book, stream, asked);
    expect(four.placed.map((x) => x.defect_id)).toEqual(["T-05", "T-02", "T-03", "T-04"]);
    expect(four.alone.map((x) => x.defect_id)).toEqual(["T-05", "T-02", "T-03", "T-04"]);
    // The roots are each defect's own, as planted alone, and every changed cell is one of them.
    const alone = asked.map((r) => plantTapeDefects(book, stream, [r]));
    expect(four.labels.map(rootKey).sort()).toEqual(
      alone.flatMap((a) => a.labels.map(rootKey)).sort(),
    );
    expect(
      cellsChanged(
        clean(m),
        four.planted.find((f) => f.month === m)!,
      ).sort(),
    ).toEqual(four.labels.map(rootKey).sort());
    // Each symptom is a defect's whose own plant shows it, or the four's together when none does alone: with the
    // MBA status gone, the reader dates delinquency from the next due date to the as-of, and the export's as-of is
    // past the first of the month.
    const at4 = (s: { file_or_table: string; row: string; field: string }) =>
      `${s.file_or_table}|${s.row}|${s.field}`;
    const each = new Map(
      asked.map((r, k) => [r.id, new Set(tapeSymptomLabels(alone[k]!, reading).map(at4))]),
    );
    const together: string[] = [];
    for (const s of tapeSymptomLabels(four, reading)) {
      if (s.defect_id.includes("+")) {
        expect([...each.values()].some((x) => x.has(at4(s)))).toBe(false);
        together.push(s.field);
      } else expect(each.get(s.defect_id)!.has(at4(s)), `${s.defect_id} ${at4(s)}`).toBe(true);
    }
    expect(together).toContain("servicing.status");
    expect(together).toContain("servicing.delinquencyDays");
  });

  it("settles a collision with T-01: the named defect wins, T-01 among drawn ones, two named are refused", () => {
    const m = at(80);
    // Drawn at a rate into a month T-01 was asked for: skipped, and said so.
    const always = plantTapeDefects(book, stream, [
      { id: "T-01", months: [m], variant: "missing" },
      { id: "T-03", rate: 1 },
    ]);
    expect(always.placed.find((x) => x.month === m)).toEqual({
      month: m,
      defect_id: "T-01",
      variant: "missing",
      column: null,
    });
    expect(always.skipped.map((x) => [x.month, x.defect_id])).toEqual([[m, "T-03"]]);
    expect(always.skipped[0]!.reason).toMatch(/replaces the tape for .* whole/);
    expect(always.placed.filter((x) => x.defect_id === "T-03").length).toBe(stream.length - 1);
    // T-01 drawn at a rate into a month another was asked for by name: T-01 gives way.
    const named = plantTapeDefects(book, stream, [
      { id: "T-03", months: [m] },
      { id: "T-01", rate: 1, variant: "missing" },
    ]);
    expect(named.placed.filter((x) => x.month === m).map((x) => x.defect_id)).toEqual(["T-03"]);
    expect(named.skipped.map((x) => [x.month, x.defect_id])).toEqual([[m, "T-01"]]);
    // Both drawn at a rate: T-01 keeps every month.
    const drawn = plantTapeDefects(book, stream, [
      { id: "T-03", rate: 1 },
      { id: "T-01", rate: 1, variant: "missing" },
    ]);
    expect(drawn.planted).toEqual([]);
    expect(drawn.skipped.length).toBe(stream.length);
    // Both by name: refused.
    expect(() =>
      plantTapeDefects(book, stream, [
        { id: "T-01", months: [m] },
        { id: "T-05", months: [m] },
      ]),
    ).toThrow(/T-01 replaces the tape for .* whole, and cannot share it with T-05/);
    // A form or a column the defect does not take, or a month with nothing before it to send again.
    expect(() =>
      plantTapeDefects(book, stream, [{ id: "T-04", months: [m], variant: "upside_down" }]),
    ).toThrow(/takes the forms/);
    expect(() =>
      plantTapeDefects(book, stream, [
        { id: "T-04", months: [m], variant: "serial", column: "Pay String" },
      ]),
    ).toThrow(/reaches IPD/);
    expect(() =>
      plantTapeDefects(book, stream, [
        { id: "T-01", months: [stream[0]!.month], variant: "resent" },
      ]),
    ).toThrow(/no tape for/);
  });

  it("draws the months, forms and columns from streams of their own", () => {
    const a = plantTapeDefects(book, stream, [
      { id: "T-03", rate: 0.25 },
      { id: "T-04", rate: 0.25 },
    ]);
    const b = plantTapeDefects(book, stream, [
      { id: "T-03", rate: 0.25 },
      { id: "T-04", rate: 0.25 },
    ]);
    expect(a.placed).toEqual(b.placed);
    expect(toJsonLine(a.labels)).toBe(toJsonLine(b.labels));
    // T-03's months are the ones it drew alone: a second defect moves none of them.
    const t03 = plantTapeDefects(book, stream, [{ id: "T-03", rate: 0.25 }]);
    expect(a.placed.filter((x) => x.defect_id === "T-03").map((x) => x.month)).toEqual(
      t03.placed.map((x) => x.month),
    );
    expect(t03.placed.length).toBeGreaterThan(stream.length / 8);
    expect(t03.placed.length).toBeLessThan(stream.length / 2);
    const t04 = a.placed.filter((x) => x.defect_id === "T-04");
    expect(new Set(t04.map((x) => x.variant)).size).toBe(3);
    expect(new Set(t04.map((x) => x.column)).size).toBeGreaterThan(3);
    const none = plantTapeDefects(book, stream, [{ id: "T-03", rate: 0 }]);
    expect([none.placed, none.labels]).toEqual([[], []]);
    expect(none.planted).toBe(stream);
    const byDefault = plantTapeDefects(book, stream, ["T-03"]);
    expect(byDefault.placed.length).toBeLessThan(stream.length / 6);
    expect(() => plantTapeDefects(book, stream, ["T-09"])).toThrow(/no tape defect T-09/);
    expect(() => plantTapeDefects(book, stream, [{ id: "T-03", months: ["2099-01"] }])).toThrow(
      /no tape for 2099-01/,
    );
  });
});
