/**
 * The record on a date: every figure an agent may say on a call or write in
 * a note that day, read from the loan's history as the life generator wrote
 * it (everything dated on or before the day) and from the contact center's
 * own records (the promise a call writes, the bankruptcy notice it holds).
 *
 * The facts come first and the text second, so a number in a transcript is
 * one of these or it is a defect: `check.ts` reads every number back out of
 * the text and looks it up in `factNumbers(facts)`.
 *
 * Two figures are sums the servicing app's tables would hold and the
 * history keeps as rows: the interest a Form 1098 reports is the interest
 * the receipts posted in the year (`tax_forms_1098`), and the amount past
 * due is the installments due and unpaid plus the late charges outstanding,
 * as a statement shows it.
 */

import {
  addDays,
  addMonths,
  daysBetween,
  parts,
  startOfMonth,
  type PlainDate,
} from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import { project } from "../escrow/ported/analysis.js";
import { statementReading } from "../escrow/statement.js";
import { analysisDecision, statementYearOf } from "../life/escrow-year.js";
import type { AnalysisRow, LoanLife, Servicer } from "../life/simulate.js";
import type { BankruptcyCase, ContactProfile } from "./types.js";

/**
 * The servicer's own figures, said on calls: invented, and the same on every
 * loan. The telephone number is in the 555-01xx block, which is set aside for
 * fiction and reaches nobody.
 */
export const SERVICER = {
  name: "Supermortgage",
  phone: "1-800-555-0187",
  hours_open: 8,
  hours_close: 9,
  /**
   * §1024.33(c)(1): during the 60-day period beginning on the transfer's effective date, a payment the prior servicer
   * receives on time is not late. The transfer date is its first day (spec §2.7, example L: effective 2026-09-01,
   * window through 2026-10-30), as the life generator reads it (`TRANSFER_WINDOW_DAYS`).
   */
  transfer_shield_days: 60,
  /** Regulation Z §1026.36(c)(3): a payoff statement within 7 business days. */
  payoff_statement_business_days: 7,
  /** Metro 2 reports a payment 30 or more days past due as late. */
  credit_report_days: 30,
  /** Homeowners Protection Act: a borrower may ask to cancel at 80 %; it ends on its own at 78 %. */
  mi_request_ltv_pct: 80,
  mi_auto_ltv_pct: 78,
  /** A shortage is spread over 12 months unless the borrower pays it. */
  shortage_spread_months: 12,
  /** §1024.35(d), §1024.36(c): a written acknowledgment within 5 business days. */
  qwr_ack_business_days: 5,
  /** §1024.35(e), §1024.36(d): a response within 30 business days. */
  qwr_response_business_days: 30,
  /** How long a password-reset link lasts. */
  reset_link_minutes: 15,
  /** The form the year's mortgage interest is reported on, said by its number. */
  form_number: 1098,
} as const;

/** The servicer before a transfer: an invented name, and a number in the same fictional block. */
export const PRIOR_SERVICER = { name: "Bramblewood Servicing", phone: "1-800-555-0142" } as const;

/** What the annual statement prints for each escrow line (ours: the servicing app's statement takes its labels from its caller). */
export const STATEMENT_LABELS: Readonly<Record<string, string>> = {
  tax_county: "county tax",
  tax_school: "school tax",
  hazard: "homeowners insurance",
  flood: "flood insurance",
  mi_borrower_paid: "mortgage insurance",
  refund: "surplus refund",
};
const LINE_OF_LABEL = new Map(Object.entries(STATEMENT_LABELS).map(([k, v]) => [v, k]));

export interface PartyFacts {
  readonly role: "borrower" | "co_borrower";
  readonly given: string;
  readonly surname: string;
  readonly dob: PlainDate;
  readonly ssn_last4: string;
}

