/**
 * Agency and regulatory thresholds, in one place, with their sources named.
 *
 * Two kinds of value live here and they go wrong differently, so they are kept
 * apart:
 *
 *   - `GUIDELINES` holds the agency values that are not dated — Fannie's
 *     minimum score, the seasoning periods, the LTV ceilings, the reserve
 *     tiers. They change when a selling guide changes, which is an event
 *     somebody reads about rather than a January.
 *   - `REGULATION_Z_THRESHOLDS` holds the ones the CFPB republishes EVERY
 *     JANUARY, keyed by the year they were in force for. A stale one of these
 *     produces a confidently wrong legal test rather than an error, and a
 *     `thresholdsReviewedFor: 2025` comment beside them did not reach a single
 *     derivation. It also did not stop the table under it from holding 2024's
 *     figures.
 *
 * **The dated table refuses a year it does not hold.** `thresholdsFor` answers
 * null rather than the newest year it has, for the same reason `lookupApor`
 * refuses a week off the end of its series: a threshold from the wrong year is
 * wrong by one annual adjustment and looks exactly like a right one. The caller
 * blocks, the decision refers, and somebody adds the year.
 *
 * So this file WILL stop answering on 1 January of the year after the last
 * entry below, and that is the alarm working. Adding a year means reading the
 * CFPB's own annual adjustment notice — not last year's figures times an
 * inflation guess.
 */

export const GUIDELINES = {
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
    /** A DU casefile with a co-borrower who will not occupy the property (B2-2-04). */
    nonOccupantCoBorrowerMax: 95,
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

  /** Higher-priced mortgage loan: APR over APOR by more than this, in points. */
  hpml: {
    firstLienSpread: 1.5,
    firstLienJumboSpread: 2.5,
    subordinateLienSpread: 3.5,
  },

  /**
   * HOEPA's rate triggers, which are not indexed and so are not in the dated
   * table. The fee trigger IS indexed and lives there; the prepayment-penalty
   * trigger is a term and a cap rather than a number.
   */
  hoepa: {
    firstLienAprSpread: 6.5,
    subordinateLienAprSpread: 8.5,
  },

  /** Net tangible benefit recoup ceiling, in months, where a state requires one. */
  netTangibleBenefit: {
    defaultRecoupMonths: 60,
  },
} as const;


/* ────────────────────────────────────────────────────────────────────────────
 * The dated half: Regulation Z's annually indexed thresholds, by year.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A limit stated the way the rule states it — a percentage of something, or a
 * flat number of dollars.
 *
 * §1026.43(e)(3)(i) alternates between the two, and reading tiers (B) and (D)
 * as percentages is the defect this shape exists to make impossible. Whoever
 * wrote `3.9` and `6.6` had approximated `$3,914` and `$1,305` at the bottom of
 * their own tiers, which is the right answer at exactly one loan size and the
 * wrong one everywhere else — permissive above it and restrictive below.
 */
export type FeeLimit = { readonly percent: number } | { readonly dollars: number };

export interface PointsAndFeesTier {
  /** The §1026.43(b)(5) loan amount at or above which this tier applies. */
  readonly minLoanAmount: number;
  readonly limit: FeeLimit;
  /** Which subparagraph of §1026.43(e)(3)(i) this is. */
  readonly paragraph: string;
}

export interface RegulationZThresholds {
  /** The year these were in force for. */
  readonly year: number;
  /** The publication each figure below was read from, recorded on derivations. */
  readonly source: string;
  /** §1026.43(e)(3)(i), highest tier first. */
  readonly qmPointsAndFees: readonly PointsAndFeesTier[];
  /**
   * The two §1026.43(e)(2)(vi) loan-amount bounds. The thresholds themselves
   * (2.25 / 3.5 / 6.5 points) are in the rule text and are not indexed; only
   * the amounts that select between them are.
   */
  readonly generalQmApr: { readonly top: number; readonly middle: number };
  /** §1026.32(a)(1)(ii): the small-loan bound and the flat dollar cap under it. */
  readonly hoepa: { readonly smallLoanBelow: number; readonly smallLoanDollarCap: number };
  /** FHFA's baseline one-unit limit, which is what makes an HPML spread jumbo. */
  readonly conformingLoanLimit: number;
}

/**
 * Every indexed figure, by the year it governed.
 *
 * ⚠ VERIFICATION. The two HOEPA figures were read from the CFPB's own
 * commentary to §1026.32 ("$27,592, reflecting a 2.3 percent increase in the
 * CPI-U from June 2024 to June 2025", and "$1,380" on the same basis). The four
 * §1026.43(e)(3)(i) figures were read from a published summary of the same
 * final rule and then CHECKED against the two verified ones, which is a
 * stronger test than it sounds: the notice indexes all six from one multiplier
 * applied to the statutory bases $100,000 / $60,000 / $20,000 / $12,500 /
 * $3,000 / $1,000, and those bases are themselves continuous (3% of 100,000 is
 * 60,000's 5%, is 3,000). So the six 2026 figures must satisfy
 *
 *     137,958 x 3%  =  4,138.74        82,775 x 5%  =  4,138.75
 *      27,592 x 5%  =  1,379.60        17,245 x 8%  =  1,379.60
 *
 * — one multiplier, 1.37958, to the dollar at all six. A transcription error in
 * any one of them shows up as a discontinuity, and `thresholds.test.ts` asserts
 * the continuity rather than trusting this comment. The conforming limit is
 * FHFA's own announcement for 2026 and is indexed off house prices, not CPI,
 * so nothing here cross-checks it.
 */
