/**
 * The questions of screen 3, in the one place they are worded.
 *
 * Two screens read this file. Screen 3 asks the questions; screen 5 shows the
 * answers back above the signature. They have to use the same words, because
 * "here is what you told us" is only true if it is the same question — a
 * second wording is a second question, and the borrower attests to the one
 * they were not asked.
 *
 * Nothing here is derived from anything. Screen 5 used to build five
 * declarations out of a credit report, a lien search, an asset report and a
 * county record and put them above the signature as though the borrower had
 * said them. A clean credit report is absence of evidence rather than a "no",
 * and an unrun pull is not even that. So every answer on this path starts as a
 * person typing it.
 *
 * The letters are URLA's. They key the explanations the borrower writes and
 * they are the only ids on this path — a requirement id never reaches a
 * borrower, here or anywhere else in the flow.
 */

import type {
  BankruptcyChapter,
  BorrowerDeclaration,
  BorrowerResidence,
  PriorPropertyTitle,
  PriorPropertyUsage,
  ResidencyBasis,
} from "@hm/shared";
import { RESIDENCE_HISTORY_MONTHS } from "@hm/shared";
import { money } from "./figures.js";

/** Unanswered is a third value, and it is the one a fresh form starts on. */
export type YesNo = "yes" | "no" | "";

/** The boolean answers, by the field the route takes them under. */
export type BooleanField =
  | "specialBorrowerSellerRelationship"
  | "undisclosedBorrowedFunds"
  | "undisclosedMortgageApplication"
  | "undisclosedCreditApplication"
  | "propertyProposedCleanEnergyLien"
  | "undisclosedComakerOfNote"
  | "outstandingJudgments"
  | "presentlyDelinquent"
  | "partyToLawsuit"
  | "priorPropertyDeedInLieuConveyed"
  | "priorPropertyShortSaleCompleted"
  | "priorPropertyForeclosureCompleted"
  | "bankruptcy";

export interface Question {
  /** URLA's letter. What an explanation is filed under. */
  readonly letter: string;
  readonly field: BooleanField;
  readonly prompt: string;
  /**
   * Only asked on a purchase (B), and sent as unanswered otherwise. DU makes
   * it conditional on the loan's purpose, so a refinance that answered it
   * would be answering a question nobody put.
   */
  readonly purchaseOnly?: boolean;
}

/** A, which is an enumeration rather than a boolean, and is asked on its own. */
export const INTENT_TO_OCCUPY = {
  letter: "A",
  prompt: "Will you live in this home as your primary residence?",
} as const;

/** A's follow-up, and its follow-up's follow-up. */
export const HOMEOWNER_PAST_THREE_YEARS = "Have you owned a home in the past three years?" as const;
export const PRIOR_PROPERTY_USAGE = "How did you use that home?" as const;
export const PRIOR_PROPERTY_TITLE = "How did you hold title to it?" as const;
export const BORROWED_FUNDS_AMOUNT = "How much?" as const;
export const BANKRUPTCY_CHAPTERS = "Which chapter, or chapters?" as const;

export const USAGE_LABELS: Readonly<Record<PriorPropertyUsage, string>> = {
  PrimaryResidence: "I lived in it",
  SecondHome: "It was a second home",
  Investment: "It was an investment property",
};

export const TITLE_LABELS: Readonly<Record<PriorPropertyTitle, string>> = {
  Sole: "In my name alone",
  JointWithSpouse: "Jointly with my spouse",
  JointWithOtherThanSpouse: "Jointly with someone other than my spouse",
};

export const CHAPTER_LABELS: Readonly<Record<BankruptcyChapter, string>> = {
  ChapterSeven: "Chapter 7",
  ChapterEleven: "Chapter 11",
  ChapterTwelve: "Chapter 12",
  ChapterThirteen: "Chapter 13",
};

export const BASIS_LABELS: Readonly<Record<ResidencyBasis, string>> = {
  Own: "I own it",
  Rent: "I rent it",
  LivingRentFree: "I live there rent free",
};

