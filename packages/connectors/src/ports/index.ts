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
  fetchTranscripts(
    file: LoanFile,
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
 * Unguarded, for the same reason the e-sign adapter is unguarded — APP-005 is
 * signed on screen 2, and a guard here would make screen 1 unreachable. What
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
  screenSanctions(file: LoanFile): Promise<ConnectorResult<SanctionsScreening>>;
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
  searchLiens(file: LoanFile, apn: string): Promise<ConnectorResult<LienSearch>>;
}

/**
 * Document scan and selfie (screen 2).
 *
 * Unguarded, deliberately, and this is the uncomfortable one. It handles a
 * government ID, which is about as sensitive as this product gets — but it
 * runs *before* the authorization is signed, because name, date of birth and
 * address come off the document and the authorization is a document the
 * borrower signs with that name. Guarding it would make APP-005 unobtainable,
 * the same trap the e-sign adapter documents.
 *
 * The protection here is not the guard, it is scope: this verifies an identity
 * the borrower is presenting to us in the moment. It pulls nothing about them
 * from anywhere else.
 */
export interface IdentityConnector {
  readonly capabilities: ConnectorCapabilities;
  verifyIdentity(file: LoanFile): Promise<ConnectorResult<IdentityVerification>>;
}

export interface ConnectorRegistry {
  readonly credit: CreditConnector;
  readonly bank: BankConnector;
  readonly payroll: PayrollConnector;
  readonly irs: IrsConnector;
  readonly esign: EsignConnector;
  readonly propertyData: PropertyDataConnector;
  readonly screening: ScreeningConnector;
  readonly liens: LienConnector;
  readonly identity: IdentityConnector;
}
