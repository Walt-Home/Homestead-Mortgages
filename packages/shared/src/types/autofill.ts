/**
 * A suggestion: something the product found, offered beside a question, and
 * never an answer.
 *
 * `docs/autofill.md` is the design. The shape it fixes: a suggestion is
 * computed on every read from rows that already exist, it is handed back
 * beside what the screen reads and stored nowhere, it is rendered as a
 * caption with a source tag and never as a filled control, and the person's
 * own save is the confirmation, written under their own principal as
 * SELF_ATTESTED exactly as a typed answer is. The suggestion is never the
 * fact. What is recorded is the outcome (`autofill_accepted`, `_corrected`,
 * `_dismissed`), one FileEvent per suggestion the screen rendered.
 *
 * The key union is closed and small on purpose, and a test holds that no key
 * can name a Section 5 field, a demographic, occupancy, citizenship, marital
 * status, military service or the first-time flag: those are asked bare and
 * only ever checked after the fact.
 *
 * Two sources so far. `bank`: the person's own consumer report, ordered as an
 * extension of credit. `prior_statement`: what the person themselves told us
 * before, a SELF_ATTESTED fact asserted under their own principal and still
 * live, and nothing anybody else said about them (a servicer's tape, an
 * applicant naming a co-borrower).
 */

export const AUTOFILL_RULES = "hm.autofill.v1";

export const SUGGESTION_KEYS = ["current_monthly_rent", "stated_monthly_income", "phone"] as const;
export type SuggestionKey = (typeof SUGGESTION_KEYS)[number];

export type SuggestionSource = "bank" | "prior_statement";

/** Where each key's evidence comes from, which is what a save's outcome is checked against. */
export const SUGGESTION_SOURCE: Readonly<Record<SuggestionKey, SuggestionSource>> = {
  current_monthly_rent: "bank",
  stated_monthly_income: "prior_statement",
  phone: "prior_statement",
};

/** The fact a prior-statement key is read from. */
export const PRIOR_STATEMENT_PREDICATE = {
  stated_monthly_income: "monthly_income",
  phone: "phone",
} as const;

/** The borrower-facing words for where a suggestion came from. */
export const SUGGESTION_TAG = {
  bank: "From your bank activity",
  prior_statement: "What you told us before",
} as const;

/** The only purpose a bank-sourced suggestion may be computed under. */
export const EXTENSION_OF_CREDIT = "EXTENSION_OF_CREDIT";

/**
 * The row a suggestion was computed from: a connector snapshot for the bank,
 * a fact for a prior statement. `at` is when it was observed.
 */
export interface SuggestionEvidence {
  readonly kind: "snapshot" | "fact";
  readonly id: string;
  readonly at: string;
}

export interface Suggestion {
  readonly key: SuggestionKey;
  /** The screen that renders it, by `ScreenPath`. */
  readonly screen: "property" | "identity" | "declarations";
  /** A caption beside a control, one tap at most, never a filled field. */
  readonly mode: "suggest";
  readonly target:
    | {
        readonly kind: "residence";
        readonly residencyType: "Current";
        readonly field: "monthlyRent";
      }
    | { readonly kind: "fact"; readonly predicate: "monthly_income" | "phone" };
  readonly value: number | string;
  readonly source: SuggestionSource;
  readonly tag: (typeof SUGGESTION_TAG)[SuggestionSource];
  /** One short line a person can read, beside the tag. */
  readonly basis: string;
  readonly evidence: SuggestionEvidence;
  /**
   * The tier the evidence holds, and the ceiling: a rule over vendor bytes is
   * an estimate, a person's own earlier statement is already attested. The
   * written row is the borrower's own, at ATTESTED, whatever this says.
   */
  readonly evidenceTier: "estimated" | "attested";
  /** The reader's party, and never anyone else's. */
  readonly partyId: string;
}

/**
 * A read-back: two figures side by side above the signature, and nothing to
 * take. Where a suggestion offers a value for a field, a read-back shows the
 * person what they told us beside what was found, so the signature attests
 * with both in view. No edit in place, no outcome, no diary row: it changes
 * nothing, and the engine reads neither figure from it.
 */
export const READ_BACK_KEYS = ["stated_vs_found_income"] as const;
export type ReadBackKey = (typeof READ_BACK_KEYS)[number];

export interface ReadBack {
  readonly key: ReadBackKey;
  readonly screen: "review";
  /** What the person told us, and the fact it was told in. */
  readonly stated: { readonly value: number; readonly evidence: SuggestionEvidence };
  /** What their own bank report shows, how many streams make it up, and the report. */
  readonly found: {
    readonly value: number;
    readonly streams: number;
    readonly evidence: SuggestionEvidence;
  };
  readonly tag: (typeof SUGGESTION_TAG)["bank"];
  /** The reader's party, and never anyone else's. */
  readonly partyId: string;
}

export const AUTOFILL_OUTCOMES = ["accepted", "corrected", "dismissed"] as const;
export type AutofillOutcome = (typeof AUTOFILL_OUTCOMES)[number];

/** What a screen reports back with its save, for each suggestion it rendered. */
export interface AutofillOutcomeInput {
  readonly key: SuggestionKey;
  /** The evidence row the suggestion named: `suggestion.evidence.id`. */
  readonly evidenceId: string;
  readonly outcome: AutofillOutcome;
  readonly proposed?: unknown;
  readonly given?: unknown;
}

/** The dismissal a reader made, keyed so newer evidence offers again. */
export function dismissalKey(key: SuggestionKey, evidenceId: string): string {
  return `${key}@${evidenceId}`;
}
