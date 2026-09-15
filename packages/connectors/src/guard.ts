/**
 * The authorization guard.
 *
 * APP-005 — "Borrower authorization to verify executed" — carries a timing
 * constraint of "Before any verification pull" and a failure severity of
 * "Regulatory violation". It is the single hardest rule in the sheet, and it
 * is the one most easily broken by a well-meaning refactor that moves a pull
 * one line earlier.
 *
 * Every person-keyed connector method takes a `PurposeToken`, which names one
 * party, one purpose and one data category. The token can only be built by
 * `mintPurposeToken` in `@hm/shared`, from real grants, and its brand is a
 * symbol that package does not export — so an adapter cannot conjure one and
 * a caller cannot forget to ask for one. The check is the parameter, not a
 * line at the top of a method.
 *
 * Address-keyed methods take an `Address` and no token, and cannot accept a
 * borrower. That is the FCRA address/person split in the type system rather
 * than in a doc comment, and it is what lets screen 1 run before any
 * authorization exists.
 *
 * This package no longer reads a loan file's `consents`. The minter lives in
 * the API, reads the `authorizations` table, and is the only minter there is.
 * The bridge that used to convert legacy consents into grants here came out
 * with the columns it read.
 */

import type { AuthorizationPurpose, DataCategory, LoanFile, PurposeToken } from "@hm/shared";

/**
 * The part of a submission this file is entitled to read: which file it is
 * about, who is in it, and what was retrieved about each of them.
 * `DuSubmission` in `ports/index.ts` is the whole of it, and the guard takes
 * this narrower shape so that the check cannot come to depend on the document
 * it is guarding.
 */
export interface DuSubmissionSubjects {
  /**
   * The loan file the application being submitted was born from —
   * `applications.loan_file_id`, which is UNIQUE, so it names this application
   * and no other. Every token has to have been minted on it.
   */
  readonly loanFileId: string;
  readonly borrowers: readonly {
    readonly partyId: string;
    readonly borrowerOrdinal: number;
    readonly dataCategories: readonly DataCategory[];
  }[];
}

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly requirementId: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/** Which permission each kind of retrieval runs under. */
export const PURPOSE_FOR: Record<DataCategory, AuthorizationPurpose> = {
  credit_report: "fcra_written_instruction",
  bank_transactions: "fcra_written_instruction",
  payroll_income: "fcra_written_instruction",
  sanctions_screening: "fcra_written_instruction",
  public_record_liens: "fcra_written_instruction",
  tax_transcript: "irs_4506c",
  identity_document: "biometric_idv",
};

/** The requirement each refusal cites, for the 403 the client routes on. */
export const REQUIREMENT_FOR: Record<DataCategory, string> = {
  credit_report: "APP-005",
  bank_transactions: "APP-005",
  payroll_income: "APP-005",
  sanctions_screening: "APP-005",
  public_record_liens: "APP-005",
  tax_transcript: "INC-008",
  identity_document: "APP-001",
};

/**
 * An adapter's own check that it was handed the right token.
 *
 * The token proves a permission; this proves it is the permission for the data
 * about to be fetched. Without it a caller holding a bank token could reach the
 * credit adapter, which is the same class of mistake one category wider.
 */
export function requireCategory(token: PurposeToken, expected: DataCategory): void {
  if (token.dataCategory !== expected) {
    throw new AuthorizationError(
      `This authorization covers ${token.dataCategory}, not ${expected}.`,
      REQUIREMENT_FOR[expected],
    );
  }
}

/**
 * An adapter's own check that the token names somebody this file is about.
 *
 * `requireCategory` proves the token is the permission for the data; this
 * proves it is the permission about the right person. Every route happens to
 * mint from the primary borrower, so without this the party half of the check
 * lived in the routes as a habit — a token for any party at all, on any file,
 * came back with that file's fixture data. The guard is in the adapters so a
 * new route cannot forget it, and a check only the routes perform is exactly
 * the convention this file exists to replace.
 *
 * The refusal names no party. A caller who may not fetch about somebody must
 * not learn from the refusal whether that somebody is on the file.
 */
