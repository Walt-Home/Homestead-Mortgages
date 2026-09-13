/**
 * The questions, the answers read back, and the words above the signature.
 *
 * The signing copy is regulated: it is what a borrower is told their signature
 * covers, and until this commit it covered five declarations the product had
 * INFERRED — "No bankruptcy in the last 7 years" off a credit report's public
 * records, "No undisclosed borrowed funds" off an asset report, "No prior
 * ownership interest in the last 3 years" off a county record — under the
 * words "Here is what we found. Signing confirms it." An unrun pull left every
 * line reading clean, so a borrower with no credit report signed a statement
 * that they had never been bankrupt, on the strength of our having looked
 * nowhere.
 *
 * So the copy is asserted word for word rather than by shape. A rewrite of
 * these sentences is a change to what somebody attests to, and it should have
 * to be made twice: once in the catalog and once here.
 */

import { describe, expect, it } from "vitest";
import { BRITISH, DAY_FIRST, DELIVERY_TIME, PROMISES, REQ_ID } from "@hm/shared";
import type { BorrowerDeclaration, BorrowerResidence } from "@hm/shared";
import { SIGNING_COPY } from "../outcomes.js";
import {
  BANKRUPTCY_CHAPTERS,
  BORROWED_FUNDS_AMOUNT,
  HOMEOWNER_PAST_THREE_YEARS,
  INTENT_TO_OCCUPY,
  PRIOR_PROPERTY_TITLE,
  PRIOR_PROPERTY_USAGE,
  QUESTIONS,
  answerLines,
  blankForm,
  bodyFrom,
  formFrom,
  missingFrom,
  priorResidenceNeeded,
  type DeclarationForm,
} from "../declarations.js";