/** 5a — this property, and the money for this loan. */
export const SECTION_5A: readonly Question[] = [
  {
    letter: "B",
    field: "specialBorrowerSellerRelationship",
    prompt: "Do you have a family or business relationship with the seller?",
    purchaseOnly: true,
  },
  {
    letter: "C",
    field: "undisclosedBorrowedFunds",
    prompt: "Are you borrowing money for this loan that is not already on your application?",
  },
  {
    letter: "D1",
    field: "undisclosedMortgageApplication",
    prompt: "Have you applied for another mortgage that is not on this application?",
  },
  {
    letter: "D2",
    field: "undisclosedCreditApplication",
    prompt: "Have you applied for any other new credit that is not on this application?",
  },
  {
    letter: "E",
    field: "propertyProposedCleanEnergyLien",
    prompt: "Will this property have a new lien for energy improvements, such as PACE?",
  },
];

/** 5b — your finances. */
export const SECTION_5B: readonly Question[] = [
  {
    letter: "F",
    field: "undisclosedComakerOfNote",
    prompt: "Are you a co-signer or guarantor on a debt that is not on your application?",
  },
  {
    letter: "G",
    field: "outstandingJudgments",
    prompt: "Are there any outstanding judgments against you?",
  },
  {
    letter: "H",
    field: "presentlyDelinquent",
    prompt: "Are you behind on, or in default on, any federal debt?",
  },
  {
    letter: "I",
    field: "partyToLawsuit",
    prompt: "Are you a party to a lawsuit that could leave you owing money?",
  },
  {
    letter: "J",
    field: "priorPropertyDeedInLieuConveyed",
    prompt: "In the past seven years, have you handed a property back in place of foreclosure?",
  },
  {
    letter: "K",
    field: "priorPropertyShortSaleCompleted",
    prompt: "In the past seven years, have you completed a short sale?",
  },
  {
    letter: "L",
    field: "priorPropertyForeclosureCompleted",
    prompt: "In the past seven years, has a property of yours been foreclosed on?",
  },
  {
    letter: "M",
    field: "bankruptcy",
    prompt: "In the past seven years, have you declared bankruptcy?",
  },
];

export const QUESTIONS: readonly Question[] = [...SECTION_5A, ...SECTION_5B];

/**
 * The answers that carry an explanation box.
 *
 * A yes to any of these is something an underwriter reads before a computer
 * does, and the sheet's own note on two of them is that yes responses must be
 * explained. The text is stored and shown back; DU consumes no explanation
 * element at all, so nothing downstream goes looking for somewhere to put it.
 */
export const EXPLAINABLE: readonly BooleanField[] = [
  "undisclosedBorrowedFunds",
  "undisclosedComakerOfNote",
  "outstandingJudgments",
  "presentlyDelinquent",
  "partyToLawsuit",
  "priorPropertyDeedInLieuConveyed",
  "priorPropertyShortSaleCompleted",
  "priorPropertyForeclosureCompleted",
  "bankruptcy",
];

/* ── The form ───────────────────────────────────────────────────────────── */

export interface ResidenceForm {
  basis: ResidencyBasis | "";
  durationMonths: string;
  monthlyRent: string;
  addressLineText: string;
  addressUnit: string;
  cityName: string;
  stateCode: string;
  postalCode: string;
}

export interface DeclarationForm {
  intentToOccupy: YesNo;
  homeownerPastThreeYears: YesNo;
  priorPropertyUsage: PriorPropertyUsage | "";
  priorPropertyTitle: PriorPropertyTitle | "";
  undisclosedBorrowedFundsAmount: string;
  bankruptcyChapters: readonly BankruptcyChapter[];
  answers: Readonly<Record<BooleanField, YesNo>>;
  explanations: Readonly<Record<string, string>>;
  current: ResidenceForm;
  prior: ResidenceForm;
}

const BLANK_RESIDENCE: ResidenceForm = {
  basis: "",
  durationMonths: "",
  monthlyRent: "",
  addressLineText: "",
  addressUnit: "",
  cityName: "",
  stateCode: "",
  postalCode: "",
};

export function blankForm(): DeclarationForm {
  return {
    intentToOccupy: "",
    homeownerPastThreeYears: "",
    priorPropertyUsage: "",
    priorPropertyTitle: "",
    undisclosedBorrowedFundsAmount: "",
    bankruptcyChapters: [],
    answers: Object.fromEntries(QUESTIONS.map((q) => [q.field, ""])) as Record<BooleanField, YesNo>,
    explanations: {},
    current: { ...BLANK_RESIDENCE },
    prior: { ...BLANK_RESIDENCE },
  };
}