export interface RecordFacts {
  readonly on: PlainDate;
  readonly servicer: Servicer;
  readonly loan_number: string;
  readonly loan_last4: string;
  readonly parties: readonly PartyFacts[];
  readonly property: {
    readonly street: string;
    readonly street_number: string;
    readonly city: string;
    readonly state: string;
    readonly zip: string;
  };
  readonly phones_last4: readonly string[];
  readonly escrowed: boolean;
  readonly rate_pct: string;
  readonly upb: Cents;
  readonly grace_days: number;
  readonly late_pct: string;
  /** The earliest installment not yet paid, with the day its grace ends; null when the loan has none left. */
  readonly next: {
    readonly due: PlainDate;
    readonly amount: Cents;
    readonly pi: Cents;
    readonly escrow: Cents;
    readonly grace_end: PlainDate;
  } | null;
  readonly past_due: {
    readonly oldest_due: PlainDate;
    readonly installments: number;
    readonly days: number;
    readonly installment_total: Cents;
    readonly late_charges: Cents;
    readonly total: Cents;
  } | null;
  readonly last_payment: {
    readonly id: string;
    readonly on: PlainDate;
    readonly amount: Cents;
    readonly applied_to: PlainDate | null;
    readonly to_suspense: Cents;
    readonly curtailment: Cents;
    readonly forwarded: boolean;
  } | null;
  /** The escrow balance at the last month-end, as the statement showed it. */
  readonly escrow_statement: { readonly as_of: PlainDate; readonly balance: Cents } | null;
  readonly analysis: {
    readonly as_of: PlainDate;
    readonly sent_on: PlainDate;
    readonly effective: PlainDate;
    readonly decision: string;
    readonly shortage: Cents | null;
    readonly surplus: Cents | null;
    readonly old_escrow: Cents;
    readonly new_escrow: Cents;
    readonly first_month_escrow: Cents;
    readonly old_total: Cents;
    readonly new_total: Cents;
    /** Taxes and the premium disbursed in the twelve months before the analysis, and in the twelve before those. */
    readonly tax_12m: Cents;
    readonly tax_prior_12m: Cents;
    readonly hazard_12m: Cents;
    readonly hazard_prior_12m: Cents;
    /**
     * How the shortage, deficiency or surplus is handled, the decision decided again by the escrow port
     * (`analysisDecision`): a shortage's and a deficiency's level installments over their months from the effective
     * date, a refund's date, a credit's monthly amount. The statement's items (vi) and (vii) say these.
     */
    readonly plan: {
      readonly months: number | null;
      readonly shortage_installment: Cents | null;
      readonly deficiency: Cents | null;
      readonly deficiency_installment: Cents | null;
      readonly refund_by: PlainDate | null;
      readonly credit_monthly: Cents | null;
    };
  } | null;
  /**
   * The annual escrow statement mailed with that analysis, when one was (`statementYearOf`): its item (viii), each
   * bill that came in other than last year's projection and the low balance against the projected low, as the
   * servicing app's engine writes them (`statementReading`). Null with no analysis, or when no statement explains a
   * year (the first analysis, a borrower more than 30 days behind at it, a year on two servicers' books).
   */
  readonly statement: {
    /** The computation year it explains, first and last day. */
    readonly year_start: PlainDate;
    readonly year_end: PlainDate;
    /** The analysis's run date: the year is the history through it, and the analysis's own assumptions after it. */
    readonly through: PlainDate;
    readonly lines: readonly StatementLineFacts[];
    /** The low-point line, or null when the low was the projected one or the engine cannot print it. */
    readonly low: {
      readonly actual: Cents;
      readonly projected: Cents;
      /** The projected low is the cushion, as it is unless the trial balance never falls to zero in the year. */
      readonly is_cushion: boolean;
      readonly text: string;
    } | null;
    /** escrow-4: the account was overdrawn during the year, so the engine's low-point line is left out. */
    readonly overdrawn: boolean;
  } | null;
  readonly arm: {
    readonly change: PlainDate;
    readonly first_new_payment: PlainDate;
    readonly prior_rate: string;
    readonly new_rate: string;
    readonly old_pi: Cents;
    readonly new_pi: Cents;
    readonly notice_on: PlainDate;
  } | null;
  readonly tax_paid: { readonly on: PlainDate; readonly amount: Cents } | null;
  readonly hazard_paid: { readonly on: PlainDate; readonly amount: Cents } | null;
  readonly refund: { readonly on: PlainDate; readonly amount: Cents } | null;
  readonly late_charge: {
    readonly due: PlainDate;
    readonly assessed_on: PlainDate;
    readonly amount: Cents;
    readonly paid_on: PlainDate | null;
  } | null;
  readonly form_1098: {
    readonly year: number;
    readonly interest: Cents;
    readonly taxes: Cents;
    readonly mailed_by: PlainDate;
  } | null;
  readonly mi: { readonly active: boolean; readonly terminated_on: PlainDate | null };
  readonly transfer: {
    readonly on: PlainDate;
    /** The last day of §1024.33(c)(1)'s 60, the transfer date being the first: the transfer date + 59. */
    readonly shield_until: PlainDate;
    readonly first_due: PlainDate | null;
  } | null;
  readonly payoff: {
    readonly on: PlainDate;
    readonly refund: Cents;
    readonly refund_on: PlainDate | null;
  } | null;
  /** The last month furnished to the credit bureaus: its Metro 2 account status and the days delinquent behind it. */
  readonly credit: {
    readonly month: string;
    readonly status: string;
    readonly days: number;
  } | null;
  /** The promise this contact records, when it records one. */
  readonly promise: { readonly amount: Cents; readonly pay_by: PlainDate } | null;
  readonly bankruptcy: {
    readonly chapter: 7 | 13;
    readonly petition_on: PlainDate;
    readonly noticed_on: PlainDate;
    readonly case_last4: string;
    readonly discharged_on: PlainDate | null;
    readonly attorney: string;
    readonly firm: string;
  } | null;
  /** A third party's authorization on file, by the day it was received. */
  readonly authorization_on: PlainDate | null;
}

