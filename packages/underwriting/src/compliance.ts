/**
 * The regulatory tests on screen 8.
 *
 * Four of these (UW-006, UW-008, APP-019, and the points-and-fees test behind
 * UW-007) carry a failure severity of "Regulatory violation" or "Financial
 * loss" in Drew's sheet. None of them may return a comfortable default when an
 * input is missing — a HOEPA test that answers "not high-cost" because it had
 * no APOR to compare against is worse than no test at all.
 */

import type { ComplianceTests, LoanFile } from "@hm/shared";
import { DerivationLog, round } from "./derive.js";
import { GUIDELINES, pointsAndFeesCap } from "./guidelines.js";

/**
 * Market inputs the flow does not collect from the borrower.
 *
 * APOR comes from the FFIEC's weekly table and the fee total comes from the
 * fee schedule behind the Loan Estimate. Both are absent in V1, which is why
 * they are an explicit optional input rather than a hidden assumption: the
 * tests that need them report blocked, and the decision screen says so.
 */
export interface MarketInputs {
  /** Average Prime Offer Rate for this product and lock date, in percent. */
  readonly apor?: number;
  /** Annual Percentage Rate for the loan as priced, in percent. */
  readonly apr?: number;
  /** Total points and fees in dollars, per the QM definition. */
  readonly pointsAndFeesAmount?: number;
}

