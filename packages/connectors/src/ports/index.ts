/**
 * The connector ports.
 *
 * Every external data source the flow depends on is declared here as an
 * interface and nowhere else. V1 ships fixture adapters (`../adapters/`)
 * because no vendor contract exists yet; the point of the seam is that
 * swapping in Plaid, Argyle, a credit reseller or an IVES provider is a new
 * file in `adapters/` and one line in the registry, with no change above.
 *
 * Two rules hold for every adapter, fixture or real:
 *
 *   1. Nothing may be pulled before APP-005. `guard.ts` enforces it, and the
 *      guard is not optional — it is in the port's own contract, not in each
 *      adapter's good intentions.
 *   2. An adapter returns domain types from `@hm/shared`, never vendor JSON.
 *      Vendor shapes stay inside the adapter so a vendor swap cannot ripple.
 */

import type {
  AssetReport,
  Consent,
  CreditReport,
  IdentityVerification,
  LoanFile,
  PayrollData,
  TaxTranscript,
} from "@hm/shared";

/** Which requirements an adapter claims it can satisfy. Checked in tests. */
export interface ConnectorCapabilities {
  readonly provider: string;
  /** "fixture" until a vendor contract exists. */
  readonly mode: "fixture" | "sandbox" | "production";
  readonly satisfies: readonly string[];
}

export interface ConnectorResult<T> {
  readonly data: T;
  readonly provider: string;
  readonly retrievedAt: string;
  /** Vendor's own id for the pull, kept for the audit trail. */
  readonly externalId: string;
}

/**
 * A handshake the borrower has to complete in their browser. Bank and payroll
 * both work this way: we mint a session, the borrower authenticates with their
 * institution, and we exchange the resulting token for data.
 */
export interface LinkSession {
  readonly sessionId: string;
  readonly linkToken: string;
  readonly expiresAt: string;
}

export interface CreditConnector {
  readonly capabilities: ConnectorCapabilities;
  /** Soft pull. Screen 3's entire premise is that this does not ding a score. */
  pullTriMerge(file: LoanFile): Promise<ConnectorResult<CreditReport>>;
}

export interface BankConnector {
  readonly capabilities: ConnectorCapabilities;
  createLinkSession(file: LoanFile): Promise<LinkSession>;
  /** The 12-month asset report. `monthsRequested` is 12 for every V1 call. */
  fetchAssetReport(
    file: LoanFile,
    sessionId: string,
    monthsRequested: number,
  ): Promise<ConnectorResult<AssetReport>>;
}

export interface PayrollConnector {
  readonly capabilities: ConnectorCapabilities;
  createLinkSession(file: LoanFile): Promise<LinkSession>;
  fetchPayroll(file: LoanFile, sessionId: string): Promise<ConnectorResult<PayrollData>>;
}

export interface IrsConnector {
  readonly capabilities: ConnectorCapabilities;
  /** Requires an executed 4506-C (INC-008) on top of the APP-005 guard. */
  fetchTranscripts(file: LoanFile, taxYears: readonly number[]): Promise<ConnectorResult<readonly TaxTranscript[]>>;
}

export interface EsignConnector {
  readonly capabilities: ConnectorCapabilities;
  createEnvelope(
    file: LoanFile,
    kind: Consent["kind"],
    borrowerId: string,
  ): Promise<{ envelopeId: string; signingUrl: string }>;
  /** Returns the consent record once the borrower has signed, else null. */
  getCompletedConsent(envelopeId: string): Promise<Consent | null>;
}

/**
 * Proving the borrower is who they say they are.
 *
 * APP-001 wants a government photo ID; typed fields cannot evidence that. The
 * shape follows the document-and-selfie vendors — Stripe Identity, Persona,
 * Socure — where you create a session, send the person to it, and read the
 * result back. It is NOT the same as validating an SSN against the SSA
 * (CRD-011), which is a separate check with a separate vendor.
 */
export interface IdentityConnector {
  readonly capabilities: ConnectorCapabilities;
  createVerificationSession(
    file: LoanFile,
    borrowerId: string,
  ): Promise<{ verificationId: string; verificationUrl: string }>;
  getVerification(verificationId: string): Promise<IdentityVerification | null>;
}

export interface ConnectorRegistry {
  readonly identity: IdentityConnector;
  readonly credit: CreditConnector;
  readonly bank: BankConnector;
  readonly payroll: PayrollConnector;
  readonly irs: IrsConnector;
  readonly esign: EsignConnector;
}
