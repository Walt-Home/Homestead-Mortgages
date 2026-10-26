/**
 * The `m3-v1` tape profile: the first partner's 118 headers, columns A–DN,
 * mapped onto typed facts.
 *
 * A port of Doug's `src/domain/partner-book/profiles/m3-v1.ts` (his §33.1
 * rule 1) onto the vendored kernel, with the logic kept and the formatting
 * ours. Money cells become decimal-string cents, half-up to the cent; dates
 * become ISO, Excel serials converted; Y/N and 1/0 become booleans. A cell
 * that cannot be read is a row exception naming the column, and the row keeps
 * every other fact. Headers the profile does not know are kept verbatim under
 * `raw`. A row is skipped only when it has no servicer loan number, a loan
 * number the reader cannot read exactly, no property state, or no readable
 * balance and rate — and the skip is on the report.
 *
 * Columns marked `investor` are the partner's investor economics. They never
 * leave this module as facts: `docs/states.md` forbids the acquisition channel
 * from reaching anything, and a retained-rate column is exactly the thing a
 * refinance review must not be able to see.
 *
 * Pure: no Node, no database. The parsers are what the importer, a fixture and
 * a test all use.
 */

import { Decimal, SCALE } from "@hm/kernel/money";
import { daysInMonth } from "@hm/kernel/calendar";
import { excelSerialToIsoDate } from "./xlsx-serial.js";

export type FactType = "text" | "money" | "rate" | "int" | "date" | "bool" | "pct" | "baths";
export type ColumnDef = {
  header: string;
  key: string;
  type: FactType;
  required?: boolean;
  investor?: boolean;
};
export type TapeProfile = {
  id: "m3-v1";
  columns: readonly ColumnDef[];
  required: readonly string[];
  loanNumber: string;
};

/**
 * money → decimal-string cents ("44136613"); rate → percent as a decimal
 * string ("7.250"); pct → decimal string (3 dp, as written); date → ISO
 * "YYYY-MM-DD"; bool → boolean; int → number; text → string.
 */
export type Fact = string | number | boolean | null;

export type RowExceptionCode =
  | "unreadable_cell"
  | "no_loan_number"
  | "no_state"
  | "no_balance_or_rate"
  | "supplement_orphan"
  | "duplicate_row"
  | "implausible_value"
  | "name_unsplit"
  | "no_property_address"
  | "no_term"
  | "loan_number_scientific"
  | "loan_number_not_exact";

export type RowException = {
  row: number;
  servicer_loan_number: string | null;
  code: RowExceptionCode;
  column?: string;
  /** What the person loading the file can do about it, where the code alone does not say. */
  detail?: string;
};

/**
 * Where a row's text came from, because the same text means different things
 * in the two. A workbook hands back a numeric cell as the text its writer
 * stored for the double — a Java writer stores a ten-digit loan number as
 * "1.002938533E9" — and that text names the number exactly. A CSV cell is
 * whatever a program printed, and a spreadsheet prints a long number the way
 * it fits the column ("1.00294E+11"), with the digits it did not show gone.
 */
export type FileKind = "xlsx" | "csv";

const C = (
  header: string,
  key: string,
  type: FactType,
  opts: { required?: boolean; investor?: boolean } = {},
): ColumnDef => ({ header, key, type, ...opts });

