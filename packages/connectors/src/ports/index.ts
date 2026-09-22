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
  PriceQuote,
  PricingScenario,
  PropertyRecord,
  SanctionsScreening,
  ServicingRecord,
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

/**
 * The parcel is on record and no automated valuation exists for it. Not the
 * same fact as the address being unknown: a co-op building, a new
 * construction, a parcel the model will not price all have a record and no
 * estimate, and a screen that reads this as "no record" drops the card it
 * could have shown.
 */
export class ValuationUnavailableError extends Error {
  constructor(readonly address: string) {
    super(`No automated valuation is available for ${address}.`);
    this.name = "ValuationUnavailableError";
  }
}

/**
 * No flood determination has been made for the address. Until a flood vendor
 * is wired the fixture knows three addresses, and every other parcel is
 * undetermined rather than unknown — a federally related mortgage needs a
 * certified determination, and an undetermined one is a fact a screen can
 * say, where an invented zone is not.
 */
export class FloodNotDeterminedError extends Error {
  constructor(readonly address: string) {
    super(`No flood determination has been made for ${address}.`);
    this.name = "FloodNotDeterminedError";
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
 * What this loan costs (UW-010).
 *
 * The port every file in this product went without: the note rate was
 * `Number(process.env.DEFAULT_NOTE_RATE ?? "6.25")`, one number for every
 * borrower, and the six requirements that need a rate to compute anything were
 * all computing against it.
 *
 * ── Two methods, because credit is the line ───────────────────────────────
 *
 * `quoteProducts` takes a `PricingScenario`, which names a loan and nobody —
 * no party, no name, no score — and it takes no `PurposeToken` and CANNOT be
 * given one. That is the same split the property lookups draw, for the same
 * reason and with the same limit on it: screen 1 quotes a payment before
 * APP-005 is signed, so a guard here would make the flow unreachable from its
 * own first step, and what makes that acceptable is that the request is a loan
 * size, a property type and a state rather than a person.
 *
 * `quoteForBorrower` is guarded, on `credit_report`. A representative FICO is
 * the credit report's number, and sending it to a pricing vendor is disclosing
 * what a bureau said about somebody to a third party — which is the thing
 * APP-005 permits, and the permission it rides on is the one that got the
 * score in the first place.
 *
 * ── The answer, for two kinds of vendor ───────────────────────────────────
 *
 * `PriceQuote` in `@hm/shared` is a union: a product and pricing engine
 * answers with a borrower-facing note rate, and an investor execution API
 * answers with a price for a stated coupon, which is not a rate until a margin
 * and a grid have been applied. Nothing below turns the second into the first.
 * Read `borrowerNoteRate`, and record `blocked` when it returns null.
 *
 * **The request is not a union, and only one of the two vendors fits it.**
 * `PricingScenario` asks a pricing engine's question. An execution API is
 * asked for a coupon ladder against a delivery type with servicing retained or
 * released, and best execution means naming several investors and comparing
 * them — none of which this request can say and none of which
 * `InvestorPriceQuote` can answer with an investor's name on it. So wiring one
 * is a change to `@hm/shared/types/pricing.ts` before it is a new file in
 * `adapters/`, which is the opposite of what the seam promises for the other
 * ten ports, and is said here so nobody discovers it mid-adapter.
 *
 * ── A vendor's answer is checked before it is believed ────────────────────
 *
 * `requireQuotableQuote` is the twin of `requireQuotableScenario` and runs on
 * the way out. A note rate of zero is the case worth naming: it is what an
 * absent field deserializes to in most mappings, it looks like a number all
 * the way down, and the engine records a payment computed from it instead of
 * blocking.
 *
 * ── An empty list is an answer; a failure is not ──────────────────────────
 *
 * No eligible product is a real outcome — a loan size nothing covers, a lock
 * period the sheet has no column for — and it comes back as an empty array.
 * Anything that stopped the quote from being asked THROWS. A caller may read
 * empty as "we offer nothing for this loan"; it may never read a failure that
 * way, which is why the two are not both `[]`.
 */
export interface PricingConnector {
  readonly capabilities: ConnectorCapabilities;
  /** Products this loan is eligible for, at the sheet's base pricing. */
  quoteProducts(scenario: PricingScenario): Promise<readonly PriceQuote[]>;
  /**
   * The same scenario with the borrower's credit priced into it.
   *
   * The score is a separate argument rather than a field on the scenario so
   * that `PricingScenario` stays provably person-free and the unguarded call
   * cannot be handed one.
   */
  quoteForBorrower(
    file: LoanFile,
    token: PurposeToken,
    scenario: PricingScenario,
    representativeFico: number,
  ): Promise<readonly PriceQuote[]>;
}

/** Thrown when there is nothing here a vendor could price. */
export class UnquotableScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnquotableScenarioError";
  }
}