const yesNo = (value: boolean | null): YesNo => (value === null ? "" : value ? "yes" : "no");
const amount = (value: number | null): string => (value === null ? "" : String(value));

/**
 * The form, filled in from what was already answered.
 *
 * A borrower coming back to correct one answer must not meet an empty form:
 * this screen refuses a partial submit, so an empty form on a revisit means
 * retyping every question to change one of them.
 */
export function formFrom(
  declaration: BorrowerDeclaration | null,
  residences: readonly BorrowerResidence[],
): DeclarationForm {
  const form = blankForm();
  if (!declaration && residences.length === 0) return form;

  const answers = { ...form.answers };
  if (declaration) {
    for (const q of QUESTIONS) answers[q.field] = yesNo(declaration[q.field]);
  }

  const residence = (r: BorrowerResidence | undefined): ResidenceForm =>
    r
      ? {
          basis: r.basis,
          durationMonths: String(r.durationMonths),
          monthlyRent: amount(r.monthlyRent),
          addressLineText: r.addressLineText ?? "",
          addressUnit: r.addressUnit ?? "",
          cityName: r.cityName ?? "",
          stateCode: r.stateCode ?? "",
          postalCode: r.postalCode ?? "",
        }
      : { ...BLANK_RESIDENCE };

  return {
    ...form,
    intentToOccupy: declaration ? (declaration.intentToOccupy === "Yes" ? "yes" : "no") : "",
    homeownerPastThreeYears:
      declaration?.homeownerPastThreeYears == null
        ? ""
        : declaration.homeownerPastThreeYears === "Yes"
          ? "yes"
          : "no",
    priorPropertyUsage: declaration?.priorPropertyUsage ?? "",
    priorPropertyTitle: declaration?.priorPropertyTitle ?? "",
    undisclosedBorrowedFundsAmount: amount(declaration?.undisclosedBorrowedFundsAmount ?? null),
    bankruptcyChapters: declaration?.bankruptcyChapters ?? [],
    answers,
    explanations: declaration?.explanations ?? {},
    current: residence(residences.find((r) => r.residencyType === "Current")),
    prior: residence(residences.find((r) => r.residencyType === "Prior")),
  };
}

/** Whether the second address block is asked for at all. */
export function priorResidenceNeeded(form: DeclarationForm): boolean {
  const months = Number(form.current.durationMonths);
  if (form.current.durationMonths === "" || Number.isNaN(months)) return false;
  return months < RESIDENCE_HISTORY_MONTHS;
}

/** Whether this question is put to this borrower at all. */
export function asked(question: Question, purchase: boolean): boolean {
  return !question.purchaseOnly || purchase;
}

/**
 * What is still unanswered, in the borrower's words.
 *
 * The route refuses a partial submit and names the field it refused, which is
 * the right place for the rule to live and the wrong place for a borrower to
 * meet it one field at a time. This is the same rule, asked before the post.
 */
export function missingFrom(form: DeclarationForm, purchase: boolean): readonly string[] {
  const missing: string[] = [];
  if (form.intentToOccupy === "") missing.push(INTENT_TO_OCCUPY.prompt);
  if (form.intentToOccupy === "yes" && form.homeownerPastThreeYears === "") {
    missing.push(HOMEOWNER_PAST_THREE_YEARS);
  }
  if (
    form.intentToOccupy === "yes" &&
    form.homeownerPastThreeYears === "yes" &&
    form.priorPropertyUsage === ""
  ) {
    missing.push(PRIOR_PROPERTY_USAGE);
  }
  for (const q of QUESTIONS) {
    if (asked(q, purchase) && form.answers[q.field] === "") missing.push(q.prompt);
  }
  if (form.answers.undisclosedBorrowedFunds === "yes" && form.undisclosedBorrowedFundsAmount === "")
    missing.push(BORROWED_FUNDS_AMOUNT);
  if (form.answers.bankruptcy === "yes" && form.bankruptcyChapters.length === 0)
    missing.push(BANKRUPTCY_CHAPTERS);

  missing.push(...missingResidence(form.current, "Where you live now"));
  if (priorResidenceNeeded(form)) {
    missing.push(...missingResidence(form.prior, "Where you lived before that"));
    if (!form.prior.addressLineText) missing.push("Your previous street address");
    if (!form.prior.cityName) missing.push("The city you lived in before");
    if (!/^[A-Za-z]{2}$/.test(form.prior.stateCode)) missing.push("The state you lived in before");
    if (!/^([0-9]{5}|[0-9]{9})$/.test(form.prior.postalCode))
      missing.push("Your previous ZIP code");
  }
  return missing;
}