export function requireSubject(token: PurposeToken, file: LoanFile): void {
  if (!file.borrowers.some((b) => b.partyId === token.partyId)) {
    throw new AuthorizationError(
      "This authorization is not for a borrower on this file, so nothing may be retrieved under it.",
      REQUIREMENT_FOR[token.dataCategory],
    );
  }
}

/** The party a token speaks for. Adapters use it to pick whose data to fetch. */
export function subjectOf(token: PurposeToken): string {
  return token.partyId;
}

/**
 * An adapter's own check that everybody in a submission authorized it.
 *
 * The three checks above are about one retrieval about one person. This one is
 * about a document that carries up to four people at once, and the difference
 * matters: `requireSubject` asks whether a token names somebody on the file,
 * which a single token for the applicant satisfies on a file where the
 * co-borrower has signed nothing. A submission has to satisfy the stronger
 * thing — every borrower in it, for every category of data it drew on about
 * them — because a co-borrower's data leaves the building here on whatever
 * permission the applicant happened to hold.
 *
 * Refusing is the correct outcome and not an obstacle. A co-borrower cannot
 * sign anything today, so an application with one cannot be submitted; the way
 * out is a signature apiece.
 *
 * The other half is WHERE each signature was made. A grant belongs to the
 * person and outlives the application it was signed on, so the same borrower
 * with two applications has one permission that reads as covering both — which
 * is how a co-borrower's federal tax transcripts came to be pulled onto a
 * joint file they had signed nothing on. Every token therefore names the file
 * it was minted on, and a token from a different one is refused here rather
 * than left to the caller to have noticed.
 *
 * Nothing is named in a refusal but the borrower's POSITION in the document and
 * the category. The caller assembled the submission, so the position tells it
 * nothing it did not already know, and a party id in an error message is one
 * more place a person's identifier travels for no reason.
 */
export function requireEveryBorrowerAuthorized(
  submission: DuSubmissionSubjects,
  tokens: readonly PurposeToken[],
): void {
  if (submission.borrowers.length === 0) {
    throw new AuthorizationError(
      "A submission with no borrower on it has nobody to authorize it and nobody to underwrite.",
      "APP-005",
    );
  }

  const onTheSubmission = new Set(submission.borrowers.map((b) => b.partyId));
  for (const token of tokens) {
    // Somebody this casefile is not about. Refused rather than ignored: a
    // permission belonging to another loan's borrower has nothing to say about
    // this one, and a set that silently drops it is a set the count below can
    // be satisfied against.
    if (!onTheSubmission.has(token.partyId)) {
      throw new AuthorizationError(
        "One of these authorizations is not for a borrower on this submission, " +
          "so nothing may be transmitted under it.",
        REQUIREMENT_FOR[token.dataCategory],
      );
    }
    // The same person, two applications — which the check above cannot see,
    // because it is the same party id both times. This is the one the ordinary
    // case walks into: a borrower signs here, signs somewhere else, and the
    // grant behind both signatures is one row.
    if (token.fileId !== submission.loanFileId) {
      throw new AuthorizationError(
        "One of these authorizations was signed on a different application, " +
          "so nothing may be transmitted under it here.",
        REQUIREMENT_FOR[token.dataCategory],
      );
    }
  }

  for (const borrower of submission.borrowers) {
    if (borrower.dataCategories.length === 0) {
      throw new AuthorizationError(
        `Borrower ${borrower.borrowerOrdinal} is on this submission with nothing retrieved ` +
          "about them, which is an assembly error rather than a permission we can check.",
        "APP-005",
      );
    }
    for (const category of borrower.dataCategories) {
      const covered = tokens.some(
        (t) => t.partyId === borrower.partyId && t.dataCategory === category,
      );
      if (!covered) {
        throw new AuthorizationError(
          `Borrower ${borrower.borrowerOrdinal} has not authorized ${category} to be shared, ` +
            "so this casefile may not be submitted.",
          REQUIREMENT_FOR[category],
        );
      }
    }
  }
}