export const REGULATION_Z_THRESHOLDS: Readonly<Record<number, RegulationZThresholds>> = {
  2026: {
    year: 2026,
    source:
      "Federal Register 2025-22773, Truth in Lending (Regulation Z) Annual Threshold " +
      "Adjustments (Credit Cards, HOEPA, and Qualified Mortgages), published 2025-12-15, " +
      "effective 2026-01-01; FHFA conforming loan limit announcement, 2025-11",
    qmPointsAndFees: [
      { minLoanAmount: 137_958, limit: { percent: 3 }, paragraph: "§1026.43(e)(3)(i)(A)" },
      { minLoanAmount: 82_775, limit: { dollars: 4_139 }, paragraph: "§1026.43(e)(3)(i)(B)" },
      { minLoanAmount: 27_592, limit: { percent: 5 }, paragraph: "§1026.43(e)(3)(i)(C)" },
      { minLoanAmount: 17_245, limit: { dollars: 1_380 }, paragraph: "§1026.43(e)(3)(i)(D)" },
      { minLoanAmount: 0, limit: { percent: 8 }, paragraph: "§1026.43(e)(3)(i)(E)" },
    ],
    generalQmApr: { top: 137_958, middle: 82_775 },
    hoepa: { smallLoanBelow: 27_592, smallLoanDollarCap: 1_380 },
    conformingLoanLimit: 832_750,
  },
};

/** The years this engine can judge a loan in, for a blocked derivation to name. */
export function thresholdYearsHeld(): readonly number[] {
  return Object.keys(REGULATION_Z_THRESHOLDS)
    .map(Number)
    .sort((a, b) => a - b);
}

/**
 * The thresholds in force on a calendar date, or null if this engine holds none.
 *
 * Null rather than the newest year held, and null rather than a throw: a
 * missing year is an input the engine could not obtain, which is a `blocked`
 * derivation and a `referred` decision, not a crash and not a guess.
 *
 * **Which year governs is itself a reading.** HOEPA and QM status attach at
 * consummation, and nothing in this product records a consummation date. The
 * rate-set date is the nearest recorded fact — it is what the APOR comparison
 * is already keyed on, so a file's price tests are all judged in one year — and
 * every derivation records the year and the date it came from, so a December
 * quote that closes in January is identifiable rather than invisible.
 */
export function thresholdsFor(rateSetOn: string): RegulationZThresholds | null {
  const year = Number(rateSetOn.slice(0, 4));
  if (!Number.isInteger(year)) return null;
  return REGULATION_Z_THRESHOLDS[year] ?? null;
}

/** Dollars to whole cents, so a bright line is compared as an integer. */
export const cents = (dollars: number): number => Math.round(dollars * 100);

/** A dollar limit and the words for where it came from. */
export interface AppliedFeeLimit {
  readonly limitCents: number;
  /** What the limit IS, in the rule's own terms, for the derivation. */
  readonly basis: string;
  readonly paragraph: string;
}

/**
 * Resolve one tier's limit against the total loan amount, in cents.
 *
 * A percentage of a dollar figure is cents already: `28,260 x 5` is 141,300
 * cents, which is $1,413.00. That is not a trick, it is why the comparison can
 * be an integer one — and it has to be, because `1_770 <= 34_230 * 0.05` is a
 * double comparison at the exact boundary these tests are decided on.
 */
function applyLimit(limit: FeeLimit, totalLoanAmount: number, paragraph: string): AppliedFeeLimit {
  if ("dollars" in limit) {
    return {
      limitCents: cents(limit.dollars),
      basis: `$${limit.dollars.toLocaleString("en-US")} flat (${paragraph})`,
      paragraph,
    };
  }
  return {
    limitCents: Math.round(totalLoanAmount * limit.percent),
    basis: `${limit.percent}% of the §1026.32(b)(4) total loan amount (${paragraph})`,
    paragraph,
  };
}

/**
 * The QM points-and-fees limit, in cents, for a loan of this size.
 *
 * **Two different figures, on purpose.** The TIER is chosen by the
 * §1026.43(b)(5) loan amount — "the principal amount the consumer will borrow
 * as reflected in the promissory note" — because that is the term
 * §1026.43(e)(3)(i) uses for its bounds and it is the only one of the two the
 * rule defines. The PERCENTAGE is applied to the §1026.32(b)(4) total loan
 * amount, because that is the term the rule uses for the base.
 *
 * This reverses what the code used to do, which chose the tier by the total
 * loan amount on the stated reasoning that "§1026.43(e)(3)(i) and §1026.32(b)(4)
 * use the same figure". They do not. The direction matters at a boundary: the
 * note amount is never smaller than the total loan amount, so choosing on it
 * puts a borderline loan in the HIGHER tier — the tighter cap — which is the
 * side to be wrong on.
 */