/** The 118 columns A–DN in tape order; header text verbatim from the partner's layout. */
export const M3_V1_COLUMNS: readonly ColumnDef[] = [
  C("M3", "m3", "text"), // A
  C("As of Date", "as_of_date", "date"), // B
  C("Servicer Loan Number", "servicer_loan_number", "text", { required: true }), // C
  C("Lien Position", "lien_position", "text"), // D
  C("Name Borrower Primary", "borrower_name", "text", { required: true }), // E
  C("Property Address", "property_address", "text", { required: true }), // F
  C("Property City", "property_city", "text", { required: true }), // G
  C("Property State", "property_state", "text", { required: true }), // H
  C("Property Zip Code", "property_zip", "text", { required: true }), // I
  C("County", "property_county", "text"), // J
  C("Zip Toxic Ranking", "zip_toxic_ranking", "pct"), // K (a decimal score: "7.2")
  C("Original Prin Bal", "original_upb_cents", "money", { required: true }), // L
  C("Interest Bearing UPB", "upb_cents", "money", { required: true }), // M
  C("UPB Deferred", "deferred_upb_cents", "money"), // N
  C("Total UPB", "total_upb_cents", "money"), // O
  C("Original Interest Rate", "original_note_rate_pct", "rate"), // P
  C("Current Interest Rate", "note_rate_pct", "rate", { required: true }), // Q
  C("Servicer Retained Interest Rate", "servicer_retained_rate_pct", "rate", { investor: true }), // R
  C("Investor Net Interest Rate", "investor_net_rate_pct", "rate", { investor: true }), // S
  C("Current P&I Payment Amt", "pi_cents", "money", { required: true }), // T
  C("Current T&I Payment Amt", "ti_cents", "money"), // U
  C("Total Due", "total_due_cents", "money"), // V
  C("IPD", "interest_paid_to_date", "date"), // W
  C("Next Due Date", "next_due_date", "date", { required: true }), // X
  C("Last Payment Date", "last_payment_date", "date"), // Y
  C("Pay String", "pay_string", "text"), // Z
  C("Current Fico", "fico_current", "int"), // AA
  C("Current Fico Date", "fico_current_date", "date"), // AB
  C("Original Fico", "fico_original", "int"), // AC
  C("GMC Purpose Code", "gmc_purpose_code", "text"), // AD
  C("Orig Appraised Value", "appraised_value_cents", "money"), // AE
  C("Most Recent BPO", "bpo_value_cents", "money"), // AF
  C("Most Recent BPO Date", "bpo_date", "date"), // AG
  C("Original Occupancy Code", "original_occupancy_code", "text"), // AH
  C("Current Occupancy", "occupancy", "text"), // AI (the tape's text)
  C("Property Type Code", "property_type_code", "text"), // AJ
  C("Mortgage Loan Type", "loan_type", "text"), // AK
  C("Date Maturity", "maturity_date", "date", { required: true }), // AL
  C("Date Payment Due First", "first_payment_date", "date", { required: true }), // AM
  C("Orig Date Closing", "origination_date", "date", { required: true }), // AN
  C("ARM Index Type", "arm_index", "text"), // AO
  C("Margin", "arm_margin_pct", "rate"), // AP
  C("ARM Fixed Period (mo)", "arm_fixed_period_months", "int"), // AQ
  C("ARM Payment Adj Period", "arm_payment_adj_period_months", "int"), // AR
  C("Arm Interest Rate Ceiling", "arm_rate_ceiling_pct", "rate"), // AS
  C("Arm Interest Rate Floor", "arm_rate_floor_pct", "rate"), // AT
  C("ARM Adj Freq", "arm_adj_freq_months", "int"), // AU
  C("ARM Neg Ind", "arm_neg_am", "bool"), // AV
  C("Orig LTV", "ltv_original_pct", "pct"), // AW
  C("Current FMV", "fmv_cents", "money"), // AX
  C("Current FMV Date", "fmv_date", "date"), // AY
  C("Current CLTV", "cltv_current_pct", "pct"), // AZ
  C("Current LTV", "ltv_current_pct", "pct"), // BA
  C("Interest Only", "interest_only", "bool"), // BB
  C("Balloon", "balloon", "bool"), // BC
  C("Term", "original_term_months", "int", { required: true }), // BD
  C("Calc Term", "remaining_term_months", "int"), // BE
  C("Doc Type", "doc_type", "text"), // BF
  C("Cash Flow Month 01", "cash_flow_month_01", "money"), // BG
  C("Cash Flow Month 02", "cash_flow_month_02", "money"), // BH
  C("Cash Flow Month 03", "cash_flow_month_03", "money"), // BI
  C("Cash Flow Month 04", "cash_flow_month_04", "money"), // BJ
  C("Cash Flow Month 05", "cash_flow_month_05", "money"), // BK
  C("Cash Flow Month 06", "cash_flow_month_06", "money"), // BL
  C("Cash Flow Month 07", "cash_flow_month_07", "money"), // BM
  C("Cash Flow Month 08", "cash_flow_month_08", "money"), // BN
  C("Cash Flow Month 09", "cash_flow_month_09", "money"), // BO
  C("Cash Flow Month 10", "cash_flow_month_10", "money"), // BP
  C("Cash Flow Month 11", "cash_flow_month_11", "money"), // BQ
  C("Cash Flow Month 12 (Most Recent Month)", "cash_flow_month_12", "money"), // BR
  C("Foreclosure Ind", "fc_status", "bool"), // BS
  C("FCL Date Refrd Atty", "fc_referral_date", "date"), // BT
  C("FCL Date Sale Scheduled", "fc_sale_scheduled_date", "date"), // BU
  C("FCL Date Sale Held", "fc_sale_held_date", "date"), // BV
  C("Active Bankruptcy Ind", "bk_status", "bool"), // BW
  C("BK Chapter Code", "bk_chapter", "text"), // BX
  C("BK Date Filed", "bk_filed_date", "date"), // BY
  C("BK Motion for Relief Date", "bk_motion_for_relief_date", "date"), // BZ
  C("BK Discharged Ind", "bk_discharged", "bool"), // CA
  C("BK Borrower Discharged Date", "bk_discharged_date", "date"), // CB
  C("BK Borrower Dismis Date", "bk_dismissed_date", "date"), // CC
  C("MERS ID", "mers_min", "text", { investor: true }), // CD
  C("Servicing Status", "servicing_status", "text"), // CE
  C("Preemptive Servicing Status", "preemptive_servicing_status", "text"), // CF
  C("Current GMC Value", "gmc_value_cents", "money"), // CG
  C("Servicer", "servicer_name", "text", { investor: true }), // CH
  C("PMI Flag", "pmi_flag", "bool"), // CI
  C("PMI Insurance Rate", "pmi_rate_pct", "rate"), // CJ
  C("PMI Home Owner Insurance Payment Percent", "pmi_homeowner_payment_pct", "pct"), // CK
  C("PMI Percent Covered", "pmi_coverage_pct", "pct"), // CL
  C("PMI Insurance Company", "pmi_company", "text"), // CM
  C("Current Occupancy", "occupancy_current", "text"), // CN (the tape repeats the header)
  C("Property Type", "property_type", "text"), // CO
  C("Prop Bedrooms", "property_bedrooms", "int"), // CP
  C("Prop Baths", "property_baths", "baths"), // CQ ("2.5", or "F:2/H:1" as a servicer writes it)
  C("Prop Sq. Ft.", "property_sqft", "int"), // CR
  C("Prop Garaged Parking", "property_garage", "text"), // CS
  C("Prop Lot Size", "property_lot_size", "text"), // CT
  C("Srv Contact Expected", "contact_expected", "bool"), // CU (a Y on a real tape, never a date)
  C("Srv Last Contact Date", "last_contact_date", "date"), // CV
  C("SRV Accrued Interest Balance", "accrued_interest_cents", "money"), // CW
  C("SRV Total Corporate Advance Balance", "advances_cents", "money"), // CX
  C("SRV Recoverable Corporate Advance Balance", "recoverable_advances_cents", "money"), // CY
  C("SRV Non-Recoverable Corporate Advance Balance", "non_recoverable_advances_cents", "money"), // CZ
  C("SRV Asset Escrow Balance", "escrow_balance_cents", "money"), // DA
  C("SRV Asset Escrow Advances", "escrow_advances_cents", "money"), // DB
  C(
    "Total Reconciled Passthrough & Other Expenses",
    "reconciled_passthrough_expenses_cents",
    "money",
    {
      investor: true,
    },
  ), // DC
  C("Total Reconciled Advances", "reconciled_advances_cents", "money", { investor: true }), // DD
  C("Reconciled Net CF", "reconciled_net_cash_flow_cents", "money", { investor: true }), // DE
  C("Modification Flag", "modification_flag", "bool"), // DF
  C("Prepayment Penalty Ind", "prepayment_penalty_flag", "bool"), // DG
  C("Prepayment Desc", "prepayment_penalty_desc", "text"), // DH
  C("Prepay Period", "prepayment_penalty_months", "int"), // DI (months of penalty: "36", "0")
  C("MBA Delinquency Status", "mba_delinquency_status", "text"), // DJ
  C("MBA Pay String", "mba_pay_string", "text"), // DK
  C("Orig Maturity Date", "orig_maturity_date", "date"), // DL
  C("DTI", "dti_pct", "pct"), // DM
  C("Agency & remittance type", "agency_remittance_type", "text", { investor: true }), // DN
];

