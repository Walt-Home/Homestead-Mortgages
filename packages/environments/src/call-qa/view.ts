/**
 * The loan's record on a day, as the QA desk reads it: the contact center's
 * `recordOn` (every figure an agent may say that day) with amounts in
 * dollars, the servicer's own constants, the promises still open, and a
 * third party's authorization on file. And the book a task's record is read
 * from, rebuilt from its seed when `record_on` asks for another day.
 */

import type { PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import { generate, defaultCalibration, type LifeBook, type Scenario } from "../life/index.js";
import type { LoanLife } from "../life/simulate.js";
import {
  PRIOR_SERVICER,
  SERVICER,
  contactCenter,
  money,
  recordOn,
  type BankruptcyCase,
  type ContactCenter,
  type LoanContacts,
  type ProfilePins,
} from "../contacts/index.js";
import type { RecordView } from "../calls/index.js";

const $ = (c: Cents): string => money(c);
const $n = (c: Cents | null): string | null => (c === null ? null : money(c));

/** The record on `on`: the contact center's facts, read as the desk reads them. */
export function recordView(
  life: LoanLife,
  loan: LoanContacts,
  on: PlainDate,
  bankruptcy: BankruptcyCase | null = loan.bankruptcy,
): RecordView {
  const auth = loan.contacts
    .filter((c) => c.purpose === "third_party_authorization" && c.on <= on)
    .map((c) => c.on)
    .pop();
  const f = recordOn(life, on, {
    profile: loan.profile,
    bankruptcy,
    promise: null,
    authorization_on: auth ?? null,
  });
  const us = f.servicer === "us";
  return {
    on: f.on,
    servicer: {
      name: us ? SERVICER.name : PRIOR_SERVICER.name,
      phone: us ? SERVICER.phone : PRIOR_SERVICER.phone,
      hours_open: SERVICER.hours_open,
      hours_close: SERVICER.hours_close,
      transfer_shield_days: SERVICER.transfer_shield_days,
      payoff_statement_business_days: SERVICER.payoff_statement_business_days,
      credit_report_days: SERVICER.credit_report_days,
      mi_request_ltv_pct: SERVICER.mi_request_ltv_pct,
      mi_auto_ltv_pct: SERVICER.mi_auto_ltv_pct,
      shortage_spread_months: SERVICER.shortage_spread_months,
      qwr_ack_business_days: SERVICER.qwr_ack_business_days,
      qwr_response_business_days: SERVICER.qwr_response_business_days,
      reset_link_minutes: SERVICER.reset_link_minutes,
      form_number: SERVICER.form_number,
    },
    loan: {
      number: f.loan_number,
      number_last4: f.loan_last4,
      rate_pct: f.rate_pct,
      principal_balance: $(f.upb),
      grace_days: f.grace_days,
      late_charge_pct: f.late_pct,
      escrowed: f.escrowed,
    },
    borrowers: f.parties.map((p) => ({
      role: p.role,
      name: `${p.given} ${p.surname}`,
      date_of_birth: p.dob,
      ssn_last4: p.ssn_last4,
    })),
    property: { ...f.property },
    phones_last4: [...f.phones_last4],
    next_installment: f.next
      ? {
          due: f.next.due,
          amount: $(f.next.amount),
          principal_interest: $(f.next.pi),
          escrow: $(f.next.escrow),
          grace_ends: f.next.grace_end,
        }
      : null,
    past_due: f.past_due
      ? {
          oldest_due: f.past_due.oldest_due,
          installments: f.past_due.installments,
          days: f.past_due.days,
          installment_total: $(f.past_due.installment_total),
          late_charges: $(f.past_due.late_charges),
          total: $(f.past_due.total),
        }
      : null,
    last_payment: f.last_payment
      ? {
          on: f.last_payment.on,
          amount: $(f.last_payment.amount),
          applied_to: f.last_payment.applied_to,
          to_suspense: $(f.last_payment.to_suspense),
          curtailment: $(f.last_payment.curtailment),
          forwarded: f.last_payment.forwarded,
        }
      : null,
    escrow_statement: f.escrow_statement
      ? { as_of: f.escrow_statement.as_of, balance: $(f.escrow_statement.balance) }
      : null,
    escrow_analysis: f.analysis
      ? {
          as_of: f.analysis.as_of,
          sent_on: f.analysis.sent_on,
          effective: f.analysis.effective,
          decision: f.analysis.decision,
          shortage: $n(f.analysis.shortage),
          surplus: $n(f.analysis.surplus),
          old_escrow: $(f.analysis.old_escrow),
          new_escrow: $(f.analysis.new_escrow),
          first_month_escrow: $(f.analysis.first_month_escrow),
          old_total: $(f.analysis.old_total),
          new_total: $(f.analysis.new_total),
          taxes_last_12_months: $(f.analysis.tax_12m),
          taxes_prior_12_months: $(f.analysis.tax_prior_12m),
          hazard_last_12_months: $(f.analysis.hazard_12m),
          hazard_prior_12_months: $(f.analysis.hazard_prior_12m),
          shortage_installment: $n(f.analysis.plan.shortage_installment),
          spread_months: f.analysis.plan.months,
          deficiency: $n(f.analysis.plan.deficiency),
          deficiency_installment: $n(f.analysis.plan.deficiency_installment),
          refund_by: f.analysis.plan.refund_by,
          credit_monthly: $n(f.analysis.plan.credit_monthly),
        }
      : null,
    annual_statement: f.statement
      ? {
          year_start: f.statement.year_start,
          year_end: f.statement.year_end,
          through: f.statement.through,
          lines: f.statement.lines.map((l) => ({
            month: l.month,
            line: l.label,
            paid: $(l.actual),
            projected: $n(l.projected),
            anticipated: l.anticipated,
            text: l.text,
          })),
          low_balance: f.statement.low
            ? {
                actual: $(f.statement.low.actual),
                projected: $(f.statement.low.projected),
                text: f.statement.low.text,
              }
            : null,
          overdrawn: f.statement.overdrawn,
        }
      : null,
    arm_change: f.arm
      ? {
          change: f.arm.change,
          first_new_payment: f.arm.first_new_payment,
          prior_rate_pct: f.arm.prior_rate,
          new_rate_pct: f.arm.new_rate,
          old_principal_interest: $(f.arm.old_pi),
          new_principal_interest: $(f.arm.new_pi),
          notice_on: f.arm.notice_on,
        }
      : null,
    tax_paid: f.tax_paid ? { on: f.tax_paid.on, amount: $(f.tax_paid.amount) } : null,
    hazard_paid: f.hazard_paid ? { on: f.hazard_paid.on, amount: $(f.hazard_paid.amount) } : null,
    escrow_refund: f.refund ? { on: f.refund.on, amount: $(f.refund.amount) } : null,
    late_charge: f.late_charge
      ? {
          due: f.late_charge.due,
          assessed_on: f.late_charge.assessed_on,
          amount: $(f.late_charge.amount),
          paid_on: f.late_charge.paid_on,
        }
      : null,
    form_1098: f.form_1098
      ? {
          year: f.form_1098.year,
          interest: $(f.form_1098.interest),
          taxes: $(f.form_1098.taxes),
          mailed_by: f.form_1098.mailed_by,
        }
      : null,
    mortgage_insurance: { active: f.mi.active, terminated_on: f.mi.terminated_on },
    transfer: f.transfer
      ? {
          on: f.transfer.on,
          shield_until: f.transfer.shield_until,
          first_due: f.transfer.first_due,
        }
      : null,
    payoff: f.payoff
      ? { on: f.payoff.on, escrow_refund: $(f.payoff.refund), refund_on: f.payoff.refund_on }
      : null,
    credit_reporting: f.credit ? { month: f.credit.month, days_delinquent: f.credit.days } : null,
    promises: loan.promises
      .filter((p) => p.made_on <= on && p.pay_by >= on)
      .map((p) => ({ made_on: p.made_on, amount: $(p.amount), pay_by: p.pay_by })),
    bankruptcy: f.bankruptcy
      ? {
          chapter: f.bankruptcy.chapter,
          petition_on: f.bankruptcy.petition_on,
          noticed_on: f.bankruptcy.noticed_on,
          case_last4: f.bankruptcy.case_last4,
          discharged_on: f.bankruptcy.discharged_on,
          attorney: f.bankruptcy.attorney,
          firm: f.bankruptcy.firm,
        }
      : null,
    authorization_on: f.authorization_on,
  };
}

/** A book a task was drawn from, rebuilt from its seed and scenario, with its contact center; the same pins on every loan. */
export interface Rebuilt {
  readonly book: LifeBook;
  readonly center: ContactCenter;
}

const CACHE_SIZE = 64;
const cache = new Map<string, Rebuilt>();

/**
 * The book and contact center a seed, a scenario and the center's pins give:
 * both at the typed default calibration, so a task never moves when the
 * calibration file or its reader does. Recently built ones are kept.
 */
export function rebuild(seed: string, scenario: Scenario, pins: ProfilePins): Rebuilt {
  const key = JSON.stringify([seed, scenario, pins]);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const calibration = defaultCalibration();
  const book = generate(seed, scenario, { calibration }).clean;
  const center = contactCenter(book, {
    calibration,
    pins: Object.fromEntries(book.loans.map((_, i) => [i, pins])),
  });
  const built = { book, center };
  cache.set(key, built);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return built;
}