export function runComplianceTests(
  file: LoanFile,
  market: MarketInputs,
  dtiBack: number | null,
  log: DerivationLog,
): ComplianceTests {
  const loanAmount = file.loan?.loanAmount ?? 0;

  /* ── ATR / QM (UW-006) ────────────────────────────────────────────────── */
  // ATR is "documented" only when income, assets and liabilities are all
  // verified and DTI actually computed. Anything less is undocumented.
  const atrInputsPresent =
    file.credit !== null && file.assets !== null && file.incomeSources.length > 0 && dtiBack !== null;
  const atrDetermination: ComplianceTests["atrDetermination"] = atrInputsPresent
    ? "documented"
    : "not_documented";
  log.record(
    "UW-006",
    "ATR determination",
    atrDetermination,
    "income, assets and liabilities verified and DTI computed",
    {
      credit_verified: file.credit !== null,
      assets_verified: file.assets !== null,
      income_verified: file.incomeSources.length > 0,
      dti_computed: dtiBack !== null,
    },
  );

  const qmStatus: ComplianceTests["qmStatus"] =
    dtiBack === null ? null : dtiBack <= GUIDELINES.ratios.maxDtiBack ? "qm" : "non_qm";
  if (qmStatus) {
    log.record("UW-006", "QM status", qmStatus, `back-end DTI vs ${GUIDELINES.ratios.maxDtiBack}%`, {
      dti_back: dtiBack,
    });
  }

  /* ── Points and fees (UW-007) ─────────────────────────────────────────── */
  let pointsAndFeesRatio: number | null = null;
  let pointsAndFeesPass: boolean | null = null;
  if (market.pointsAndFeesAmount === undefined || loanAmount === 0) {
    log.blocked("UW-007", "Points and fees test", ["fee schedule from the Loan Estimate"]);
  } else {
    const cap = pointsAndFeesCap(loanAmount);
    pointsAndFeesRatio = round((market.pointsAndFeesAmount / loanAmount) * 100);
    pointsAndFeesPass = pointsAndFeesRatio <= cap;
    log.record(
      "UW-007",
      "Points and fees",
      pointsAndFeesRatio,
      `points_and_fees / loan_amount vs the ${cap}% cap for this loan size`,
      { points_and_fees: market.pointsAndFeesAmount, loan_amount: loanAmount, cap_percent: cap },
    );
  }

  /* ── HPML (UW-008) ────────────────────────────────────────────────────── */
  let hpmlSpread: number | null = null;
  let isHpml: boolean | null = null;
  if (market.apr === undefined || market.apor === undefined) {
    log.blocked("UW-008", "HPML test", [
      market.apr === undefined ? "APR" : null,
      market.apor === undefined ? "APOR (FFIEC weekly table)" : null,
    ].filter((x): x is string => x !== null));
  } else {
    hpmlSpread = round(market.apr - market.apor);
    const threshold =
      loanAmount > GUIDELINES.hpml.conformingLoanLimit
        ? GUIDELINES.hpml.firstLienJumboSpread
        : GUIDELINES.hpml.firstLienSpread;
    isHpml = hpmlSpread > threshold;
    log.record("UW-008", "HPML spread", hpmlSpread, `apr - apor vs the ${threshold} first-lien threshold`, {
      apr: market.apr,
      apor: market.apor,
      threshold,
      jumbo: loanAmount > GUIDELINES.hpml.conformingLoanLimit,
    });
  }

  /* ── HOEPA (UW-009) ───────────────────────────────────────────────────── */
  let isHighCost: boolean | null = null;
  if (hpmlSpread === null && pointsAndFeesRatio === null) {
    log.blocked("UW-009", "HOEPA high-cost test", ["APR/APOR", "fee schedule"]);
  } else {
    const aprTrigger = hpmlSpread !== null && hpmlSpread > GUIDELINES.hoepa.firstLienAprSpread;
    const feeTrigger =
      pointsAndFeesRatio !== null && pointsAndFeesRatio > GUIDELINES.hoepa.pointsAndFeesPercent;
    isHighCost = aprTrigger || feeTrigger;
    log.record("UW-009", "HOEPA high-cost", isHighCost, "APR spread OR points-and-fees trigger", {
      apr_spread: hpmlSpread,
      apr_trigger_threshold: GUIDELINES.hoepa.firstLienAprSpread,
      points_and_fees_percent: pointsAndFeesRatio,
      fee_trigger_threshold: GUIDELINES.hoepa.pointsAndFeesPercent,
    });
  }

  /* ── Net tangible benefit (APP-019) ───────────────────────────────────── */
  let netTangibleBenefit: ComplianceTests["netTangibleBenefit"];
  const existing = file.loan?.existingLoan;
  if (file.loan && file.loan.purpose !== "purchase" && existing && file.product) {
    const newPayment = estimateNewPayment(file.loan.loanAmount, file.product.noteRate, file.product.termMonths);
    const paymentDelta = round(existing.monthlyPayment - newPayment);
    const rateDelta = round(existing.rate - file.product.noteRate);
    // Recoup is closing cost divided by monthly saving. Without a fee total we
    // cannot compute it, so it reports as unattainable rather than as zero.
    const fees = market.pointsAndFeesAmount;
    if (fees === undefined) {
      log.blocked("APP-019", "Net tangible benefit", ["closing cost total"]);
    } else if (paymentDelta <= 0) {
      netTangibleBenefit = {
        paymentDelta,
        rateDelta,
        recoupMonths: Number.POSITIVE_INFINITY,
        thresholdMonths: GUIDELINES.netTangibleBenefit.defaultRecoupMonths,
        satisfied: false,
      };
      log.record("APP-019", "Net tangible benefit", false, "new payment is not lower than the old", {
        old_payment: existing.monthlyPayment,
        new_payment: round(newPayment),
      });
    } else {
      const recoupMonths = round(fees / paymentDelta, 1);
      const thresholdMonths = GUIDELINES.netTangibleBenefit.defaultRecoupMonths;
      netTangibleBenefit = {
        paymentDelta,
        rateDelta,
        recoupMonths,
        thresholdMonths,
        satisfied: recoupMonths <= thresholdMonths,
      };
      log.record(
        "APP-019",
        "Net tangible benefit",
        recoupMonths,
        `closing_costs / monthly_saving vs a ${thresholdMonths}-month threshold`,
        { closing_costs: fees, monthly_saving: paymentDelta, rate_delta: rateDelta },
      );
    }
  }

  return {
    atrDetermination,
    qmStatus,
    qmType: qmStatus === "qm" ? "general" : undefined,
    pointsAndFeesRatio,
    pointsAndFeesPass,
    hpmlSpread,
    isHpml,
    isHighCost,
    netTangibleBenefit,
  };
}

function estimateNewPayment(amount: number, annualRate: number, termMonths: number): number {
  const r = annualRate / 100 / 12;
  if (r === 0) return amount / termMonths;
  return (amount * r) / (1 - Math.pow(1 + r, -termMonths));
}