export const M3_V1: TapeProfile = {
  id: "m3-v1",
  columns: M3_V1_COLUMNS,
  required: M3_V1_COLUMNS.filter((c) => c.required).map((c) => c.header),
  loanNumber: "servicer_loan_number",
};

/** The profiles the reader knows; a caller names one by id. */
export const PROFILES: Readonly<Record<string, TapeProfile>> = { "m3-v1": M3_V1 };

export function profileById(id: string): TapeProfile {
  const p = PROFILES[id];
  if (!p) {
    throw new RangeError(`unknown tape profile ${id}; known: ${Object.keys(PROFILES).join(", ")}`);
  }
  return p;
}

/**
 * Header texts compare trimmed, whitespace-collapsed and case-insensitively:
 * a partner's export drifts in case and padding, never in words.
 */
export function normalizeHeader(h: string): string {
  return h.trim().replace(/\s+/g, " ").toLowerCase();
}

// ── numbers in scientific notation ────────────────────────────────────────

/**
 * A number in scientific notation, written out in plain digits: "1.25E7" →
 * "12500000", "5.0E-4" → "0.0005", "-1.5E2" → "-150". String arithmetic —
 * the mantissa's digits with the point moved — and never a double, so every
 * digit written is kept and none is invented. Null when the text is not
 * scientific notation, when its exponent is past any double's, and when the
 * exponent carries a plus sign.
 *
 * The plus sign is the line between a number as stored and a number as
 * shown. A writer storing a double prints the exponent bare — Java's
 * "1.002938533E9", Excel's own "4.4999999999999998E-2" — while a spreadsheet
 * showing a long number in a column too narrow for it prints "1.00294E+11",
 * rounded to what fits, and a CSV saved from it carries the rounding. Some
 * writers do sign the exponent from 10^15 up, past any balance or rate; a
 * loan number that long, stored that way, is refused and asked for as text
 * (`readLoanNumber`).
 */
