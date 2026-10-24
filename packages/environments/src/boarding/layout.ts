/**
 * The layout's code lists: for every column of every file in a transfer
 * package, its format and, for a coded column, its codes.
 *
 * The final tape's columns, their MISMO paths and the rules that read them
 * are the servicing app's own column dictionary (`FINAL_TAPE_COLUMNS`, in the
 * ported codec), and the enumerations its MISMO text names are read from it;
 * a test holds the Y/N columns to the ones the codec's encoder writes as Y or
 * N. The detail files' notes are LAYOUT.md's, and the correspondence file,
 * the tape's four columns after the layout's own and the payment history's
 * split are the writer's own (`life/transfer-package.ts`).
 */

import { FINAL_TAPE_COLUMNS } from "./ported/tape-codec.js";
import {
  CAP_COLUMN,
  CORRESPONDENCE_FILE,
  CORRESPONDENCE_HEADER,
  CORRESPONDENCE_KINDS,
  FLOOD_COLUMN,
  MI_DATE_COLUMN,
  MI_VALUE_COLUMN,
  PACKAGE_FILES,
  TAPE_HEADER,
  type PackageFile,
} from "../life/transfer-package.js";

export type Format =
  "id" | "text" | "money" | "date" | "percent" | "bps" | "count" | "yes_no" | "code";

export interface ColumnSpec {
  readonly file: PackageFile;
  readonly column: string;
  readonly format: Format;
  /** A coded column's codes; null for any other. */
  readonly codes: readonly string[] | null;
  readonly note: string;
  /** The final tape's illustrative MISMO v3.6 path and the gate rules that read the column, from the codec's dictionary. */
  readonly mismo?: string;
  readonly read_by?: string;
}

export const FORMATS: Readonly<Record<Format, string>> = {
  id: "an identifier, as the file gives it",
  text: "free text",
  money:
    "a decimal dollar amount with two places and no symbol or grouping (negative allowed); blank is none",
  date: "an ISO 8601 date, YYYY-MM-DD; blank is none",
  percent: "a decimal percent (6.500 is 6.5 %)",
  bps: "whole basis points (275 is 2.75 %)",
  count: "a whole number",
  yes_no: "Y or N",
  code: "one of the column's codes",
};

/** The tape's booleans: the columns the codec's encoder writes Y or N (`yn`, tape-codec.ts:46). */
export const YES_NO_COLUMNS: readonly string[] = [
  "mers_eligible",
  "escrowed",
  "nib_separated",
  "bk_active",
  "fc_active",
  "lm_in_process",
  "scra_active",
  "tax_parcel_verified",
  "mi_flag",
  "flood_determination_life_of_loan",
  "sii_present",
  "sii_complete",
  "fair_lending_present",
  "acp_enrolled",
  "fees_itemized",
  "mers_investor_is_fnma",
];

const TAPE_FORMATS: Readonly<Record<string, Format>> = {
  transferor_loan_number: "id",
  fnma_loan_number: "id",
  min: "id",
  remittance_type: "code",
  upb: "money",
  scheduled_upb: "money",
  next_due_date: "date",
  note_rate_pct: "percent",
  pi_payment: "money",
  escrow_payment: "money",
  maturity_date: "date",
  original_term_months: "count",
  original_upb: "money",
  instrument_date: "date",
  origination_date: "date",
  first_payment_date: "date",
  interest_method: "code",
  amortization: "code",
  arm_index: "text",
  arm_margin_bps: "bps",
  arm_initial_cap_bps: "bps",
  arm_periodic_cap_bps: "bps",
  arm_lifetime_cap_bps: "bps",
  arm_lookback_days: "count",
  arm_next_change_date: "date",
  escrow_balance: "money",
  late_charge_pct: "percent",
  late_charge_grace_days: "count",
  deferred_principal: "money",
  forborne_principal: "money",
  scra_rate_cap_reason: "text",
  occupancy: "code",
  hazard_policy_expires: "date",
  unapplied_funds: "money",
  fees_advances: "money",
  corporate_advances: "money",
  late_charges_due: "money",
  last_principal_applied: "money",
  [CAP_COLUMN]: "money",
  [MI_VALUE_COLUMN]: "money",
  [MI_DATE_COLUMN]: "date",
  [FLOOD_COLUMN]: "code",
};

/** FEMA's flood zones (44 CFR 64.3): A and V zones are special flood hazard areas; B, C, X and D are not. */
export const FLOOD_ZONES: readonly string[] = [
  "A",
  "AE",
  "AH",
  "AO",
  "AR",
  "A99",
  "V",
  "VE",
  "B",
  "C",
  "X",
  "D",
];