/** One of the statement's bill lines, as the engine wrote it. */
export interface StatementLineFacts {
  readonly kind: "not_projected" | "differs";
  /** The first of the month the line names. */
  readonly month: PlainDate;
  /** The escrow line it is, and the label the statement prints. */
  readonly line_type: string;
  readonly label: string;
  readonly actual: Cents;
  readonly projected: Cents | null;
  /** The month runs past the run date: the statement shows what the analysis expected to pay. */
  readonly anticipated: boolean;
  /** The engine's own sentence. */
  readonly text: string;
}

export interface RecordContext {
  readonly profile: ContactProfile;
  readonly bankruptcy: BankruptcyCase | null;
  readonly promise?: { readonly amount: Cents; readonly pay_by: PlainDate } | null;
  readonly authorization_on?: PlainDate | null;
}

const last = <T>(xs: readonly T[], ok: (x: T) => boolean): T | null => {
  for (let i = xs.length - 1; i >= 0; i--) if (ok(xs[i]!)) return xs[i]!;
  return null;
};
const sum = (xs: Iterable<Cents>): Cents => {
  let s = 0n;
  for (const x of xs) s += x;
  return s;
};

/** The P&I of the installment due on `due`: the latest ARM change in effect by then, or the note's. */
export function piOn(life: LoanLife, due: PlainDate): Cents {
  const c = last(life.arm_changes, (a) => a.first_new_payment <= due);
  return c ? c.new_pi : life.draw.initial_pi_cents;
}

const planOf = (a: AnalysisRow): NonNullable<RecordFacts["analysis"]>["plan"] => {
  const d = analysisDecision(a);
  return {
    months: d.kind === "shortage" ? d.months : null,
    shortage_installment: d.kind === "shortage" ? d.installment_cents : null,
    deficiency: d.kind === "shortage" && d.deficiency_cents > 0n ? d.deficiency_cents : null,
    deficiency_installment:
      d.kind === "shortage" && d.deficiency_cents > 0n ? d.deficiency_installment_cents : null,
    refund_by: d.kind === "refund" ? d.due_on : null,
    credit_monthly: d.kind === "credit" ? d.credit_monthly_cents : null,
  };
};

const statements = new WeakMap<AnalysisRow, RecordFacts["statement"]>();

