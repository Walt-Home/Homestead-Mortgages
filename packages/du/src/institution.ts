/**
 * Who we are to Fannie Mae, and the two placeholders standing where that
 * answer goes.
 *
 * A DU submission carries the institution it is sent under in two places, and
 * both were empty because nobody holds the number yet:
 *
 * - `LOAN_IDENTIFIER` with `LoanIdentifierType` of `LenderLoan`, which is the
 *   lender's own number for this loan. `String 15`, and the Map's note says no
 *   borrower identifier may appear in it.
 * - the message-level `MESSAGE/DEAL_SETS/PARTIES` party whose role is
 *   `SubmittingParty`, carrying a `PartyRoleIdentifier`. `String 6`, filed in
 *   the Map under "Institution ID" — the seller/servicer number, which is a
 *   contract question and not a format. It sits OUTSIDE the `DEAL`, which is
 *   why it is assembled beside the deal rather than inside `parties.ts`, and
 *   none of the eighteen shipped samples carries one to copy.
 *
 * So there are placeholders, and the whole design of them is that they cannot
 * be mistaken for a number somebody allocated. **A plausible-looking fake
 * reaching Fannie Mae is worse than an empty element**, because an empty
 * element is a submission that fails and a plausible one is a submission that
 * succeeds against somebody else's institution.
 *
 * Three things make that hold:
 *
 * 1. The values SAY they are placeholders. `PLACEHOLDER-DEV` is not a loan
 *    number anybody's originator would mint and `PLCHLD` is not a
 *    seller/servicer number.
 * 2. `assertInstitutionEmittable` refuses them when `NODE_ENV` is
 *    `production`, and `assembleSubmission` calls it before it builds
 *    anything. The check reads the environment here rather than taking it as
 *    an argument, for the reason the connector guard lives inside the adapters:
 *    an argument is a thing a caller can forget or pass wrong, and there is
 *    only one of these checks precisely so there is only one to get right.
 * 3. The widths are read out of `generated/lengths.ts` rather than written
 *    down, so a specification that moves either one moves this with it.
 *
 * What is NOT here is where a real number comes from. Nothing mints a lender
 * loan number, no column holds one, and `docs/du-readiness.md` names both
 * under what is still needed. Replacing these is what makes a submission real.
 */

import { DU_FORMATS } from "./generated/lengths.js";

/** The two values a submission states an institution with. */
export interface DuInstitution {
  /** The lender's own number for this loan. `LoanIdentifierType` `LenderLoan`. */
  readonly lenderLoanIdentifier: string;
  /** The seller/servicer number the casefile is submitted under. */
  readonly submittingPartyIdentifier: string;
}

/** Where the Map files the lender's loan number, form field B.01. */
export const LENDER_LOAN_IDENTIFIER_FORMAT =
  "MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL/LOANS/LOAN/LOAN_IDENTIFIERS/LOAN_IDENTIFIER#LoanIdentifier#B.01";

/** And the submitting party's, which the Map files under no form field at all. */
export const SUBMITTING_PARTY_IDENTIFIER_FORMAT =
  "MESSAGE/DEAL_SETS/PARTIES/PARTY/ROLES/ROLE/PARTY_ROLE_IDENTIFIERS/PARTY_ROLE_IDENTIFIER#PartyRoleIdentifier#";

/**
 * The width the specification gives a destination, or a throw.
 *
 * A destination the generated table does not carry is one this file has the
 * wrong XPath for, and a silent `undefined` there would turn the length check
 * below into nothing at all.
 */
function widthOf(destination: string): number {
  const format = DU_FORMATS[destination];
  if (!format || format.kind !== "string" || format.maxLength === undefined) {
    throw new Error(
      `${destination} is not a string destination the generated lengths table carries, so ` +
        "nothing here knows how wide the value may be.",
    );
  }
  return format.maxLength;
}

const LENDER_LOAN_WIDTH = widthOf(LENDER_LOAN_IDENTIFIER_FORMAT);
const SUBMITTING_PARTY_WIDTH = widthOf(SUBMITTING_PARTY_IDENTIFIER_FORMAT);

/**
 * The characters the Map forbids in a lender loan number.
 *
 * Its note lists them literally — `<`, `>`, `&`, an apostrophe, a double quote
 * and a percent sign. Five of the six are what the emitter would escape, so a
 * value carrying one produces a document that validates and states a number
 * nobody typed; the sixth is Fannie Mae's own rule. Both quote characters are
 * written as their curly forms too, because that is how the note spells them
 * and a value pasted out of a document carries them.
 */
const FORBIDDEN_IN_A_LOAN_NUMBER = /[<>&'"%‘’“”]/;

/**
 * What stands where Grander's numbers go.
 *
 * Each is exactly as wide as its destination allows, so what refuses them is
 * the check below saying what they are, rather than a length overrun that
 * would read as a formatting mistake.
 */
export const PLACEHOLDER_INSTITUTION: DuInstitution = {
  lenderLoanIdentifier: "PLACEHOLDER-DEV",
  submittingPartyIdentifier: "PLCHLD",
};

/** Which of the two values is still the placeholder. Empty when neither is. */
export function placeholdersIn(institution: DuInstitution): readonly string[] {
  const standing: string[] = [];
  if (institution.lenderLoanIdentifier === PLACEHOLDER_INSTITUTION.lenderLoanIdentifier) {
    standing.push("lenderLoanIdentifier");
  }
  if (institution.submittingPartyIdentifier === PLACEHOLDER_INSTITUTION.submittingPartyIdentifier) {
    standing.push("submittingPartyIdentifier");
  }
  return standing;
}

function assertWidth(what: string, value: string, maximum: number): void {
  if (value === "") {
    throw new Error(`${what} is empty. A submission states the institution or it states nothing.`);
  }
  if (value.length > maximum) {
    throw new Error(
      `${what} is ${value.length} characters at a destination that takes ${maximum}.`,
    );
  }
}

/**
 * The institution, or a refusal.
 *
 * Called by `assembleSubmission` before it reads a row, so there is no
 * arrangement of callers in which a document is built against an institution
 * this has not seen. The messages name the field and never the value: a loan
 * number is not a secret, but a refusal is a string somebody pastes into a
 * ticket and the rest of this package keeps values out of those.
 */
export function assertInstitutionEmittable(institution: DuInstitution): void {
  assertWidth("The lender loan number", institution.lenderLoanIdentifier, LENDER_LOAN_WIDTH);
  assertWidth(
    "The submitting party's institution identifier",
    institution.submittingPartyIdentifier,
    SUBMITTING_PARTY_WIDTH,
  );
  if (FORBIDDEN_IN_A_LOAN_NUMBER.test(institution.lenderLoanIdentifier)) {
    throw new Error(
      "The lender loan number carries a character Fannie Mae's note forbids there: an angle " +
        "bracket, an ampersand, a quote or a percent sign.",
    );
  }

  const standing = placeholdersIn(institution);
  if (standing.length > 0 && process.env.NODE_ENV === "production") {
    throw new Error(
      `Refusing to assemble a submission against a placeholder institution: ${standing.join(
        " and ",
      )}. Nobody holds the seller/servicer number this casefile would be sent under, and a ` +
        "number that looks real is worse than none.",
    );
  }
}
