/**
 * The regulatory tests on screen 8.
 *
 * Four of these (UW-006, UW-008, APP-019, and the points-and-fees test behind
 * UW-007) carry a failure severity of "Regulatory violation" or "Financial
 * loss" in Drew's sheet. None of them may return a comfortable default when an
 * input is missing — a HOEPA test that answers "not high-cost" because it had
 * no APOR to compare against is worse than no test at all.
 *
 * **Every dated threshold these tests read is chosen by the rate-set date**, in
 * the one named time zone `@hm/shared` holds, and refused rather than defaulted
 * when this engine does not carry that year. Before that, a December file
 * recomputed in January — decisions are append-only and a re-pull recomputes —
 * was judged on next year's figures, and the two stored decisions would
 * disagree about one loan for no reason on the file.
 */

import {
  calendarDateIn,
  RATE_SET_TIME_ZONE,
  type ComplianceTests,
  type LoanFile,
} from "@hm/shared";
import { DerivationLog, round } from "./derive.js";
import {
  cents,
  generalQmSpreadCap,
  GUIDELINES,
  hoepaPointsAndFeesLimit,
  pointsAndFeesLimit,
  thresholdsFor,
  thresholdYearsHeld,
  type RegulationZThresholds,
} from "./guidelines.js";

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
  /**
   * The §1026.43(b)(5) loan amount: the note principal.
   *
   * This is the figure that SELECTS a threshold tier — §1026.43(e)(3)(i) and
   * (e)(2)(vi) and §1026.32(a)(1)(ii) all bound their tiers by "loan amount",
   * and §1026.43(b)(5) is the only definition either section offers. What each
   * percentage is then applied TO is the §1026.32(b)(4) total loan amount,
   * which is a different and always smaller number.
   */
  const loanAmount = file.loan?.loanAmount ?? 0;

  /**
   * Which year's indexed thresholds govern, and the date that says so.
   *
   * The rate-set date is read as a CALENDAR date in one named zone, the same
   * one the APOR lookup uses, so a file's price tests are all judged in one
   * year and against one week. A year this engine does not hold is a blocked
   * derivation naming what is missing — never the newest year it has.
   */
  const rateSetOn =
    file.product?.rateQuotedAt == null
      ? null
      : calendarDateIn(new Date(file.product.rateQuotedAt));
  const thresholds = rateSetOn === null ? null : thresholdsFor(rateSetOn);
  const thresholdBlockers = (): string[] =>
    rateSetOn === null
      ? ["the date this loan's rate was set, which decides which year's thresholds apply"]
      : [
          `the Regulation Z thresholds indexed for ${rateSetOn.slice(0, 4)} ` +
            `(this engine holds ${thresholdYearsHeld().join(", ")})`,
        ];
  /** Stamped onto every derivation decided against a dated figure. */
  const provenance = (t: RegulationZThresholds): Record<string, unknown> => ({
    rate_set_on: rateSetOn,
    rate_set_time_zone: RATE_SET_TIME_ZONE,
    thresholds_year: t.year,
    thresholds_source: t.source,
  });

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
   *
   * The property type is now one of the inputs, because §1026.43(e)(2)(vi)(D)
   * gives a first-lien manufactured-home loan its own threshold. It was decided
   * with no property on the file at all, which is how a manufactured home got
   * measured against the tier for a house.
   */
  let qmStatus: ComplianceTests["qmStatus"] = null;
  const propertyType = file.property?.propertyType ?? null;
  if (
    market.apr === undefined ||
    market.apor === undefined ||
    thresholds === null ||
    propertyType === null
  ) {
    log.blocked(
      "UW-006",
      "QM status",
      [
        market.apr === undefined ? "APR" : null,
        market.apor === undefined ? "APOR (FFIEC weekly table)" : null,
        propertyType === null ? "the type of the property securing this loan" : null,
        ...(thresholds === null ? thresholdBlockers() : []),
      ].filter((x): x is string => x !== null),
    );
  } else if (atrDetermination !== "documented") {
    // No ATR determination means no QM, whatever the price says.
    qmStatus = "non_qm";
    log.record("UW-006", "QM status", qmStatus, "ATR was not documented", {
      atr_determination: atrDetermination,
    });
  } else {
    const cap = generalQmSpreadCap(loanAmount, propertyType, thresholds);
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
    qmStatus = exactMilli < milli(cap.points) ? "qm" : "non_qm";
    log.record(
      "UW-006",
      "QM status",
      qmStatus,
      `General QM price test: apr - apor (${round(spread)}) below the ${cap.points} point ` +
        `threshold ${cap.paragraph} sets for this loan`,
      {
        apr: market.apr,
        apor: market.apor,
        spread: round(spread),
        threshold: cap.points,
        threshold_paragraph: cap.paragraph,
        manufactured_home: cap.manufacturedHome,
        property_type: propertyType,
        loan_amount: loanAmount,
        dti_back_considered: dtiBack,
        ...provenance(thresholds),
      },
    );
  }

  /* ── Points and fees (UW-007) ─────────────────────────────────────────── */
  /**
   * The QM cap is a DOLLAR limit, and two of its five tiers are flat dollars.
   *
   * §1026.43(e)(3)(i)(B) and (D) state `$4,139` and `$1,380`, not a percentage;
   * the table here encoded them as 3.9% and 6.6%, which are those dollars
   * divided by the bottom of their own tiers. Right at one loan size and wrong
   * everywhere else — at a $137,000 total loan amount 3.9% allows $5,343 where
   * the rule allows $4,139, which hands the §1026.43(e)(1) presumption of
   * compliance to a loan that is not a qualified mortgage.
   *
   * And the pass was decided on the ratio ROUNDED to hundredths, which is the
   * same defect the HPML spread was fixed for: $6,000.40 against a $6,000 cap
   * rounds to 3.00% and passes. The ratio is still computed and recorded — the
   * screen shows it, and a CHECK on `decisions` reads it — but the test is an
   * integer comparison in cents.
   */
  let pointsAndFeesRatio: number | null = null;
  let pointsAndFeesPass: boolean | null = null;
  let pointsAndFeesCents: number | null = null;
  if (
    market.pointsAndFeesAmount === undefined ||
    market.totalLoanAmount === undefined ||
    market.totalLoanAmount <= 0 ||
    loanAmount === 0 ||
    thresholds === null
  ) {
    log.blocked(
      "UW-007",
      "Points and fees test",
      [
        market.pointsAndFeesAmount === undefined ? "a priced fee schedule" : null,
        market.totalLoanAmount === undefined || market.totalLoanAmount <= 0
          ? "the §1026.32(b)(4) total loan amount this ratio is measured against"
          : null,
        loanAmount === 0 ? "the loan amount, which chooses the tier" : null,
        ...(thresholds === null ? thresholdBlockers() : []),
      ].filter((x): x is string => x !== null),
    );
  } else {
    const limit = pointsAndFeesLimit(loanAmount, market.totalLoanAmount, thresholds);
    pointsAndFeesCents = cents(market.pointsAndFeesAmount);
    pointsAndFeesRatio = round((market.pointsAndFeesAmount / market.totalLoanAmount) * 100);
    pointsAndFeesPass = pointsAndFeesCents <= limit.limitCents;
    log.record(
      "UW-007",
      "Points and fees",
      pointsAndFeesRatio,
      `points_and_fees against the ${limit.basis}, compared in whole cents; the ratio ` +
        `beside it is points_and_fees / total_loan_amount (§1026.32(b)(4), not the note amount)`,
      {
        points_and_fees: market.pointsAndFeesAmount,
        total_loan_amount: market.totalLoanAmount,
        loan_amount: loanAmount,
        cap_dollars: round(limit.limitCents / 100, 2),
        cap_basis: limit.basis,
        cap_paragraph: limit.paragraph,
        ...provenance(thresholds),
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
    if (thresholds === null) {
      // The spread is computable; which side of the jumbo line this loan sits
      // on is not, because the conforming limit moves every year too.
      log.blocked("UW-008", "HPML test", thresholdBlockers());
    } else {
      const jumbo = loanAmount > thresholds.conformingLoanLimit;
      const threshold = jumbo
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
          jumbo,
          conforming_loan_limit: thresholds.conformingLoanLimit,
          ...provenance(thresholds),
        },
      );
    }
  }

  /* ── HOEPA (UW-009) ───────────────────────────────────────────────────── */
  /**
   * THREE triggers, any one of which makes the loan high-cost — so the two
   * answers need different amounts of evidence and this is not a boolean over
   * `!== null`.
   *
   * ONE trigger firing settles it: a loan priced past the rate trigger is
   * high-cost whatever the fees did, so `true` is sound on one side alone.
   * `false` is not. "Not high-cost" means no trigger fired, and a side that was
   * never tested did not fail to fire — it was not asked. With the fee schedule
   * always priced and the APR blocked on a loan carrying mortgage insurance, a
   * two-valued test returned exactly that: a confident "not high-cost" on a loan
   * whose rate nobody had compared to anything, which is the failure this file's
   * header opens with.
   *
   * The third trigger, §1026.32(a)(1)(iii), is the prepayment penalty, and it
   * was simply not tested — `isHighCost: false` was asserted having asked two
   * of three questions, which is the same asymmetry one layer up. A boolean on
   * the product row can prove it FALSE (there is no penalty, so it cannot be
   * charged past 36 months or above 2% of the amount prepaid) and can never
   * prove it TRUE, because a penalty inside both bounds is not a trigger. So a
   * product that carries one blocks, and says what it is waiting for.
   */
  let isHighCost: boolean | null = null;
  // §1026.32(a)(1)(i) says "more than 6.5 percentage points", so this keeps the
  // strict > the HPML test above gives up — but it reads the same UNROUNDED
  // spread, because a true 6.5004 rounded to 6.50 fails a strict > as surely as
  // an exact 1.5 failed one.
  const aprTrigger =
    exactSpread === null ? null : milli(exactSpread) > milli(GUIDELINES.hoepa.firstLienAprSpread);
  const feeLimit =
    thresholds === null || market.totalLoanAmount === undefined || market.totalLoanAmount <= 0
      ? null
      : hoepaPointsAndFeesLimit(loanAmount, market.totalLoanAmount, thresholds);
  // "will exceed", so strictly over, and in whole cents for the same reason the
  // spreads are in thousandths.
  const feeTrigger =
    pointsAndFeesCents === null || feeLimit === null
      ? null
      : pointsAndFeesCents > feeLimit.limitCents;
  const penaltyTrigger = prepaymentPenaltyTrigger(file.product);
  const triggers = { apr: aprTrigger, pointsAndFees: feeTrigger, prepaymentPenalty: penaltyTrigger };
  if (principalDwelling === false) {
    log.record(
      "UW-009",
      "HOEPA high-cost test",
      "out_of_scope",
      `§1026.32(a)(1) reaches a loan secured by the consumer's principal dwelling; ` +
        `this one is secured by a ${occupancy}`,
      { occupancy, apr_spread: hpmlSpread, points_and_fees_percent: pointsAndFeesRatio },
    );
  } else if (aprTrigger === true || feeTrigger === true || penaltyTrigger === true) {
    isHighCost = true;
  } else if (aprTrigger === false && feeTrigger === false && penaltyTrigger === false) {
    isHighCost = false;
  }
  if (isHighCost === null) {
    log.blocked(
      "UW-009",
      "HOEPA high-cost test",
      [
        aprTrigger === null ? "APR/APOR, for the rate trigger" : null,
        feeTrigger === null ? "fee schedule, for the points-and-fees trigger" : null,
        penaltyTrigger === null
          ? file.product
            ? "the prepayment penalty's term and cap (§1026.32(a)(1)(iii): chargeable more " +
              "than 36 months after consummation, or more than 2% of the amount prepaid), " +
              "which the product row does not carry"
            : "a quoted product, for the prepayment-penalty trigger"
          : null,
        ...(thresholds === null && feeTrigger === null ? thresholdBlockers() : []),
      ].filter((x): x is string => x !== null),
    );
  } else {
    log.record(
      "UW-009",
      "HOEPA high-cost",
      isHighCost,
      "APR spread OR points-and-fees OR prepayment-penalty trigger",
      {
        apr_spread: hpmlSpread,
        apr_trigger_threshold: GUIDELINES.hoepa.firstLienAprSpread,
        apr_trigger: aprTrigger,
        points_and_fees_percent: pointsAndFeesRatio,
        fee_trigger_limit_dollars: feeLimit === null ? null : round(feeLimit.limitCents / 100, 2),
        fee_trigger_basis: feeLimit === null ? null : feeLimit.basis,
        fee_trigger: feeTrigger,
        prepayment_penalty: file.product?.prepaymentPenalty ?? null,
        prepayment_penalty_trigger: penaltyTrigger,
        ...(thresholds === null ? {} : provenance(thresholds)),
      },
    );
  }

  /* ── Net tangible benefit (APP-019) ───────────────────────────────────── */
  let netTangibleBenefit: ComplianceTests["netTangibleBenefit"];
  const existing = file.loan?.existingLoan;
  if (file.loan && file.loan.purpose !== "purchase") {
    // A refinance with no existing loan used to run no test and record nothing,
    // so a file missing the very thing APP-019 measures could still decide.
    // Silence is not a pass: a test that did not run has to say so, which is
    // what makes the decision `referred`.
    if (!existing || !file.product) {
      log.blocked(
        "APP-019",
        "Net tangible benefit",
        [
          !existing ? "the existing loan (APP-018)" : null,
          !file.product ? "a quoted product" : null,
        ].filter((x): x is string => x !== null),
      );
    } else {
      const newPayment = estimateNewPayment(
        file.loan.loanAmount,
        file.product.noteRate,
        file.product.termMonths,
      );
      /**
       * The rate difference, or an honest absence.
       *
       * A credit bureau's mortgage tradeline carries no interest rate, and the
       * credit pull wrote `0` into the column anyway — so a refinance off a
       * real report published a `rateDelta` of −6.25 with no derivation behind
       * it, which is the one thing a number on a decision may not be. Null is
       * what "we were never told the old rate" looks like.
       */
      const rateDelta = existing.rate === null ? null : round(existing.rate - file.product.noteRate);
      const rateDeltaSource =
        existing.rate === null ? "unknown (no source on file carries the existing rate)" : "on file";
      // Recoup is EVERY closing cost divided by monthly saving, not the points
      // and fees: a borrower recoups the appraisal, the title premium and the
      // recording fees along with what the lender keeps. Without a fee total we
      // cannot compute it, so it reports as unattainable rather than as zero.
      const fees = market.closingCostTotal;
      /**
       * The saving is P&I against P&I, so the old payment has to BE P&I.
       *
       * The one federal formulation of this test — 38 U.S.C. 3709(a), which is
       * VA's and does not reach a conventional refinance — divides the fees by
       * "the reduction in the monthly principal and interest payment", and
       * `estimateNewPayment` computes P&I. A credit bureau reports the
       * SCHEDULED payment, which on an escrowed loan includes taxes and
       * insurance the new loan will also charge: subtracting P&I from it
       * overstates the saving by the whole old escrow, understates the recoup,
       * and passes a test the refinance fails. So an existing payment that does
       * not know what it is blocks rather than being treated as P&I.
       */
      if (fees === undefined) {
        log.blocked("APP-019", "Net tangible benefit", ["closing cost total"]);
      } else if (existing.paymentBasis !== "principal_and_interest") {
        log.blocked("APP-019", "Net tangible benefit", [
          "the principal-and-interest portion of the existing payment (a credit report's " +
            "scheduled payment may include escrow, and this one is " +
            `${existing.paymentBasis ?? "of unrecorded basis"})`,
        ]);
      } else if (round(existing.monthlyPayment - newPayment) <= 0) {
        // Null, not Infinity. `decisions.compliance` is jsonb and JSON has no
        // infinity: Prisma wrote the row and Postgres read it back as null, so a
        // stored counteroffer said the benefit test failed and could not say by
        // how much — "we could not compute this" and "it never recoups" collapsed
        // into one value, silently, at write time. Null here is unambiguous
        // because a test that did not run leaves `netTangibleBenefit` itself
        // undefined, and a negative `paymentDelta` beside a null recoup says the
        // payment went UP.
        const paymentDelta = round(existing.monthlyPayment - newPayment);
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
            old_payment_basis: existing.paymentBasis,
            new_payment: round(newPayment),
            rate_delta: rateDelta,
            rate_delta_source: rateDeltaSource,
          },
        );
      } else {
        const paymentDelta = round(existing.monthlyPayment - newPayment);
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
          `closing_costs / monthly_saving vs a ${thresholdMonths}-month threshold, both ` +
            `payments principal-and-interest`,
          {
            closing_costs: fees,
            monthly_saving: paymentDelta,
            old_payment_basis: existing.paymentBasis,
            rate_delta: rateDelta,
            rate_delta_source: rateDeltaSource,
          },
        );
      }
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
    hoepaTriggers: triggers,
    netTangibleBenefit,
  };
}