/** The statement mailed with an analysis, as the record holds it: read once per analysis row. */
function statementOf(life: LoanLife, a: AnalysisRow): RecordFacts["statement"] {
  if (statements.has(a)) return statements.get(a)!;
  const y = statementYearOf(life, a);
  let out: RecordFacts["statement"] = null;
  if (y) {
    const reading = statementReading(y.analysis, y.ledger, STATEMENT_LABELS);
    const lastMonth = startOfMonth(y.through);
    const lines = reading.bills.map((b): StatementLineFacts => {
      const line_type = LINE_OF_LABEL.get(b.label) ?? b.label;
      const assumed = y.assumed.disbursements.some(
        (d) => d.line_type === line_type && startOfMonth(d.on) === b.month,
      );
      return {
        kind: b.kind,
        month: b.month,
        line_type,
        label: b.label,
        actual: b.actual_cents,
        projected: b.projected_cents,
        anticipated: b.month > lastMonth || assumed,
        text: b.text,
      };
    });
    // The cushion, from the projection's own bills on the life generator's policy (two months, simulate.ts), when
    // re-projecting them gives the projection's targets.
    const again = project(y.analysis.projection.items, y.analysis.year_start, {
      policy_months: 2,
      instrument_months: null,
      state_max_months: null,
    });
    const same = again.targets.every((t, k) => t === y.analysis.projection.targets[k]);
    out = {
      year_start: y.analysis.year_start,
      year_end: addDays(addMonths(y.analysis.year_start, 12), -1),
      through: y.through,
      lines,
      low: reading.low
        ? {
            actual: reading.low.actual_cents,
            projected: reading.low.projected_cents,
            is_cushion: same && reading.low.projected_cents === again.cushion_cents,
            text: reading.low.text,
          }
        : null,
      overdrawn: reading.refused.length > 0,
    };
  }
  statements.set(a, out);
  return out;
}

/** Whether an installment was paid by the end of `on`. */
const paidBy = (i: { satisfied_on: PlainDate | null }, on: PlainDate) =>
  i.satisfied_on !== null && i.satisfied_on <= on;

/** The servicer whose books the loan was on that day. */
export const servicerOn = (life: LoanLife, on: PlainDate): Servicer =>
  life.transfer_in_on !== null && on < life.transfer_in_on ? "prior" : "us";

