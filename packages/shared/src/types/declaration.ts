/**
 * What the borrower answered, in the one shape every reader shares.
 *
 * These are URLA Section 5 and the residence history, as of THIS request. They
 * are not derived from anything and nothing here may be: a declaration is the
 * borrower's own statement, and a clean credit report is absence of evidence
 * rather than a "no". The screen that asks them, the engine that counts them
 * and the screen that reads them back before the signature all use this shape,
 * so the words on the last screen are the answers that were stored rather than
 * a second reading of the same tables.
 *
 * The unions restate the `Du*` Prisma enums deliberately. `@hm/shared` is
 * imported by the web app, which has no database client and must not gain one;
 * the two are structurally identical, and the API maps a row straight into
 * this without a cast for that reason.
 */

/** A question DU asks as an enumeration rather than as a boolean. */
export type DeclarationYesNo = "Yes" | "No";

/** How a property the borrower owned before was used. `Other` is not legal. */
export type PriorPropertyUsage = "Investment" | "PrimaryResidence" | "SecondHome";

/** How they held title to it. */
export type PriorPropertyTitle = "Sole" | "JointWithSpouse" | "JointWithOtherThanSpouse";

/** The four chapters DU accepts. There is no fifth. */
export type BankruptcyChapter =
  "ChapterSeven" | "ChapterEleven" | "ChapterTwelve" | "ChapterThirteen";

export type ResidencyType = "Current" | "Prior";

export type ResidencyBasis = "Own" | "Rent" | "LivingRentFree";

/**
 * Section 5, as one borrower answered it.
 *
 * Five fields are nullable and each for a stated reason: the two follow-ups
 * only exist once their trigger question was answered Yes, the FHA and
 * purchase questions are only put on those products, and the lawsuit question
 * is only required on a government file. Everything else is an answer, because
 * the wire has no way to say "unanswered" and a nil answer to "have you
 * declared bankruptcy" is not one.
 */
export interface BorrowerDeclaration {
  readonly intentToOccupy: DeclarationYesNo;
  readonly homeownerPastThreeYears: DeclarationYesNo | null;
  readonly priorPropertyUsage: PriorPropertyUsage | null;
  readonly priorPropertyTitle: PriorPropertyTitle | null;
  readonly fhaSecondaryResidence: boolean | null;
  readonly specialBorrowerSellerRelationship: boolean | null;
  readonly undisclosedBorrowedFunds: boolean;
  /** Dollars. The column is bigint cents. */
  readonly undisclosedBorrowedFundsAmount: number | null;
  readonly undisclosedMortgageApplication: boolean;
  readonly undisclosedCreditApplication: boolean;
  readonly propertyProposedCleanEnergyLien: boolean;
  readonly undisclosedComakerOfNote: boolean;
  readonly outstandingJudgments: boolean;
  readonly presentlyDelinquent: boolean;
  readonly partyToLawsuit: boolean | null;
  readonly priorPropertyDeedInLieuConveyed: boolean;
  readonly priorPropertyShortSaleCompleted: boolean;
  readonly priorPropertyForeclosureCompleted: boolean;
  readonly bankruptcy: boolean;
  /** Which chapters, when the answer above is yes. Empty when it is not. */
  readonly bankruptcyChapters: readonly BankruptcyChapter[];
  /**
   * The borrower's own words, by question key. Stored and shown back, never
   * emitted: DU consumes no explanation element, so a serializer looking for
   * somewhere to put one would be inventing the place.
   */
  readonly explanations: Readonly<Record<string, string>> | null;
}

/**
 * Where they live, and where they lived before that.
 *
 * The CURRENT row carries no address of its own — it reads the pinned current
 * address, so there is one storage and two renderings. A PRIOR row carries its
 * own, because there is no prior-address fact to read one from.
 */
export interface BorrowerResidence {
  readonly residencyType: ResidencyType;
  readonly basis: ResidencyBasis;
  readonly durationMonths: number;
  /** Dollars. The column is bigint cents. */
  readonly monthlyRent: number | null;
  readonly addressLineText: string | null;
  readonly addressUnit: string | null;
  readonly cityName: string | null;
  readonly stateCode: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
}

/**
 * Below this, a prior residence is required.
 *
 * URLA asks for two years of address history, and DU makes the prior residence
 * conditionally required when the current one is shorter. The number lives here
 * because the applicability predicate and the screen that decides whether to
 * show the second address block have to agree about it.
 */
export const RESIDENCE_HISTORY_MONTHS = 24;
