/**
 * What Desktop Underwriter answers with.
 *
 * Three things come back: a recommendation, a findings report, and the casefile
 * identifier DU minted. This file is the vocabulary for the first two; the
 * identifier is a `VARCHAR(30)` on `applications` and DU chooses it.
 *
 * ── A DU recommendation is not our decision ───────────────────────────────
 *
 * `AusRecommendation` in `types/decision.ts` is what OUR engine returns, and it
 * is deliberately DU-shaped so that a real submission could one day stand where
 * the shadow engine stands. That resemblance is the hazard this type exists to
 * keep apart, and the spellings are kept verbatim from DU so that the two can
 * never be assigned to one another by accident: "Approve/Eligible" is not
 * `approve_eligible`, and the compiler says so at every call site.
 *
 * They are not the same sentence either. Our `refer` means "we could not
 * compute this" — the engine returns it whenever any input was blocked, which
 * is why a `refer` becomes `referred` and carries no edge out of underwriting.
 * DU's `Refer` means the opposite: DU computed the whole thing and is telling us
 * a human has to underwrite it. And DU splits by eligibility where we do not,
 * so "Refer/Ineligible" — computed, underwritable by hand, and not saleable to
 * Fannie on these terms — has no member of ours to land on without losing half
 * of what it said.
 *
 * What DU says is Fannie Mae's assessment of a loan they might buy. The
 * creditor here is Grander, and an extension of credit is theirs to decide.
 * Nothing in this file may be rendered as an approval or a denial.
 *
 * ── Why the set is ours and an unknown value is refused ───────────────────
 *
 * The vendored corpus in `packages/du-schema` specifies what we SEND. It
 * enumerates nothing DU answers with: `AutomatedUnderwritingRecommendationDescription`
 * is a `MISMOString` in the schema chain, free text with no enumeration behind
 * it, and the specification workbook names a recommendation only in prose — an
 * implementation note about retired ARM plans receiving an "Out of Scope" one.
 *
 * So this closed set is written from DU's published recommendations rather than
 * derived from a file, and there is nothing for `du:verify` to diff it against.
 * That is exactly why `parseDuRecommendation` refuses what it does not
 * recognize instead of passing it through: a value nobody here has read is a
 * value nobody here has decided what to do about, and storing it would make the
 * first person to see it guess.
 *
 * `parseDuResponseStatus` is the same refusal on the field that decides which
 * of the two shapes below a response is, and it is the one that has to be
 * loudest. A recommendation nobody recognizes at least arrives labelled as a
 * recommendation; a STATUS nobody recognizes, quietly read as "errored",
 * discards a verdict DU gave and records that DU gave none.
 */

/**
 * The six, spelled the way DU spells them.
 *
 * Two axes flattened into one set, because DU reports them flattened: the
 * credit-risk half (Approve, Refer, Refer with Caution) and the eligibility
 * half (Eligible, Ineligible) — except where DU does not cross them, which is
 * the whole reason this is a list and not a product of two enums.
 */
export const DU_RECOMMENDATIONS = [
  "Approve/Eligible",
  "Approve/Ineligible",
  "Refer/Eligible",
  "Refer/Ineligible",
  "Refer with Caution",
  "Out of Scope",
] as const;

export type DuRecommendation = (typeof DU_RECOMMENDATIONS)[number];

/** Thrown rather than defaulted. See the header. */
export class UnknownDuRecommendationError extends Error {
  constructor(readonly value: string) {
    super(
      `Desktop Underwriter answered with a recommendation this system does not know: ${JSON.stringify(value)}. ` +
        "Nothing is stored and nothing moves until somebody decides what it means.",
    );
    this.name = "UnknownDuRecommendationError";
  }
}

/**
 * Read DU's own spelling, or refuse it.
 *
 * Surrounding whitespace is trimmed and nothing else is normalized. A transport
 * that pads a field has not said a different thing; a case or a word that
 * differs has, and folding either would be this function inventing a member.
 */
export function parseDuRecommendation(value: string): DuRecommendation {
  const trimmed = value.trim();
  const known = DU_RECOMMENDATIONS.find((r) => r === trimmed);
  if (!known) throw new UnknownDuRecommendationError(value);
  return known;
}

/**
 * One line of the findings report.
 *
 * `category` is free text and deliberately not an enum. We hold the submission
 * specification and not the response one, so a closed set here would be built
 * from the handful of category names somebody has seen — and the first real
 * message filed under a name nobody had seen would be refused at the door. The
 * rule the repo keeps is to refuse a value we ACT on; we act on the
 * recommendation, and we display these.
 */
export interface DuMessage {
  readonly category: string;
  /** DU's own message number, where the message carries one. */
  readonly code: string | null;
  readonly text: string;
}

/**
 * What Desktop Underwriter last answered about an application, as the file
 * carries it beside the decision. Fannie Mae's assessment of a loan they might
 * buy, recorded and not a decision: nothing moves on it, and the owner reads
 * it while a co-borrower's read of the file carries null.
 */
export interface DuAnswer {
  readonly seq: number;
  readonly status: DuResponseStatus;
  readonly recommendation: DuRecommendation | null;
  readonly duCasefileId: string | null;
  readonly provider: string;
  readonly submittedAt: string;
  readonly receivedAt: string;
  readonly messages: readonly DuMessage[];
}

/**
 * A response, which either carries a recommendation or does not.
 *
 * A union rather than a nullable field, for the reason the engine returns
 * `refer` rather than `approve_eligible` when an input was blocked: "DU could
 * not evaluate this casefile" and "DU evaluated it" must not collapse into one
 * shape that a reader can mistake for the other. An errored response is a real
 * answer worth recording — it is how a resubmission learns what to fix — and it
 * is not a verdict about the loan.
 */
export const DU_RESPONSE_STATUSES = ["answered", "errored"] as const;

export type DuResponseStatus = (typeof DU_RESPONSE_STATUSES)[number];

/** Thrown rather than defaulted, for the reason above. */
export class UnknownDuResponseStatusError extends Error {
  constructor(readonly value: string) {
    super(
      `Desktop Underwriter answered with a status this system does not know: ${JSON.stringify(value)}. ` +
        "Nothing is stored and nothing moves until somebody decides what it means.",
    );
    this.name = "UnknownDuResponseStatusError";
  }
}

/**
 * Read which of the two shapes a response is, or refuse it.
 *
 * The status is the one field anything ACTS on: it alone decides whether a
 * recommendation is kept or thrown away. So the rule that applies to the
 * recommendation applies harder here — a word nobody has decided about, read as
 * "errored", would file a verdict DU gave as a casefile DU could not evaluate,
 * which is the exact collapse the union below exists to prevent.
 *
 * Trimmed and not otherwise normalized, on the same reasoning as
 * `parseDuRecommendation`.
 */
export function parseDuResponseStatus(value: string): DuResponseStatus {
  const trimmed = value.trim();
  const known = DU_RESPONSE_STATUSES.find((s) => s === trimmed);
  if (!known) throw new UnknownDuResponseStatusError(value);
  return known;
}

export type DuResponse =
  | {
      readonly status: "answered";
      /** `AutomatedUnderwritingCaseIdentifier`. DU minted it; it is not ours. */
      readonly duCasefileId: string;
      readonly recommendation: DuRecommendation;
      readonly messages: readonly DuMessage[];
      readonly respondedAt: string;
    }
  | {
      readonly status: "errored";
      /** Null where DU refused the casefile before opening one. */
      readonly duCasefileId: string | null;
      readonly messages: readonly DuMessage[];
      readonly respondedAt: string;
    };