export function recordOn(life: LoanLife, on: PlainDate, ctx: RecordContext): RecordFacts {
  const d = life.draw;
  const servicer = servicerOn(life, on);
  const loanNumber = servicer === "prior" ? d.prior_servicer_loan_number : d.servicer_loan_number;
  const terms =
    servicer === "us"
      ? life.boarded.terms
      : {
          late_charge_pct: d.late_charge.pct,
          late_charge_grace_days: d.late_charge.grace_days,
        };
  const grace = terms.late_charge_grace_days;

  // An installment exists in the record once it is projected, about a month ahead of its due date.
  const horizon = addDays(on, 31);
  const known = life.installments.filter((i) => i.due <= horizon);
  const unpaid = known.filter((i) => !paidBy(i, on));
  const ahead = life.installments.find((i) => i.due > horizon && !paidBy(i, on));
  const nx = unpaid[0] ?? (ahead && ahead.due <= addDays(on, 62) ? ahead : undefined);
  const ended =
    (life.payoff && life.payoff.on <= on) || (life.transfer_out_on && life.transfer_out_on <= on);
  const next =
    nx && !ended
      ? {
          due: nx.due,
          amount: nx.pi + nx.escrow,
          pi: nx.pi,
          escrow: nx.escrow,
          grace_end: addDays(nx.due, grace),
        }
      : null;

  const late = life.fees.filter(
    (f) => f.assessed_on <= on && f.state !== "waived" && f.state !== "accrued_suspended",
  );
  const lateOutstanding = sum(
    late.map((f) =>
      f.collected_on !== null && f.collected_on <= on ? f.amount - f.collected : f.amount,
    ),
  );
  const behind = unpaid.filter((i) => i.due < on);
  const pastDue =
    behind.length && !ended
      ? (() => {
          const inst = sum(behind.map((i) => i.pi + i.escrow));
          const lc = lateOutstanding > 0n ? lateOutstanding : 0n;
          return {
            oldest_due: behind[0]!.due,
            installments: behind.length,
            days: daysBetween(behind[0]!.due, on),
            installment_total: inst,
            late_charges: lc,
            total: inst + lc,
          };
        })()
      : null;

  const lr = last(life.receipts, (r) => r.on <= on && r.mode !== "payoff");
  const lastPayment = lr
    ? {
        id: lr.id,
        on: lr.on,
        amount: lr.amount,
        applied_to: lr.installments[0]?.due ?? null,
        to_suspense: lr.to_suspense,
        curtailment: lr.curtailment,
        forwarded: lr.channel === "transferor_forward",
      }
    : null;
  const upbRow = last(life.receipts, (r) => r.on <= on);
  const upb = upbRow ? upbRow.upb_after : d.orig_upb_cents;

  const arm = last(life.arm_changes, (a) => a.change <= on);
  const rate = arm ? arm.new_rate_pct : d.note_rate_pct;

  const stmt = d.escrowed ? last(life.months, (m) => m.as_of < on) : null;

  const window12 = (from: PlainDate, to: PlainDate, pred: (line: string) => boolean) =>
    sum(
      life.disbursements
        .filter((x) => x.kind === "bill" && pred(x.line) && x.on >= from && x.on < to)
        .map((x) => x.amount),
    );
  const isTax = (l: string) => l.startsWith("tax");
  const isHaz = (l: string) => l === "hazard";
  const an = last(life.analyses, (a) => a.sent_on <= on && a.sent_on >= addDays(on, -400));
  const analysis = an
    ? {
        as_of: an.as_of,
        sent_on: an.sent_on,
        effective: an.effective,
        decision: an.decision,
        shortage: an.shortage,
        surplus: an.surplus,
        old_escrow: an.old_payment,
        new_escrow: an.new_payment,
        first_month_escrow: an.first_month_payment,
        old_total: piOn(life, addMonths(an.effective, -1)) + an.old_payment,
        new_total: piOn(life, an.effective) + an.first_month_payment,
        tax_12m: window12(addMonths(an.as_of, -12), an.as_of, isTax),
        tax_prior_12m: window12(addMonths(an.as_of, -24), addMonths(an.as_of, -12), isTax),
        hazard_12m: window12(addMonths(an.as_of, -12), an.as_of, isHaz),
        hazard_prior_12m: window12(addMonths(an.as_of, -24), addMonths(an.as_of, -12), isHaz),
        plan: planOf(an),
      }
    : null;
  const statement = an ? statementOf(life, an) : null;

  const ac = last(
    life.arm_changes,
    (a) => a.notice_sent_on <= on && a.notice_sent_on >= addDays(on, -400),
  );
  const armFacts = ac
    ? {
        change: ac.change,
        first_new_payment: ac.first_new_payment,
        prior_rate: ac.prior_rate_pct,
        new_rate: ac.new_rate_pct,
        old_pi: piOn(life, addMonths(ac.first_new_payment, -1)),
        new_pi: ac.new_pi,
        notice_on: ac.notice_sent_on,
      }
    : null;

  const tax = last(life.disbursements, (x) => x.kind === "bill" && isTax(x.line) && x.on <= on);
  const haz = last(life.disbursements, (x) => x.kind === "bill" && isHaz(x.line) && x.on <= on);
  const ref = last(
    life.disbursements,
    (x) => x.kind === "refund" && x.on <= on && x.on >= addDays(on, -120),
  );

  const fee = last(life.fees, (f) => f.assessed_on <= on && f.assessed_on >= addDays(on, -75));
  const feeInst = fee ? life.installments.find((i) => i.due === fee.due) : undefined;
  const lateCharge = fee
    ? {
        due: fee.due,
        assessed_on: fee.assessed_on,
        amount: fee.amount,
        paid_on: feeInst && paidBy(feeInst, on) ? feeInst.satisfied_on : null,
      }
    : null;

  const p = parts(on);
  let form1098: RecordFacts["form_1098"] = null;
  if (p.m <= 4) {
    const y = p.y - 1;
    const inYear = (x: PlainDate) => parts(x).y === y && servicerOn(life, x) === servicer;
    let interest = 0n;
    for (const r of life.receipts)
      if (inYear(r.on)) for (const x of r.installments) interest += x.interest;
    if (life.payoff && inYear(life.payoff.on)) interest += life.payoff.interest;
    const taxes = sum(
      life.disbursements
        .filter((x) => x.kind === "bill" && isTax(x.line) && inYear(x.on))
        .map((x) => x.amount),
    );
    if (interest > 0n)
      form1098 = { year: y, interest, taxes, mailed_by: `${p.y}-01-31` as PlainDate };
  }

  const term = last(
    life.pmi,
    (x) => x.status === "terminated" && x.effective_on !== null && x.effective_on <= on,
  );
  const mi = {
    active: d.mi !== null && !term && !ended,
    terminated_on: term?.effective_on ?? null,
  };

  const tin = life.transfer_in_on;
  const transfer =
    tin && tin <= on && on <= addDays(tin, 150)
      ? {
          on: tin,
          // The last day of the 60, the transfer date being the first.
          shield_until: addDays(tin, SERVICER.transfer_shield_days - 1),
          first_due: life.installments.find((i) => i.due >= tin)?.due ?? null,
        }
      : null;

  const po = life.payoff && life.payoff.on <= on ? life.payoff : null;
  const poRefund = po ? life.disbursements.find((x) => x.kind === "payoff_refund") : undefined;
  const payoff = po
    ? {
        on: po.on,
        refund: po.escrow_refund,
        refund_on: poRefund && poRefund.on <= on ? poRefund.on : null,
      }
    : null;

  const cm = last(life.months, (m) => m.as_of < on);
  const credit = cm
    ? { month: cm.month, status: cm.metro2.account_status, days: cm.days_delinquent }
    : null;

  // The case as the servicer holds it: from the attorney's notice, while the servicer whose books the loan is on knows
  // of it (a boarding that dropped it, D-37, knows of none from the transfer).
  const held = ctx.bankruptcy;
  const bk =
    held && held.noticed_on <= on && (held.known_until === undefined || on <= held.known_until)
      ? held
      : null;
  const firstNumber = /^\d+/.exec(d.property.street)?.[0] ?? "";

  return {
    on,
    servicer,
    loan_number: loanNumber,
    loan_last4: loanNumber.slice(-4),
    parties: d.parties.map((x, i) => ({
      role: i === 0 ? "borrower" : "co_borrower",
      given: x.given_name,
      surname: x.surname,
      dob: x.date_of_birth,
      ssn_last4: ctx.profile.ssn_last4[i] ?? "0000",
    })),
    property: {
      street: d.property.street,
      street_number: firstNumber,
      city: d.property.city,
      state: d.property.state,
      zip: d.property.zip,
    },
    phones_last4: ctx.profile.phones.map((x) => x.last4),
    escrowed: d.escrowed,
    rate_pct: rate,
    upb,
    grace_days: grace,
    late_pct: terms.late_charge_pct,
    next,
    past_due: pastDue,
    last_payment: lastPayment,
    escrow_statement: stmt ? { as_of: stmt.as_of, balance: stmt.escrow_balance } : null,
    analysis,
    statement,
    arm: armFacts,
    tax_paid: tax ? { on: tax.on, amount: tax.amount } : null,
    hazard_paid: haz ? { on: haz.on, amount: haz.amount } : null,
    refund: ref ? { on: ref.on, amount: ref.amount } : null,
    late_charge: lateCharge,
    form_1098: form1098,
    mi,
    transfer,
    payoff,
    credit,
    promise: ctx.promise ?? null,
    bankruptcy: bk
      ? {
          chapter: bk.chapter,
          petition_on: bk.petition_on,
          noticed_on: bk.noticed_on,
          case_last4: bk.case_last4,
          discharged_on: bk.discharged_on && bk.discharged_on <= on ? bk.discharged_on : null,
          attorney: bk.attorney,
          firm: bk.firm,
        }
      : null,
    authorization_on: ctx.authorization_on ?? null,
  };
}