/**
 * The whole of what an adapter asserts about a scenario before asking.
 *
 * Shared by both adapters for the reason `requireDocument` is: the check that
 * matters is the one on the path that reaches a vendor, and a sanity check
 * living only in the fixture is a check on the path where nothing was at
 * stake. A pricing engine handed a zero loan amount does not refuse — it
 * answers off the base sheet, and that answer becomes a note rate on a file.
 *
 * A FICO outside the scorable range is the same failure on the guarded call:
 * 0 sits below every tier, and a vendor that floors rather than refuses prices
 * the worst credit in the book.
 */
export function requireQuotableScenario(scenario: PricingScenario): void {
  if (scenario.loanAmount <= 0) {
    throw new UnquotableScenarioError("A loan of nothing prices at nothing. Refusing to quote.");
  }
  if (scenario.propertyValue <= 0) {
    throw new UnquotableScenarioError(
      "Pricing runs on LTV, and a property worth nothing has none. Refusing to quote.",
    );
  }
  if (scenario.lockDays <= 0) {
    throw new UnquotableScenarioError(
      "A rate sheet is quoted per lock period, and no period names no column.",
    );
  }
}

/** The scorable range. Outside it, a score is a bug rather than bad credit. */
export function requireScorableFico(fico: number): void {
  if (!Number.isFinite(fico) || fico < 300 || fico > 850) {
    throw new UnquotableScenarioError(
      "A representative FICO outside 300-850 is not a credit tier. Refusing to quote.",
    );
  }
}

/**
 * The plausible band for a first-lien note rate, in percent.
 *
 * Wide on purpose — it is not a business rule about what we would offer, and
 * nothing may read it as one. It is the band outside which a number is a
 * mapping bug rather than a price: a field read off the wrong key, a decimal
 * read as a percent, a fraction read as a whole number. 30-year fixed rates
 * have been under 3 and over 18 inside living memory, so a band narrow enough
 * to be interesting would refuse a real market.
 */
const PLAUSIBLE_NOTE_RATE = { min: 0.5, max: 25 } as const;

/** The longest amortization anybody writes, with room. 40 years is 480. */
const MAX_TERM_MONTHS = 600;

/**
 * The answer-side twin of `requireQuotableScenario`, and the reason it exists.
 *
 * `requireScorableFico` asserts exactly this shape on the way IN, and for a
 * while nothing asserted anything on the way OUT: a vendor answering with a
 * note rate of 0, of -4.5, of 999, of NaN, or with the field simply absent —
 * the ordinary mapping bug, a key the vendor did not send — was taken at its
 * word and written to `loan_files.note_rate`. A zero is the worst of them,
 * because it does not read as missing anywhere downstream: it amortizes, it
 * produces a payment, and the engine RECORDS that payment as a derivation
 * rather than blocking on it. A $332,000 loan at no interest, with a formula
 * beside it.
 *
 * Here rather than in one adapter for the reason `requireQuotableScenario` is:
 * the check that matters is the one on the path that reaches a vendor, and the
 * fixture is the path where nothing was at stake.
 */
