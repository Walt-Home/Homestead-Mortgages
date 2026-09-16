/**
 * The loan file — the one object the whole product reads and writes.
 *
 * It is deliberately assembled from nullable sections. A file is legitimately
 * half-empty for most of its life, and the requirement engine's entire job is
 * to answer "given what is here so far, what applies and what is missing?"
 * A shape that demanded completeness could not represent screen 3.
 */

import type { LoanTerms, ProductSelection, SubjectProperty } from "./loan.js";
import type { Borrower, Consent } from "./borrower.js";
import type {
  AssetReport,
  CreditReport,
  IncomeReportSource,
  IncomeSource,
  PayrollData,
  TaxTranscript,
  UploadedDocument,
  FileEmployment,
} from "./verification.js";
import type { Decision, DisclosureRecord } from "./decision.js";
import type {
  AvmEstimate,
  FloodDetermination,
  LienSearch,
  PropertyRecord,
  SanctionsScreening,
} from "./property-record.js";

/**
 * How far through the ten sheet screens the borrower has got, plus
 * `complete` for a file that has walked all of them.
 *
 * A runtime list, with the union derived from it, because the web app used to
 * keep a second spelling of these names and nothing could tell. A type
 * alone crosses no wire; a list a test can iterate is what makes a map keyed
 * on these names prove it has an entry for each of them.
 */
export const FLOW_STAGES = [
  "property_loan",
  "identity",
  "credit",
  "declarations",
  "bank",
  "payroll",
  "irs_transcript",
  "upload_fallback",
  "decision",
  "persistent_consent",
  "complete",
] as const;

export type FlowStage = (typeof FLOW_STAGES)[number];

/**
 * The moment TRID says an application exists: six pieces received (APP-002).
 *
 * This is a recorded event rather than a derived boolean because it starts a
 * three-business-day clock whose miss is a regulatory violation, and a clock
 * you can accidentally recompute is a clock you can accidentally restart.
 * See `docs/decisions.md` on why it does not fire at the end of screen 1.
 */
export interface ApplicationReceipt {
  readonly receivedAt: string;
  readonly sixPieces: {
    readonly name: boolean;
    readonly income: boolean;
    readonly ssn: boolean;
    readonly propertyAddress: boolean;
    readonly valueEstimate: boolean;
    readonly loanAmount: boolean;
  };
  /**
   * Each person on the file, what they have supplied, and what they signed.
   *
   * The three party-side pieces are counted PER PERSON here for the same
   * reason the trigger counts them per person: TRID's pieces are about the
   * consumer asking for credit, so one person's name beside another's SSN is
   * nobody's application. What received the application is one applicant's
   * three — the flat `sixPieces` above — and this says who else is on the file
   * and how far each of them has got.
   *
   * A signature is one person's act too. `authorizedAt` is their own
   * verification authorization and `taxRecordsAt` their own Form 4506-C, which
   * names a single taxpayer; both are null for somebody who has not signed,
   * and null is the reason nothing of theirs has been retrieved.
   */
  readonly signers: readonly ApplicationSigner[];
}

/** One person on the file, as the receipt names them. */
export interface ApplicationSigner {
  readonly borrowerId: string;
  readonly name: string;
  /** Their position in the submitted document, or null before they have one. */
  readonly ordinal: number | null;
  readonly pieces: {
    readonly name: boolean;
    readonly income: boolean;
    readonly ssn: boolean;
  };
  readonly authorizedAt: string | null;
  readonly taxRecordsAt: string | null;
}

/**
 * A live connector session. Screen 9's persistent consent is what keeps these
 * alive past the decision, and the refinance-monitoring loop is built on them.
 * V1 records them; it does not yet re-pull on a schedule.
 */
export interface ConnectorLink {
  readonly kind: "credit" | "bank" | "payroll" | "irs";
  readonly provider: string;
  readonly linkedAt: string;
  readonly lastSyncedAt: string;
  readonly status: "active" | "needs_reauth" | "revoked" | "error";
  /** False until the borrower opts in on screen 9. */
  readonly persistentMonitoringEnabled: boolean;
}