/** Every number the record holds that day, by kind, the way `check.ts` reads them out of text. */
export interface FactNumbers {
  readonly money: ReadonlySet<string>;
  readonly dates: ReadonlySet<PlainDate>;
  readonly ints: ReadonlySet<number>;
  readonly pcts: ReadonlySet<string>;
  readonly phones: ReadonlySet<string>;
}

export const pctKey = (p: string | number): string => String(Number(p));

export function factNumbers(f: RecordFacts): FactNumbers {
  const money = new Set<string>();
  const dates = new Set<PlainDate>();
  const ints = new Set<number>();
  const pcts = new Set<string>();
  const m = (c: Cents | null | undefined) => {
    // An amount is said without its sign ("overdrawn by $137.39"), so the record holds each by its size.
    if (c !== null && c !== undefined) money.add((c < 0n ? -c : c).toString());
  };
  const dt = (x: PlainDate | null | undefined) => {
    if (x) dates.add(x);
  };
  const n = (x: number | string | null | undefined) => {
    if (x === null || x === undefined || x === "") return;
    const v = Number(x);
    if (Number.isFinite(v)) ints.add(v);
  };
  dt(f.on);
  n(parts(f.on).y);
  n(f.loan_number);
  n(f.loan_last4);
  for (const p of f.parties) {
    dt(p.dob);
    n(p.ssn_last4);
  }
  n(f.property.street_number);
  n(f.property.zip);
  for (const x of f.phones_last4) n(x);
  pcts.add(pctKey(f.rate_pct));
  pcts.add(pctKey(f.late_pct));
  m(f.upb);
  n(f.grace_days);
  if (f.next) {
    dt(f.next.due);
    dt(f.next.grace_end);
    m(f.next.amount);
    m(f.next.pi);
    m(f.next.escrow);
  }
  if (f.past_due) {
    dt(f.past_due.oldest_due);
    n(f.past_due.installments);
    n(f.past_due.days);
    m(f.past_due.installment_total);
    m(f.past_due.late_charges);
    m(f.past_due.total);
  }
  if (f.last_payment) {
    dt(f.last_payment.on);
    dt(f.last_payment.applied_to);
    m(f.last_payment.amount);
    m(f.last_payment.to_suspense);
    m(f.last_payment.curtailment);
  }
  if (f.escrow_statement) {
    dt(f.escrow_statement.as_of);
    m(f.escrow_statement.balance);
  }
  if (f.analysis) {
    const a = f.analysis;
    for (const x of [a.as_of, a.sent_on, a.effective]) dt(x);
    for (const x of [
      a.shortage,
      a.surplus,
      a.old_escrow,
      a.new_escrow,
      a.first_month_escrow,
      a.old_total,
      a.new_total,
      a.tax_12m,
      a.tax_prior_12m,
      a.hazard_12m,
      a.hazard_prior_12m,
      a.plan.shortage_installment,
      a.plan.deficiency,
      a.plan.deficiency_installment,
      a.plan.credit_monthly,
    ])
      m(x);
    n(a.plan.months);
    dt(a.plan.refund_by);
  }
  if (f.statement) {
    const s = f.statement;
    dt(s.year_start);
    dt(s.year_end);
    // A line's month is said with its year ("in January 2030"), which reads as the year alone.
    for (const l of s.lines) {
      dt(l.month);
      n(parts(l.month).y);
      m(l.actual);
      m(l.projected);
    }
    if (s.low) {
      m(s.low.actual);
      m(s.low.projected);
    }
  }
  if (f.arm) {
    for (const x of [f.arm.change, f.arm.first_new_payment, f.arm.notice_on]) dt(x);
    pcts.add(pctKey(f.arm.prior_rate));
    pcts.add(pctKey(f.arm.new_rate));
    m(f.arm.old_pi);
    m(f.arm.new_pi);
  }
  for (const x of [f.tax_paid, f.hazard_paid, f.refund])
    if (x) {
      dt(x.on);
      m(x.amount);
    }
  if (f.late_charge) {
    dt(f.late_charge.due);
    dt(f.late_charge.assessed_on);
    dt(f.late_charge.paid_on);
    m(f.late_charge.amount);
  }
  if (f.form_1098) {
    n(f.form_1098.year);
    m(f.form_1098.interest);
    m(f.form_1098.taxes);
    dt(f.form_1098.mailed_by);
  }
  dt(f.mi.terminated_on);
  if (f.transfer) {
    dt(f.transfer.on);
    dt(f.transfer.shield_until);
    dt(f.transfer.first_due);
  }
  if (f.payoff) {
    dt(f.payoff.on);
    dt(f.payoff.refund_on);
    m(f.payoff.refund);
  }
  if (f.credit) n(f.credit.days);
  if (f.promise) {
    m(f.promise.amount);
    dt(f.promise.pay_by);
  }
  if (f.bankruptcy) {
    n(f.bankruptcy.chapter);
    dt(f.bankruptcy.petition_on);
    dt(f.bankruptcy.noticed_on);
    dt(f.bankruptcy.discharged_on);
    n(f.bankruptcy.case_last4);
  }
  dt(f.authorization_on);
  // The servicer's own figures, said on every loan.
  for (const k of [
    "hours_open",
    "hours_close",
    "transfer_shield_days",
    "payoff_statement_business_days",
    "credit_report_days",
    "shortage_spread_months",
    "qwr_ack_business_days",
    "qwr_response_business_days",
    "reset_link_minutes",
    "form_number",
  ] as const)
    n(SERVICER[k]);
  pcts.add(pctKey(SERVICER.mi_request_ltv_pct));
  pcts.add(pctKey(SERVICER.mi_auto_ltv_pct));
  return {
    money,
    dates,
    ints,
    pcts,
    phones: new Set([f.servicer === "us" ? SERVICER.phone : PRIOR_SERVICER.phone]),
  };
}