export function pointsAndFeesLimit(
  loanAmount: number,
  totalLoanAmount: number,
  thresholds: RegulationZThresholds,
): AppliedFeeLimit {
  for (const tier of thresholds.qmPointsAndFees) {
    if (loanAmount >= tier.minLoanAmount) {
      return applyLimit(tier.limit, totalLoanAmount, tier.paragraph);
    }
  }
  // Unreachable: the last tier has minLoanAmount 0 and the table is validated.
  throw new Error(
    `The ${thresholds.year} points-and-fees table has no tier for a loan of ${loanAmount}.`,
  );
}

/**
 * HOEPA's points-and-fees trigger, in cents.
 *
 * §1026.32(a)(1)(ii): "5 percent of the total loan amount for a transaction
 * with a loan amount of $20,000 [indexed] or more", or "the lesser of 8 percent
 * of the total loan amount or $1,000 [indexed]" below that. The code applied a
 * flat 5% at every size.
 *
 * Under the small-loan bound the flat 5% is the LOWER number, so it errs
 * restrictive — a $20,000 loan carrying $1,300 in points and fees was declined
 * as high-cost, and told why in a Regulation B notice, on a rule that does not
 * fire on it. "Conservative" is not a defense when the conservative answer is a
 * denial.
 */
export function hoepaPointsAndFeesLimit(
  loanAmount: number,
  totalLoanAmount: number,
  thresholds: RegulationZThresholds,
): AppliedFeeLimit {
  if (loanAmount >= thresholds.hoepa.smallLoanBelow) {
    return {
      limitCents: Math.round(totalLoanAmount * 5),
      basis: "5% of the §1026.32(b)(4) total loan amount (§1026.32(a)(1)(ii)(A))",
      paragraph: "§1026.32(a)(1)(ii)(A)",
    };
  }
  const eightPercent = Math.round(totalLoanAmount * 8);
  const flat = cents(thresholds.hoepa.smallLoanDollarCap);
  const lesser = Math.min(eightPercent, flat);
  return {
    limitCents: lesser,
    basis:
      `the lesser of 8% of the §1026.32(b)(4) total loan amount and ` +
      `$${thresholds.hoepa.smallLoanDollarCap.toLocaleString("en-US")} ` +
      `(§1026.32(a)(1)(ii)(B)), which here is ` +
      `${lesser === flat ? "the flat dollar cap" : "the percentage"}`,
    paragraph: "§1026.32(a)(1)(ii)(B)",
  };
}

/** What the General QM price test compares a spread against, and under which rule. */
export interface GeneralQmSpreadThreshold {
  /** Percentage points of APR over APOR. A loan is QM strictly below it. */
  readonly points: number;
  readonly paragraph: string;
  readonly manufacturedHome: boolean;
}

/**
 * The General QM APR-over-APOR threshold for this loan.
 *
 * §1026.43(e)(2)(vi)(D) gives a first-lien loan secured by a MANUFACTURED HOME
 * under the top bound 6.5 points rather than 2.25 or 3.5. Without it this
 * engine labelled a manufactured-home loan priced between the two `non_qm` on a
 * threshold the rule does not apply to it — restrictive, and stored on an
 * append-only decision.
 *
 * Lien position is assumed first throughout this engine, so (E) and (F) — the
 * subordinate-lien tiers — are deliberately absent rather than wrong: adding
 * them would mean reading a lien field that does not exist.
 */
export function generalQmSpreadCap(
  loanAmount: number,
  propertyType: string,
  thresholds: RegulationZThresholds,
): GeneralQmSpreadThreshold {
  const { top, middle } = thresholds.generalQmApr;
  if (propertyType === "manufactured" && loanAmount < top) {
    return { points: 6.5, paragraph: "§1026.43(e)(2)(vi)(D)", manufacturedHome: true };
  }
  if (loanAmount >= top) {
    return { points: 2.25, paragraph: "§1026.43(e)(2)(vi)(A)", manufacturedHome: false };
  }
  if (loanAmount >= middle) {
    return { points: 3.5, paragraph: "§1026.43(e)(2)(vi)(B)", manufacturedHome: false };
  }
  return { points: 6.5, paragraph: "§1026.43(e)(2)(vi)(C)", manufacturedHome: false };
}

/** Annual MI rate for an LTV, or 0 at or below 80% where none is required. */
export function mortgageInsuranceRate(ltv: number): number {
  for (const band of GUIDELINES.mortgageInsurance) {
    if (ltv >= band.minLtv) return band.annualRate;
  }
  return 0;
}
