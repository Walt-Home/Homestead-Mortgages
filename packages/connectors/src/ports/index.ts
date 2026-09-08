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
  PurposeToken,
  Address,
  AddressSuggestion,
  AssetReport,
  AvmEstimate,
  Consent,
  CreditReport,
  FloodDetermination,
  IdentityVerification,
  LienSearch,
  LoanFile,
  PayrollData,
  PropertyRecord,
  SanctionsScreening,
  TaxTranscript,
} from "@hm/shared";

/**
 * No public record exists for this address, as far as the provider knows.
 *
 * A distinct error rather than a null return, because callers must not be
 * able to treat "we found nothing" as "there is nothing". An address with no
 * assessor record is a normal outcome — new construction, a bad parse, a
 * county we do not cover — and the screen above has to say so rather than
 * render a blank card.
 */
export class AddressNotFoundError extends Error {
  constructor(readonly address: string) {
    super(`No public record found for ${address}.`);
    this.name = "AddressNotFoundError";
  }
}

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
  /**
   * Whether the borrower must complete the vendor's own widget before any data
   * exists.
   *
   * A fixture can mint a session and answer with a report in the same call. A
   * real aggregator cannot: the borrower authenticates with their bank inside
   * the vendor's UI, and the server learns nothing until that returns a token.
   * The client cannot infer which it is dealing with, and inferring wrong means
   * either a widget that never opens or a fetch against a bank nobody has
   * logged into.
   */
  readonly requiresClientHandoff: boolean;
}

/**
 * Where an adapter keeps a vendor credential between calls.
 *
 * Plaid's CRA flow spans three round trips and a borrower logging into their
 * bank: create a user, create a link token, and later exchange what the widget
 * returned and pull a report. The `user_token` from the first call is needed by
 * the last, and the two are separated by however long somebody takes to find
 * their banking password.
 *
 * An earlier adapter in this repo kept that kind of state in a Map on the
 * instance. That works on one process and fails intermittently the moment Cloud
 * Run scales past one — created on instance A, read on instance B, not found.
 * Handing the adapter a store makes the persistence explicit rather than
 * accidental.
 *
 * ⚠ These values are bearer credentials for a person's bank data. The
 * implementation must encrypt them at rest before this is pointed at anything
 * real; see docs/decisions.md on the vault work.
 */
export interface VendorTokenStore {
  get(loanFileId: string, key: string): Promise<string | null>;
  put(loanFileId: string, key: string, value: string): Promise<void>;
}

/** What the vendor's widget handed back, on its way to the report fetch. */
export interface LinkHandoff {
  readonly sessionId: string;
  /** Absent for a fixture, required by an aggregator. */
  readonly publicToken?: string;
}

/**
 * A twelve-month asset report is not always ready when asked for.
 *
 * Aggregators assemble one asynchronously — a bank with slow transaction
 * history can take minutes. Modelling that as a value rather than a timeout
 * keeps "still building" distinguishable from "failed", which are different
 * things to tell a borrower.
 */
export type AssetReportResult =
  | { readonly status: "ready"; readonly result: ConnectorResult<AssetReport> }
  | { readonly status: "pending"; readonly retryAfterMs: number };

export interface CreditConnector {
  readonly capabilities: ConnectorCapabilities;
  /**
   * Soft pull. Screen 3's entire premise is that this does not ding a score.
   *
   * The token names WHOSE credit. It cannot be constructed outside
   * `@hm/shared`, so this method cannot be called without a permission having
   * been checked for that specific borrower — which the previous signature,
   * taking a file and nothing else, could not express.
   */
  pullTriMerge(file: LoanFile, token: PurposeToken): Promise<ConnectorResult<CreditReport>>;
}

export interface BankConnector {
  readonly capabilities: ConnectorCapabilities;
  createLinkSession(file: LoanFile, token: PurposeToken): Promise<LinkSession>;
  /** The 12-month asset report. `monthsRequested` is 12 for every V1 call. */
  fetchAssetReport(
    file: LoanFile,
    token: PurposeToken,
    handoff: LinkHandoff,
    monthsRequested: number,
  ): Promise<AssetReportResult>;
}

export interface PayrollConnector {
  readonly capabilities: ConnectorCapabilities;
  createLinkSession(file: LoanFile, token: PurposeToken): Promise<LinkSession>;
  fetchPayroll(
    file: LoanFile,
    token: PurposeToken,
    sessionId: string,
  ): Promise<ConnectorResult<PayrollData>>;
}

export interface IrsConnector {
  readonly capabilities: ConnectorCapabilities;
  /**
   * Requires an executed 4506-C (INC-008), which is a different permission
   * from the one behind a credit pull — so the token must carry
   * `tax_transcript`, and a caller holding an APP-005 token is refused.
   */
  fetchTranscripts(
    file: LoanFile,
    token: PurposeToken,
    taxYears: readonly number[],
  ): Promise<ConnectorResult<readonly TaxTranscript[]>>;
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
 * Address autocomplete and public property data.
 *
 * Deviates from the one-argument-is-always-`file` convention above, and has
 * to: both run on screen 1 while the borrower is still typing, before a loan
 * file exists to pass. They take an `Address` instead.
 *
 * These take no `PurposeToken` and CANNOT be given one — the split between
 * address-keyed and person-keyed retrieval is in the signatures rather than in
 * a comment somebody has to read. Unguarded for the same reason the e-sign
 * adapter is unguarded: APP-005 is signed on screen 2, and a guard here would
 * make screen 1 unreachable. What
 * makes that acceptable is the payload: a partial street address the borrower
 * is typing into our own form, and public county records about a building.
 * Neither is borrower data in the sense APP-005 exists to protect. Nothing
 * here touches a person.
 */
export interface PropertyDataConnector {
  readonly capabilities: ConnectorCapabilities;
  /** Autocomplete candidates for a partial address. */
  suggestAddresses(query: string): Promise<readonly AddressSuggestion[]>;
  /** The assessor record — APN, characteristics, tax, prior ownership (APP-004). */
  lookupRecord(address: Address): Promise<ConnectorResult<PropertyRecord>>;
  /** Automated valuation. Not an appraisal, and the file records the difference. */
  estimateValue(address: Address): Promise<ConnectorResult<AvmEstimate>>;
  /** FEMA flood-zone determination. */
  determineFlood(address: Address): Promise<ConnectorResult<FloodDetermination>>;
}

/**
 * OFAC/SDN screening (CRD-010).
 *
 * Guarded. This one screens a *person* against government watchlists, it runs
 * on screen 2 after the authorization is signed, and it is exactly the kind of
 * third-party lookup APP-005 exists to gate.
 */
export interface ScreeningConnector {
  readonly capabilities: ConnectorCapabilities;
  screenSanctions(
    file: LoanFile,
    token: PurposeToken,
  ): Promise<ConnectorResult<SanctionsScreening>>;
}

/**
 * Ownership-and-encumbrance search against the APN from screen 1.
 *
 * Guarded — it ties a named borrower to recorded debts. Two of screen 4's
 * derived declarations come from here, which is how that screen states facts
 * instead of asking questions.
 */
export interface LienConnector {
  readonly capabilities: ConnectorCapabilities;
  searchLiens(
    file: LoanFile,
    token: PurposeToken,
    apn: string,
  ): Promise<ConnectorResult<LienSearch>>;
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
  readonly propertyData: PropertyDataConnector;
  readonly screening: ScreeningConnector;
  readonly liens: LienConnector;
}
