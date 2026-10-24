/**
 * A record read the way a note is read against it.
 *
 * The rubric takes the loan's record as JSON, the way a reviewer sees it:
 * amounts as dollars ("$1,234.56"), dates as YYYY-MM-DD, rates as strings
 * under keys ending in `_pct`, the servicer's telephone number as written.
 * Two checks read it. Provenance hands it whole to the servicing app's
 * `figureRuns`, which takes digit-runs from every value. The note check is
 * the contact center's (`check.ts`): it reads each number in a note by kind
 * (money, a date, a rate, a telephone number, a count) and looks for it
 * here, by kind; `recordNumbers` is what it looks in, taken from the JSON by
 * these rules and no others:
 *
 *   - money: every string that is a dollar amount, by its cents, signless;
 *   - dates: every string that is a date, YYYY-MM-DD;
 *   - rates: every value under a key ending in `_pct`;
 *   - telephone numbers: every string written 1-NNN-NNN-NNNN;
 *   - counts: every number, every string of digits alone (a loan number, a
 *     ZIP code, the last four of a taxpayer number), and the year of every
 *     date.
 */

import type { PlainDate } from "@hm/kernel/calendar";
import { pctKey, type FactNumbers } from "../contacts/record.js";

const MONEY = /^-?\$\d{1,3}(,\d{3})*\.\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^1-\d{3}-\d{3}-\d{4}$/;
const DIGITS = /^\d+$/;

/** "$1,234.56" or "-$1,234.56" as cents, signless. */
export const centsOfDollars = (s: string): string => {
  const x = s.replace(/[-$,]/g, "");
  const [w, f] = x.split(".");
  return (BigInt(w!) * 100n + BigInt((f ?? "0").padEnd(2, "0").slice(0, 2))).toString();
};

export function recordNumbers(record: unknown): FactNumbers {
  const money = new Set<string>();
  const dates = new Set<PlainDate>();
  const ints = new Set<number>();
  const pcts = new Set<string>();
  const phones = new Set<string>();
  const walk = (v: unknown, key: string): void => {
    if (v === null || v === undefined || typeof v === "boolean") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
      return;
    }
    if (key.endsWith("_pct")) {
      pcts.add(pctKey(String(v)));
      return;
    }
    if (typeof v === "number") {
      if (Number.isFinite(v)) ints.add(v);
      return;
    }
    const s = String(v);
    if (MONEY.test(s)) money.add(centsOfDollars(s));
    else if (DATE.test(s)) {
      dates.add(s as PlainDate);
      ints.add(Number(s.slice(0, 4)));
    } else if (PHONE.test(s)) phones.add(s);
    else if (DIGITS.test(s)) ints.add(Number(s));
  };
  walk(record, "");
  return { money, dates, ints, pcts, phones };
}

/** An amount as a reviewer reads it. */
export type Dollars = string;

/**
 * The loan's record on one day, as the call-QA desk reads it: every figure
 * an agent may say that day (the contact center's `RecordFacts`, contacts/
 * record.ts), amounts in dollars, and the servicer's own constants.
 */
