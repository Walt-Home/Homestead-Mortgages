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
