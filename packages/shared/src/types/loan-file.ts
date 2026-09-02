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
  EmploymentRecord,
  IncomeSource,
  PayrollData,
  TaxTranscript,
  UploadedDocument,
} from "./verification.js";
import type { Decision, DisclosureRecord } from "./decision.js";
import type {
  AvmEstimate,
  FloodDetermination,
  LienSearch,
  PropertyRecord,
  SanctionsScreening,
} from "./property-record.js";

/** Which of the nine screens the borrower has completed. */
export type FlowStage =
  | "property_loan"
  | "identity"
  | "credit"
  | "bank"
  | "payroll"
  | "irs_transcript"
  | "upload_fallback"
  | "decision"
  | "persistent_consent"
  | "complete";

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
  readonly employment: readonly EmploymentRecord[];

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