/** The notes of the tape's columns after the layout's own, which this package's writer adds. */
const EXTENSION_NOTES: Readonly<Record<string, string>> = {
  [CAP_COLUMN]:
    "The note's dollar cap on a late charge (MISMO LATE_CHARGE_RULE/LateChargeMaximumAmount): blank when the note has none. A column of this package's writer after the layout's own; the layout has no place for it, and the servicing app's decoder does not read it.",
  [MI_VALUE_COLUMN]:
    "The mortgage insurance's original value (12 U.S.C. 4901(12)), from which its termination dates are computed: blank when no MI is in force. A column of this package's writer after the layout's own; the servicing app's decoder does not read it.",
  [MI_DATE_COLUMN]:
    "The date the mortgage insurance terminates automatically: the first due date on which the initial amortization schedule reaches 78 % of the original value (12 U.S.C. 4902(b)); blank when no MI is in force. A column of this package's writer after the layout's own; the servicing app's decoder does not read it.",
  [FLOOD_COLUMN]:
    "The FEMA flood zone of the property, from the life-of-loan flood determination (MISMO FLOOD_DETERMINATION/FloodZoneIdentifier). A zone that begins with A or V is a special flood hazard area. A column of this package's writer after the layout's own; the servicing app's decoder does not read it.",
};

/** The codes a MISMO path names in parentheses, as the dictionary writes them: "(A/A, S/A, S/S)". */
function codesIn(mismo: string): string[] | null {
  const m = /\(([^()]+)\)\s*$/.exec(mismo);
  if (!m) return null;
  const codes = m[1]!.split(",").map((x) => x.trim());
  return codes.every((c) => /^[A-Za-z0-9_/]+$/.test(c)) ? codes : null;
}

const tape: ColumnSpec[] = TAPE_HEADER.map((column) => {
  const dict = FINAL_TAPE_COLUMNS.find((c) => c.column === column);
  const format: Format = YES_NO_COLUMNS.includes(column)
    ? "yes_no"
    : (TAPE_FORMATS[column] ?? "text");
  const codes =
    format === "yes_no"
      ? ["Y", "N"]
      : column === FLOOD_COLUMN
        ? [...FLOOD_ZONES]
        : format === "code"
          ? codesIn(dict!.mismo)
          : null;
  if (format === "code" && !codes) throw new Error(`${column}: the dictionary names no codes`);
  return {
    file: "boarding_tape.final.csv",
    column,
    format,
    codes,
    note: EXTENSION_NOTES[column] ?? `${FORMATS[format]}.`,
    ...(dict ? { mismo: dict.mismo, read_by: dict.rules } : {}),
  };
});

const detail = (
  file: PackageFile,
  cols: readonly (readonly [string, Format, (readonly string[] | null)?, string?])[],
): ColumnSpec[] =>
  cols.map(([column, format, codes, note]) => ({
    file,
    column,
    format,
    codes: format === "yes_no" ? ["Y", "N"] : (codes ?? null),
    note: note ?? `${FORMATS[format]}.`,
  }));

const LOAN = ["transferor_loan_number", "id"] as const;

