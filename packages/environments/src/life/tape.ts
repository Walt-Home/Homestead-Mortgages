/**
 * The tape writer: a partner's monthly loan tape in the m3-v1 layout, written
 * from the month-end projection.
 *
 * One file per month, one row per loan the servicer held at that month-end,
 * and the profile's 118 columns, A to DN, in its order with its header text
 * verbatim (`packages/partner-book/src/m3-v1.ts`; a test holds the two lists
 * equal). Each cell is the projection's value in the form a partner's export
 * gives it:
 *
 *   - dates as m/d/yyyy: the real tape's month, day and year, with the year
 *     in four digits. The real tape writes two (`docs/decisions.md`, "What the
 *     real tape taught the profile"), and the reader puts a two-digit year in
 *     the century nearest the day it reads it, so four keep the round trip off
 *     the clock;
 *   - money in dollars and cents, with no symbol or grouping and a minus sign
 *     before a negative ("441366.13", "-12.50");
 *   - rates in percent as the projection holds them ("6.375"). A rate of 1 or
 *     less carries its percent sign, because the reader takes a bare one for a
 *     fraction (`parseRatePct`). The PMI rate is in basis points ("45"), the
 *     form the one borrower-paid loan on a real tape gives it;
 *   - flags as Y and N, and codes in the sample partner's notation
 *     (`M3_NOTATION`), the repeated "Current Occupancy" header in both of its
 *     places;
 *   - the pay strings exactly as the projection writes them.
 *
 * A column the projection carries nothing for (FICO, a BPO, the property's
 * rooms, the investor's economics) is left empty, as an export leaves a
 * column its system does not keep. The writer invents nothing.
 *
 * The tape's as-of date is the month's last day. It is written on every row,
 * and every row is measured on it: the projection's month-end is the last day
 * of the month, and the writer refuses a row that says otherwise.
 *
 * Pure: no Node and no reader. The reader is `@hm/partner-book`, whose profile
 * reaches `node:zlib` through its vendored workbook reader, so importing it
 * here would put a Node module under everything that draws from the life
 * generator. The round-trip test imports both, as refi-review's tests import
 * the reader. See docs/environments.md, "The life generator".
 */

import { addMonths, endOfMonth, parts, plainDate, type PlainDate } from "@hm/kernel/calendar";
import { Decimal, formatCents, type Cents } from "@hm/kernel/money";
import type { LifeBook } from "./generate.js";
import { monthEndRow, type TapeRow } from "./projection.js";
import type { Servicer } from "./simulate.js";

/** Bump on any change to what the writer puts in a cell, so a stored tape can say which writer made it. */
export const TAPE_VERSION = "1.0.0";
export const TAPE_PROFILE = "m3-v1";

/** The profile's cell types (`FactType` in m3-v1.ts). */
export type TapeCellType = "text" | "money" | "rate" | "int" | "date" | "bool" | "pct" | "baths";

export interface TapeColumn {
  readonly header: string;
  readonly key: string;
  readonly type: TapeCellType;
  readonly required?: true;
  readonly investor?: true;
  /** The cell for one projection row; "" when the projection has nothing for the column. */
  readonly cell: (r: TapeRow) => string;
}

