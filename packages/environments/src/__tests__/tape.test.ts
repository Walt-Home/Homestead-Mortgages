/**
 * The tape writer: a ten-year book of two hundred loans written as a
 * partner's monthly m3-v1 tapes and read back by the partner-book reader,
 * every fact and every field of the partner-feed contract equal to the
 * month-end projection's; and T-03, the first tape-stream defect, planted,
 * labeled, and followed through the reader to what it reaches.
 *
 * The reader is `@hm/partner-book`, a test-only import here: the writer
 * cannot import it (tape.ts says why), so this is where both are.
 */

import { describe, expect, it } from "vitest";
import { addMonths, parts } from "@hm/kernel/calendar";
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
  TAPE_COLUMNS,
  defaultCalibration,
  generate,
  plantTapeDefects,
  tapeColumnIndex,
  tapeProjection,
  tapeStream,
  tapeSymptomLabels,
  toCsvText,
  writeSupplement,
  writeTape,
  type TapeFile,
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

/** The partner-book reader, as a `TapeReading`: the record and facts of each row, its exceptions, a refusal. */
const reading = (f: TapeFile): TapeReading => {
  const r = read(f);
  return {
    rejected: r.rejected ? `missing ${r.rejected.missing_headers.join(", ")}` : null,
    rows: r.records.map((x) => ({
      servicer_loan_number: x.record.sourceLoanKey,
      tables: { [READ_TABLES.record]: x.record, [READ_TABLES.facts]: x.facts },
    })),
    exceptions: r.exceptions.map((e) => ({
      servicer_loan_number: e.servicer_loan_number,
      code: e.code,
      ...(e.column ? { column: e.column } : {}),
    })),
  };
};

describe("tape-stream defects", () => {
  const months = [stream[4]!.month, stream[61]!.month, stream.at(-2)!.month];
  const p = plantTapeDefects(book, stream, [{ id: "T-03", months }]);
  const roots = p.labels;

  it("plants T-03 in the months asked for, and labels every value it changed", () => {
    expect(p.clean).toBe(stream);
    expect(p.placed).toEqual(months.map((month) => ({ month, defect_id: "T-03" })));
    const changed: string[] = [];
    p.planted.forEach((f, k) => {
      const c = stream[k]!;
      if (!months.includes(f.month)) expect(f).toBe(c);
      expect(f.headers).toEqual(c.headers);
      f.rows.forEach((row, i) =>
        row.forEach((cell, j) => {
          if (cell !== c.rows[i]![j])
            changed.push(toJsonLine([f.filename, c.loans[i], c.headers[j], c.rows[i]![j], cell]));
        }),
      );
    });
    expect(
      roots.map((x) => toJsonLine([x.tape, x.loan, x.field, x.true_value, x.planted_value])),
    ).toEqual(changed);
    for (const x of roots) {
      expect([x.defect_id, x.root_cause, x.file_or_table]).toEqual(["T-03", true, x.tape]);
      expect(x.true_value).toMatch(/^0\d+$/);
      expect(x.planted_value).toBe(x.true_value!.replace(/^0+(?=\d)/, ""));
      expect(x.on).toBe(p.clean.find((f) => f.filename === x.tape)!.as_of);
    }
    // A ZIP code that starts with 0, and the pay string of every loan whose oldest month was current.
    const fields = new Set(roots.map((x) => x.field));
    expect([...fields].sort()).toEqual(["Pay String", "Property Zip Code"]);
    expect(roots.filter((x) => x.field === "Property Zip Code").length).toBeGreaterThan(0);
    expect(roots.some((x) => x.true_value === "000000000000" && x.planted_value === "0")).toBe(
      true,
    );
  });

  it("follows each stripped value through the reader to what it reaches, and to nothing else", () => {
    const symptoms = tapeSymptomLabels(p, reading);
    for (const x of symptoms) expect([x.defect_id, x.root_cause]).toEqual(["T-03", false]);
    // What each root reaches: a ZIP the contract's address and the fact, a pay string the fact alone.
    const reaches: Record<string, readonly (readonly [string, string])[]> = {
      "Property Zip Code": [
        [READ_TABLES.record, "property.postalCode"],
        [READ_TABLES.facts, "property_zip"],
      ],
      "Pay String": [[READ_TABLES.facts, "pay_string"]],
    };
    const key = (x: {
      tape: string;
      loan: string;
      row: string;
      file_or_table: string;
      field: string;
      true_value: string | null;
      planted_value: string | null;
    }) =>
      toJsonLine([x.tape, x.loan, x.row, x.file_or_table, x.field, x.true_value, x.planted_value]);
    const predicted = roots.flatMap((x) =>
      reaches[x.field]!.map(([file_or_table, field]) => key({ ...x, file_or_table, field })),
    );
    expect(symptoms.map(key).sort()).toEqual(predicted.sort());
    expect(symptoms.filter((x) => x.file_or_table === READ_TABLES.record).length).toBeGreaterThan(
      0,
    );
    for (const x of symptoms) {
      expect(x.expected_handling).not.toMatch(/^Downstream/);
      expect(x.on).toBe(p.clean.find((f) => f.filename === x.tape)!.as_of);
    }
  });

  it("draws the months from a stream of its own, and refuses what it cannot plant", () => {
    const a = plantTapeDefects(book, stream, [{ id: "T-03", rate: 0.25 }]);
    const b = plantTapeDefects(book, stream, [{ id: "T-03", rate: 0.25 }]);
    expect(a.placed).toEqual(b.placed);
    expect(toJsonLine(a.labels)).toBe(toJsonLine(b.labels));
    expect(a.placed.length).toBeGreaterThan(stream.length / 8);
    expect(a.placed.length).toBeLessThan(stream.length / 2);
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