function missingResidence(residence: ResidenceForm, label: string): readonly string[] {
  const missing: string[] = [];
  if (residence.basis === "") missing.push(`${label}: own, rent or rent free`);
  const months = Number(residence.durationMonths);
  if (residence.durationMonths === "" || !Number.isInteger(months) || months < 0 || months > 999) {
    missing.push(`${label}: how many months`);
  }
  return missing;
}

/** Dollars off a text field, with a blank meaning none rather than zero. */
const dollars = (value: string): number | null => {
  const digits = value.replace(/[^0-9.]/g, "");
  if (digits === "") return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
};

/**
 * The body `POST /files/:id/declaration` takes.
 *
 * Every field the route calls required is here, and every conditional one is
 * present exactly when its trigger says it was asked — both directions, the
 * way the CHECK constraints behind the route are written. A follow-up answered
 * when its trigger says it was never put is as wrong as a missing one.
 */
export function bodyFrom(form: DeclarationForm, purchase: boolean) {
  const bool = (field: BooleanField): boolean => form.answers[field] === "yes";
  const occupying = form.intentToOccupy === "yes";
  const owned = occupying && form.homeownerPastThreeYears === "yes";

  const explanations: Record<string, string> = {};
  for (const q of QUESTIONS) {
    const text = form.explanations[q.letter]?.trim();
    if (text && bool(q.field) && EXPLAINABLE.includes(q.field)) explanations[q.letter] = text;
  }

  return {
    declaration: {
      intentToOccupy: occupying ? "Yes" : "No",
      homeownerPastThreeYears: occupying
        ? form.homeownerPastThreeYears === "yes"
          ? "Yes"
          : "No"
        : null,
      priorPropertyUsage: owned ? form.priorPropertyUsage : null,
      // Optional in DU with no conditionality of its own, so it goes when the
      // borrower stated it and is absent when they did not.
      priorPropertyTitle: owned && form.priorPropertyTitle ? form.priorPropertyTitle : null,
      // Asked only on an FHA file, which this flow does not originate. Null is
      // "not asked", which is the truth about it.
      fhaSecondaryResidence: null,
      specialBorrowerSellerRelationship: purchase
        ? form.answers.specialBorrowerSellerRelationship === "yes"
        : null,
      undisclosedBorrowedFunds: bool("undisclosedBorrowedFunds"),
      undisclosedBorrowedFundsAmount: bool("undisclosedBorrowedFunds")
        ? dollars(form.undisclosedBorrowedFundsAmount)
        : null,
      undisclosedMortgageApplication: bool("undisclosedMortgageApplication"),
      undisclosedCreditApplication: bool("undisclosedCreditApplication"),
      propertyProposedCleanEnergyLien: bool("propertyProposedCleanEnergyLien"),
      undisclosedComakerOfNote: bool("undisclosedComakerOfNote"),
      outstandingJudgments: bool("outstandingJudgments"),
      presentlyDelinquent: bool("presentlyDelinquent"),
      partyToLawsuit: bool("partyToLawsuit"),
      priorPropertyDeedInLieuConveyed: bool("priorPropertyDeedInLieuConveyed"),
      priorPropertyShortSaleCompleted: bool("priorPropertyShortSaleCompleted"),
      priorPropertyForeclosureCompleted: bool("priorPropertyForeclosureCompleted"),
      bankruptcy: bool("bankruptcy"),
      bankruptcyChapters: bool("bankruptcy") ? [...form.bankruptcyChapters] : [],
      explanations: Object.keys(explanations).length > 0 ? explanations : null,
    },
    residences: [
      {
        residencyType: "Current" as const,
        basis: form.current.basis as ResidencyBasis,
        durationMonths: Number(form.current.durationMonths),
        // One-directional, like the CHECK: an amount needs a rented home, and
        // a rented home needs no amount.
        monthlyRent: form.current.basis === "Rent" ? dollars(form.current.monthlyRent) : null,
      },
      ...(priorResidenceNeeded(form)
        ? [
            {
              residencyType: "Prior" as const,
              basis: form.prior.basis as ResidencyBasis,
              durationMonths: Number(form.prior.durationMonths),
              monthlyRent: form.prior.basis === "Rent" ? dollars(form.prior.monthlyRent) : null,
              addressLineText: form.prior.addressLineText,
              addressUnit: form.prior.addressUnit || null,
              cityName: form.prior.cityName,
              stateCode: form.prior.stateCode.toUpperCase(),
              postalCode: form.prior.postalCode,
            },
          ]
        : []),
    ],
  };
}