export function requireQuotableQuote(quote: PriceQuote): void {
  if (!Number.isInteger(quote.termMonths) || quote.termMonths <= 0) {
    throw new UnquotableScenarioError(
      `A term of ${quote.termMonths} months is not a term. Refusing to quote ${quote.productCode}.`,
    );
  }
  if (quote.termMonths > MAX_TERM_MONTHS) {
    throw new UnquotableScenarioError(
      `A term of ${quote.termMonths} months is longer than any loan is written for. ` +
        `Refusing to quote ${quote.productCode}.`,
    );
  }
  const effective = Date.parse(quote.effectiveAt);
  const expires = Date.parse(quote.expiresAt);
  if (!Number.isFinite(effective) || !Number.isFinite(expires) || expires <= effective) {
    throw new UnquotableScenarioError(
      `A quote whose window runs from ${quote.effectiveAt} to ${quote.expiresAt} has no window. ` +
        `Refusing to quote ${quote.productCode}.`,
    );
  }
  // Whether the window has PASSED is not asked here, and that is the gap
  // rather than an oversight: nothing in this product enforces an expiry, so a
  // check would refuse every quote a fixture dated to a past reference day
  // while changing nothing about a live one. What is refused is a window that
  // is not a window, which is the vendor-mapping failure.
  //
  // An execution API's arm has no borrower-facing rate by construction, and
  // refusing its absence here would refuse the whole vendor kind. The caller
  // reads `borrowerNoteRate` and records blocked; what is checked is the arm
  // that DOES claim to carry one.
  if (quote.basis !== "borrower_rate") return;
  const rate = quote.noteRate;
  if (!Number.isFinite(rate) || rate < PLAUSIBLE_NOTE_RATE.min || rate > PLAUSIBLE_NOTE_RATE.max) {
    throw new UnquotableScenarioError(
      `A note rate of ${rate} is not a rate any vendor meant. ` +
        `Refusing to quote ${quote.productCode}.`,
    );
  }
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
 *   - **A transport.** An endpoint, an authentication scheme and an HTTP
 *     envelope — the media type, and whether a POST is answered synchronously
 *     at all — none of which is in the vendored corpus. That corpus specifies
 *     the casefile, not the conversation: the MESSAGE-level envelope IS built,
 *     in `packages/du/src/assemble`, and `DU_Wrapper_3.4.0_B324.xsd` is an
 *     `xsd:redefine` of the MISMO model rather than a wrapper around a message.
 *     A real adapter must not invent the HTTP half, which is why `duConnector`
 *     takes the endpoint, the credential scheme and the response reader as
 *     configuration with no defaults.
 *   - **Reading the answer.** DU's response format is a specification we do not
 *     hold either. `parseDuRecommendation` is the half that can be written
 *     today, and a real adapter must go through it rather than storing whatever
 *     string arrived. `mismoAusResponseReader` does, against the one response
 *     shape the schema chain declares, and is marked as the guess it is.
 *   - **Retries that do not open a second case.** DU recognizes a resubmission
 *     by `duCasefileId`, so a retry after a timeout has to carry the identifier
 *     from the response it never saw. The fixture is deterministic and hides
 *     this entirely. The emitter now writes it —
 *     `LOAN/UNDERWRITING/AUTOMATED_UNDERWRITINGS/AUTOMATED_UNDERWRITING`, from
 *     `applications.du_casefile_id`, absent on a first submission — and
 *     `DuTransportError.mayHaveOpenedACase` is how the adapter says it cannot
 *     know whether a timed-out send arrived.
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

/**
 * The CFPB's weekly mortgage-rate survey, which the average prime offer rate
 * is computed from.
 *
 * A source and not a person: the file names no borrower, no address and no
 * loan, so there is nothing an authorization could be for and the call takes
 * no token. It is the one port in the registry that fetches a publication
 * rather than a report, which is why it returns a document with the server's
 * own headers on it and not a `ConnectorResult` — the provenance a decision
 * records for an APOR is "which publication", and the publication's identity
 * is its ETag and its Last-Modified, not an external id a vendor minted.
 *
 * Nothing on a request path calls this. `scripts/fetch-apor.ts` does, on a
 * schedule, and writes what it gets into `apor_survey_fetches`; the API reads
 * that table. A route that fetched on demand would put a decision's inputs at
 * the mercy of a government file server at the moment a borrower clicked.
 */
export interface AporSurveyDocument {
  /** The document exactly as served. Parsed in `@hm/underwriting`, never here. */
  readonly csv: string;
  readonly url: string;
  readonly retrievedAt: string;
  /** The server's Last-Modified header, verbatim, or null if it sent none. */
  readonly lastModified: string | null;
  /** The server's ETag, verbatim, or null if it sent none. */
  readonly etag: string | null;
}

export type AporSurveyFetch =
  | { readonly status: "fetched"; readonly document: AporSurveyDocument }
  /** The server answered 304 to the headers it was given. Nothing to ingest. */
  | { readonly status: "unchanged"; readonly etag: string | null };

export interface AporSeriesConnector {
  readonly capabilities: ConnectorCapabilities;
  /**
   * The PUBLISHED fixed-rate table — `YieldTableFixed.txt`, one Monday per
   * row, the file the CFPB's own calculator reads. The figure in force, and
   * the source of truth; the survey below is the cross-check. Same
   * conditional-request contract as `fetchSurvey`.
   */
  fetchTable(options?: {
    readonly ifNoneMatch?: string;
    readonly ifModifiedSince?: string;
  }): Promise<AporSurveyFetch>;
  /**
   * Fetch the survey, conditionally when the previous fetch's headers are
   * given. Both are sent because the CFPB's file server honors
   * `If-Modified-Since` and ignores `If-None-Match` — measured, not assumed —
   * and a server that honors either is a 304 instead of eighteen kilobytes.
   * Throws on any answer that is not the survey — a non-2xx status, or a body
   * that does not begin with the survey's header row — rather than returning
   * something a parser would then have to refuse.
   */
  fetchSurvey(options?: {
    readonly ifNoneMatch?: string;
    readonly ifModifiedSince?: string;
  }): Promise<AporSurveyFetch>;
  /**
   * Ask the CFPB's own rate-spread calculator what it holds for a week and a
   * term, as a check on what was just ingested. The calculator answers a
   * spread against a given APR; at an APR of 10.000 the APOR is 10 minus the
   * spread. "unavailable" is an outage, not a disagreement, and is reported
   * rather than failed on; an ANSWER that disagrees with the stored row is a
   * contradiction between two CFPB sources and is failed on.
   */
  rateSpreadCheck(input: {
    readonly weekOf: string;
    readonly termYears: number;
  }): Promise<{ status: "answered"; apor: number } | { status: "unavailable"; reason: string }>;
}

/**
 * Outbound mail. The one port keyed on neither an address nor a person: a
 * message goes to whoever the caller names, and what the caller may say to
 * them is the caller's rule — so, like e-sign, it is unguarded, and the guard
 * test lists it as such.
 *
 * Deliberately small. A co-borrower's invitation is one recipient, a
 * subject and plain text with one link in it, and the link is the whole of
 * the message's authority; nothing here needs templates, attachments or
 * HTML. `not_delivered` is an answer rather than a throw because the caller
 * has to record that the invitation exists and was not sent, which is a
 * different thing from an invitation that does not exist.
 */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}