export interface RecordView {
  readonly on: string;
  /** The servicer of record that day, its telephone number and the figures it says on every loan. */
  readonly servicer: {
    readonly name: string;
    readonly phone: string;
    readonly hours_open: number;
    readonly hours_close: number;
    readonly transfer_shield_days: number;
    readonly payoff_statement_business_days: number;
    readonly credit_report_days: number;
    readonly mi_request_ltv_pct: number;
    readonly mi_auto_ltv_pct: number;
    readonly shortage_spread_months: number;
    readonly qwr_ack_business_days: number;
    readonly qwr_response_business_days: number;
    readonly reset_link_minutes: number;
    readonly form_number: number;
  };
  readonly loan: {
    readonly number: string;
    readonly number_last4: string;
    readonly rate_pct: string;
    readonly principal_balance: Dollars;
    readonly grace_days: number;
    readonly late_charge_pct: string;
    readonly escrowed: boolean;
  };
  readonly borrowers: readonly {
    readonly role: "borrower" | "co_borrower";
    readonly name: string;
    readonly date_of_birth: string;
    readonly ssn_last4: string;
  }[];
  readonly property: {
    readonly street: string;
    readonly street_number: string;
    readonly city: string;
    readonly state: string;
    readonly zip: string;
  };
  readonly phones_last4: readonly string[];
  readonly next_installment: {
    readonly due: string;
    readonly amount: Dollars;
    readonly principal_interest: Dollars;
    readonly escrow: Dollars;
    readonly grace_ends: string;
  } | null;
  readonly past_due: {
    readonly oldest_due: string;
    readonly installments: number;
    readonly days: number;
    readonly installment_total: Dollars;
    readonly late_charges: Dollars;
    readonly total: Dollars;
  } | null;
  readonly last_payment: {
    readonly on: string;
    readonly amount: Dollars;
    readonly applied_to: string | null;
    readonly to_suspense: Dollars;
    readonly curtailment: Dollars;
    readonly forwarded: boolean;
  } | null;
  readonly escrow_statement: { readonly as_of: string; readonly balance: Dollars } | null;
  readonly escrow_analysis: {
    readonly as_of: string;
    readonly sent_on: string;
    readonly effective: string;
    readonly decision: string;
    readonly shortage: Dollars | null;
    readonly surplus: Dollars | null;
    readonly old_escrow: Dollars;
    readonly new_escrow: Dollars;
    readonly first_month_escrow: Dollars;
    readonly old_total: Dollars;
    readonly new_total: Dollars;
    readonly taxes_last_12_months: Dollars;
    readonly taxes_prior_12_months: Dollars;
    readonly hazard_last_12_months: Dollars;
    readonly hazard_prior_12_months: Dollars;
  } | null;
  readonly arm_change: {
    readonly change: string;
    readonly first_new_payment: string;
    readonly prior_rate_pct: string;
    readonly new_rate_pct: string;
    readonly old_principal_interest: Dollars;
    readonly new_principal_interest: Dollars;
    readonly notice_on: string;
  } | null;
  readonly tax_paid: { readonly on: string; readonly amount: Dollars } | null;
  readonly hazard_paid: { readonly on: string; readonly amount: Dollars } | null;
  readonly escrow_refund: { readonly on: string; readonly amount: Dollars } | null;
  readonly late_charge: {
    readonly due: string;
    readonly assessed_on: string;
    readonly amount: Dollars;
    readonly paid_on: string | null;
  } | null;
  readonly form_1098: {
    readonly year: number;
    readonly interest: Dollars;
    readonly taxes: Dollars;
    readonly mailed_by: string;
  } | null;
  readonly mortgage_insurance: { readonly active: boolean; readonly terminated_on: string | null };
  readonly transfer: {
    readonly on: string;
    readonly shield_until: string;
    readonly first_due: string | null;
  } | null;
  readonly payoff: {
    readonly on: string;
    readonly escrow_refund: Dollars;
    readonly refund_on: string | null;
  } | null;
  /** The last month furnished to the credit bureaus, and the days delinquent behind it. */
  readonly credit_reporting: { readonly month: string; readonly days_delinquent: number } | null;
  /** Promises to pay made on or before the day and not yet due. */
  readonly promises: readonly {
    readonly made_on: string;
    readonly amount: Dollars;
    readonly pay_by: string;
  }[];
  /** A bankruptcy case the servicer has been told of. */
  readonly bankruptcy: {
    readonly chapter: 7 | 13;
    readonly petition_on: string;
    readonly noticed_on: string;
    readonly case_last4: string;
    readonly discharged_on: string | null;
    readonly attorney: string;
    readonly firm: string;
  } | null;
  /** A third party's written authorization on file, by the day it was received. */
  readonly authorization_on: string | null;
}

/**
 * Whether the bankruptcy disclaimer takes the mini-Miranda's place on the
 * record's day: a case the servicer knows of, until a Chapter 13 discharge
 * (after a Chapter 7 discharge collection never resumes; contacts/derive.ts
 * `disclaimer`).
 */
export const bankruptcyApplies = (r: RecordView): boolean =>
  r.bankruptcy !== null &&
  !(
    r.bankruptcy.chapter === 13 &&
    r.bankruptcy.discharged_on !== null &&
    r.bankruptcy.discharged_on <= r.on
  );
