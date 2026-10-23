/**
 * What a book shows beside what the calibration asked for.
 *
 * Some keys are drawn from directly (the escrow, ARM and MI shares, the
 * payment shares); the delinquency check and the missed-month share are not
 * drawn at all, because the roll rates make them: they are what a book should
 * come out near if the roll rates are right. This reads both kinds off a book.
 * The figures are per loan-month, or per loan, over every month the book
 * generated, the prior servicer's included.
 */

import type { Calibration, CalibrationKey } from "./calibration.js";
import type { LifeBook } from "./generate.js";

export interface CheckRow {
  readonly key: CalibrationKey;
  readonly target: number;
  readonly realized: number;
  /** "drawn" when the generator draws from the key, "check" when the key is only a target. */
  readonly use: "drawn" | "check";
}

export function calibrationCheck(book: LifeBook, cal: Calibration): CheckRow[] {
  const R = cal.rates;
  const loans = book.loans;
  const n = Math.max(1, loans.length);
  let months = 0;
  let late30 = 0;
  let missed = 0;
  let payments = 0;
  let partial = 0;
  let curtail = 0;
  let runs = 0;
  let charged = 0;
  let contacts = 0;
  for (const l of loans) {
    months += l.months.length;
    late30 += l.months.filter((m) => m.days_delinquent >= 30).length;
    missed += l.behavior.filter((b) => b.kind === "missed").length;
    const borrower = l.receipts.filter((r) => r.mode !== "partial_rest" && r.mode !== "payoff");
    payments += borrower.length;
    partial += borrower.filter((r) => r.mode === "partial").length;
    curtail += borrower.filter((r) => r.mode === "curtail").length;
    runs += l.late_charge_runs.length;
    charged += l.late_charge_runs.filter(
      (r) => r.outcome === "assessed" || r.outcome === "accrued_suspended",
    ).length;
    contacts += l.contacts.length;
  }
  const per = (a: number, b: number) => (b > 0 ? a / b : 0);
  return [
    {
      key: "delinquency.conventional_30plus_share",
      target: R.delinquency.conventional_30plus_share,
      realized: per(late30, months),
      use: "check",
    },
    {
      key: "payment.missed_month_share",
      target: R.payment.missed_month_share,
      realized: per(missed, months),
      use: "check",
    },
    {
      key: "payment.late_after_grace_share",
      target: R.payment.late_after_grace_share,
      realized: per(charged, runs),
      use: "drawn",
    },
    {
      key: "payment.partial_share",
      target: R.payment.partial_share,
      realized: per(partial, payments),
      use: "drawn",
    },
    {
      key: "payment.curtailment_share",
      target: R.payment.curtailment_share,
      realized: per(curtail, payments),
      use: "drawn",
    },
    {
      key: "escrow.share_of_loans",
      target: R.escrow.share_of_loans,
      realized: per(loans.filter((l) => l.draw.escrowed).length, n),
      use: "drawn",
    },
    {
      key: "arm.share_of_outstanding",
      target: R.arm.share_of_outstanding,
      realized: per(loans.filter((l) => l.draw.arm).length, n),
      use: "drawn",
    },
    {
      key: "mi.share_of_loans",
      target: R.mi.share_of_loans,
      realized: per(loans.filter((l) => l.draw.mi).length, n),
      use: "drawn",
    },
    {
      key: "contacts.per_loan_year",
      target: R.contacts.per_loan_year,
      realized: per(contacts, months / 12),
      use: "drawn",
    },
  ];
}
