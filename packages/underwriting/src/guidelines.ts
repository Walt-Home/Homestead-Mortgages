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
   * General QM price thresholds: APR minus APOR, in percentage points.
   *
   * The 43% back-end DTI limit people remember was REPLACED. The CFPB's
   * General QM Final Rule (mandatory compliance October 2022) made the bright
   * line a price test — DTI must be considered and documented, but it is no
   * longer what decides QM status. Deciding it from DTI, as this engine did,
   * produces a confidently wrong legal determination in both directions: a
   * high-DTI loan priced well is QM, and a low-DTI loan priced badly is not.
   *
   * Tiers are by loan amount and adjust annually.
   */
  generalQm: [
    { minLoanAmount: 132_756, maxAprOverApor: 2.25 },
    { minLoanAmount: 79_654, maxAprOverApor: 3.5 },
    { minLoanAmount: 0, maxAprOverApor: 6.5 },
  ],

  /**
   * Borrower-paid monthly mortgage insurance, as an annual percentage of the
   * loan amount, by LTV band.
   *
   * ⚠ ESTIMATE. Real MI rates come from an insurer's rate card and vary by
   * FICO, term, coverage and product. But omitting MI entirely — which this
   * engine did — understates PITIA and therefore DTI for every loan above 80%
   * LTV, which is exactly the population where the DTI answer is tightest.
   */
  mortgageInsurance: [
    { minLtv: 95.01, annualRate: 0.0112 },
    { minLtv: 90.01, annualRate: 0.0076 },
    { minLtv: 85.01, annualRate: 0.0051 },
    { minLtv: 80.01, annualRate: 0.0032 },
  ],

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

/** The General QM APR-over-APOR threshold for a loan of this size. */
export function generalQmSpreadCap(loanAmount: number): number {
  for (const tier of GUIDELINES.generalQm) {
    if (loanAmount >= tier.minLoanAmount) return tier.maxAprOverApor;
  }
  return 6.5;
}

/** Annual MI rate for an LTV, or 0 at or below 80% where none is required. */
export function mortgageInsuranceRate(ltv: number): number {
  for (const band of GUIDELINES.mortgageInsurance) {
    if (ltv >= band.minLtv) return band.annualRate;
  }
  return 0;
}

/** The points-and-fees cap that applies to a loan of this size. */
export function pointsAndFeesCap(loanAmount: number): number {
  for (const tier of GUIDELINES.qmPointsAndFees) {
    if (loanAmount >= tier.minLoanAmount) return tier.maxPercent;
  }
  // Unreachable: the last tier has minLoanAmount 0.
  return GUIDELINES.qmPointsAndFees[GUIDELINES.qmPointsAndFees.length - 1]?.maxPercent ?? 8;
}
