/**
 * The seven rows the declarations screen carries, and the three conditions that
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
 * to declare — and the rows are what make the engine able to say so.
 *
 * Six of the seven are about the person answering. The seventh, APP-028, is
 * about the house: whether the land comes with it is one answer for the file,
 * and it is on this screen because nothing we retrieve carries it.
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

/**
 * One borrower, carrying only the two fields these six read.
 *
 * On the person rather than on the file, because that is where the answers
 * are. A file-level copy was borrower 1's, and the engine read it for
 * everybody.
 */
const who = (
  firstName: string,
  lastName: string,
  declaration: BorrowerDeclaration | null,
  residences: readonly BorrowerResidence[] = [],
) => ({ firstName, lastName, declaration, residences });

const file = (
  declaration: BorrowerDeclaration | null,
  residences: readonly BorrowerResidence[] = [],
): LoanFile =>
  ({ borrowers: [who("Ada", "Lovelace", declaration, residences)] }) as unknown as LoanFile;

/** Two people who answered differently, in document order. */
const household = (hers: ReturnType<typeof who>, his: ReturnType<typeof who>): LoanFile =>
  ({ borrowers: [hers, his] }) as unknown as LoanFile;

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

describe("the seven evaluators", () => {
  const status = (id: string, f: LoanFile) => EVALUATORS[id]!(f).status;

  it("is unsatisfied on a borrower nobody has asked", () => {
    const unasked = { ...file(null), ...EVERYTHING_RETRIEVED } as LoanFile;
    for (const id of ["APP-022", "APP-023", "APP-024", "APP-025", "APP-026", "APP-027"]) {
      expect(status(id, unasked), id).toBe("unsatisfied");
    }
  });

  it("is unsatisfied while the estate is unanswered, on a file that has a property", () => {
    // The seventh reads the FILE and not the borrower, so it needs a property
    // to be unanswered ON — and null is what "not asked" looks like there. A
    // column that defaulted to fee simple would report this satisfied on every
    // file ever created, which is the shape `borrowers.current_housing` had.
    const withProperty = (estateType: "FeeSimple" | "Leasehold" | null) =>
      ({ ...file(DECLARED, [CURRENT]), property: { estateType } }) as unknown as LoanFile;
    expect(status("APP-028", withProperty(null))).toBe("unsatisfied");
    expect(EVALUATORS["APP-028"]!(withProperty("FeeSimple"))).toEqual({
      status: "satisfied",
      evidence: "fee simple",
    });
    expect(EVALUATORS["APP-028"]!(withProperty("Leasehold"))).toEqual({
      status: "satisfied",
      evidence: "leasehold",
    });
  });

  it("does not become the co-borrower's question on a file with two people", () => {
    // One house, one estate. Six of these seven ask each borrower separately,
    // and answering this one twice would state two tenures for one property.
    const both = {
      ...household(who("Ada", "Lovelace", DECLARED, [CURRENT]), who("Dev", "Raman", null)),
      property: { estateType: "FeeSimple" },
    } as unknown as LoanFile;
    expect(status("APP-022", both)).toBe("unsatisfied");
    expect(EVALUATORS["APP-028"]!(both)).toEqual({ status: "satisfied", evidence: "fee simple" });
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
    const recent = { ...CURRENT, durationMonths: 14 };
    expect(status("APP-027", file(DECLARED, [recent, PRIOR]))).toBe("satisfied");
    expect(status("APP-027", file(DECLARED, [recent, { ...PRIOR, cityName: null }]))).toBe(
      "unsatisfied",
    );
  });

  it("asks a previous address only of whoever moved recently", () => {
    // One person moving is what makes the condition true of the FILE. It does
    // not give the other person a previous address to state, and reporting
    // that it does would put a question on the outstanding list that nobody
    // can answer.
    const settled = who("Ada", "Lovelace", DECLARED, [{ ...CURRENT, durationMonths: 90 }]);
    const moved = who("Dev", "Raman", DECLARED, [{ ...CURRENT, durationMonths: 14 }, PRIOR]);
    const both = household(settled, moved);

    expect(evaluateCondition("current_residence_under_two_years", both)).toBe(true);
    expect(EVALUATORS["APP-027"]!(both)).toEqual({
      status: "satisfied",
      evidence:
        "Ada Lovelace: 90 month(s) at the current address; Dev Raman: 12 Old Street, Austin TX",
    });
  });
});

describe("a bankruptcy only the co-borrower declared", () => {
  const clean = who("Ada", "Lovelace", DECLARED, [CURRENT]);
  const declared = who(
    "Dev",
    "Raman",
    { ...DECLARED, bankruptcy: true, bankruptcyChapters: ["ChapterSeven"] },
    [CURRENT],
  );
  const both = household(clean, declared);

  it("is a bankruptcy the file has declared", () => {
    // The file used to carry ONE copy of Section 5 and it was borrower 1's, so
    // this read false and APP-024 never reached the outstanding list.
    expect(evaluateCondition("declared_bankruptcy", both)).toBe(true);
  });

  it("does not report it as all-no under APP-023", () => {
    expect(EVALUATORS["APP-023"]!(both)).toEqual({
      status: "satisfied",
      evidence: "Ada Lovelace: section 5b answered, all no; Dev Raman: section 5b answered, 1 yes",
    });
  });

  it("asks the chapters of him and not of her", () => {
    expect(EVALUATORS["APP-024"]!(both)).toEqual({
      status: "satisfied",
      evidence: "Ada Lovelace: no bankruptcy declared; Dev Raman: ChapterSeven",
    });
    // And an unnamed chapter is his failure, under his name, rather than the
    // file's.
    const vague = household(
      clean,
      who("Dev", "Raman", { ...DECLARED, bankruptcy: true }, [CURRENT]),
    );
    expect(EVALUATORS["APP-024"]!(vague)).toEqual({
      status: "unsatisfied",
      missing: "Dev Raman: a bankruptcy was declared with no chapter named",
    });
  });

  it("leaves a borrower nobody has asked undetermined rather than clean", () => {
    // `ofAnyBorrower` over a three-valued answer: one silence cannot settle it.
    const silent = household(who("Ada", "Lovelace", null), declared);
    expect(evaluateCondition("declared_bankruptcy", silent)).toBe(true);
    const neither = household(
      who("Ada", "Lovelace", null),
      who("Dev", "Raman", DECLARED, [CURRENT]),
    );
    expect(evaluateCondition("declared_bankruptcy", neither)).toBeNull();
  });
});