/** A delimited file: a header row and data rows, every cell text. */
export interface CsvFile {
  readonly filename: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface TapeFile extends CsvFile {
  /** The month the tape is for, "YYYY-MM". */
  readonly month: string;
  /** The tape's as-of date: the month's last day. */
  readonly as_of: PlainDate;
  /** Whose books the rows are from. */
  readonly servicer: Servicer;
  /** The generator's loan id on each row, in row order, for labels. */
  readonly loans: readonly string[];
}

/**
 * How the tape writes the codes the projection holds in words: the sample
 * partner's notation (`packages/partner-book/src/fixtures/northlight.ts`)
 * where it has one, and otherwise a word the reader maps ("Service Released",
 * `servicingStatusOf`). A value with no entry stops the writer rather than
 * reaching a tape as a guess.
 */
export const M3_NOTATION = {
  lien_position: { first: "1" },
  loan_type: { conventional: "Conventional" },
  /** Original occupancy code (AH), "Current Occupancy" (AI) and its repeat (CN). */
  occupancy: { principal: { code: "O", text: "Owner Occupied", short: "Owner" } },
  /** "Property Type Code" (AJ) and "Property Type" (CO). */
  property_type: { single_family: { code: "SF", text: "Single Family" } },
  servicing_status: {
    current: "Active",
    delinquent: "Active",
    paid_off: "Paid Off",
    transferred: "Service Released",
  },
  /** "C", or the days of the MBA bucket, as the reader reads it. */
  mba_delinquency_status: { current: "C", "30": "30", "60": "60", "90": "90", "120+": "120" },
} as const satisfies Record<string, Record<string, unknown>>;

function code<T>(table: Readonly<Record<string, T>>, name: string, value: string): T {
  const v = table[value];
  if (v === undefined)
    throw new RangeError(`the tape has no notation for ${name} "${value}"; add it to M3_NOTATION`);
  return v;
}

/* ── cells ───────────────────────────────────────────────────────────────── */

const date = (d: PlainDate | null): string => {
  if (d === null) return "";
  const p = parts(d);
  return `${p.m}/${p.d}/${p.y}`;
};
const money = (c: Cents | null): string =>
  c === null ? "" : formatCents(c, { symbol: false, grouping: false });
const rate = (pct: string | null): string =>
  pct === null ? "" : Decimal.parse(pct).cmp(Decimal.ONE) <= 0 ? `${pct}%` : pct;
const bps = (pct: string | null): string =>
  pct === null ? "" : Decimal.parse(pct).mul(Decimal.fromInt(100)).toString();
const int = (n: number | null): string => (n === null ? "" : String(n));
const pct = (n: number | null): string => (n === null ? "" : String(n));
const flag = (b: boolean | null): string => (b === null ? "" : b ? "Y" : "N");
const text = (s: string | null): string => s ?? "";
const empty = (): string => "";

const C = (
  header: string,
  key: string,
  type: TapeCellType,
  cell: (r: TapeRow) => string = empty,
  opts: { required?: true; investor?: true } = {},
): TapeColumn => ({ header, key, type, ...opts, cell });
const REQUIRED = { required: true } as const;
const INVESTOR = { investor: true } as const;
const cashFlow = (i: number) => (r: TapeRow) => money(r.cash_flow[i] ?? null);
const occupancy = (r: TapeRow) => code(M3_NOTATION.occupancy, "occupancy", r.property.occupancy);
const propertyType = (r: TapeRow) =>
  code(M3_NOTATION.property_type, "property type", r.property.property_type);

/** The 118 columns A–DN, in tape order, each with its cell. One line a column, as the profile has them. */
/* prettier-ignore */
export const TAPE_COLUMNS: readonly TapeColumn[] = [
  C("M3", "m3", "text"), // A
  C("As of Date", "as_of_date", "date", (r) => date(r.as_of_date)), // B
  C("Servicer Loan Number", "servicer_loan_number", "text", (r) => r.servicer_loan_number, REQUIRED), // C
  C("Lien Position", "lien_position", "text", (r) => code(M3_NOTATION.lien_position, "lien position", r.terms.lien_position)), // D
  C("Name Borrower Primary", "borrower_name", "text", (r) => r.borrower.borrower_name, REQUIRED), // E
  C("Property Address", "property_address", "text", (r) => r.property.property_address, REQUIRED), // F
  C("Property City", "property_city", "text", (r) => r.property.property_city, REQUIRED), // G
  C("Property State", "property_state", "text", (r) => r.property.property_state, REQUIRED), // H
  C("Property Zip Code", "property_zip", "text", (r) => r.property.property_zip, REQUIRED), // I
  C("County", "property_county", "text"), // J
  C("Zip Toxic Ranking", "zip_toxic_ranking", "pct"), // K
  C("Original Prin Bal", "original_upb_cents", "money", (r) => money(r.terms.original_upb_cents), REQUIRED), // L
  C("Interest Bearing UPB", "upb_cents", "money", (r) => money(r.balance.upb_cents), REQUIRED), // M
  C("UPB Deferred", "deferred_upb_cents", "money", (r) => money(r.balance.deferred_upb_cents)), // N
  C("Total UPB", "total_upb_cents", "money", (r) => money(r.balance.total_upb_cents)), // O
  C("Original Interest Rate", "original_note_rate_pct", "rate", (r) => rate(r.terms.original_note_rate_pct)), // P
  C("Current Interest Rate", "note_rate_pct", "rate", (r) => rate(r.terms.note_rate_pct), REQUIRED), // Q
  C("Servicer Retained Interest Rate", "servicer_retained_rate_pct", "rate", empty, INVESTOR), // R
  C("Investor Net Interest Rate", "investor_net_rate_pct", "rate", empty, INVESTOR), // S
  C("Current P&I Payment Amt", "pi_cents", "money", (r) => money(r.terms.pi_cents), REQUIRED), // T
  C("Current T&I Payment Amt", "ti_cents", "money", (r) => money(r.terms.ti_cents)), // U
  C("Total Due", "total_due_cents", "money", (r) => money(r.terms.total_due_cents)), // V
  C("IPD", "interest_paid_to_date", "date", (r) => date(r.status.interest_paid_to_date)), // W
  C("Next Due Date", "next_due_date", "date", (r) => date(r.status.next_due_date), REQUIRED), // X
  C("Last Payment Date", "last_payment_date", "date", (r) => date(r.status.last_payment_date)), // Y
  C("Pay String", "pay_string", "text", (r) => r.pay_string), // Z
  C("Current Fico", "fico_current", "int"), // AA
  C("Current Fico Date", "fico_current_date", "date"), // AB
  C("Original Fico", "fico_original", "int"), // AC
  C("GMC Purpose Code", "gmc_purpose_code", "text"), // AD
  C("Orig Appraised Value", "appraised_value_cents", "money", (r) => money(r.property.appraised_value_cents)), // AE
  C("Most Recent BPO", "bpo_value_cents", "money"), // AF
  C("Most Recent BPO Date", "bpo_date", "date"), // AG
  C("Original Occupancy Code", "original_occupancy_code", "text", (r) => occupancy(r).code), // AH
  C("Current Occupancy", "occupancy", "text", (r) => occupancy(r).text), // AI
  C("Property Type Code", "property_type_code", "text", (r) => propertyType(r).code), // AJ
  C("Mortgage Loan Type", "loan_type", "text", (r) => code(M3_NOTATION.loan_type, "loan type", r.terms.loan_type)), // AK
  C("Date Maturity", "maturity_date", "date", (r) => date(r.terms.maturity_date), REQUIRED), // AL
  C("Date Payment Due First", "first_payment_date", "date", (r) => date(r.terms.first_payment_date), REQUIRED), // AM
  C("Orig Date Closing", "origination_date", "date", (r) => date(r.terms.origination_date), REQUIRED), // AN
  C("ARM Index Type", "arm_index", "text", (r) => text(r.terms.arm_index)), // AO
  C("Margin", "arm_margin_pct", "rate", (r) => rate(r.terms.arm_margin_pct)), // AP
  C("ARM Fixed Period (mo)", "arm_fixed_period_months", "int", (r) => int(r.terms.arm_fixed_period_months)), // AQ
  C("ARM Payment Adj Period", "arm_payment_adj_period_months", "int", (r) => int(r.terms.arm_payment_adj_period_months)), // AR
  C("Arm Interest Rate Ceiling", "arm_rate_ceiling_pct", "rate", (r) => rate(r.terms.arm_rate_ceiling_pct)), // AS
  C("Arm Interest Rate Floor", "arm_rate_floor_pct", "rate", (r) => rate(r.terms.arm_rate_floor_pct)), // AT
  C("ARM Adj Freq", "arm_adj_freq_months", "int", (r) => int(r.terms.arm_adj_freq_months)), // AU
  C("ARM Neg Ind", "arm_neg_am", "bool", (r) => flag(r.terms.arm_neg_am)), // AV
  C("Orig LTV", "ltv_original_pct", "pct", (r) => pct(r.terms.ltv_original_pct)), // AW
  C("Current FMV", "fmv_cents", "money"), // AX
  C("Current FMV Date", "fmv_date", "date"), // AY
  C("Current CLTV", "cltv_current_pct", "pct"), // AZ
  C("Current LTV", "ltv_current_pct", "pct"), // BA
  C("Interest Only", "interest_only", "bool", (r) => flag(r.terms.interest_only)), // BB
  C("Balloon", "balloon", "bool", (r) => flag(r.terms.balloon)), // BC
  C("Term", "original_term_months", "int", (r) => int(r.terms.original_term_months), REQUIRED), // BD
  C("Calc Term", "remaining_term_months", "int", (r) => int(r.terms.remaining_term_months)), // BE
  C("Doc Type", "doc_type", "text"), // BF
  C("Cash Flow Month 01", "cash_flow_month_01", "money", cashFlow(0)), // BG
  C("Cash Flow Month 02", "cash_flow_month_02", "money", cashFlow(1)), // BH
  C("Cash Flow Month 03", "cash_flow_month_03", "money", cashFlow(2)), // BI
  C("Cash Flow Month 04", "cash_flow_month_04", "money", cashFlow(3)), // BJ
  C("Cash Flow Month 05", "cash_flow_month_05", "money", cashFlow(4)), // BK
  C("Cash Flow Month 06", "cash_flow_month_06", "money", cashFlow(5)), // BL
  C("Cash Flow Month 07", "cash_flow_month_07", "money", cashFlow(6)), // BM
  C("Cash Flow Month 08", "cash_flow_month_08", "money", cashFlow(7)), // BN
  C("Cash Flow Month 09", "cash_flow_month_09", "money", cashFlow(8)), // BO
  C("Cash Flow Month 10", "cash_flow_month_10", "money", cashFlow(9)), // BP
  C("Cash Flow Month 11", "cash_flow_month_11", "money", cashFlow(10)), // BQ
  C("Cash Flow Month 12 (Most Recent Month)", "cash_flow_month_12", "money", cashFlow(11)), // BR
  C("Foreclosure Ind", "fc_status", "bool", (r) => flag(r.foreclosure.fc_status)), // BS
  C("FCL Date Refrd Atty", "fc_referral_date", "date", (r) => date(r.foreclosure.fc_referral_date)), // BT
  C("FCL Date Sale Scheduled", "fc_sale_scheduled_date", "date", (r) => date(r.foreclosure.fc_sale_scheduled_date)), // BU
  C("FCL Date Sale Held", "fc_sale_held_date", "date", (r) => date(r.foreclosure.fc_sale_held_date)), // BV
  C("Active Bankruptcy Ind", "bk_status", "bool", (r) => flag(r.bankruptcy.bk_status)), // BW
  C("BK Chapter Code", "bk_chapter", "text", (r) => text(r.bankruptcy.bk_chapter)), // BX
  C("BK Date Filed", "bk_filed_date", "date", (r) => date(r.bankruptcy.bk_filed_date)), // BY
  C("BK Motion for Relief Date", "bk_motion_for_relief_date", "date", (r) => date(r.bankruptcy.bk_motion_for_relief_date)), // BZ
  C("BK Discharged Ind", "bk_discharged", "bool", (r) => flag(r.bankruptcy.bk_discharged)), // CA
  C("BK Borrower Discharged Date", "bk_discharged_date", "date", (r) => date(r.bankruptcy.bk_discharged_date)), // CB
  C("BK Borrower Dismis Date", "bk_dismissed_date", "date", (r) => date(r.bankruptcy.bk_dismissed_date)), // CC
  C("MERS ID", "mers_min", "text", empty, INVESTOR), // CD
  C("Servicing Status", "servicing_status", "text", (r) => code(M3_NOTATION.servicing_status, "servicing status", r.status.servicing_status)), // CE
  C("Preemptive Servicing Status", "preemptive_servicing_status", "text"), // CF
  C("Current GMC Value", "gmc_value_cents", "money"), // CG
  C("Servicer", "servicer_name", "text", empty, INVESTOR), // CH
  C("PMI Flag", "pmi_flag", "bool", (r) => flag(r.pmi.pmi_flag)), // CI
  C("PMI Insurance Rate", "pmi_rate_pct", "rate", (r) => bps(r.pmi.pmi_rate_pct)), // CJ
  C("PMI Home Owner Insurance Payment Percent", "pmi_homeowner_payment_pct", "pct", (r) => pct(r.pmi.pmi_homeowner_payment_pct)), // CK
  C("PMI Percent Covered", "pmi_coverage_pct", "pct", (r) => pct(r.pmi.pmi_coverage_pct)), // CL
  C("PMI Insurance Company", "pmi_company", "text", (r) => text(r.pmi.pmi_company)), // CM
  C("Current Occupancy", "occupancy_current", "text", (r) => occupancy(r).short), // CN
  C("Property Type", "property_type", "text", (r) => propertyType(r).text), // CO
  C("Prop Bedrooms", "property_bedrooms", "int"), // CP
  C("Prop Baths", "property_baths", "baths"), // CQ
  C("Prop Sq. Ft.", "property_sqft", "int"), // CR
  C("Prop Garaged Parking", "property_garage", "text"), // CS
  C("Prop Lot Size", "property_lot_size", "text"), // CT
  C("Srv Contact Expected", "contact_expected", "bool", (r) => flag(r.contact.contact_expected)), // CU
  C("Srv Last Contact Date", "last_contact_date", "date", (r) => date(r.contact.last_contact_date)), // CV
  C("SRV Accrued Interest Balance", "accrued_interest_cents", "money", (r) => money(r.balance.accrued_interest_cents)), // CW
  C("SRV Total Corporate Advance Balance", "advances_cents", "money"), // CX
  C("SRV Recoverable Corporate Advance Balance", "recoverable_advances_cents", "money"), // CY
  C("SRV Non-Recoverable Corporate Advance Balance", "non_recoverable_advances_cents", "money"), // CZ
  C("SRV Asset Escrow Balance", "escrow_balance_cents", "money", (r) => money(r.escrow.escrow_balance_cents)), // DA
  C("SRV Asset Escrow Advances", "escrow_advances_cents", "money", (r) => money(r.escrow.escrow_advances_cents)), // DB
  C("Total Reconciled Passthrough & Other Expenses", "reconciled_passthrough_expenses_cents", "money", empty, INVESTOR), // DC
  C("Total Reconciled Advances", "reconciled_advances_cents", "money", empty, INVESTOR), // DD
  C("Reconciled Net CF", "reconciled_net_cash_flow_cents", "money", empty, INVESTOR), // DE
  C("Modification Flag", "modification_flag", "bool"), // DF
  C("Prepayment Penalty Ind", "prepayment_penalty_flag", "bool"), // DG
  C("Prepayment Desc", "prepayment_penalty_desc", "text"), // DH
  C("Prepay Period", "prepayment_penalty_months", "int"), // DI
  C("MBA Delinquency Status", "mba_delinquency_status", "text", (r) => code(M3_NOTATION.mba_delinquency_status, "MBA status", r.status.mba_delinquency_status)), // DJ
  C("MBA Pay String", "mba_pay_string", "text", (r) => r.mba_pay_string), // DK
  // The original maturity: no loan here is modified, so it is the note's.
  C("Orig Maturity Date", "orig_maturity_date", "date", (r) => date(r.terms.maturity_date)), // DL
  C("DTI", "dti_pct", "pct"), // DM
  C("Agency & remittance type", "agency_remittance_type", "text", empty, INVESTOR), // DN
];

export const TAPE_HEADERS: readonly string[] = TAPE_COLUMNS.map((c) => c.header);

/** Where the column for a profile key sits in the tape, from 0. */
export function tapeColumnIndex(key: string): number {
  const i = TAPE_COLUMNS.findIndex((c) => c.key === key);
  if (i < 0) throw new RangeError(`no tape column for ${key}`);
  return i;
}

/* ── files ───────────────────────────────────────────────────────────────── */

const lastDay = (month: string): PlainDate => endOfMonth(plainDate(`${month}-01`));
const filenameFor = (month: string, servicer: Servicer): string =>
  `${servicer === "prior" ? "prior-" : ""}tape-${month}.csv`;

/** One projection row as the tape's cells, in column order. */
export function tapeCells(r: TapeRow): string[] {
  return TAPE_COLUMNS.map((c) => c.cell(r));
}

export interface TapeOptions {
  /** Whose tape: the servicer the loans are with at the month-end (default "us"). */
  readonly servicer?: Servicer;
}

/**
 * The projection rows a month's tape carries: every loan with a month-end that
 * month on the servicer's books, in book order. Two loans with one loan number
 * stop the writer: the reader keeps the first and drops the second as a
 * duplicate, which is T-01's damage and never a clean tape's. The generator
 * draws loan numbers at random from a hundred million, so a book of thousands
 * can draw a pair.
 */
export function tapeProjection(book: LifeBook, month: string, opts: TapeOptions = {}): TapeRow[] {
  const servicer = opts.servicer ?? "us";
  const asOf = lastDay(month);
  const rows: TapeRow[] = [];
  const byNumber = new Map<string, string>();
  for (const l of book.loans) {
    const r = monthEndRow(l, month);
    if (!r || r.servicer !== servicer) continue;
    if (r.as_of_date !== asOf)
      throw new RangeError(
        `${l.loan_id} ${month}: measured on ${r.as_of_date}, not on the tape's as-of ${asOf}`,
      );
    const other = byNumber.get(r.servicer_loan_number);
    if (other !== undefined)
      throw new RangeError(
        `${month}: ${other} and ${l.loan_id} both carry loan number ${r.servicer_loan_number}; a clean tape carries each loan once`,
      );
    byNumber.set(r.servicer_loan_number, l.loan_id);
    rows.push(r);
  }
  return rows;
}

/** The servicer's tape for one month. */
export function writeTape(book: LifeBook, month: string, opts: TapeOptions = {}): TapeFile {
  const servicer = opts.servicer ?? "us";
  const rows = tapeProjection(book, month, { servicer });
  return {
    filename: filenameFor(month, servicer),
    month,
    as_of: lastDay(month),
    servicer,
    headers: TAPE_HEADERS,
    rows: rows.map(tapeCells),
    loans: rows.map((r) => r.loan_id),
  };
}

/** Every month any loan has a month-end on the servicer's books, oldest first. */
export function tapeMonths(book: LifeBook, opts: TapeOptions = {}): string[] {
  const servicer = opts.servicer ?? "us";
  const seen = new Set<string>();
  for (const l of book.loans)
    for (const m of l.months) if (m.servicer === servicer) seen.add(m.month);
  return [...seen].sort();
}

/** The monthly stream: one tape for every month from the servicer's first month-end to its last. */
export function tapeStream(book: LifeBook, opts: TapeOptions = {}): TapeFile[] {
  const months = tapeMonths(book, opts);
  if (months.length === 0) return [];
  const out: TapeFile[] = [];
  for (let m = months[0]!; m <= months.at(-1)!; m = addMonths(plainDate(`${m}-01`), 1).slice(0, 7))
    out.push(writeTape(book, m, opts));
  return out;
}

/**
 * The supplement a partner sends beside a month's tape: for each loan on it,
 * the loan number, the primary borrower's name and date of birth (ISO, the
 * only form the reader takes). The m3 layout carries no date of birth, and
 * the co-borrower nowhere. One per tape, because the reader reports a
 * supplement row for a loan not on the tape beside it as an orphan.
 */
export function writeSupplement(book: LifeBook, month: string, opts: TapeOptions = {}): CsvFile {
  const servicer = opts.servicer ?? "us";
  const rows = tapeProjection(book, month, { servicer }).map((r) => {
    const b1 = r.borrower.parties.find((p) => p.role === "PRIMARY_BORROWER")!;
    return [r.servicer_loan_number, r.borrower.borrower_name, b1.date_of_birth];
  });
  return {
    filename: `${servicer === "prior" ? "prior-" : ""}supplement-${month}.csv`,
    headers: ["servicer_loan_number", "borrower_name", "date_of_birth"],
    rows,
  };
}

const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The file as CSV text: RFC 4180, CRLF after every row, a cell quoted when it holds a comma, a quote or a line break. */
export function toCsvText(f: CsvFile): string {
  return [f.headers, ...f.rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
