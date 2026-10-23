/**
 * The m3-v1 layout as a reviewer looks it up: each column's letter, the
 * profile's header, key and type, whether the reader requires it, and the
 * form the partner's export writes it in, with the rules a column keeps from
 * month to month. The columns are the tape writer's (`TAPE_COLUMNS`, which a
 * test holds equal to the profile); the forms are the writer's own (tape.ts),
 * stated in words.
 */

import { TAPE_COLUMNS, type TapeColumn } from "../life/tape.js";

/** A column's letter: A to Z, then AA to DN, as a spreadsheet names it. */
export function letterOf(i: number): string {
  return i < 26
    ? String.fromCharCode(65 + i)
    : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26));
}

/** Header text as the reader compares it: trimmed, spaces collapsed, any case (m3-v1.ts `normalizeHeader`). */
export const normalizeHeader = (h: string): string => h.trim().replace(/\s+/g, " ").toLowerCase();

const FORMS: Readonly<Record<TapeColumn["type"], string>> = {
  text: "text, as written",
  money:
    'dollars and cents, two places, no symbol or grouping, a minus sign before a negative ("441366.13", "-12.50")',
  rate: 'a percent to three places ("6.375"); a rate of 1 or less carries its percent sign',
  int: "a whole number",
  date: 'm/d/yyyy, the year in four digits, no leading zeros ("5/1/2027")',
  bool: "Y or N",
  pct: "a decimal, as written",
  baths: "a decimal, as written",
};

/** What a column's form says beyond its type's. */
const OWN_FORMS: Readonly<Record<string, string>> = {
  as_of_date: "m/d/yyyy: the last day of the month the tape is for, the same on every row",
  servicer_loan_number: "the partner's loan number: ten digits, the loan's key on every tape",
  property_zip: "five digits",
  pay_string:
    "twelve characters, the oldest month first and the tape's own month last: 0 current, 3, 6 and 9 for 30, 60 and 90 or more days late by the MBA's count, X for a month before the loan's first",
  mba_pay_string: "the pay string with C for each 0",
  mba_delinquency_status: "C for current, or 30, 60, 90 or 120: the MBA's bucket",
  servicing_status:
    "Active for a loan the partner services at the month-end; Paid Off or Service Released for one it closed that month",
  pmi_rate_pct: 'basis points of the original balance a year ("45")',
  ti_cents:
    "money: the escrow share of the monthly payment, for the next installment due; 0.00 on a loan with no escrow",
  total_due_cents: "money: the P&I payment plus the T&I payment",
  escrow_balance_cents:
    "money: the escrow account's balance at the month-end; negative when the partner has advanced",
  cash_flow_month_12:
    "money: what the borrower paid in the tape's own month, every receipt together (Cash Flow Month 01 is eleven months before)",
};

/** Rules a column's dates keep. */
const FIRST_OF_A_MONTH = new Set([
  "interest_paid_to_date",
  "next_due_date",
  "maturity_date",
  "first_payment_date",
  "orig_maturity_date",
]);
const NEVER_CHANGES = new Set([
  "maturity_date",
  "first_payment_date",
  "origination_date",
  "orig_maturity_date",
]);

export interface LayoutColumn {
  readonly letter: string;
  readonly header: string;
  readonly key: string;
  readonly type: TapeColumn["type"];
  readonly required: boolean;
  /** The partner's investor economics: the reader drops them, and the partner leaves them empty here. */
  readonly investor: boolean;
  readonly form: string;
  readonly rules: readonly string[];
}

export const LAYOUT: readonly LayoutColumn[] = TAPE_COLUMNS.map((c, i) => ({
  letter: letterOf(i),
  header: c.header,
  key: c.key,
  type: c.type,
  required: c.required === true,
  investor: c.investor === true,
  form: OWN_FORMS[c.key] ?? FORMS[c.type],
  rules: [
    ...(FIRST_OF_A_MONTH.has(c.key)
      ? ["the first of a month: every installment is due on the first"]
      : []),
    ...(NEVER_CHANGES.has(c.key)
      ? ["the same on every month's tape for a loan: it is the note's"]
      : []),
  ],
}));

/** A column of the layout by its letter or its header (as the reader compares them); the first of a repeated header. */
export function layoutColumn(name: string): LayoutColumn | null {
  const n = name.trim();
  return (
    LAYOUT.find((c) => c.letter === n.toUpperCase()) ??
    LAYOUT.find((c) => normalizeHeader(c.header) === normalizeHeader(n)) ??
    null
  );
}

/** The layout's column for a profile key. */
export function columnOfKey(key: string): LayoutColumn {
  const c = LAYOUT.find((x) => x.key === key);
  if (!c) throw new RangeError(`no column for ${key}`);
  return c;
}

/** The two code columns with a fixed width, and the width. */
export const CODE_WIDTHS: Readonly<Record<string, number>> = {
  "Property Zip Code": 5,
  "Pay String": 12,
};
