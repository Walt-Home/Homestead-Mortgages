/**
 * The authorization guard.
 *
 * APP-005 — "Borrower authorization to verify executed" — carries a timing
 * constraint of "Before any verification pull" and a failure severity of
 * "Regulatory violation". It is the single hardest rule in the sheet, and it
 * is the one most easily broken by a well-meaning refactor that moves a pull
 * one line earlier.
 *
 * So it is not a convention. Every adapter calls this first, the port's own
 * docs say so, and `guard.test.ts` calls every registered adapter against an
 * unauthorized file and fails if any of them returns data.
 */

import type { Consent, LoanFile } from "@sm/shared";

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly requirementId: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

function activeConsent(file: LoanFile, kind: Consent["kind"]): Consent | undefined {
  return file.consents.find((c) => c.kind === kind && !c.revokedAt);
}

/**
 * Throws unless the borrower has signed the verification authorization.
 * Call this at the top of every connector method that reaches a third party.
 */
export function assertVerificationAuthorized(file: LoanFile): void {
  if (!activeConsent(file, "verification_authorization")) {
    throw new AuthorizationError(
      "No active borrower authorization to verify (APP-005). No credit, income, " +
        "employment or asset data may be pulled.",
      "APP-005",
    );
  }
}

/** The IRS transcript pull needs its own executed 4506-C on top of APP-005. */
export function assert4506cExecuted(file: LoanFile): void {
  assertVerificationAuthorized(file);
  if (!activeConsent(file, "form_4506c")) {
    throw new AuthorizationError(
      "No executed 4506-C (INC-008). IRS transcripts may not be requested.",
      "INC-008",
    );
  }
}
