/**
 * The authorization guard.
 *
 * APP-005 — "Borrower authorization to verify executed" — carries a timing
 * constraint of "Before any verification pull" and a failure severity of
 * "Regulatory violation". It is the single hardest rule in the sheet, and it
 * is the one most easily broken by a well-meaning refactor that moves a pull
 * one line earlier.
 *
 * WHAT CHANGED, AND WHY IT MATTERED
 *
 * The previous guard was `assertVerificationAuthorized(file)`, and its problem
 * is legible in the signature: it took a FILE and no subject. It looked for any
 * active consent of the right kind anywhere on the file and ignored
 * `Consent.borrowerId` completely — so on a two-borrower file, one person's
 * signature authorized a credit pull about the other. It also could not tell a
 * bank authorization from a tax-transcript one.
 *
 * Now every person-keyed connector method takes a `PurposeToken`, which names
 * one borrower, one purpose and one data category. The token can only be built
 * by `purposeFor`, which checks that THAT borrower granted THAT permission, and
 * its brand is a symbol `@hm/shared` does not export — so an adapter cannot
 * conjure one and a caller cannot forget to ask for one. The check is no longer
 * a line at the top of a method that a refactor can move; it is the parameter.
 *
 * Address-keyed methods take an `Address` and no token, and they cannot accept
 * a borrower. That is the FCRA address/person split in the type system rather
 * than in a doc comment, and it is what lets screen 1 run before any
 * authorization exists.
 *
 * THE BRIDGE, AND WHAT IT DOES NOT YET DO
 *
 * `purposeFor` reads the loan file's `consents`. The real grants live in the
 * `authorizations` table — party-scoped, category-scoped and expiring — and
 * nothing is wired to them yet. So this converts the old rows into grants and
 * mints from those. Two consequences worth knowing:
 *
 *   - The subject is a BORROWER id, not a party id. When parties are wired the
 *     minter changes and no call site does.
 *   - Legacy consents have no expiry, so the bridge gives them none rather than
 *     inventing one. Expiry arrives with real authorizations; changing the
 *     subject rule and the expiry rule in one step would make a regression
 *     impossible to attribute.
 */

import {
  mintPurposeToken,
  type AuthorizationPurpose,
  type Consent,
  type DataCategory,
  type Grant,
  type LoanFile,
  type PurposeToken,
} from "@hm/shared";

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly requirementId: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * What each legacy consent kind permits.
 *
 * Exhaustive over `Consent["kind"]`, so a new kind is a TypeScript error here
 * rather than a permission that silently grants nothing — or, worse, one that
 * falls through to a default and grants everything.
 */
const LEGACY_GRANTS: Record<
  Consent["kind"],
  { purpose: AuthorizationPurpose; categories: readonly DataCategory[] }
> = {
  verification_authorization: {
    purpose: "fcra_written_instruction",
    categories: [
      "credit_report",
      "bank_transactions",
      "payroll_income",
      "sanctions_screening",
      "public_record_liens",
    ],
  },
  form_4506c: { purpose: "irs_4506c", categories: ["tax_transcript"] },
  persistent_monitoring: {
    purpose: "fcra_account_review",
    categories: ["credit_report", "bank_transactions"],
  },
  econsent: { purpose: "electronic_delivery", categories: [] },
  sms_contact: { purpose: "marketing_contact", categories: [] },
};

/** The far future. The old model has no expiry and the bridge invents none. */
const NO_EXPIRY = "9999-12-31T00:00:00.000Z";

/** The file's consents, as grants the minter understands. */
function grantsFrom(file: LoanFile): Grant[] {
  return file.consents.map((c, i) => {
    const mapped = LEGACY_GRANTS[c.kind];
    return {
      id: c.envelopeId ?? `consent:${c.kind}:${i}`,
      // The bridge: a borrower id standing in for a party id. Both are uuids,
      // and when parties are wired only this line changes.
      partyId: c.borrowerId,
      purpose: mapped.purpose,
      dataCategories: mapped.categories,
      grantedAt: c.grantedAt,
      expiresAt: NO_EXPIRY,
      revokedAt: c.revokedAt ?? null,
    };
  });
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
const REQUIREMENT_FOR: Partial<Record<DataCategory, string>> = {
  tax_transcript: "INC-008",
};

/**
 * Proof that this borrower's data may be fetched, for this purpose, now.
 *
 * Throws `AuthorizationError` rather than returning a denial, because every
 * caller is about to reach a third party and none of them has a sensible way
 * to carry on without permission.
 */
export function purposeFor(
  file: LoanFile,
  borrowerId: string,
  dataCategory: DataCategory,
): PurposeToken {
  // A subject who is not on this file is refused before anything else is
  // considered. The old guard could not even ask this question.
  if (!file.borrowers.some((b) => b.id === borrowerId)) {
    throw new AuthorizationError(
      `Refusing to retrieve ${dataCategory}: ${borrowerId} is not a borrower on this file.`,
      "APP-005",
    );
  }

  const result = mintPurposeToken({
    partyId: borrowerId,
    purpose: PURPOSE_FOR[dataCategory],
    dataCategory,
    grants: grantsFrom(file),
    now: new Date(),
  });

  if (!result.ok) {
    throw new AuthorizationError(
      `No authorization to retrieve ${dataCategory} for this borrower: ${result.message}. ` +
        "No credit, income, employment or asset data may be pulled.",
      REQUIREMENT_FOR[dataCategory] ?? "APP-005",
    );
  }
  return result.token;
}

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
      "APP-005",
    );
  }
}

/** The borrower a token speaks for. Adapters use it to pick whose data to fetch. */
export function subjectOf(token: PurposeToken): string {
  return token.partyId;
}