/**
 * The numbers of every row the history dated `on`: what a system note written
 * that day may repeat (a second tax line disbursed the same morning, a
 * curtailment, a forwarded payment), beside the facts an agent reads.
 */
export function dayNumbers(life: LoanLife, on: PlainDate): FactNumbers {
  const money = new Set<string>();
  const dates = new Set<PlainDate>();
  const pcts = new Set<string>();
  const m = (c: Cents | null | undefined) => {
    if (c !== null && c !== undefined) money.add((c < 0n ? -c : c).toString());
  };
  const dt = (d: PlainDate | null | undefined) => {
    if (d) dates.add(d);
  };
  for (const r of life.receipts)
    if (r.on === on) {
      m(r.amount);
      m(r.to_suspense);
      m(r.curtailment);
      dt(r.credited_as_of);
    }
  for (const x of life.disbursements) if (x.on === on) m(x.amount);
  for (const f of life.fees)
    if (f.assessed_on === on) {
      m(f.amount);
      dt(f.due);
    }
  for (const a of life.analyses)
    if (a.as_of === on || a.sent_on === on) {
      for (const c of [a.shortage, a.surplus, a.new_payment, a.old_payment, a.first_month_payment])
        m(c);
      dt(a.effective);
    }
  for (const a of life.arm_changes)
    if (a.notice_sent_on === on) {
      m(a.new_pi);
      dt(a.first_new_payment);
      pcts.add(pctKey(a.new_rate_pct));
    }
  for (const x of life.pmi) if (x.on === on) dt(x.effective_on);
  if (life.payoff && life.payoff.on === on) m(life.payoff.funds);
  dt(on);
  return { money, dates, ints: new Set(), pcts, phones: new Set() };
}

/** Several sets of numbers as one. */
export function unionNumbers(...xs: readonly FactNumbers[]): FactNumbers {
  const u = <T>(f: (x: FactNumbers) => ReadonlySet<T>) => new Set<T>(xs.flatMap((x) => [...f(x)]));
  return {
    money: u((x) => x.money),
    dates: u((x) => x.dates),
    ints: u((x) => x.ints),
    pcts: u((x) => x.pcts),
    phones: u((x) => x.phones),
  };
}
