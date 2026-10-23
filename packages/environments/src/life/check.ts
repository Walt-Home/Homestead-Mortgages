/**
 * What a book shows beside what the calibration asked for.
 *
 * Some keys are drawn from directly (the escrow, ARM and MI shares, the
 * payment shares, the monthly roll and cure); the delinquency check and the
 * missed-month share are not drawn at all, because the roll rates make them:
 * they are what a book should come out near if the roll rates are right. This
 * reads both kinds off a book, over every month the book generated, the prior
 * servicer's included.
 *
 * The payment shares are measured as the calibration states them: over
 * installments on loans current at the due date (every earlier installment
 * credited before it), by when the installment was credited in full. An
 * installment credited by the first business day on or after its due date is
 * on time, so a due date on a weekend does not move a borrower who paid on it
 * into grace; by the end of grace it is within grace; after that and in the
 * month, late; and after the month, missed. A month the loan closed in is not
 * measured. The shares within grace and before the due day are read only on
 * due dates that are a business day following one: around a weekend or a
 * holiday, a payment drawn for the day before the due date, or the day after
 * it, rolls to the same business day as one drawn for the due date, and when
 * it arrived no longer says which it was.
 *
 * The roll and cure are drawn monthly, so they are read monthly: the share of
 * current loans' installments the borrower missed, and of a behind borrower's
 * monthly decisions, the share that cured. The file states them a quarter
 * apart, so they are also read the way its source counts them, from one
 * quarter's last month-end to the next, against what the monthly chain gives a
 * quarter later (`quarterAhead`). That reading is a check: a quarter-end also
 * finds a loan one payment behind that missed nothing, because the rest of a
 * partial payment had not arrived or a disaster month made a miss likelier.
 */

import { addDays, endOfMonth, rollForward, servicer, type PlainDate } from "@hm/kernel/calendar";
import { graceEnd } from "../payments/ported/latecharges.js";
import { quarterAhead, type Calibration, type CalibrationKey } from "./calibration.js";
import type { LifeBook } from "./generate.js";

export interface CheckRow {
  readonly key: CalibrationKey;
  /** What is measured, in a few words. A key read two ways has a row for each. */
  readonly measure: string;
  readonly target: number;
  readonly realized: number;
  /** "drawn" when the generator draws what is measured, "check" when the figure is only a target. */
  readonly use: "drawn" | "check";
}

/** When an installment on a loan current at its due date was credited in full. */
export type Arrival = "before_due" | "due_day" | "within_grace" | "after_grace" | "not_in_month";

export interface ArrivalRow {
  readonly loan: string;
  readonly due: PlainDate;
  readonly arrival: Arrival;
  /** The borrower's draw missed it (a `missed` behavior row), not merely paid it late or in pieces. */
  readonly missed: boolean;
  /** The due date is a business day and so is the day before: an arrival around it says when the borrower paid. */
  readonly clear: boolean;
}

/** Every installment on a loan current at its due date, in a month the loan was open through, with when it arrived. */
export function arrivals(book: LifeBook): ArrivalRow[] {
  const out: ArrivalRow[] = [];
  for (const l of book.loans) {
    const lastMonthEnd = l.months.at(-1)?.as_of ?? null;
    const closedOn = l.payoff?.on ?? l.transfer_out_on ?? null;
    const grace = l.boarded.terms.late_charge_grace_days;
    const missed = new Set(l.behavior.filter((b) => b.kind === "missed").map((b) => b.due));
    let current = true;
    let lastCredited: PlainDate | null = null;
    for (const i of l.installments) {
      const credited = i.credited_as_of ?? i.satisfied_on;
      const monthEnd = endOfMonth(i.due);
      const isCurrent = current && (lastCredited === null || lastCredited < i.due);
      const observed =
        lastMonthEnd !== null &&
        monthEnd <= lastMonthEnd &&
        (closedOn === null || monthEnd < closedOn);
      if (isCurrent && observed) {
        const arrival: Arrival =
          credited === null || credited > monthEnd
            ? "not_in_month"
            : credited < i.due
              ? "before_due"
              : credited <= rollForward(i.due, servicer)
                ? "due_day"
                : credited <= graceEnd(i.due, grace)
                  ? "within_grace"
                  : "after_grace";
        out.push({
          loan: l.loan_id,
          due: i.due,
          arrival,
          missed: missed.has(i.due),
          clear: servicer.isBusinessDay(i.due) && servicer.isBusinessDay(addDays(i.due, -1)),
        });
      }
      if (credited === null) current = false;
      else if (lastCredited === null || credited > lastCredited) lastCredited = credited;
    }
  }
  return out;
}

const QUARTER_ENDS = new Set(["03", "06", "09", "12"]);
const monthPlus = (month: string, n: number): string => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  return `${y + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}`;
};