export interface LoanFile {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stage: FlowStage;

  readonly property: SubjectProperty | null;
  readonly loan: LoanTerms | null;
  readonly product: ProductSelection | null;
  readonly borrowers: readonly Borrower[];
  readonly consents: readonly Consent[];

  readonly application: ApplicationReceipt | null;

  /*
   * Section 5 and the residence history are NOT here.
   *
   * They were, as borrower 1's answers under a file-level name, and the engine
   * read them for every borrower on the file: a co-borrower's declared
   * bankruptcy was answered with the first borrower's "no", above a signature
   * attesting to it. They live on `Borrower` — one set per person, because
   * that is how many sets there are — and the evaluators and conditions that
   * read them walk `borrowers`. There is no file-level copy to fall back to,
   * which is the point: a field that exists gets read.
   */

  /**
   * Public record about the property, retrieved on screen 1 rather than asked.
   * Null until the lookup has run — which is a different fact from "the county
   * has nothing", and the UI must not render them the same way.
   */
  readonly propertyRecord: PropertyRecord | null;
  readonly valuation: AvmEstimate | null;
  readonly flood: FloodDetermination | null;
  /** Screen 2's screening and search. Null until run. */
  readonly sanctions: SanctionsScreening | null;
  readonly lienSearch: LienSearch | null;

  readonly credit: CreditReport | null;
  readonly assets: AssetReport | null;
  readonly payroll: PayrollData | null;
  readonly transcripts: readonly TaxTranscript[];

  /**
   * Income and employment as finally determined. These are not raw connector
   * output — they are the reconciled set the decision runs on, which is why
   * the same borrower can have a payroll record and a bank-inferred one and
   * still qualify on exactly one of them.
   */
  readonly incomeSources: readonly IncomeSource[];
  /** Every live employment on the file, across borrowers; `partyId` says whose. */
  readonly employment: readonly FileEmployment[];

  /**
   * Which retrieval last wrote each of the income rows the engine SUMS — the
   * ones with an established continuance — with `null` where the row names no
   * income pull.
   *
   * It is here rather than on the rows because an `IncomeSource` is what a
   * report said, and nothing about the report it arrived in. The reader is the
   * label on `ratios.totalQualifyingIncome`: `assets` above is the latest BANK
   * snapshot and stops being the source of that figure the moment a payroll
   * pull replaces the rows, so a label keyed on it names a retrieval the
   * number no longer comes from.
   *
   * Optional because only the projection off the database can know it; a
   * `LoanFile` assembled in memory has no snapshots to ask.
   */
  readonly qualifyingIncomeReportedBy?: readonly (IncomeReportSource | null)[];

  readonly documents: readonly UploadedDocument[];
  readonly disclosures: readonly DisclosureRecord[];
  readonly links: readonly ConnectorLink[];

  readonly decision: Decision | null;

  /** Set by the OFAC/SDN screen (CRD-010). Null until it has run. */
  readonly sanctionsScreenClear: boolean | null;
  /** Set by the SSA-89 validation (CRD-011), only when it was required. */
  readonly ssnValidatedWithSsa: boolean | null;
  /** Fraud and red-flag review (UW-018). */
  readonly fraudReviewComplete: boolean;
  /**
   * When the borrower signed the application (screen 4).
   *
   * The column existed but was never surfaced, so the client had no way to
   * know a file was signed. It is the single source of truth for that — there
   * is deliberately no parallel `application_signature` consent.
   */
  readonly applicationSignedAt: string | null;
  /** True once the borrower affirmatively indicates intent after the LE. */
  readonly intentToProceedAt: string | null;
  /** Delivery channel in use; decides whether eConsent applies (APP-012). */
  readonly deliveryMethod: "electronic" | "mail";
}
