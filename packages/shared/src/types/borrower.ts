/** Borrower identity, declarations, and the consents that gate everything. */

import type { BorrowerDeclaration, BorrowerResidence } from "./declaration.js";
import type { Address, StateCode } from "./loan.js";

export type MaritalStatus = "married" | "unmarried" | "separated";

/**
 * Residency, which changes product eligibility and the documents an
 * underwriter will ask for. Not in the V1 sheet; asking it alongside the rest
 * of identity is cheaper than discovering it at underwriting.
 */
export type Citizenship = "us_citizen" | "permanent_resident" | "non_permanent_resident";

/**
 * Identity proven against a government document rather than typed.
 *
 * APP-001 asks that the borrower "is who they claim to be", with evidence of a
 * government photo ID. Typed fields cannot evidence that; a document-and-selfie
 * check can. The port is vendor-shaped (Stripe Identity, Persona, Socure) and
 * the adapter is a fixture like every other connector.
 */
export interface IdentityVerification {
  readonly verificationId: string;
  readonly status: "pending" | "verified" | "failed";
  readonly verifiedAt?: string;
  /** What the document said, for comparison against what was typed. */
  readonly documentName?: string;
  readonly documentDateOfBirth?: string;
  /** The address on the document, so screen 2 does not have to ask for it. */
  readonly documentAddress?: Address;
  readonly failureReason?: string;
}

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

/**
 * A person the applicant has named on the application who has not arrived.
 *
 * The applicant names a co-borrower by name and email and nothing else; the
 * co-borrower completes their own profile, in their own session, with their
 * own permissions — a separate, private application. Until they do, this is
 * all the file holds about them, and it is deliberately not a `Borrower`: a
 * `Borrower` carries an identity the engine and the casefile assembler read,
 * and a half-empty one would be read as a person with no date of birth rather
 * than as a person who has not answered yet.
 *
 * So a named co-borrower is listed here and not in `borrowers`, every
 * per-borrower evaluator judges the people who have arrived, and the file
 * cannot be signed, decided or submitted while this list is non-empty — the
 * product's "waiting for your co-borrower".
 */
export interface InvitedBorrower {
  /** The `borrowers` row that will become theirs when they arrive. */
  readonly id: string;
  readonly partyId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  /** Whether they will live in the home; a co-signer does not. */
  readonly occupiesProperty: boolean;
  /**
   * Where they are. `named`: the applicant has named them and nothing has been
   * sent. `invited`: an invitation is live. Neither means they can sign in;
   * the day they claim, the row leaves this list.
   */
  readonly status: "named" | "invited";
}

export interface Borrower {
  readonly id: string;
  /**
   * The durable person this row is a per-application record about.
   *
   * Required. Every identity field on this object is projected from a fact on
   * the party; the row itself holds nothing that identifies anyone. A
   * retrieval is authorized about the party, and a second application reuses
   * it.
   */
  readonly partyId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string;
  readonly ssn: SsnReference;
  readonly email: string;
  readonly phone: string;
  readonly currentAddress: Address;
  readonly maritalStatus: MaritalStatus;
  readonly citizenship: Citizenship;
  readonly identityVerification: IdentityVerification | null;
  /** Community-property states require the spouse even when not borrowing. */
  readonly nonBorrowingSpouseName?: string;
  readonly nonBorrowingSpouseSignatureRequired: boolean;
  /** BCP-47. Anything but "en" puts the file in LEP handling (APP-017). */
  readonly preferredLanguage: string;
  readonly demographics: Demographics | null;
  /** No ownership interest in a primary residence in the prior 3 years. */
  readonly firstTimeHomebuyer: boolean | null;
  readonly isMilitary: boolean;
  /**
   * Null is "nobody has been asked", and it is not "rent".
   *
   * The column behind this carried a NOT NULL default of `"rent"` while no
   * screen collected it, so every file stated a housing basis its borrower
   * had never given. Every reader of this field has to be able to say "we do
   * not know", which is why the null is in the type rather than in a comment.
   */
  readonly currentHousing: "rent" | "own" | "rent_free" | null;
  readonly monthlyRent?: number;
  /**
   * Section 5 and the residence history, as THIS person answered them.
   *
   * Per borrower rather than per file, because the questions are about the
   * person answering: "have you declared bankruptcy in the past seven years"
   * has one answer per borrower and a file with two of them has two. A single
   * file-level copy meant a co-borrower's block on the review screen could
   * only show borrower 1's answers back under a second person's name.
   *
   * Null is unasked, and it is not "no" — the same three-valued rule the rest
   * of this type keeps. A borrower who has said nothing has not said no.
   */
  readonly declaration: BorrowerDeclaration | null;
  /** Empty until the same answers are given; one current row, at most one prior. */
  readonly residences: readonly BorrowerResidence[];
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
    | "persistent_monitoring"
    /**
     * Agreement to be contacted by text. A checkbox, not a signature — never
     * in SIGNABLE, because there is no document to execute.
     */
    | "sms_contact";
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
