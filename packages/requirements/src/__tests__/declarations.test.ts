/**
 * The six rows the declarations screen carries, and the three conditions that
 * read an answer rather than a retrieval.
 *
 * Everywhere else in this registry a condition asks what a connector returned.
 * These three ask what a person said, and that is the whole point: a credit
 * report showing no bankruptcy does not answer "have you declared bankruptcy",
 * and a county record showing no deed does not answer "have you owned a home".
 * Screen 5 used to answer both from exactly those two sources.
 *
 * Each predicate is three-valued, and `null` is the state that matters. An
 * unasked borrower is somebody we might still ask, not somebody with nothing
 * to declare — and the six rows are what make the engine able to say so.
 */

import { describe, expect, it } from "vitest";
import type { BorrowerDeclaration, BorrowerResidence, LoanFile } from "@hm/shared";
import { evaluateCondition } from "../conditions.js";
import { EVALUATORS } from "../satisfaction.js";

const DECLARED: BorrowerDeclaration = {
  intentToOccupy: "Yes",
  homeownerPastThreeYears: "No",
  priorPropertyUsage: null,
  priorPropertyTitle: null,
  fhaSecondaryResidence: null,
  specialBorrowerSellerRelationship: false,
  undisclosedBorrowedFunds: false,
  undisclosedBorrowedFundsAmount: null,
  undisclosedMortgageApplication: false,
  undisclosedCreditApplication: false,
  propertyProposedCleanEnergyLien: false,
  undisclosedComakerOfNote: false,
  outstandingJudgments: false,
  presentlyDelinquent: false,
  partyToLawsuit: false,
  priorPropertyDeedInLieuConveyed: false,
  priorPropertyShortSaleCompleted: false,
  priorPropertyForeclosureCompleted: false,
  bankruptcy: false,
  bankruptcyChapters: [],
  explanations: null,
};

const CURRENT: BorrowerResidence = {
  residencyType: "Current",
  basis: "Rent",
  durationMonths: 30,
  monthlyRent: 1_850,
  addressLineText: null,
  addressUnit: null,
  cityName: null,
  stateCode: null,
  postalCode: null,
  countryCode: null,
};

const PRIOR: BorrowerResidence = {
  ...CURRENT,
  residencyType: "Prior",
  durationMonths: 40,
  addressLineText: "12 Old Street",
  cityName: "Austin",
  stateCode: "TX",
  postalCode: "78701",
};

/** Only the two fields these six read. Nothing else decides any of them. */
const file = (
  declaration: BorrowerDeclaration | null,
  residences: readonly BorrowerResidence[] = [],
): LoanFile => ({ declaration, residences }) as unknown as LoanFile;

/**
 * Everything a connector could possibly say about the same questions.
 *
 * A bankruptcy on the credit report, a foreclosure in the lien search,
 * borrowed funds in the asset report and a prior deed in the county record —
 * the four sources the deleted `buildDeclarations` read. Against an unasked
 * borrower every one of these six must still answer "not asked".
 */
const EVERYTHING_RETRIEVED = {
  credit: { publicRecords: [{ type: "bankruptcy" }, { type: "foreclosure" }] },
  lienSearch: { delinquentFederalDebt: true, foreclosureOrShortSaleInHistory: true },
  assets: { borrowedFunds: [{ amount: 5_000 }] },
  propertyRecord: { priorOwnershipInLastThreeYears: true },
} as unknown as Partial<LoanFile>;

describe("the conditions that read an answer", () => {
  it("cannot know any of them until somebody is asked", () => {
    const unasked = file(null);
    expect(evaluateCondition("declared_bankruptcy", unasked)).toBeNull();
    expect(evaluateCondition("declared_homeowner_past_three_years", unasked)).toBeNull();
    expect(evaluateCondition("current_residence_under_two_years", unasked)).toBeNull();
  });

  it("is unmoved by everything a connector could say about the same thing", () => {
    // The defect in one assertion: a bankruptcy on the credit report is not
    // an answer to "have you declared bankruptcy", and a county record of a
    // prior deed is not an answer to "have you owned a home".
    const retrieved = { ...file(null), ...EVERYTHING_RETRIEVED } as LoanFile;
    expect(evaluateCondition("declared_bankruptcy", retrieved)).toBeNull();
    expect(evaluateCondition("declared_homeowner_past_three_years", retrieved)).toBeNull();
  });

  it("answers what the borrower actually said", () => {
    expect(evaluateCondition("declared_bankruptcy", file(DECLARED))).toBe(false);
    expect(evaluateCondition("declared_bankruptcy", file({ ...DECLARED, bankruptcy: true }))).toBe(
      true,
    );
    expect(evaluateCondition("declared_homeowner_past_three_years", file(DECLARED))).toBe(false);
    expect(
      evaluateCondition(
        "declared_homeowner_past_three_years",
        file({ ...DECLARED, homeownerPastThreeYears: "Yes" }),
      ),
    ).toBe(true);
  });

  it("asks for a previous address under two years and not at two years", () => {
    const at = (months: number) =>
      evaluateCondition(
        "current_residence_under_two_years",
        file(DECLARED, [{ ...CURRENT, durationMonths: months }]),
      );
    expect(at(23)).toBe(true);
    expect(at(24)).toBe(false);
    expect(at(25)).toBe(false);
  });
});

describe("the six evaluators", () => {
  const status = (id: string, f: LoanFile) => EVALUATORS[id]!(f).status;

  it("is unsatisfied on a borrower nobody has asked", () => {
    const unasked = { ...file(null), ...EVERYTHING_RETRIEVED } as LoanFile;
    for (const id of ["APP-022", "APP-023", "APP-024", "APP-025", "APP-026", "APP-027"]) {
      expect(status(id, unasked), id).toBe("unsatisfied");
    }
  });

  it("is satisfied by the answers, and by nothing else", () => {
    const answered = file(DECLARED, [CURRENT]);
    expect(status("APP-022", answered)).toBe("satisfied");
    expect(status("APP-023", answered)).toBe("satisfied");
    expect(status("APP-026", answered)).toBe("satisfied");
  });

  it("wants the chapters from a borrower who declared a bankruptcy", () => {
    const declared = { ...DECLARED, bankruptcy: true };
    expect(status("APP-024", file(declared))).toBe("unsatisfied");
    expect(status("APP-024", file({ ...declared, bankruptcyChapters: ["ChapterSeven"] }))).toBe(
      "satisfied",
    );
  });

  it("wants the usage from a borrower who owned a home, and not the title", () => {
    const owned = { ...DECLARED, homeownerPastThreeYears: "Yes" as const };
    expect(status("APP-025", file(owned))).toBe("unsatisfied");
    // Title is DU-optional with no conditionality of its own, so a borrower
    // who declined it has still answered the question that was required.
    expect(status("APP-025", file({ ...owned, priorPropertyUsage: "Investment" }))).toBe(
      "satisfied",
    );
  });

  it("wants the whole previous address, not a fragment of one", () => {
    expect(status("APP-027", file(DECLARED, [CURRENT, PRIOR]))).toBe("satisfied");
    expect(status("APP-027", file(DECLARED, [CURRENT, { ...PRIOR, cityName: null }]))).toBe(
      "unsatisfied",
    );
  });
});
