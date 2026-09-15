/**
 * The connector ports.
 *
 * Every external data source the flow depends on is declared here as an
 * interface and nowhere else, as is the one external party we SEND to. V1
 * ships fixture adapters (`../adapters/`) because no vendor contract exists
 * yet; the point of the seam is that swapping in Plaid, Argyle, a credit
 * reseller or an IVES provider is a new file in `adapters/` and one line in
 * the registry, with no change above.
 *
 * Two rules hold for every adapter, fixture or real:
 *
 *   1. Nothing may be pulled before APP-005, and nothing may be transmitted
 *      about somebody who did not authorize it. `guard.ts` enforces both, and
 *      the guard is not optional — it is in the port's own contract, not in
 *      each adapter's good intentions.
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
  DataCategory,
  DuResponse,
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

/**
 * Sending a casefile to Desktop Underwriter, and reading what comes back.
 *
 * The one port that TRANSMITS. Every other connector in this file retrieves —
 * it asks a third party for something about a borrower and brings it home. This
 * one carries every borrower's name, date of birth, social security number,
 * income, assets, liabilities and declarations out of this system to Fannie
 * Mae, which is why the guard on it is the strictest in the package and why it
 * takes a set of tokens rather than one.
 *
 * ── Whose authorization ───────────────────────────────────────────────────
 *
 * EVERY borrower's, and one borrower's will not do for another.
 *
 * A submission is a single document about up to four people. The applicant
 * holds the only session on a joint file, so a guard keyed on "the file is
 * authorized" — or on the primary borrower's token, which is what every
 * connector route happens to mint — would transmit a co-borrower's tax and
 * credit data on a signature they never gave. `requireSubject` exists because
 * that had already happened once inside this package with a single-party pull;
 * here the same mistake sends four people's data to an agency in one call.
 *
 * The consequence is deliberate and is not a gap to route around: a
 * co-borrower cannot sign anything today, so a two-borrower application cannot
 * be submitted today. Refusing is the correct behavior until each of them can
 * sign, and the fix is a signature apiece rather than a looser guard.
 *
 * ── What a real adapter must do that the fixture does not ─────────────────
 *
 * The fixture answers. It does not transmit, and everything below is what the
 * word "submit" actually costs:
 *
 *   - **Credentials.** A casefile goes in under a seller/servicer number, and
 *     ours would be Grander's: they are the creditor and Supermortgage
 *     administers as their agent. Whether the agency agreement permits it is a
 *     contract question with a longer lead time than any code, which is why
 *     `duConnector` takes the number as configuration and refuses to be
 *     constructed without one.
 *   - **A transport.** An endpoint, an authentication scheme and a message
 *     envelope, none of which is in the vendored corpus — that corpus specifies
 *     the casefile, not the conversation. A real adapter must not invent one.
 *   - **Reading the answer.** DU's response format is a specification we do not
 *     hold either. `parseDuRecommendation` is the half that can be written
 *     today, and a real adapter must go through it rather than storing whatever
 *     string arrived.
 *   - **Retries that do not open a second case.** DU recognizes a resubmission
 *     by `duCasefileId`, so a retry after a timeout has to carry the identifier
 *     from the response it never saw. The fixture is deterministic and hides
 *     this entirely.
 *   - **Deciding what happens to the document.** Whether an emitted casefile is
 *     retained anywhere is an open privacy question — it carries up to four
 *     cleartext social security numbers — and nothing in this repository stores
 *     one.
 */
export interface DuSubmissionBorrower {
  readonly partyId: string;
  /** DU Borrower 1 through 4, as the document orders them. */
  readonly borrowerOrdinal: number;
  /**
   * Which retrievals this person's figures were drawn from.
   *
   * The guard is keyed on this rather than on a single blanket permission,
   * because a figure may be transmitted only if the person it belongs to
   * permitted the retrieval it came from — and those are several different
   * permissions with different legal bases. Transcript income rides on a Form
   * 4506-C and the rest on APP-005; a submission carrying both on an APP-005
   * token alone is sending the IRS's answer under a permission that does not
   * mention the IRS.
   *
   * Never empty. DU underwrites each borrower's credit, so a borrower on a
   * casefile has had something retrieved about them; a borrower declaring none
   * is an assembly bug, and the adapter refuses rather than transmitting a
   * person nothing was checked for.
   */
  readonly dataCategories: readonly DataCategory[];
}

export interface DuSubmission {
  readonly applicationId: string;
  /**
   * The loan file the application was born from — `applications.loan_file_id`,
   * which is NOT NULL and UNIQUE, so it names this application and no other.
   *
   * Here because an authorization is scoped to a file rather than to an
   * application: a grant belongs to the person and outlives the file it was
   * signed on, so the guard has to be told which file's signatures these
   * tokens are supposed to be. The assembler reads it off the same row it read
   * `applicationId` from, and `recordDuResponse` checks the pair against
   * Postgres when the answer comes back.
   */
  readonly loanFileId: string;
  /**
   * Ours, stable across every resubmission of this loan. It is a 36-character
   * UUID, it fits neither DU identifier field, and it is never sent as one.
   */
  readonly ausCasefileId: string;
  /** DU's own, on a resubmission. Null the first time DU sees this case. */
  readonly duCasefileId: string | null;
  readonly borrowers: readonly DuSubmissionBorrower[];
  /**
   * The emitted casefile, as the emitter produced it.
   *
   * Opaque here on purpose: this package neither builds it nor parses it, and
   * an adapter that reads it has taken on a second copy of the serializer's
   * assumptions. The only thing asserted about it is that there is one, by
   * `requireDocument` below — an empty body reaches DU as a malformed casefile
   * rather than as an error we could have caught.
   */
  readonly document: string;
}

/**
 * Thrown when a submission carries no casefile to submit.
 *
 * Its own class rather than a plain `Error` because the one thing a caller has
 * to be able to tell is that this is NOT `DuTransportNotWiredError`: "there is
 * nowhere to send this" is an operator's problem and "there is nothing to
 * send" is the assembler's, and the adapter that will one day have a transport
 * can raise either.
 */
export class EmptyDuDocumentError extends Error {
  constructor() {
    super("A submission with an empty document transmits nothing. Refusing to send.");
    this.name = "EmptyDuDocumentError";
  }
}

/**
 * The whole of what an adapter asserts about the emitted bytes.
 *
 * Shared by both adapters rather than written in each, because the one that
 * matters is the one that can actually send, and an emptiness check that lives
 * only in the fixture is a check on the path where nothing was going anywhere.
 */
export function requireDocument(submission: Pick<DuSubmission, "document">): void {
  if (submission.document.trim() === "") throw new EmptyDuDocumentError();
}

export interface DuConnector {
  readonly capabilities: ConnectorCapabilities;
  /**
   * `tokens` must cover every borrower on the submission, for every data
   * category that borrower's figures came from, and each must have been minted
   * on `loanFileId`. The check is inside the adapter, like every other
   * person-keyed port, so a new route cannot forget it.
   *
   * Mint them with `tokenFor` in the API and nothing else. It is the only
   * minter that asks whether this borrower's signature is on THIS file before
   * it stamps the file id a submission is then checked against; a token built
   * straight from `mintPurposeToken` carries whatever file its caller named.
   */
  submit(
    submission: DuSubmission,
    tokens: readonly PurposeToken[],
  ): Promise<ConnectorResult<DuResponse>>;
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
  readonly du: DuConnector;
}
