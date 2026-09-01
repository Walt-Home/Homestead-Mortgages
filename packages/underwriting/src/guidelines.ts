/**
 * Agency and regulatory thresholds, in one place, with their sources named.
 *
 * ⚠ THESE ARE DATED VALUES AND SEVERAL CHANGE EVERY JANUARY.
 *
 * The QM points-and-fees tiers, the conforming loan limit and the APOR feed
 * are all annually adjusted, and a stale threshold here produces a confidently
 * wrong compliance test rather than an error. `thresholdsReviewedFor` is the
 * year these were last checked against the published tables; the engine stamps
 * it onto every result so a decision made against stale numbers is
 * identifiable after the fact rather than indistinguishable from a fresh one.
 *
 * Before this product underwrites anything real, these need to come from a
 * maintained source — the FFIEC APOR tables and the CFPB's annual threshold
 * adjustments — not from a constant in a repo.
 */

export const GUIDELINES = {
  thresholdsReviewedFor: 2025,

  credit: {
    /** Fannie's minimum representative score for a standard eligible loan. */
    minimumRepresentativeFico: 620,
    /** Months of seasoning after a Chapter 7 discharge. */
    bankruptcyChapter7SeasoningMonths: 48,
    bankruptcyChapter13SeasoningMonths: 24,
    foreclosureSeasoningMonths: 84,
    shortSaleOrDilSeasoningMonths: 48,
  },

  ratios: {
    /** DU's maximum debt-to-income for an Approve/Eligible recommendation. */
    maxDtiBack: 50,
    /** Above this, DU wants compensating factors; we surface it as a finding. */
    dtiCautionThreshold: 45,
  },

  ltv: {
    purchasePrimaryMax: 97,
    purchaseSecondHomeMax: 90,
    purchaseInvestmentMax: 85,
    rateTermRefinanceMax: 97,
    cashOutRefinanceMax: 80,
  },

  /**
   * Reserve requirements in months of PITIA. A V1 stand-in for the AUS's own
   * determination, which varies by far more than these three inputs.
   */
  reserves: {
    primaryResidenceMonths: 0,
    secondHomeMonths: 2,
    investmentMonths: 6,
    /** Added per financed property beyond the subject, for multiple-property files. */
    perAdditionalFinancedPropertyMonths: 2,
  },

  /**
   * Interested-party contribution caps as a percentage of sales price, by LTV
   * band, primary residence and second home. Investment is 2% at every LTV.
   */
  ipc: {
    primaryAndSecondHome: [
      { minLtv: 90.01, maxPercent: 3 },
      { minLtv: 75.01, maxPercent: 6 },
      { minLtv: 0, maxPercent: 9 },
    ],
    investmentMaxPercent: 2,
  },

  /**
   * QM points-and-fees caps. Tiered by loan amount, adjusted annually for
   * inflation by the CFPB. 2025 figures.
   */
  qmPointsAndFees: [
    { minLoanAmount: 130_461, maxPercent: 3 },
    { minLoanAmount: 78_277, maxPercent: 3.9 },
    { minLoanAmount: 26_092, maxPercent: 5 },
    { minLoanAmount: 16_308, maxPercent: 6.6 },
    { minLoanAmount: 0, maxPercent: 8 },
  ],

  /** Higher-priced mortgage loan: APR over APOR by more than this, in points. */
  hpml: {
    firstLienSpread: 1.5,
    firstLienJumboSpread: 2.5,
    subordinateLienSpread: 3.5,
    /** 2025 conforming limit for a one-unit property in a standard-cost area. */
    conformingLoanLimit: 806_500,
  },

  /** HOEPA high-cost triggers. Any one makes the loan high-cost. */
  hoepa: {
    firstLienAprSpread: 6.5,
    subordinateLienAprSpread: 8.5,
    pointsAndFeesPercent: 5,
  },

  /** Net tangible benefit recoup ceiling, in months, where a state requires one. */
  netTangibleBenefit: {
    defaultRecoupMonths: 60,
  },
} as const;

/** The points-and-fees cap that applies to a loan of this size. */
export function pointsAndFeesCap(loanAmount: number): number {
  for (const tier of GUIDELINES.qmPointsAndFees) {
    if (loanAmount >= tier.minLoanAmount) return tier.maxPercent;
  }
  // Unreachable: the last tier has minLoanAmount 0.
  return GUIDELINES.qmPointsAndFees[GUIDELINES.qmPointsAndFees.length - 1]?.maxPercent ?? 8;
}
