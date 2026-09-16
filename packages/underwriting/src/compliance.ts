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
import { generalQmSpreadCap, GUIDELINES, pointsAndFeesCap } from "./guidelines.js";

/**
 * The priced figures these tests are decided on, none of which a borrower
 * types.
 *
 * `resolveMarketInputs` derives all four — the APOR off the weekly table for
 * the week the rate was set, the APR by Appendix J, and the two fee totals off
 * the dated fee schedule — and each is optional because each of them can fail
 * to derive. A field that is absent here is a derivation that recorded
 * `blocked` with what it was waiting for, so the tests below report blocked and
 * the decision screen says so.
 *
 * The two fee totals are separate fields because they are different subsets of
 * one schedule and neither answers for the other: points and fees is what the
 * QM cap and the HOEPA fee trigger measure, and the closing cost total is what
 * a refinance recoups. Net tangible benefit used to divide the points-and-fees
 * figure by the monthly saving, which recouped about half of what the borrower
 * actually pays and let a refinance pass a test it fails.
 */
export interface MarketInputs {
  /** Average Prime Offer Rate for this product and the week the rate was set. */
  readonly apor?: number;
  /** Annual Percentage Rate for the loan as priced, in percent. */
  readonly apr?: number;
  /** Total points and fees in dollars, per §1026.32(b)(1). */
  readonly pointsAndFeesAmount?: number;
  /**
   * The §1026.32(b)(4) **total loan amount** the ratio above is measured
   * against, which is NOT the note amount.
   *
   * It is the amount financed less the financed charges §1026.32(b)(1)(iii)
   * and (iv) name — on this lender's schedule, the loan less its prepaid
   * finance charges, which is the same figure the Appendix J solve discounts
   * against. Dividing by the note amount instead understates the ratio by
   * exactly the share the fees are of the loan, and it understates it in the
   * permissive direction: a loan whose statutory ratio is over the cap reports
   * under it, the HOEPA fee trigger does not fire, and a high-cost mortgage is
   * approved with a stored decision asserting it passed.
   *
   * Absent, the ratio is blocked rather than computed against the wrong
   * denominator — a ratio is a pair of numbers, and only one of them is here.
   */
  readonly totalLoanAmount?: number;
  /** Everything the borrower pays at closing, per the fee schedule. */
  readonly closingCostTotal?: number;
}

/** A rate in whole thousandths of a percentage point, so bright lines compare as integers. */
const milli = (x: number): number => Math.round(x * 1000);

