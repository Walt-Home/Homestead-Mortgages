/**
 * The month-end projection: per loan per month, what a partner's tape
 * carries, so the tape writer (tape.ts) only has to lay it out.
 *
 * The groups and their field names follow the m3-v1 profile's keys
 * (packages/partner-book/src/m3-v1.ts): the terms, the balances, the status
 * and dates, the pay string, the escrow balance, twelve months of cash flow,
 * the PMI fields, and the foreclosure and bankruptcy fields. Values are typed
 * (cents as bigint, dates as ISO strings), never formatted cells.
 *
 * The pay string is twelve characters, oldest month first, as the refi-tape
 * environment writes one: 0 current, 3, 6 and 9 for 30, 60 and 90 or more
 * days by the MBA count of missed payments, X for a month before the loan's
 * first. The cash flow is the borrower's money received in each of the twelve
 * months ending with the as-of month (Month 01 the oldest, Month 12 the
 * as-of month), payoff funds included, null before the loan's first month.
 *
 * A loan's last month-end, the month it paid off or transferred, is measured
 * on the day it closed: its delinquency is what it owed then, and a loan paid
 * in full has nothing past due (simulate.ts, `monthEnd`).
 *
 * A loan still being paid always has a next due date here, as a partner's
 * tape always does. The ledger runs one installment ahead of the month, so a
 * borrower who paid next month's installment early leaves none open at the
 * month-end; since life 1.2.0 the month-end itself takes the installment
 * after the one interest is paid to, and counts the remaining term and reads
 * the payment from it (simulate.ts, `monthEnd`), so the projection copies
 * both. Under 1.1.0 the month-end's `next_due` was null there and the
 * projection filled it.
 *
 * Foreclosure is not generated yet, so its fields are always empty; they are
 * here so the tape writer's layout is complete. A bankruptcy is reported
 * from the petition for as long as the servicer whose books the loan is on
 * knows of it (a boarding that dropped the case, D-37, reports none).
 */