/* ── What screen 5 reads back ───────────────────────────────────────────── */

export interface AnswerLine {
  readonly prompt: string;
  readonly answer: string;
  /** The borrower's own words, where they wrote any. */
  readonly explanation?: string;
}

const months = (count: number): string => `${count} ${count === 1 ? "month" : "months"}`;

/**
 * The borrower's answers, in the words they were asked in.
 *
 * This is the whole of what screen 5 puts above the signature. It reads the
 * stored declaration and nothing else: no credit report, no lien search, no
 * asset report, no county record. A line here is something a person said.
 */
export function answerLines(
  declaration: BorrowerDeclaration | null,
  residences: readonly BorrowerResidence[],
): readonly AnswerLine[] {
  const lines: AnswerLine[] = [];
  const current = residences.find((r) => r.residencyType === "Current");
  const prior = residences.find((r) => r.residencyType === "Prior");

  if (current) {
    lines.push({
      prompt: "Where you live now",
      answer:
        `${BASIS_LABELS[current.basis]}, ${months(current.durationMonths)}` +
        (current.monthlyRent != null ? `, ${money(current.monthlyRent)} a month` : ""),
    });
  }
  if (prior) {
    lines.push({
      prompt: "Where you lived before that",
      answer: `${prior.addressLineText}, ${prior.cityName} ${prior.stateCode} — ${months(
        prior.durationMonths,
      )}`,
    });
  }
  if (!declaration) return lines;

  lines.push({
    prompt: INTENT_TO_OCCUPY.prompt,
    answer: declaration.intentToOccupy === "Yes" ? "Yes" : "No",
  });
  if (declaration.homeownerPastThreeYears != null) {
    lines.push({
      prompt: HOMEOWNER_PAST_THREE_YEARS,
      answer: declaration.homeownerPastThreeYears === "Yes" ? "Yes" : "No",
    });
  }
  if (declaration.priorPropertyUsage) {
    lines.push({
      prompt: PRIOR_PROPERTY_USAGE,
      answer: USAGE_LABELS[declaration.priorPropertyUsage],
    });
  }
  if (declaration.priorPropertyTitle) {
    lines.push({
      prompt: PRIOR_PROPERTY_TITLE,
      answer: TITLE_LABELS[declaration.priorPropertyTitle],
    });
  }

  for (const q of QUESTIONS) {
    const value = declaration[q.field];
    // Null is a question that was never put — on a refinance, B is not asked,
    // and printing "No" would be an answer nobody gave.
    if (value === null) continue;
    const line: AnswerLine = {
      prompt: q.prompt,
      answer: value ? "Yes" : "No",
      explanation: declaration.explanations?.[q.letter],
    };
    lines.push(line);
    if (q.field === "undisclosedBorrowedFunds" && declaration.undisclosedBorrowedFundsAmount) {
      lines.push({
        prompt: BORROWED_FUNDS_AMOUNT,
        answer: money(declaration.undisclosedBorrowedFundsAmount),
      });
    }
    if (q.field === "bankruptcy" && declaration.bankruptcyChapters.length > 0) {
      lines.push({
        prompt: BANKRUPTCY_CHAPTERS,
        answer: declaration.bankruptcyChapters.map((c) => CHAPTER_LABELS[c]).join(", "),
      });
    }
  }

  return lines;
}