export function runComplianceTests(
  file: LoanFile,
  market: MarketInputs,
  dtiBack: number | null,
  log: DerivationLog,
): ComplianceTests {
  const loanAmount = file.loan?.loanAmount ?? 0;

  /**
   * Whether the two price rules reach this loan at all.
   *
   * §1026.32(a)(1) opens "a consumer credit transaction secured by the
   * consumer's principal dwelling", and §1026.35(a)(1) is worded the same way.
   * A second home is not a principal dwelling, and a loan made to buy an
   * investment property is business-purpose credit §1026.3(a)(1) exempts from
   * Regulation Z outright. Neither is high-cost and neither is higher-priced,
   * whatever the arithmetic says.
   *
   * Nothing here read occupancy before, and the arithmetic does not decline to
   * run on its own: this lender's flat fees are 5.8% of a $30,000 loan, so a
   * small second-home purchase fired the HOEPA fee trigger, and `determineOutcome`
   * turns one high-cost finding into a denial ahead of every other branch. That
   * is a borrower declined — and sent an adverse-action notice under Regulation
   * B naming the reason — on a legal determination the rule does not authorize
   * for that property. `decisions` is append-only, so it would stand.
   *
   * Out of scope is recorded rather than blocked. A blocked derivation means
   * "we could not compute this" and forces `refer`; this is the opposite — we
   * know the answer is that the test does not reach the loan. The verdicts stay
   * null because `ComplianceTests` has no way to say "not applicable", and the
   * derivation carries the reason.
   */
  const occupancy = file.property?.occupancy ?? null;
  const principalDwelling = occupancy === null ? null : occupancy === "primary_residence";

  /* ── ATR / QM (UW-006) ────────────────────────────────────────────────── */
  // ATR is "documented" only when income, assets and liabilities are all
  // verified and DTI actually computed. Anything less is undocumented.
  const atrInputsPresent =
    file.credit !== null &&
    file.assets !== null &&
    file.incomeSources.length > 0 &&
    dtiBack !== null;
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

  /**
   * General QM is a PRICE test, not a DTI test.
   *
   * The 43% DTI limit everyone remembers was replaced: since the CFPB's
   * General QM Final Rule took mandatory effect in October 2022, a first-lien
   * loan is General QM when its APR does not exceed APOR by more than the
   * threshold for its size. DTI must still be considered and documented — that
   * is what `atrDetermination` above is for — but it does not decide the
   * question.
   *
   * Deciding it from DTI produced a confidently wrong legal determination in
   * both directions, and without APR and APOR the honest answer is that we do
   * not know rather than a number derived from the wrong input.
   */
  let qmStatus: ComplianceTests["qmStatus"] = null;
  if (market.apr === undefined || market.apor === undefined) {
    log.blocked(
      "UW-006",
      "QM status",
      [
        market.apr === undefined ? "APR" : null,
        market.apor === undefined ? "APOR (FFIEC weekly table)" : null,
      ].filter((x): x is string => x !== null),
    );
  } else if (atrDetermination !== "documented") {
    // No ATR determination means no QM, whatever the price says.
    qmStatus = "non_qm";
    log.record("UW-006", "QM status", qmStatus, "ATR was not documented", {
      atr_determination: atrDetermination,
    });
  } else {
    const cap = generalQmSpreadCap(loanAmount);
    // Decided on the exact spread, recorded as the rounded one. §1026.43(e)(2)(vi)
    // disqualifies a loan whose APR exceeds APOR "by 2.25 or more percentage
    // points", so the loan is General QM only strictly BELOW the cap — and a
    // spread rounded to hundredths before the comparison lands 2.2501 on 2.25
    // and hands the §1026.43(e)(1) presumption of compliance to a loan outside
    // it. The rounding is for the screen; the test is not the screen.
    // In whole thousandths of a point. An APR carries three places and an
    // APOR two, so the spread is exact at three — and a raw double difference
    // is not: 8.28 - 6.78 is 1.4999999999999991, which a bright line stated
    // as 1.5 would miss.
    const exactMilli = milli(market.apr) - milli(market.apor);
    const spread = exactMilli / 1000;
    qmStatus = exactMilli < milli(cap) ? "qm" : "non_qm";
    log.record(
      "UW-006",
      "QM status",
      qmStatus,
      `General QM price test: apr - apor (${round(spread)}) below the ${cap} point threshold for this loan size`,
      {
        apr: market.apr,
        apor: market.apor,
        spread: round(spread),
        threshold: cap,
        dti_back_considered: dtiBack,
      },
    );
  }

  /* ── Points and fees (UW-007) ─────────────────────────────────────────── */
  let pointsAndFeesRatio: number | null = null;
  let pointsAndFeesPass: boolean | null = null;
  if (
    market.pointsAndFeesAmount === undefined ||
    market.totalLoanAmount === undefined ||
    market.totalLoanAmount <= 0 ||
    loanAmount === 0
  ) {
    log.blocked(
      "UW-007",
      "Points and fees test",
      [
        market.pointsAndFeesAmount === undefined ? "a priced fee schedule" : null,
        market.totalLoanAmount === undefined || market.totalLoanAmount <= 0
          ? "the §1026.32(b)(4) total loan amount this ratio is measured against"
          : null,
      ].filter((x): x is string => x !== null),
    );
  } else {
    // The cap tier is chosen by the total loan amount too: §1026.43(e)(3)(i)
    // and §1026.32(b)(4) use the same figure, so a loan near a tier boundary
    // must not be placed in one tier and measured in another.
    const cap = pointsAndFeesCap(market.totalLoanAmount);
    pointsAndFeesRatio = round((market.pointsAndFeesAmount / market.totalLoanAmount) * 100);
    pointsAndFeesPass = pointsAndFeesRatio <= cap;
    log.record(
      "UW-007",
      "Points and fees",
      pointsAndFeesRatio,
      `points_and_fees / total_loan_amount (§1026.32(b)(4), not the note amount) ` +
        `vs the ${cap}% cap for this loan size`,
      {
        points_and_fees: market.pointsAndFeesAmount,
        total_loan_amount: market.totalLoanAmount,
        loan_amount: loanAmount,
        cap_percent: cap,
      },
    );
  }

  /* ── HPML (UW-008) ────────────────────────────────────────────────────── */
  let hpmlSpread: number | null = null;
  let isHpml: boolean | null = null;
  let exactSpread: number | null = null;
  if (market.apr === undefined || market.apor === undefined) {
    log.blocked(
      "UW-008",
      "HPML test",
      [
        market.apr === undefined ? "APR" : null,
        market.apor === undefined ? "APOR (FFIEC weekly table)" : null,
      ].filter((x): x is string => x !== null),
    );
  } else if (principalDwelling === false) {
    hpmlSpread = round(market.apr - market.apor);
    log.record(
      "UW-008",
      "HPML test",
      "out_of_scope",
      `§1026.35(a)(1) reaches a loan secured by the consumer's principal dwelling; ` +
        `this one is secured by a ${occupancy}`,
      { occupancy, apr: market.apr, apor: market.apor, spread: hpmlSpread },
    );
  } else if (principalDwelling === null) {
    log.blocked("UW-008", "HPML test", ["the occupancy of the property securing this loan"]);
  } else {
    // Decided on the exact spread, recorded as the rounded one, and decided
    // with >= because §1026.35(a)(1)(i) is worded as a floor: an APR that
    // exceeds APOR "by 1.5 or more percentage points". A strict > rejected the
    // boundary, and rounding to hundredths first collapsed every true spread in
    // [1.495, 1.505) onto 1.50 — two independent ways to record an HPML as not
    // one. The HOEPA trigger below keeps its strict > because §1026.32(a)(1)(i)
    // is worded the other way, "more than 6.5 percentage points"; it reads the
    // same exact spread for the same reason.
    exactSpread = (milli(market.apr) - milli(market.apor)) / 1000;
    hpmlSpread = round(exactSpread);
    const threshold =
      loanAmount > GUIDELINES.hpml.conformingLoanLimit
        ? GUIDELINES.hpml.firstLienJumboSpread
        : GUIDELINES.hpml.firstLienSpread;
    isHpml = milli(exactSpread) >= milli(threshold);
    log.record(
      "UW-008",
      "HPML spread",
      hpmlSpread,
      `apr - apor against the ${threshold} first-lien threshold, which §1026.35(a)(1)(i) ` +
        `states as "or more"`,
      {
        apr: market.apr,
        apor: market.apor,
        threshold,
        jumbo: loanAmount > GUIDELINES.hpml.conformingLoanLimit,
      },
    );
  }

  /* ── HOEPA (UW-009) ───────────────────────────────────────────────────── */
  /**
   * Two triggers, either of which makes the loan high-cost — so the two answers
   * need different amounts of evidence and this is not a boolean over
   * `!== null`.
   *
   * ONE trigger firing settles it: a loan priced past the rate trigger is
   * high-cost whatever the fees did, so `true` is sound on one side alone.
   * `false` is not. "Not high-cost" means neither trigger fired, and a side
   * that was never tested did not fail to fire — it was not asked. With the fee
   * schedule always priced and the APR blocked on a loan carrying mortgage
   * insurance, a two-valued test returned exactly that: a confident "not
   * high-cost" on a loan whose rate nobody had compared to anything, which is
   * the failure this file's header opens with.
   */
  let isHighCost: boolean | null = null;
  // §1026.32(a)(1)(i) says "more than 6.5 percentage points", so this keeps the
  // strict > the HPML test above gives up — but it reads the same UNROUNDED
  // spread, because a true 6.5004 rounded to 6.50 fails a strict > as surely as
  // an exact 1.5 failed one.
  const aprTrigger =
    exactSpread === null ? null : milli(exactSpread) > milli(GUIDELINES.hoepa.firstLienAprSpread);
  const feeTrigger =
    pointsAndFeesRatio === null ? null : pointsAndFeesRatio > GUIDELINES.hoepa.pointsAndFeesPercent;
  if (principalDwelling === false) {
    log.record(
      "UW-009",
      "HOEPA high-cost test",
      "out_of_scope",
      `§1026.32(a)(1) reaches a loan secured by the consumer's principal dwelling; ` +
        `this one is secured by a ${occupancy}`,
      { occupancy, apr_spread: hpmlSpread, points_and_fees_percent: pointsAndFeesRatio },
    );
  } else if (aprTrigger === false && feeTrigger === false) {
    isHighCost = false;
  } else if (aprTrigger === true || feeTrigger === true) {
    isHighCost = true;
  }
  if (isHighCost === null) {
    log.blocked(
      "UW-009",
      "HOEPA high-cost test",
      [
        aprTrigger === null ? "APR/APOR, for the rate trigger" : null,
        feeTrigger === null ? "fee schedule, for the points-and-fees trigger" : null,
      ].filter((x): x is string => x !== null),
    );
  } else {
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
    const newPayment = estimateNewPayment(
      file.loan.loanAmount,
      file.product.noteRate,
      file.product.termMonths,
    );
    const paymentDelta = round(existing.monthlyPayment - newPayment);
    const rateDelta = round(existing.rate - file.product.noteRate);
    // Recoup is EVERY closing cost divided by monthly saving, not the points
    // and fees: a borrower recoups the appraisal, the title premium and the
    // recording fees along with what the lender keeps. Without a fee total we
    // cannot compute it, so it reports as unattainable rather than as zero.
    const fees = market.closingCostTotal;
    if (fees === undefined) {
      log.blocked("APP-019", "Net tangible benefit", ["closing cost total"]);
    } else if (paymentDelta <= 0) {
      // Null, not Infinity. `decisions.compliance` is jsonb and JSON has no
      // infinity: Prisma wrote the row and Postgres read it back as null, so a
      // stored counteroffer said the benefit test failed and could not say by
      // how much — "we could not compute this" and "it never recoups" collapsed
      // into one value, silently, at write time. Null here is unambiguous
      // because a test that did not run leaves `netTangibleBenefit` itself
      // undefined, and a negative `paymentDelta` beside a null recoup says the
      // payment went UP.
      netTangibleBenefit = {
        paymentDelta,
        rateDelta,
        recoupMonths: null,
        thresholdMonths: GUIDELINES.netTangibleBenefit.defaultRecoupMonths,
        satisfied: false,
      };
      log.record(
        "APP-019",
        "Net tangible benefit",
        false,
        "new payment is not lower than the old",
        {
          old_payment: existing.monthlyPayment,
          new_payment: round(newPayment),
        },
      );
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