import { addMonths, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import { interest } from "../payoff/ported/quote.js";
import type { FnmaDelinquencyStatus } from "../pmi/ported/delinquency.js";
import type { LifeBook } from "./generate.js";
import type { LoanLife, MonthEnd, Servicer } from "./simulate.js";

export interface TapeRow {
  readonly loan_id: string;
  readonly as_of_date: PlainDate;
  /** Whose books the loan is on at the month-end. */
  readonly servicer: Servicer;
  readonly servicer_loan_number: string;
  readonly borrower: {
    readonly borrower_name: string;
    readonly parties: readonly {
      readonly given_name: string;
      readonly surname: string;
      readonly date_of_birth: PlainDate;
      readonly role: "PRIMARY_BORROWER" | "CO_BORROWER";
    }[];
  };
  readonly property: {
    readonly property_address: string;
    readonly property_city: string;
    readonly property_state: string;
    readonly property_zip: string;
    readonly property_type: string;
    readonly occupancy: string;
    readonly appraised_value_cents: Cents;
  };
  readonly terms: {
    readonly lien_position: "first";
    readonly loan_type: "conventional";
    readonly original_upb_cents: Cents;
    readonly original_note_rate_pct: string;
    readonly note_rate_pct: string;
    readonly pi_cents: Cents;
    readonly ti_cents: Cents;
    readonly total_due_cents: Cents;
    readonly original_term_months: number;
    readonly remaining_term_months: number;
    readonly maturity_date: PlainDate;
    readonly first_payment_date: PlainDate;
    readonly origination_date: PlainDate;
    readonly ltv_original_pct: number;
    readonly interest_only: false;
    readonly balloon: false;
    readonly arm_index: string | null;
    readonly arm_margin_pct: string | null;
    readonly arm_fixed_period_months: number | null;
    readonly arm_payment_adj_period_months: number | null;
    readonly arm_adj_freq_months: number | null;
    readonly arm_rate_ceiling_pct: string | null;
    readonly arm_rate_floor_pct: string | null;
    readonly arm_neg_am: false | null;
    readonly late_charge_pct: string;
    readonly late_charge_grace_days: number;
    /** What the servicer's system holds (a defective twin's boarding shows here), not the note. */
    readonly late_charge_max_cents: Cents | null;
  };
  readonly balance: {
    readonly upb_cents: Cents;
    readonly deferred_upb_cents: Cents;
    readonly total_upb_cents: Cents;
    readonly accrued_interest_cents: Cents;
    readonly suspense_cents: Cents;
    readonly late_charges_due_cents: Cents;
    readonly amount_past_due_cents: Cents;
  };
  readonly status: {
    readonly servicing_status: MonthEnd["status"];
    readonly delinquency_days: number;
    readonly mba_delinquency_status: FnmaDelinquencyStatus;
    readonly next_due_date: PlainDate | null;
    readonly interest_paid_to_date: PlainDate | null;
    readonly last_payment_date: PlainDate | null;
    readonly metro2_account_status: string;
    readonly repayment_plan: boolean;
  };
  readonly pay_string: string;
  readonly mba_pay_string: string;
  readonly escrow: {
    readonly escrowed: boolean;
    readonly escrow_balance_cents: Cents;
    readonly escrow_advances_cents: Cents;
  };
  /** Twelve months, Month 01 (oldest) to Month 12 (the as-of month). */
  readonly cash_flow: readonly (Cents | null)[];
  readonly pmi: {
    readonly pmi_flag: boolean;
    readonly pmi_rate_pct: string | null;
    readonly pmi_coverage_pct: number | null;
    readonly pmi_company: string | null;
    readonly pmi_homeowner_payment_pct: null;
  };
  readonly foreclosure: {
    readonly fc_status: false;
    readonly fc_referral_date: null;
    readonly fc_sale_scheduled_date: null;
    readonly fc_sale_held_date: null;
  };
  /** The case the servicer whose books the loan is on knows of (a boarding that dropped it reports none). */
  readonly bankruptcy: {
    readonly bk_status: boolean;
    readonly bk_chapter: string | null;
    readonly bk_filed_date: PlainDate | null;
    readonly bk_motion_for_relief_date: null;
    readonly bk_discharged: false;
    readonly bk_discharged_date: null;
    readonly bk_dismissed_date: null;
  };
  readonly contact: {
    readonly last_contact_date: PlainDate | null;
    readonly contact_expected: boolean;
  };
}

const PAY_CHAR: Readonly<Record<FnmaDelinquencyStatus, string>> = {
  current: "0",
  "30": "3",
  "60": "6",
  "90": "9",
  "120+": "9",
};

/** The loan's month-end row for `month` ("YYYY-MM"), or null when it has none (before its first month or after it ended). */
export function monthEndRow(loan: LoanLife, month: string): TapeRow | null {
  const k = loan.months.findIndex((m) => m.month === month);
  if (k < 0) return null;
  const m = loan.months[k]!;
  const d = loan.draw;
  const firstMonth = loan.months[0]!.month;
  const months12: string[] = [];
  for (let i = 11; i >= 0; i--)
    months12.push(addMonths(`${month}-01` as PlainDate, -i).slice(0, 7));
  const cash = new Map<string, Cents>();
  for (const r of loan.receipts) {
    const key = r.on.slice(0, 7);
    if (key < months12[0]! || key > month) continue;
    cash.set(key, (cash.get(key) ?? 0n) + r.amount);
  }
  // The months are contiguous from the first, so the one i places back is k - i.
  let pay = "";
  for (let i = 11; i >= 0; i--) pay += k - i < 0 ? "X" : PAY_CHAR[loan.months[k - i]!.mba_status];
  let lastContact: PlainDate | null = null;
  for (const c of loan.contacts) {
    if (c.on > m.as_of) break;
    lastContact = c.on;
  }
  const b1 = d.parties[0]!;
  const ended = m.status === "paid_off" || m.status === "transferred";
  return {
    loan_id: loan.loan_id,
    as_of_date: m.as_of,
    servicer: m.servicer,
    servicer_loan_number:
      m.servicer === "prior" ? d.prior_servicer_loan_number : d.servicer_loan_number,
    borrower: {
      borrower_name: `${b1.surname}, ${b1.given_name}`,
      parties: d.parties.map((p) => ({
        given_name: p.given_name,
        surname: p.surname,
        date_of_birth: p.date_of_birth,
        role: p.position === 1 ? "PRIMARY_BORROWER" : "CO_BORROWER",
      })),
    },
    property: {
      property_address: d.property.street,
      property_city: d.property.city,
      property_state: d.property.state,
      property_zip: d.property.zip,
      property_type: d.property.property_type,
      occupancy: d.property.occupancy,
      appraised_value_cents: d.value_cents,
    },
    terms: {
      lien_position: "first",
      loan_type: "conventional",
      original_upb_cents: d.orig_upb_cents,
      original_note_rate_pct: d.note_rate_pct,
      note_rate_pct: m.rate_pct,
      pi_cents: m.pi,
      ti_cents: m.escrow_payment,
      total_due_cents: m.pi + m.escrow_payment,
      original_term_months: d.term_months,
      remaining_term_months: m.remaining_term_months,
      maturity_date: d.maturity,
      first_payment_date: d.first_due,
      origination_date: d.note_date,
      ltv_original_pct: d.ltv_pct,
      interest_only: false,
      balloon: false,
      arm_index: d.arm?.index ?? null,
      arm_margin_pct: d.arm?.margin_pct ?? null,
      arm_fixed_period_months: d.arm?.fixed_period_months ?? null,
      arm_payment_adj_period_months: d.arm?.period_months ?? null,
      arm_adj_freq_months: d.arm?.period_months ?? null,
      arm_rate_ceiling_pct: d.arm
        ? (Number(d.note_rate_pct) + Number(d.arm.lifetime_cap_pct)).toFixed(3)
        : null,
      arm_rate_floor_pct: d.arm?.margin_pct ?? null,
      arm_neg_am: d.arm ? false : null,
      late_charge_pct: loan.boarded.terms.late_charge_pct,
      late_charge_grace_days: loan.boarded.terms.late_charge_grace_days,
      late_charge_max_cents:
        m.servicer === "prior" ? d.late_charge.cap_cents : loan.boarded.terms.late_charge_cap_cents,
    },
    balance: {
      upb_cents: m.upb,
      deferred_upb_cents: 0n,
      total_upb_cents: m.upb,
      accrued_interest_cents:
        ended || m.lpi === null || m.lpi >= m.as_of
          ? 0n
          : interest(m.upb, m.rate_pct, m.lpi, m.as_of).total_cents,
      suspense_cents: m.suspense,
      late_charges_due_cents: m.late_charges_due,
      amount_past_due_cents: m.amount_past_due,
    },
    status: {
      servicing_status: m.status,
      delinquency_days: m.days_delinquent,
      mba_delinquency_status: m.mba_status,
      next_due_date: m.next_due,
      interest_paid_to_date: m.lpi,
      last_payment_date: m.last_payment_on,
      metro2_account_status: m.metro2.account_status,
      repayment_plan: m.plan_active,
    },
    pay_string: pay,
    mba_pay_string: pay.replace(/0/g, "C"),
    escrow: {
      // What the servicer's system holds: a twin boarded non-escrowed (D-31) shows here once it is ours.
      escrowed: m.servicer === "prior" ? d.escrowed : loan.boarded.terms.escrowed,
      escrow_balance_cents: m.escrow_balance,
      escrow_advances_cents: m.escrow_advance,
    },
    cash_flow: months12.map((mm) =>
      mm < firstMonth ? (cash.get(mm) ?? null) : (cash.get(mm) ?? 0n),
    ),
    pmi: {
      pmi_flag: m.mi_active,
      pmi_rate_pct: d.mi?.rate_pct ?? null,
      pmi_coverage_pct: d.mi?.coverage_pct ?? null,
      pmi_company: d.mi?.company ?? null,
      pmi_homeowner_payment_pct: null,
    },
    foreclosure: {
      fc_status: false,
      fc_referral_date: null,
      fc_sale_scheduled_date: null,
      fc_sale_held_date: null,
    },
    bankruptcy: {
      bk_status: m.bankruptcy !== undefined,
      bk_chapter: m.bankruptcy?.chapter ?? null,
      bk_filed_date: m.bankruptcy?.filed_on ?? null,
      bk_motion_for_relief_date: null,
      bk_discharged: false,
      bk_discharged_date: null,
      bk_dismissed_date: null,
    },
    contact: {
      last_contact_date: lastContact,
      contact_expected: !ended && m.days_delinquent >= 30,
    },
  };
}

/** Every month-end row of one loan, oldest first. */
export function loanRows(loan: LoanLife): TapeRow[] {
  return loan.months.map((m) => monthEndRow(loan, m.month)!);
}

/** The book as of one month-end: a row for every loan with a month-end that month. */
export function bookTape(book: LifeBook, month: string): TapeRow[] {
  return book.loans.flatMap((l) => {
    const r = monthEndRow(l, month);
    return r ? [r] : [];
  });
}