export function expandScientific(text: string): string | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?)(\d+)$/.exec(text.trim());
  if (!m) return null;
  const [, sign = "", int = "", frac = "", expSign = "", expDigits = ""] = m;
  if ((int === "" && frac === "") || expSign === "+") return null;
  const exp = (expSign === "-" ? -1 : 1) * Number(expDigits);
  // A double's exponent runs from -324 to 308.
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) return null;
  const digits = int + frac;
  const point = int.length + exp;
  let whole: string;
  let fraction: string;
  if (point <= 0) {
    whole = "0";
    fraction = "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    whole = digits + "0".repeat(point - digits.length);
    fraction = "";
  } else {
    whole = digits.slice(0, point);
    fraction = digits.slice(point);
  }
  whole = whole.replace(/^0+(?=\d)/, "");
  fraction = fraction.replace(/0+$/, "");
  if (/^0*$/.test(whole + fraction)) return "0";
  return (sign === "-" ? "-" : "") + whole + (fraction ? `.${fraction}` : "");
}

/**
 * Scientific notation as a program prints a number: one digit, then a point,
 * more digits and an exponent ("1.002938533E9", "1.00294E+11"), or no point
 * and a signed exponent ("1E+11"). "4E2" and "2019E0012" are not this, since
 * no program prints a number that way, and an identifier may well be either.
 */