export type MailOutcome =
  | { readonly status: "sent"; readonly externalId: string; readonly provider: string }
  | { readonly status: "not_delivered"; readonly reason: string };
export interface MailConnector {
  readonly capabilities: ConnectorCapabilities;
  send(message: MailMessage): Promise<MailOutcome>;
}

/**
 * The servicing platform's record of a mortgage: what it has concluded about
 * a loan it watches or services, keyed on the number the servicer uses.
 *
 * Unguarded, and listed as such in the guard test, for the reason the
 * property lookups are: the key is a loan number, never a person, and the
 * platform on the other side already holds the same loan from the same
 * partner's tape — the tape that lands here without anyone's authorization
 * either, because a servicer's facts about a mortgage are not a consumer
 * report. Nothing about a person crosses in either direction. Who may SEE
 * the answer is the route's rule: a party on the loan, or nobody.
 *
 * `null` is an answer — the platform holds no such loan — and a vendor
 * failure is a throw, so a caller cannot read "we could not ask" as "there
 * is nothing".
 */
export interface ServicingLoanRef {
  readonly servicerSlug: string;
  readonly servicerLoanNumber: string;
  /**
   * The platform's own id for this loan from an earlier read, when the caller
   * kept it (`ConnectorResult.externalId`). An adapter reads by it and falls
   * back to the number when the platform no longer answers it, so a stale id
   * costs one extra call rather than a wrong answer. Optional: the first read
   * has none, and the fixture needs none.
   */
  readonly externalLoanId?: string;
}

export interface ServicingConnector {
  readonly capabilities: ConnectorCapabilities;
  fetchRecord(ref: ServicingLoanRef): Promise<ConnectorResult<ServicingRecord> | null>;
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
  readonly pricing: PricingConnector;
  readonly du: DuConnector;
  readonly aporSeries: AporSeriesConnector;
  readonly mail: MailConnector;
  readonly servicing: ServicingConnector;
}