/**
 * HOEPA's third trigger, §1026.32(a)(1)(iii), as far as a boolean can carry it.
 *
 * A separate function rather than a ternary because the answer is three-valued
 * and today's inputs can only produce two of the three: TypeScript narrows a
 * `const` to what its initializer can be, so inlining this would type the
 * trigger `false | null` and mark the `true` arm of the OR below as dead code.
 * It is not dead — it is the arm a product row carrying the penalty's term and
 * cap will take — and a type that forbids it would have to be widened by
 * whoever adds that row, in the file where the mistake is hardest to see.
 */
function prepaymentPenaltyTrigger(product: LoanFile["product"]): boolean | null {
  // No product is no answer: the trigger is a property of the loan's terms.
  if (!product) return null;
  // `false` settles it. A penalty that cannot be charged at all cannot be
  // charged more than 36 months after consummation, and cannot exceed 2% of the
  // amount prepaid.
  if (product.prepaymentPenalty === false) return false;
  // `true` on the boolean is NOT `true` on the trigger. A penalty inside both
  // bounds is lawful and not high-cost, and the bounds are not on this row — so
  // the honest answer is that we do not know, which blocks UW-009.
  return null;
}

function estimateNewPayment(amount: number, annualRate: number, termMonths: number): number {
  const r = annualRate / 100 / 12;
  if (r === 0) return amount / termMonths;
  return (amount * r) / (1 - Math.pow(1 + r, -termMonths));
}