const SCIENTIFIC = /^[+-]?\d(?:\.\d+[eE][+-]?\d+|[eE][+-]\d+)$/;

/**
 * 2^53 − 1: past it a double cannot hold every whole number, so the digits
 * of one that large are the writer's rounding.
 */
const MAX_EXACT_WHOLE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * A stored number's text — scientific, or a whole number with a ".0" as Java
 * writes one below 10^7 — as the whole number it names, in digits; null when
 * it names none exactly: a fraction, a negative, a value past 2^53 − 1, or an
 * exponent with a plus sign (see `expandScientific`).
 */
function exactWholeNumber(text: string): string | null {
  const plain = SCIENTIFIC.test(text) ? expandScientific(text) : text.replace(/\.0+$/, "");
  return plain !== null && /^\d+$/.test(plain) && BigInt(plain) <= MAX_EXACT_WHOLE ? plain : null;
}

export type LoanNumberRefusal = {
  readonly code: "loan_number_scientific" | "loan_number_not_exact";
  readonly detail: string;
};

/**
 * A loan-number cell as the loan number it is, or the reason it cannot be
 * read without guessing digits. The cell is trimmed and not empty.
 *
 * From a workbook, a number the writer stored — "1.002938533E9", or
 * "1234567.0" — is written out in its digits when it names a whole number
 * exactly, and refused as `loan_number_not_exact` when it does not. From a
 * CSV, scientific notation is never written out: it may be a spreadsheet's
 * display with digits already gone, so it is refused as
 * `loan_number_scientific`. Anything else is the loan number as written,
 * dashes, letters and leading zeros kept.
 */
export function readLoanNumber(cell: string, kind: FileKind): string | LoanNumberRefusal {
  const t = cell.trim();
  const scientific = SCIENTIFIC.test(t);
  if (scientific && kind === "csv") {
    return {
      code: "loan_number_scientific",
      detail:
        `The loan number reads "${t}", a number in scientific notation, the way a spreadsheet ` +
        "shows a long one, and the digits it did not show may be gone. Format the loan-number " +
        "column as text and export the file again.",
    };
  }
  if (scientific || (kind === "xlsx" && /^\d+\.0+$/.test(t))) {
    return (
      exactWholeNumber(t) ?? {
        code: "loan_number_not_exact",
        detail:
          `The workbook holds the loan number as "${t}", which names no whole number exactly, ` +
          "so its digits would be a guess. Format the loan-number column as text and export the " +
          "workbook again.",
      }
    );
  }
  return t;
}

/**
 * A loan number as a key to compare two by, never as one to store: the same
 * loan written "1002938533", "1.002938533E9", "001002938533" or "1002-938533"
 * comes back "1002938533". Scientific notation is written out when it names
 * a whole number exactly (`exactWholeNumber`); otherwise spaces and dashes
 * go, and a number that is all digits, with or without a ".0", loses its
 * leading zeros and the ".0". An identifier with letters keeps them as
 * written. Null when nothing is left, or when the notation names no whole
 * number exactly — "1.00294E+11" included, which may be a display's rounding.
 */
export function plainLoanNumber(raw: string): string | null {
  const t = raw.trim();
  if (SCIENTIFIC.test(t)) return exactWholeNumber(t);
  const s = t.replace(/[\s-]+/g, "");
  if (!s) return null;
  const whole = /^(\d+)(?:\.0+)?$/.exec(s);
  return whole ? whole[1]!.replace(/^0+(?=\d)/, "") : s;
}

// ── parsers (pure; null = unreadable; "" is the caller's empty cell) ──────

/**
 * "$441,366.13" | "441366.13" | "(1,234.50)" | "1,234.50-" → "44136613" /
 * "-123450"; a stored double's scientific notation ("1.25E7") written out
 * first (`expandScientific`); half-up to the cent; null when unreadable.
 */
