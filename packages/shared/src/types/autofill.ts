/**
 * A suggestion: something the product found, offered beside a question, and
 * never an answer.
 *
 * `docs/autofill.md` is the design. The shape it fixes: a suggestion is
 * computed on every read of a file from rows that already exist, it is
 * handed back beside the file and stored nowhere, it is rendered as a caption
 * with a source tag and never as a filled control, and the borrower's own
 * save is the confirmation, written under their own principal as
 * SELF_ATTESTED exactly as a typed answer is. The suggestion is never the
 * fact. What is recorded is the outcome (`autofill_accepted`, `_corrected`,
 * `_dismissed`), one FileEvent per suggestion the screen rendered.
 *
 * The key union is closed and small on purpose, and a test holds that no key
 * can name a Section 5 field, a demographic, occupancy, citizenship, marital
 * status, military service or the first-time flag: those are asked bare and
 * only ever checked after the fact. The first key is the rent, which is URLA
 * 1a housing and not a declaration, suggested only after the person has said
 * they rent, from a category-gated run in their own bank report, under a
 * purpose certified to the bureau as an extension of credit.
 */

export const AUTOFILL_RULES = "hm.autofill.v1";

export const SUGGESTION_KEYS = ["current_monthly_rent"] as const;
export type SuggestionKey = (typeof SUGGESTION_KEYS)[number];

/** The only purpose a bank-sourced suggestion may be computed under. */
export const EXTENSION_OF_CREDIT = "EXTENSION_OF_CREDIT";

export interface Suggestion {
  readonly key: SuggestionKey;
  /** The screen that renders it, by `ScreenPath`. */
  readonly screen: "declarations";
  /** A caption beside a control, one tap at most, never a filled field. */
  readonly mode: "suggest";
  readonly target: {
    readonly kind: "residence";
    readonly residencyType: "Current";
    readonly field: "monthlyRent";
  };
  readonly value: number;
  readonly source: "bank";
  /** The borrower-facing words for where it came from. */
  readonly tag: "From your bank activity";
  /** One sentence a person can read, with the figure and the payee in it. */
  readonly basis: string;
  readonly evidence: { readonly snapshotId: string; readonly retrievedAt: string };
  /**
   * The tier the evidence holds, and the ceiling: a rule over vendor bytes is
   * an estimate. The written row is the borrower's own, at ATTESTED, whatever
   * this says.
   */
  readonly evidenceTier: "estimated";
  /** The reader's party, and never anyone else's. */
  readonly partyId: string;
}

export const AUTOFILL_OUTCOMES = ["accepted", "corrected", "dismissed"] as const;
export type AutofillOutcome = (typeof AUTOFILL_OUTCOMES)[number];

/** What a screen reports back with its save, for each suggestion it rendered. */
export interface AutofillOutcomeInput {
  readonly key: SuggestionKey;
  readonly snapshotId: string;
  readonly outcome: AutofillOutcome;
  readonly proposed?: unknown;
  readonly given?: unknown;
}

/** The dismissal a reader made, keyed so a newer snapshot offers again. */
export function dismissalKey(key: SuggestionKey, snapshotId: string): string {
  return `${key}@${snapshotId}`;
}
