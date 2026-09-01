/** Borrower identity, declarations, and the consents that gate everything. */

import type { Address, StateCode } from "./loan.js";

export type MaritalStatus = "married" | "unmarried" | "separated";

/**
 * SSN is never stored or passed in the clear.
 *
 * Everything outside the identity vault sees this: the last four for display,
 * and an opaque handle the vault can exchange for the full value when a
 * connector genuinely needs it. No requirement in the sheet needs the full SSN
 * anywhere except the credit pull (CRD-001), the SSA validation (CRD-011) and
 * the 4506-C (INC-008) — three call sites, all server-side.
 */
export interface SsnReference {
  readonly last4: string;
  readonly vaultHandle: string;
}

export interface Demographics {
  /** URLA Section 7. Any may be declined; declining is itself a recorded answer. */
  readonly ethnicity: readonly string[] | "declined";
  readonly race: readonly string[] | "declined";
  readonly sex: string | "declined";
  /** Set when collected face-to-face and the borrower declined (APP-011). */
  readonly visualObservationNoted: boolean;
}

export interface Borrower {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly ssn: SsnReference;
  readonly email: string;
  readonly phone: string;
  readonly currentAddress: Address;
  readonly maritalStatus: MaritalStatus;
  /** Community-property states require the spouse even when not borrowing. */
  readonly nonBorrowingSpouseName?: string;
  readonly nonBorrowingSpouseSignatureRequired: boolean;
  /** BCP-47. Anything but "en" puts the file in LEP handling (APP-017). */
  readonly preferredLanguage: string;
  readonly demographics: Demographics | null;
  /** No ownership interest in a primary residence in the prior 3 years. */
  readonly firstTimeHomebuyer: boolean | null;
  readonly isMilitary: boolean;
  readonly currentHousing: "rent" | "own" | "rent_free";
  readonly monthlyRent?: number;
}

/**
 * A recorded consent. `APP-005` is the one that gates every verification pull
 * in the product — nothing may call a connector before it exists, and the
 * timestamp is the evidence that we did not.
 */
export interface Consent {
  readonly kind:
    | "verification_authorization"
    | "econsent"
    | "form_4506c"
    | "persistent_monitoring";
  readonly borrowerId: string;
  readonly grantedAt: string;
  readonly revokedAt?: string;
  /** E-signature envelope id from the signing vendor, where one applies. */
  readonly envelopeId?: string;
  readonly ipAddress: string;
  readonly userAgent: string;
}

/** States where a non-borrowing spouse must be identified and may need to sign. */
export const COMMUNITY_PROPERTY_STATES: readonly StateCode[] = [
  "AZ",
  "CA",
  "ID",
  "LA",
  "NV",
  "NM",
  "TX",
  "WA",
  "WI",
];