const NOTHING_DECLARED: BorrowerDeclaration = {
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

const RENTING: BorrowerResidence = {
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

/** Every question answered, the follow-ups taken, one previous address. */
function filledIn(): DeclarationForm {
  const form = blankForm();
  const answers = { ...form.answers };
  for (const q of QUESTIONS) answers[q.field] = "no";
  return {
    ...form,
    intentToOccupy: "yes",
    homeownerPastThreeYears: "yes",
    priorPropertyUsage: "PrimaryResidence",
    priorPropertyTitle: "Sole",
    answers,
    current: { ...form.current, basis: "Rent", durationMonths: "14", monthlyRent: "1850" },
    prior: {
      ...form.prior,
      basis: "Rent",
      durationMonths: "36",
      monthlyRent: "1600",
      addressLineText: "12 Old Street",
      cityName: "Austin",
      stateCode: "TX",
      postalCode: "78701",
    },
  };
}

describe("the words above the signature", () => {
  it("says the answers are the borrower's own, and that signing says they are true", () => {
    expect(SIGNING_COPY).toEqual({
      heading: "What you told us",
      lead: "These are your own answers, in your words. Signing says they are true and complete.",
      change: "Change an answer",
      unanswered: "There are a few questions still to answer before you sign.",
      // The sentence above names work on another screen, so it needs a
      // control. Without one it sat over a signature the screen was happy to
      // take, which is the whole of what the gate now refuses.
      answerThem: "Answer them now",
      panelTitle: "Your application",
      panelBody:
        "This is the application itself — the property, the loan, your details and the answers above. It also includes IRS Form 4506-C, which lets us request your tax records directly rather than asking you to find them.",
      panelTerms:
        "Signing submits it, and says the answers above are true and complete. It does not commit you to borrowing anything, and it is not an agreement to any particular rate or terms.",
      signButton: "Sign and submit",
    });
  });

  it("claims nothing was found, because nothing was looked up", () => {
    // The sentence this replaced was "Here is what we found. Signing confirms
    // it.", over a list built from four connectors. Neither half may come back.
    const words = Object.values(SIGNING_COPY).join(" ");
    expect(words).not.toMatch(/what we found/i);
    expect(words).not.toMatch(/\b(credit report|lien search|bank activity|property records)\b/i);
  });

  it("keeps every rule the rest of the borrower copy keeps", () => {
    for (const line of [...Object.values(SIGNING_COPY), ...QUESTIONS.map((q) => q.prompt)]) {
      expect(line, line).not.toMatch(PROMISES);
      expect(line, line).not.toMatch(DELIVERY_TIME);
      expect(line, line).not.toMatch(REQ_ID);
      expect(line, line).not.toMatch(BRITISH);
      expect(line, line).not.toMatch(DAY_FIRST);
    }
  });
});

describe("the questions", () => {
  it("is all fourteen of URLA's lettered ones, each asked once", () => {
    // Pinned by letter rather than iterated, because every other assertion in
    // this file walks QUESTIONS — so a question quietly dropped from the
    // catalog would take its own coverage with it and nothing would fail.
    expect([INTENT_TO_OCCUPY.letter, ...QUESTIONS.map((q) => q.letter)]).toEqual([
      "A",
      "B",
      "C",
      "D1",
      "D2",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
      "M",
    ]);
    // D is two DU-required booleans behind one lettered question — the place a
    // naive A-through-M enumeration loses a field.
    expect(new Set(QUESTIONS.map((q) => q.field)).size).toBe(QUESTIONS.length);
  });

  it("puts only B on a purchase, and every other one on every file", () => {
    expect(QUESTIONS.filter((q) => q.purchaseOnly).map((q) => q.letter)).toEqual(["B"]);
  });
});

describe("the answers read back", () => {
  it("is the borrower's own answers and nothing else", () => {
    const lines = answerLines(NOTHING_DECLARED, [RENTING]);
    // One line per question actually put, plus the residence.
    expect(lines[0]).toEqual({
      prompt: "Where you live now",
      answer: "I rent it, 30 months, $1,850 a month",
    });
    expect(lines.map((l) => l.prompt)).toContain(INTENT_TO_OCCUPY.prompt);
    expect(lines.map((l) => l.prompt)).toContain(HOMEOWNER_PAST_THREE_YEARS);
    for (const q of QUESTIONS) expect(lines.map((l) => l.prompt)).toContain(q.prompt);
  });

  it("says nothing at all about a borrower who has not been asked", () => {
    // The failure this replaced rendered five clean declarations on exactly
    // this file, because a connector that had not run found nothing.
    expect(answerLines(null, [])).toEqual([]);
  });

  it("leaves out a question that was never put", () => {
    // B is asked on a purchase. On a refinance it is null, and a "No" printed
    // beside it would be an answer nobody gave.
    const refinance = { ...NOTHING_DECLARED, specialBorrowerSellerRelationship: null };
    const prompts = answerLines(refinance, [RENTING]).map((l) => l.prompt);
    expect(prompts).not.toContain(QUESTIONS[0]!.prompt);
  });

  it("carries the amount, the chapters and the borrower's own words", () => {
    const lines = answerLines(
      {
        ...NOTHING_DECLARED,
        undisclosedBorrowedFunds: true,
        undisclosedBorrowedFundsAmount: 12_000,
        bankruptcy: true,
        bankruptcyChapters: ["ChapterSeven"],
        explanations: { M: "Discharged in 2019." },
      },
      [RENTING],
    );
    expect(lines.find((l) => l.prompt === BORROWED_FUNDS_AMOUNT)?.answer).toBe("$12,000");
    expect(lines.find((l) => l.prompt === BANKRUPTCY_CHAPTERS)?.answer).toBe("Chapter 7");
    expect(lines.find((l) => l.explanation)?.explanation).toBe("Discharged in 2019.");
  });

  it("reads back the previous address when there is one", () => {
    const prior: BorrowerResidence = {
      ...RENTING,
      residencyType: "Prior",
      durationMonths: 36,
      addressLineText: "12 Old Street",
      cityName: "Austin",
      stateCode: "TX",
      postalCode: "78701",
    };
    const lines = answerLines(NOTHING_DECLARED, [RENTING, prior]);
    expect(lines[1]).toEqual({
      prompt: "Where you lived before that",
      answer: "12 Old Street, Austin TX — 36 months",
    });
  });
});

describe("the form", () => {
  it("will not submit until every question is answered", () => {
    const empty = missingFrom(blankForm(), true);
    // The route refuses a partial body and names one field; the screen names
    // all of them, because a borrower meeting that refusal one question at a
    // time is meeting it wrong.
    expect(empty).toContain(INTENT_TO_OCCUPY.prompt);
    for (const q of QUESTIONS) expect(empty).toContain(q.prompt);
    expect(missingFrom(filledIn(), true)).toEqual([]);
  });

  it("asks for the previous address only under two years", () => {
    const form = filledIn();
    expect(priorResidenceNeeded(form)).toBe(true);
    expect(
      priorResidenceNeeded({ ...form, current: { ...form.current, durationMonths: "24" } }),
    ).toBe(false);
    // Unanswered is not "a long time": an empty field must not silently
    // withdraw the question.
    expect(priorResidenceNeeded(blankForm())).toBe(false);
  });

  it("sends every answer the route requires", () => {
    const body = bodyFrom(filledIn(), true);
    expect(body.declaration.intentToOccupy).toBe("Yes");
    expect(body.declaration.homeownerPastThreeYears).toBe("Yes");
    expect(body.declaration.priorPropertyUsage).toBe("PrimaryResidence");
    expect(body.declaration.priorPropertyTitle).toBe("Sole");
    for (const q of QUESTIONS) {
      expect(body.declaration[q.field], q.field).toBe(false);
    }
    expect(body.residences).toHaveLength(2);
    expect(body.residences[0]).toEqual({
      residencyType: "Current",
      basis: "Rent",
      durationMonths: 14,
      monthlyRent: 1850,
    });
  });

  it("withdraws a follow-up when its trigger says it was never put", () => {
    // Both directions, the way the CHECK behind the route reads: a follow-up
    // answered under a trigger that says it was not asked is as wrong as a
    // missing one.
    const body = bodyFrom({ ...filledIn(), intentToOccupy: "no" }, true);
    expect(body.declaration.homeownerPastThreeYears).toBeNull();
    expect(body.declaration.priorPropertyUsage).toBeNull();
    expect(
      bodyFrom({ ...filledIn(), homeownerPastThreeYears: "no" }, true).declaration
        .priorPropertyUsage,
    ).toBeNull();
  });

  it("leaves the purchase-only question unanswered on a refinance", () => {
    expect(bodyFrom(filledIn(), false).declaration.specialBorrowerSellerRelationship).toBeNull();
    expect(bodyFrom(filledIn(), true).declaration.specialBorrowerSellerRelationship).toBe(false);
  });

  it("sends a rent amount only where there is rent to pay", () => {
    const owned = filledIn();
    owned.current = { ...owned.current, basis: "Own", monthlyRent: "1850" };
    expect(bodyFrom(owned, true).residences[0]!.monthlyRent).toBeNull();
  });

  it("comes back filled in, so one answer can be corrected", () => {
    // An empty form on a revisit means retyping seventeen answers to change a
    // month, and this screen refuses a partial submit.
    const form = formFrom(NOTHING_DECLARED, [RENTING]);
    expect(form.intentToOccupy).toBe("yes");
    expect(form.answers.bankruptcy).toBe("no");
    expect(form.current.durationMonths).toBe("30");
    expect(form.current.monthlyRent).toBe("1850");
  });

  it("carries the two follow-up prompts a borrower can meet", () => {
    // Named so a rename here fails rather than leaving screen 5 reading an
    // answer back under different words than it was asked in.
    expect(PRIOR_PROPERTY_USAGE).toBe("How did you use that home?");
    expect(PRIOR_PROPERTY_TITLE).toBe("How did you hold title to it?");
  });
});