export function calibrationCheck(book: LifeBook, cal: Calibration): CheckRow[] {
  const R = cal.rates;
  const loans = book.loans;
  const n = Math.max(1, loans.length);
  const arrived = arrivals(book);
  const currentDue = new Map<string, Set<PlainDate>>();
  for (const a of arrived) {
    let s = currentDue.get(a.loan);
    if (!s) currentDue.set(a.loan, (s = new Set()));
    s.add(a.due);
  }
  let months = 0;
  let pastDue = 0;
  let open = 0;
  let payments = 0;
  let partial = 0;
  let curtail = 0;
  let contacts = 0;
  let minutes = 0;
  let runs = 0;
  let charged = 0;
  let cures = 0;
  let behindDecisions = 0;
  const q = { current: 0, toLate: 0, behind: 0, toCurrent: 0 };
  const isOpen = (s: string) => s === "current" || s === "delinquent";
  const late = (s: string) => s === "30" || s === "60";
  for (const l of loans) {
    months += l.months.length;
    const byMonth = new Map(l.months.map((m) => [m.month, m]));
    for (const m of l.months) {
      if (!isOpen(m.status)) continue;
      open++;
      if (m.mba_status !== "current") pastDue++;
      if (!QUARTER_ENDS.has(m.month.slice(5, 7))) continue;
      const next = byMonth.get(monthPlus(m.month, 3));
      if (!next || !isOpen(next.status)) continue;
      if (m.mba_status === "current") {
        q.current++;
        if (late(next.mba_status)) q.toLate++;
      } else if (late(m.mba_status)) {
        q.behind++;
        if (next.mba_status === "current") q.toCurrent++;
      }
    }
    const borrower = l.receipts.filter((r) => r.mode !== "partial_rest" && r.mode !== "payoff");
    payments += borrower.length;
    partial += borrower.filter((r) => r.mode === "partial").length;
    curtail += borrower.filter((r) => r.mode === "curtail").length;
    // A borrower who is behind decides once a month: cure, pay the oldest installment, or miss again.
    const dues = currentDue.get(l.loan_id);
    const c = borrower.filter((r) => r.mode === "cure").length;
    cures += c;
    behindDecisions +=
      c +
      borrower.filter((r) => r.mode === "oldest").length +
      l.behavior.filter((b) => b.kind === "missed" && b.due !== null && !dues?.has(b.due)).length;
    for (const r of l.late_charge_runs) {
      if (!dues?.has(r.due)) continue;
      runs++;
      if (r.outcome === "assessed" || r.outcome === "accrued_suspended") charged++;
    }
    contacts += l.contacts.length;
    minutes += l.contacts.reduce((s, x) => s + x.minutes, 0);
  }
  const count = (k: Arrival, rows: readonly ArrivalRow[] = arrived) =>
    rows.filter((a) => a.arrival === k).length;
  const clear = arrived.filter((a) => a.clear);
  const before = count("before_due", clear);
  const onTime = before + count("due_day", clear);
  const per = (a: number, b: number) => (b > 0 ? a / b : 0);
  const D = R.delinquency;
  const quarter = quarterAhead(D.roll_current_to_30, D.cure_from_30, D.roll_30_to_60);
  return [
    {
      key: "delinquency.conventional_30plus_share",
      measure: "month-ends one payment or more past due",
      target: D.conventional_30plus_share,
      realized: per(pastDue, open),
      use: "check",
    },
    {
      key: "delinquency.roll_current_to_30",
      measure: "installments on current loans the borrower missed",
      target: D.roll_current_to_30,
      realized: per(arrived.filter((a) => a.missed).length, arrived.length),
      use: "drawn",
    },
    {
      key: "delinquency.cure_from_30",
      measure: "a behind borrower's monthly decisions that cured",
      target: D.cure_from_30,
      realized: per(cures, behindDecisions),
      use: "drawn",
    },
    {
      key: "delinquency.roll_current_to_30",
      measure: "loans current at a quarter's end that are 30 to 60 days late at the next",
      target: quarter.current_to_30_60,
      realized: per(q.toLate, q.current),
      use: "check",
    },
    {
      key: "delinquency.cure_from_30",
      measure: "loans 30 to 60 days late at a quarter's end that are current at the next",
      target: quarter.behind_to_current,
      realized: per(q.toCurrent, q.behind),
      use: "check",
    },
    {
      key: "payment.missed_month_share",
      measure: "installments on current loans not credited by month end",
      target: R.payment.missed_month_share,
      realized: per(count("not_in_month"), arrived.length),
      use: "check",
    },
    {
      key: "payment.late_within_grace_share",
      measure: "installments on current loans credited after the due day and within grace",
      target: R.payment.late_within_grace_share,
      realized: per(count("within_grace", clear), clear.length),
      use: "drawn",
    },
    {
      key: "payment.late_after_grace_share",
      measure: "installments on current loans charged a late fee",
      target: R.payment.late_after_grace_share,
      realized: per(charged, runs),
      use: "drawn",
    },
    {
      key: "payment.day_of_month",
      measure: "installments on current loans paid by the due day that were paid before it",
      target: R.payment.early_share,
      realized: per(before, onTime),
      use: "drawn",
    },
    {
      key: "payment.partial_share",
      measure: "borrower receipts short of the installment",
      target: R.payment.partial_share,
      realized: per(partial, payments),
      use: "drawn",
    },
    {
      key: "payment.curtailment_share",
      measure: "borrower receipts carrying extra principal",
      target: R.payment.curtailment_share,
      realized: per(curtail, payments),
      use: "drawn",
    },
    {
      key: "escrow.share_of_loans",
      measure: "loans with an escrow account",
      target: R.escrow.share_of_loans,
      realized: per(loans.filter((l) => l.draw.escrowed).length, n),
      use: "drawn",
    },
    {
      key: "arm.share_of_outstanding",
      measure: "adjustable-rate loans",
      target: R.arm.share_of_outstanding,
      realized: per(loans.filter((l) => l.draw.arm).length, n),
      use: "drawn",
    },
    {
      key: "mi.share_of_loans",
      measure: "loans drawn with mortgage insurance",
      target: R.mi.share_of_loans,
      realized: per(loans.filter((l) => l.draw.mi).length, n),
      use: "drawn",
    },
    {
      key: "contacts.per_loan_year",
      measure: "inbound contacts per loan-year",
      target: R.contacts.per_loan_year,
      realized: per(contacts, months / 12),
      use: "drawn",
    },
    {
      key: "contacts.handle_time_minutes",
      measure: "minutes per inbound contact",
      target: R.contacts.handle_time_minutes,
      realized: per(minutes, contacts),
      use: "drawn",
    },
  ];
}