export const COLUMNS: readonly ColumnSpec[] = [
  ...tape,
  ...detail("payment_history.csv", [
    LOAN,
    ["due_date", "date", null, "One row per scheduled installment, oldest first."],
    ["scheduled_amount", "money", null, "The installment's payment: P&I and escrow."],
    [
      "received_on",
      "date",
      null,
      "The day the installment was paid in full; blank = unpaid as of the close of business before the transfer date.",
    ],
    ["received_amount", "money", null, "What paid it; blank = unpaid."],
    [
      "principal",
      "money",
      null,
      "How the prior servicer applied the payment that paid the row: to principal. With interest and escrow it is the payment; blank = unpaid. A column of this package's writer after the layout's own, as the prior servicer's transaction history gives it; the servicing app's decoder does not read it.",
    ],
    ["interest", "money", null, "The payment's interest; blank = unpaid."],
    [
      "escrow",
      "money",
      null,
      "The payment's escrow; blank = unpaid. Less than the escrow the installment billed when the $50 rule applied a short payment (F-1-09).",
    ],
  ]),
  ...detail("escrow_history.csv", [
    LOAN,
    ["line_type", "code", ["county_tax", "hazard", "flood", "mi"], "One row per escrow line."],
    [
      "annual_amount",
      "money",
      null,
      "The line's bills in the twelve months from the transfer date.",
    ],
    ["next_due_date", "date", null, "The line's next bill on or after the transfer date."],
  ]),
  ...detail("escrow_analysis.csv", [
    LOAN,
    ["last_analysis_date", "date", null, "The last escrow analysis; one row per escrowed loan."],
    ["escrow_balance", "money"],
    [
      "balance_sign_consistent",
      "yes_no",
      null,
      "N = the history contradicts the balance sign (HF-007).",
    ],
  ]),
  ...detail("lossmit_file.csv", [
    LOAN,
    ["application_status", "text", null, "One row per loan with loss mitigation in process."],
    ["received_on", "date"],
  ]),
  ...detail("fc_bk_file.csv", [
    LOAN,
    ["bk_chapter", "text", null, "One row per loan in bankruptcy or foreclosure."],
    ["bk_case_number", "text"],
    ["bk_filed_on", "date"],
    ["fc_referral_date", "date"],
    ["fc_attorney", "text"],
  ]),
  ...detail("consents_file.csv", [
    LOAN,
    ["esign_evidence", "yes_no"],
    ["tcpa_voice_evidence", "yes_no"],
  ]),
  ...detail("images_manifest.csv", [
    LOAN,
    [
      "document_type",
      "code",
      ["note", "mortgage", "title_policy", "allonge", "deferral_agreement"],
      "One row per document image.",
    ],
    ["filename", "text"],
    ["sha256", "text", null, "The SHA-256 of the image the transferor delivers alongside."],
  ]),
  ...detail("trial_balance.csv", [
    LOAN,
    ["fnma_loan_number", "id"],
    [
      "upb_as_of_t_minus_1",
      "money",
      null,
      "The F-1-11 trial balance as of the close of business before the transfer date.",
    ],
  ]),
  ...detail("fnma_position.csv", [
    ["fnma_loan_number", "id", null, "Fannie Mae's position (the LSDU pull), one row per loan."],
    ["on_approved_list", "yes_no"],
    ["remittance_type", "code", ["A/A", "S/A", "S/S"]],
    ["upb", "money"],
    ["scheduled_upb", "money", null, "Only for S/S loans."],
  ]),
  ...detail("mers_lookup.csv", [
    ["min", "id", null, "The MERS lookup, one row per registered MIN."],
    ["status", "code", ["Active", "Inactive", "Deactivated"]],
    ["servicer_org_id", "id"],
    ["investor_org_id", "id"],
  ]),
  ...detail("fair_lending.csv", [
    LOAN,
    ["ethnicity", "text", null, "Restricted; access-logged; not read in a boarding review."],
    ["race", "text"],
    ["sex", "text"],
    ["age", "count"],
    ["preferred_language", "text"],
  ]),
  ...detail(
    CORRESPONDENCE_FILE,
    CORRESPONDENCE_HEADER.map(
      (c): readonly [string, Format, (readonly string[] | null)?, string?] =>
        c === "transferor_loan_number"
          ? LOAN
          : c === "sent_on"
            ? [
                c,
                "date",
                null,
                "The day the prior servicer sent it, or the call was made or taken.",
              ]
            : c === "direction"
              ? [c, "code", ["outbound", "inbound"]]
              : c === "channel"
                ? [c, "code", ["mail", "phone", "email"]]
                : c === "kind"
                  ? [
                      c,
                      "code",
                      CORRESPONDENCE_KINDS,
                      "What the row is. A periodic_statement is the monthly statement (12 CFR 1026.41(d)): the installment it bills, its P&I and escrow, the late fee the prior servicer's system will charge, and the last day before that fee is imposed. The documents of record: mi_disclosure, the lender's mortgage-insurance disclosure at consummation (12 U.S.C. 4903(a)(1)), whose due_date is the automatic-termination date and amount the original value; flood_determination, the life-of-loan flood determination, whose detail is the FEMA zone; repayment_plan, a plan the prior servicer agreed, whose amount is the arrears it spreads; bankruptcy_notice, the court's notice of a petition; scra_notice, the prior servicer's notice of a servicemember's rate cap, whose due_date is the first capped installment and pi the capped P&I.",
                    ]
                  : c === "due_date"
                    ? [
                        c,
                        "date",
                        null,
                        "The installment a statement or notice is about; on an mi_disclosure, the automatic-termination date.",
                      ]
                    : c === "late_fee_after"
                      ? [
                          c,
                          "date",
                          null,
                          "A statement's late fee is charged if the payment has not been received by the end of this day.",
                        ]
                      : c === "detail"
                        ? [c, "text"]
                        : [c, "money"],
    ),
  ),
];

/** Every column of `file`, or the one named. */
export function columnsOf(file: string, column?: string): ColumnSpec[] {
  if (!(PACKAGE_FILES as readonly string[]).includes(file))
    throw new RangeError(
      `no file ${JSON.stringify(file)}; the package's files are ${PACKAGE_FILES.join(", ")}`,
    );
  const cols = COLUMNS.filter((c) => c.file === file);
  if (column === undefined) return cols;
  const one = cols.filter((c) => c.column === column);
  if (one.length === 0)
    throw new RangeError(
      `${file} has no column ${JSON.stringify(column)}; its columns are ${cols.map((c) => c.column).join(", ")}`,
    );
  return one;
}