export function parseMoneyCents(cell: string): string | null {
  let s = cell.trim();
  if (!s) return null;
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith("-")) {
    neg = true;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) s = s.slice(1).trim();
  if (s.startsWith("$")) s = s.slice(1).trim();
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1).trim();
  }
  s = s.replace(/,/g, "");
  s = expandScientific(s) ?? s;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const int = m[1] ?? "";
  const frac = m[2] ?? "";
  if (int === "" && frac === "") return null;
  let cents = BigInt(int || "0") * 100n + BigInt((frac + "00").slice(0, 2));
  // Half-up to the cent.
  if (frac.length > 2 && frac.charCodeAt(2) - 48 >= 5) cents += 1n;
  if (cents === 0n) return "0";
  return (neg ? "-" : "") + cents.toString();
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

function isoOf(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/**
 * A two-digit year is read into the century that puts it nearest to `now`,
 * the earlier one on a tie: on a tape in 2026, "1/1/51" is a maturity in
 * 2051 and "1/14/98" an origination in 1998. A fixed pivot cannot serve
 * both ends of a thirty-year note.
 */
export function fourDigitYear(yy: number, now: Date = new Date()): number {
  const thisYear = now.getUTCFullYear();
  const century = Math.floor(thisYear / 100) * 100;
  let best = century - 100 + yy;
  for (const y of [century + yy, century + 100 + yy]) {
    if (Math.abs(y - thisYear) < Math.abs(best - thisYear)) best = y;
  }
  return best;
}

/**
 * ISO (with or without a time), yyyy/mm/dd, m/d/yyyy, m-d-yyyy, m/d/yy
 * (each with or without a time; the two-digit year by `fourDigitYear`),
 * yyyymmdd, Excel serial text → "YYYY-MM-DD"; null when unreadable. A serial
 * is never read from scientific notation: every writer prints the serials 1
 * to 2,958,465 plainly, so a date cell written that way was not stored as one.
 */
export function parseDateIso(cell: string, now: Date = new Date()): string | null {
  const s = cell.trim();
  if (!s) return null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s))) {
    return isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s))) {
    return isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[T ].*)?$/.exec(s))) {
    return isoOf(Number(m[3]), Number(m[1]), Number(m[2]));
  }
  if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2})(?:[T ].*)?$/.exec(s))) {
    return isoOf(fourDigitYear(Number(m[3]), now), Number(m[1]), Number(m[2]));
  }
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
    return isoOf(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  if ((m = /^(\d{1,7})(?:\.\d*)?$/.exec(s))) {
    const serial = Number(m[1]);
    // 1900-01-01 … 9999-12-31
    if (serial < 1 || serial > 2_958_465) return null;
    return excelSerialToIsoDate(serial);
  }
  return null;
}

/**
 * A plain decimal, or a stored double's scientific notation written out;
 * null past the kernel's SCALE decimal places, which no rate or percentage
 * reaches and which the kernel would refuse by throwing.
 */
function parsePlainDecimal(s: string): Decimal | null {
  const written = s.replace(/,/g, "").trim();
  const t = expandScientific(written) ?? written;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  if ((t.split(".")[1] ?? "").length > SCALE) return null;
  const fixed = t.startsWith(".")
    ? "0" + t
    : t.startsWith("-.")
      ? "-0" + t.slice(1)
      : t.startsWith("+.")
        ? "0" + t.slice(1)
        : t;
  return Decimal.parse(fixed.endsWith(".") ? fixed.slice(0, -1) : fixed.replace(/^\+/, ""));
}

/**
 * "7.25" | "7.250%" | "0.0725" | "7.25E-2" (≤ 1 without a % sign → ×100) →
 * "7.250" (3 dp, half-up); null when unreadable or negative.
 */
export function parseRatePct(cell: string): string | null {
  let s = cell.trim();
  if (!s) return null;
  const hasPct = s.endsWith("%");
  if (hasPct) s = s.slice(0, -1).trim();
  let d = parsePlainDecimal(s);
  if (d === null || d.isNegative()) return null;
  if (!hasPct && d.cmp(Decimal.ONE) <= 0) d = d.mul(Decimal.fromInt(100));
  return d.toFixed(3, "HALF_UP");
}

/** A percentage or plain decimal as written ("80.00" | "80%" | "2.5") → 3 dp decimal string; never rescaled. */
export function parsePctDecimal(cell: string): string | null {
  let s = cell.trim();
  if (!s) return null;
  if (s.endsWith("%")) s = s.slice(0, -1).trim();
  const d = parsePlainDecimal(s);
  return d === null ? null : d.toFixed(3, "HALF_UP");
}

/**
 * "2.5" | "2" | "F:2/H:1" (full and half baths, as a servicer's system writes
 * them) → "2.500"; null when unreadable.
 */
export function parseBathsDecimal(cell: string): string | null {
  const s = cell.trim();
  if (!s) return null;
  const m = /^F:\s*(\d+)\s*\/\s*H:\s*(\d+)$/i.exec(s);
  if (m) return parsePctDecimal(String(Number(m[1]) + Number(m[2]) / 2));
  return parsePctDecimal(s);
}

/** "748" | "748.0" | "1,200" | "1.2E7" → number; null when unreadable. */
export function parseIntCell(cell: string): number | null {
  const written = cell.trim().replace(/,/g, "");
  if (!written) return null;
  const s = expandScientific(written) ?? written;
  const m = /^([+-]?\d+)(?:\.0*)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** Y/N, YES/NO, 1/0, TRUE/FALSE, T/F (case-insensitive) → boolean; null when unreadable. */
export function parseBool(cell: string): boolean | null {
  const s = cell.trim().toUpperCase();
  if (!s) return null;
  if (["Y", "YES", "1", "TRUE", "T"].includes(s)) return true;
  if (["N", "NO", "0", "FALSE", "F"].includes(s)) return false;
  return null;
}

export function parseCell(type: FactType, cell: string): Fact {
  switch (type) {
    case "text":
      return cell.trim();
    case "money":
      return parseMoneyCents(cell);
    case "rate":
      return parseRatePct(cell);
    case "pct":
      return parsePctDecimal(cell);
    case "baths":
      return parseBathsDecimal(cell);
    case "int":
      return parseIntCell(cell);
    case "date":
      return parseDateIso(cell);
    case "bool":
      return parseBool(cell);
  }
}

/** Luhn check digit (mod 10) for a digit string — the MERS MIN's 18th digit over the first 17. */
export function luhnCheckDigit(digits: string): number {
  let sum = 0;
  // The rightmost digit of `digits` is doubled: it sits next to the check digit.
  let dbl = true;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return (10 - (sum % 10)) % 10;
}

/** 18 digits and a valid Luhn check digit (the MERS MIN: 7-digit org id, 10-digit sequence, check digit). */
export function luhnValidMin(s: string): boolean {
  const t = s.trim();
  if (!/^\d{18}$/.test(t)) return false;
  return luhnCheckDigit(t.slice(0, 17)) === t.charCodeAt(17) - 48;
}

// ── header presence and row mapping ───────────────────────────────────────

export function profileHeadersPresent(
  profile: TapeProfile,
  headers: readonly string[],
): { ok: boolean; missing: string[] } {
  const present = new Set(headers.map(normalizeHeader));
  const missing = profile.required.filter((h) => !present.has(normalizeHeader(h)));
  return { ok: missing.length === 0, missing };
}

/**
 * Resolve each tape header to a profile column by normalized text. A header
 * the tape repeats ("Current Occupancy") takes the profile's columns of that
 * text in order, so the n-th occurrence maps to the n-th definition.
 */
export function resolveColumns(
  profile: TapeProfile,
  headers: readonly string[],
): (ColumnDef | null)[] {
  const byHeader = new Map<string, ColumnDef[]>();
  for (const c of profile.columns) {
    const k = normalizeHeader(c.header);
    const list = byHeader.get(k) ?? [];
    list.push(c);
    byHeader.set(k, list);
  }
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const k = normalizeHeader(h);
    const list = byHeader.get(k);
    if (!list) return null;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return list[Math.min(n, list.length - 1)] ?? null;
  });
}

const MAX_PLAUSIBLE_RATE = Decimal.parse("25");

export type MappedRow = {
  /** Every profile key, null when the tape lacks the header or the cell is empty. Investor columns are absent. */
  facts: Record<string, Fact>;
  /** Headers the profile does not know, verbatim. */
  raw: Record<string, string>;
  exceptions: RowException[];
  skip: RowExceptionCode | null;
};

/**
 * Map one tape row. Investor columns are read for the gate and then dropped.
 * `kind` is where the row's text came from, and decides only how the loan
 * number is read (`readLoanNumber`); a caller that cannot say reads it as a
 * CSV's, which is never rewritten.
 */
export function mapTapeRow(
  profile: TapeProfile,
  headers: readonly string[],
  row: readonly string[],
  rowNo: number,
  kind: FileKind = "csv",
): MappedRow {
  const cols = resolveColumns(profile, headers);
  const facts: Record<string, Fact> = {};
  for (const c of profile.columns) if (!c.investor) facts[c.key] = null;
  const raw: Record<string, string> = {};
  const unreadable: string[] = [];
  headers.forEach((header, i) => {
    const cell = row[i] ?? "";
    const col = cols[i];
    if (!col) {
      const h = header.trim();
      let key = h || `column_${i + 1}`;
      if (key in raw) {
        let n = 2;
        while (`${key} (${n})` in raw) n++;
        key = `${key} (${n})`;
      }
      raw[key] = cell;
      return;
    }
    if (col.investor) return;
    if (cell.trim() === "") {
      facts[col.key] = null;
      return;
    }
    const v = parseCell(col.type, cell);
    if (v === null) {
      unreadable.push(col.header);
      facts[col.key] = null;
      return;
    }
    facts[col.key] = v;
  });
  const loanCell = facts[profile.loanNumber];
  const written = typeof loanCell === "string" && loanCell.trim() !== "" ? loanCell.trim() : null;
  const loanRead = written === null ? null : readLoanNumber(written, kind);
  const refused = loanRead !== null && typeof loanRead !== "string" ? loanRead : null;
  // A refused number stays as written, on the fact and on the report, so the
  // person can find the row in their own file.
  const loanNo = typeof loanRead === "string" ? loanRead : written;
  facts[profile.loanNumber] = loanNo;
  const exceptions: RowException[] = unreadable.map((column) => ({
    row: rowNo,
    servicer_loan_number: loanNo,
    code: "unreadable_cell",
    column,
  }));
  let skip: RowExceptionCode | null = null;
  const state = facts["property_state"];
  if (loanNo === null) skip = "no_loan_number";
  else if (refused) skip = refused.code;
  else if (typeof state !== "string" || state.trim() === "") skip = "no_state";
  else if (facts["upb_cents"] === null || facts["note_rate_pct"] === null) {
    skip = "no_balance_or_rate";
  }
  if (refused) {
    const column = profile.columns.find((c) => c.key === profile.loanNumber);
    exceptions.push({
      row: rowNo,
      servicer_loan_number: loanNo,
      code: refused.code,
      column: column?.header ?? profile.loanNumber,
      detail: refused.detail,
    });
  } else if (skip) exceptions.push({ row: rowNo, servicer_loan_number: loanNo, code: skip });
  else {
    // A rate above 25 % or a balance above the original principal by more
    // than a tenth loads, with `implausible_value` naming the column.
    const rate = facts["note_rate_pct"];
    if (typeof rate === "string" && Decimal.parse(rate).cmp(MAX_PLAUSIBLE_RATE) > 0) {
      exceptions.push({
        row: rowNo,
        servicer_loan_number: loanNo,
        code: "implausible_value",
        column: "Current Interest Rate",
      });
    }
    const upb = facts["upb_cents"];
    const orig = facts["original_upb_cents"];
    if (
      typeof upb === "string" &&
      typeof orig === "string" &&
      BigInt(orig) > 0n &&
      BigInt(upb) * 10n > BigInt(orig) * 11n
    ) {
      exceptions.push({
        row: rowNo,
        servicer_loan_number: loanNo,
        code: "implausible_value",
        column: "Interest Bearing UPB",
      });
    }
  }
  return { facts, raw, exceptions, skip };
}
