/**
 * Fixture adapters — the V1 implementation of every connector port.
 *
 * They return persona data from `../fixtures/personas.ts` after enforcing the
 * same authorization guard a real adapter must. That is the part worth being
 * careful about: a fixture that skips the guard trains the codebase to expect
 * data before consent, and the first real vendor inherits that assumption.
 *
 * `latencyMs` exists so the UI is built against a connector that takes time.
 * A borrower staring at screen 4 for eight seconds is the actual experience,
 * and a fixture that resolves instantly hides every missing spinner.
 */

import type {
  PurposeToken,
  Address,
  AddressSuggestion,
  AvmEstimate,
  Consent,
  CreditReport,
  DuRecommendation,
  DuResponse,
  FloodDetermination,
  LienSearch,
  LoanFile,
  PayrollData,
  PriceQuote,
  PricingScenario,
  PropertyRecord,
  SanctionsScreening,
  TaxTranscript,
} from "@hm/shared";
import { FFIEC_SURVEY, FFIEC_YIELD_TABLE_FIXED } from "@hm/shared";
import {
  AddressNotFoundError,
  requireDocument,
  requireQuotableScenario,
  requireScorableFico,
} from "../ports/index.js";
import type {
  AporSeriesConnector,
  AssetReportResult,
  BankConnector,
  DuConnector,
  DuSubmission,
  IdentityConnector,
  LinkHandoff,
  ConnectorRegistry,
  MailConnector,
  MailMessage,
  MailOutcome,
  ConnectorResult,
  CreditConnector,
  EsignConnector,
  IrsConnector,
  LienConnector,
  LinkSession,
  PayrollConnector,
  PricingConnector,
  PropertyDataConnector,
  ScreeningConnector,
} from "../ports/index.js";
import {
  requireCategory,
  requireEveryBorrowerAuthorized,
  requireSubject,
  subjectOf,
} from "../guard.js";
import { PERSONAS, type PersonaId, DEFAULT_PERSONA } from "../fixtures/personas.js";
import { ADDRESS_BOOK, OFAC_LISTS, PUBLIC_RECORDS } from "../fixtures/public-records.js";
import { RATE_SHEET, SHEET_LOCK_DAYS, sheetWindow } from "../fixtures/rate-sheet.js";

export interface FixtureOptions {
  readonly persona?: PersonaId;
  /** Simulated round-trip time. Set to 0 in tests. */
  readonly latencyMs?: number;
  /** Reference date the persona's relative dates are generated from. */
  readonly referenceDate?: Date;
  /**
   * What the watchlists say. Every persona's public record screens clear, so
   * without this there is no way to see the one state a name on a list
   * produces: a file held while somebody looks at it. Asked for explicitly,
   * because a fixture that sometimes matched would make the hold look like
   * flakiness.
   */
  readonly screening?: "clear" | "near_match";
  /**
   * What Desktop Underwriter answers. Defaults to "Approve/Eligible".
   *
   * `"error"` is the other shape a response comes in — DU could not evaluate
   * the casefile and returned no recommendation at all — and it is a value
   * rather than a thrown error because a rejected casefile is an answer worth
   * recording, not a failed call. Asked for explicitly, for the reason
   * `screening` is: a fixture that sometimes referred would make a hold look
   * like flakiness.
   */
  readonly du?: DuRecommendation | "error";
}

interface Resolved {
  readonly persona: PersonaId;
  readonly latencyMs: number;
  readonly ref: Date;
  readonly screening: "clear" | "near_match";
  readonly du: DuRecommendation | "error";
}

function resolve(options: FixtureOptions): Resolved {
  return {
    persona: options.persona ?? DEFAULT_PERSONA,
    latencyMs: options.latencyMs ?? 900,
    ref: options.referenceDate ?? new Date(),
    screening: options.screening ?? "clear",
    du: options.du ?? "Approve/Eligible",
  };
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function result<T>(data: T, provider: string, externalId: string): ConnectorResult<T> {
  return { data, provider, retrievedAt: new Date().toISOString(), externalId };
}

function session(prefix: string, ref: Date): LinkSession {
  const expires = new Date(ref.getTime() + 30 * 60_000);
  return {
    sessionId: `${prefix}-session`,
    linkToken: `${prefix}-token`,
    expiresAt: expires.toISOString(),
    // A fixture needs nobody to log in anywhere.
    requiresClientHandoff: false,
  };
}

export function fixtureCreditConnector(options: FixtureOptions = {}): CreditConnector {
  const { persona, latencyMs, ref } = resolve(options);
  return {
    capabilities: {
      provider: "fixture-credit",
      mode: "fixture",
      satisfies: ["CRD-001", "CRD-002", "CRD-003", "CRD-004", "CRD-005", "CRD-016", "APP-018"],
    },
    async pullTriMerge(
      file: LoanFile,
      token: PurposeToken,
    ): Promise<ConnectorResult<CreditReport>> {
      requireCategory(token, "credit_report");
      requireSubject(token, file);
      await sleep(latencyMs);
      return result(PERSONAS[persona].credit(ref), "fixture-credit", `credit-${persona}`);
    },
  };
}

export function fixtureBankConnector(options: FixtureOptions = {}): BankConnector {
  const { persona, latencyMs, ref } = resolve(options);
  return {
    capabilities: {
      provider: "fixture-bank",
      mode: "fixture",
      satisfies: [
        "AST-001",
        "AST-005",
        "AST-007",
        "AST-008",
        "CRD-013",
        "CRD-017",
        "CRD-018",
        "INC-001",
      ],
    },
    async createLinkSession(file: LoanFile, token: PurposeToken): Promise<LinkSession> {
      requireCategory(token, "bank_transactions");
      requireSubject(token, file);
      return session("bank", ref);
    },
    async fetchAssetReport(
      file: LoanFile,
      token: PurposeToken,
      _handoff: LinkHandoff,
      monthsRequested: number,
    ): Promise<AssetReportResult> {
      requireCategory(token, "bank_transactions");
      requireSubject(token, file);
      // The 12-month window is not a preference. CRD-017's cash flow assessment
      // and CRD-018's rent history both need twelve, and a shorter report
      // satisfies neither — so a caller asking for less is a bug, not a choice.
      if (monthsRequested < 12) {
        throw new Error(
          `Asset report requested for ${monthsRequested} months; CRD-017 and CRD-018 require 12.`,
        );
      }
      await sleep(latencyMs);
      return {
        status: "ready",
        result: result(PERSONAS[persona].assets(ref), "fixture-bank", `assets-${persona}`),
      };
    },
  };
}

export function fixturePayrollConnector(options: FixtureOptions = {}): PayrollConnector {
  const { persona, latencyMs, ref } = resolve(options);
  return {
    capabilities: {
      provider: "fixture-payroll",
      mode: "fixture",
      satisfies: ["INC-002", "INC-005", "INC-006", "INC-022", "INC-023"],
    },
    async createLinkSession(file: LoanFile, token: PurposeToken): Promise<LinkSession> {
      requireCategory(token, "payroll_income");
      requireSubject(token, file);
      return session("payroll", ref);
    },
    async fetchPayroll(
      file: LoanFile,
      token: PurposeToken,
      _sessionId: string,
    ): Promise<ConnectorResult<PayrollData>> {
      requireCategory(token, "payroll_income");
      requireSubject(token, file);
      await sleep(latencyMs);
      return result(PERSONAS[persona].payroll(ref), "fixture-payroll", `payroll-${persona}`);
    },
  };
}

export function fixtureIrsConnector(options: FixtureOptions = {}): IrsConnector {
  const { persona, latencyMs, ref } = resolve(options);
  return {
    capabilities: {
      provider: "fixture-irs",
      mode: "fixture",
      satisfies: ["INC-003", "INC-009"],
    },
    async fetchTranscripts(
      file: LoanFile,
      token: PurposeToken,
      taxYears: readonly number[],
    ): Promise<ConnectorResult<readonly TaxTranscript[]>> {
      // A different permission from the one behind a credit pull. A caller
      // holding an APP-005 token is refused here, which the old
      // `assert4506cExecuted(file)` could not do — it checked the file for any
      // 4506-C, by anyone.
      requireCategory(token, "tax_transcript");
      requireSubject(token, file);
      await sleep(latencyMs);
      const all = PERSONAS[persona].transcripts(ref);
      const filtered = taxYears.length ? all.filter((t) => taxYears.includes(t.taxYear)) : all;
      return result(filtered, "fixture-irs", `transcripts-${persona}`);
    },
  };
}

/**
 * The e-sign adapter is the one connector that must NOT check the
 * authorization guard — it is how the authorization gets signed in the first
 * place. Guarding it would make APP-005 unobtainable.
 */
/**
 * The e-sign adapter, deliberately STATELESS.
 *
 * An earlier version kept envelopes in a Map on the adapter instance. That
 * works on one process and breaks on Cloud Run the moment it scales past one:
 * the envelope is created on instance A, the borrower signs, and the completion
 * request lands on instance B, which has never heard of it. The failure is
 * intermittent and load-dependent, which is the worst kind.
 *
 * So the envelope id CARRIES its own state. A real vendor holds this in their
 * own system and hands back an opaque id; a fixture has nowhere to put it, and
 * inventing a table for a thing that will be deleted the day Docusign is wired
 * in is worse than encoding it. The port's shape is unchanged, so the real
 * adapter can be opaque without anything above caring.
 */
const ENVELOPE_PREFIX = "fixture-envelope";

function encodeEnvelope(kind: Consent["kind"], borrowerId: string): string {
  return `${ENVELOPE_PREFIX}.${kind}.${borrowerId}`;
}

function decodeEnvelope(envelopeId: string): { kind: Consent["kind"]; borrowerId: string } | null {
  const parts = envelopeId.split(".");
  if (parts.length !== 3 || parts[0] !== ENVELOPE_PREFIX) return null;
  const [, kind, borrowerId] = parts;
  if (!kind || !borrowerId) return null;
  return { kind: kind as Consent["kind"], borrowerId };
}

export function fixtureEsignConnector(options: FixtureOptions = {}): EsignConnector {
  const { latencyMs } = resolve(options);

  return {
    capabilities: {
      provider: "fixture-esign",
      mode: "fixture",
      satisfies: ["APP-005", "APP-012", "INC-008"],
    },
    async createEnvelope(_file: LoanFile, kind: Consent["kind"], borrowerId: string) {
      const envelopeId = encodeEnvelope(kind, borrowerId);
      await sleep(latencyMs);
      return { envelopeId, signingUrl: `/sign/${envelopeId}` };
    },
    async getCompletedConsent(envelopeId: string): Promise<Consent | null> {
      const envelope = decodeEnvelope(envelopeId);
      if (!envelope) return null;
      return {
        kind: envelope.kind,
        borrowerId: envelope.borrowerId,
        grantedAt: new Date().toISOString(),
        envelopeId,
        ipAddress: "127.0.0.1",
        userAgent: "fixture",
      };
    },
  };
}

/* ── Property data ──────────────────────────────────────────────────────── */

/** Single-line form, for the autocomplete dropdown. */
function oneLine(address: Address): string {
  const street = address.line2 ? `${address.line1}, ${address.line2}` : address.line1;
  return `${street}, ${address.city}, ${address.state} ${address.postalCode}`;
}

function sameAddress(a: Address, b: Address): boolean {
  return a.line1.toLowerCase() === b.line1.toLowerCase() && a.postalCode === b.postalCode;
}

/**
 * Assessor, AVM and flood, plus address autocomplete.
 *
 * UNGUARDED, deliberately. These run on screen 1, before the authorization on
 * screen 2 exists, and a guard here would make the flow unreachable from its
 * own first step — the trap `fixtureEsignConnector` documents below.
 *
 * The reason that is acceptable is narrower than "it comes first": nothing
 * here is about a person. An address the borrower is typing into our form, and
 * public county records about a building, are not what APP-005 gates. The
 * moment a lookup keys on a *name* it moves to `fixtureScreeningConnector` or
 * `fixtureLienConnector`, both of which are guarded.
 *
 * A lookup for an address we hold no fixture for throws `AddressNotFoundError`
 * rather than falling back to the active persona's record. Returning somebody
 * else's building would put fabricated square footage in front of a borrower
 * and ask them to confirm it — and a borrower who confirms invented
 * characteristics has been walked into a false attestation by the UI. Not
 * knowing is a legitimate answer; guessing is not.
 */
export function fixturePropertyDataConnector(options: FixtureOptions = {}): PropertyDataConnector {
  // No `persona` here on purpose: this connector answers from the address, not
  // from whoever is walking the flow. See the note above.
  const { latencyMs, ref } = resolve(options);
  const fixtureFor = (address: Address) => {
    const match = Object.values(PUBLIC_RECORDS).find((r) => sameAddress(r.address, address));
    if (!match) throw new AddressNotFoundError(oneLine(address));
    return match;
  };

  return {
    capabilities: {
      provider: "fixture-property",
      mode: "fixture",
      satisfies: ["APP-004"],
    },
    async suggestAddresses(query: string): Promise<readonly AddressSuggestion[]> {
      const q = query.trim().toLowerCase();
      if (q.length < 3) return [];
      // A third of the usual latency: an autocomplete that takes 900ms is an
      // autocomplete nobody waits for.
      await sleep(Math.round(latencyMs / 3));
      return ADDRESS_BOOK.filter((a) => oneLine(a).toLowerCase().includes(q)).map((a) => ({
        id: `${a.line1}|${a.postalCode}`.replace(/\s+/g, "-").toLowerCase(),
        label: oneLine(a),
        address: a,
      }));
    },
    async lookupRecord(address: Address): Promise<ConnectorResult<PropertyRecord>> {
      await sleep(latencyMs);
      return result(fixtureFor(address).record, "fixture-property", `record-${address.postalCode}`);
    },
    async estimateValue(address: Address): Promise<ConnectorResult<AvmEstimate>> {
      await sleep(latencyMs);
      return result(fixtureFor(address).avm(ref), "fixture-avm", `avm-${address.postalCode}`);
    },
    async determineFlood(address: Address): Promise<ConnectorResult<FloodDetermination>> {
      await sleep(latencyMs);
      return result(fixtureFor(address).flood(ref), "fixture-flood", `flood-${address.postalCode}`);
    },
  };
}

/* ── Screening ──────────────────────────────────────────────────────────── */

/**
 * OFAC/SDN screening (CRD-010).
 *
 * Guarded — this one screens a named person against government watchlists.
 * It replaces the inline `sanctionsScreenClear: true` the credit route used to
 * assert without screening anything.
 *
 * `screening: "near_match"` is the only way to see a held file. All three
 * public-record fixtures come back clear — variable_income's score-41 hit is
 * deliberately below the threshold — so a sample borrower whose application is
 * held would otherwise wear a pill its own evidence contradicts. The match is
 * built against the name of the party the TOKEN speaks for rather than a fixed
 * one, because a hold that named somebody else would be the same contradiction
 * one layer down — and on a file with a co-borrower, "whoever sorts first" is
 * not the person the search was run on.
 */
export function fixtureScreeningConnector(options: FixtureOptions = {}): ScreeningConnector {
  const { persona, latencyMs, ref, screening } = resolve(options);
  return {
    capabilities: {
      provider: "fixture-screening",
      mode: "fixture",
      satisfies: ["CRD-010"],
    },
    async screenSanctions(
      file: LoanFile,
      token: PurposeToken,
    ): Promise<ConnectorResult<SanctionsScreening>> {
      requireCategory(token, "sanctions_screening");
      requireSubject(token, file);
      await sleep(latencyMs);
      if (screening === "near_match") {
        const who = file.borrowers.find((b) => b.partyId === subjectOf(token));
        const matchedName = who ? `${who.firstName} ${who.lastName}`.toUpperCase() : "UNKNOWN";
        return result(
          {
            clear: false,
            // One list and a score under 100: a near match is a name that
            // looks like the one on the list, which is why a person has to
            // read it rather than the file simply stopping.
            matches: [{ listName: "OFAC SDN", matchedName, score: 86 }],
            listsChecked: [...OFAC_LISTS],
            screenedAt: ref.toISOString(),
          },
          "fixture-screening",
          `ofac-${persona}-near-match`,
        );
      }
      return result(PUBLIC_RECORDS[persona].sanctions(ref), "fixture-screening", `ofac-${persona}`);
    },
  };
}

/* ── Liens ──────────────────────────────────────────────────────────────── */

/**
 * Ownership and encumbrance search against the APN from screen 1.
 *
 * Guarded — it ties a named borrower to recorded debts.
 */
export function fixtureLienConnector(options: FixtureOptions = {}): LienConnector {
  const { persona, latencyMs, ref } = resolve(options);
  return {
    capabilities: {
      provider: "fixture-liens",
      mode: "fixture",
      satisfies: ["UW-005", "APP-016"],
    },
    async searchLiens(
      file: LoanFile,
      token: PurposeToken,
      apn: string,
    ): Promise<ConnectorResult<LienSearch>> {
      requireCategory(token, "public_record_liens");
      requireSubject(token, file);
      if (!apn) {
        // The search is keyed on the APN the assessor lookup returned. Calling
        // it without one silently searches nothing and reports a clean result,
        // which is the worst possible answer to "are there liens".
        throw new Error("Lien search requires an APN. Run the assessor lookup first.");
      }
      await sleep(latencyMs);
      return result(PUBLIC_RECORDS[persona].liens(ref), "fixture-liens", `liens-${apn}`);
    },
  };
}

/* ── Identity ───────────────────────────────────────────────────────────── */

export function fixtureIdentityConnector(options: FixtureOptions = {}): IdentityConnector {
  const { persona, latencyMs, ref } = resolve(options);
  const PREFIX = "fixture-idv";

  return {
    capabilities: {
      provider: "fixture-identity",
      mode: "fixture",
      satisfies: ["APP-001"],
    },
    async createVerificationSession(_file, borrowerId) {
      await sleep(latencyMs);
      const verificationId = `${PREFIX}.${borrowerId}`;
      return { verificationId, verificationUrl: `/verify/${verificationId}` };
    },
    async getVerification(verificationId) {
      if (!verificationId.startsWith(`${PREFIX}.`)) return null;
      await sleep(latencyMs);
      const doc = PUBLIC_RECORDS[persona].identity(ref);
      return {
        verificationId,
        status: "verified",
        verifiedAt: new Date().toISOString(),
        documentName: `${doc.firstName} ${doc.lastName}`,
        documentDateOfBirth: doc.dateOfBirth,
        documentAddress: doc.address,
      };
    },
  };
}

/* ── Pricing ────────────────────────────────────────────────────────────── */

/**
 * The rate sheet, served without a vendor.
 *
 * Two things about it are the point, and both are refusals.
 *
 * It applies NO adjustment — no FICO tier, no LTV band, no occupancy hit —
 * and says so on every quote it returns, including the guarded one that was
 * handed a score. `RATE_SHEET`'s header carries the argument: the matrices
 * are published documents this repository does not hold, and the plausible
 * invention is worse than the absence because it gets believed. So
 * `quoteForBorrower` answers with the same base rate `quoteProducts` does and
 * `creditTierApplied` is false in both, which is the sheet describing itself
 * rather than a caller having to know.
 *
 * And it holds one lock column. A scenario asking for any other period gets an
 * empty list, which the port defines as "nothing eligible" and which is the
 * truthful answer — the alternative is a 60-day request answered off the
 * 30-day column, which is a lock-extension spread invented at the moment
 * somebody needed one.
 */
export function fixturePricingConnector(options: FixtureOptions = {}): PricingConnector {
  const { latencyMs, ref } = resolve(options);

  function sheet(scenario: PricingScenario): readonly PriceQuote[] {
    if (scenario.lockDays !== SHEET_LOCK_DAYS) return [];
    const { effectiveAt, expiresAt } = sheetWindow(ref);
    return RATE_SHEET.map((product) => ({
      basis: "borrower_rate" as const,
      productCode: product.productCode,
      productName: product.productName,
      termMonths: product.termMonths,
      amortization: product.amortization,
      noteRate: product.baseRate,
      // No price. This sheet quotes a rate and nothing about execution, and a
      // par price asserted here would put "no discount points" into the
      // points-and-fees total on the strength of a fixture.
      pricePercentOfPar: null,
      lockDays: scenario.lockDays,
      effectiveAt,
      expiresAt,
      adjustments: [],
      creditTierApplied: false,
      // Nothing in this repository can lock a rate: no desk, no record, no
      // expiry enforcement. A fixture that said otherwise would be the one
      // claim on this port a borrower could act on and lose money over.
      locked: false,
    }));
  }

  return {
    capabilities: {
      provider: "fixture-pricing",
      mode: "fixture",
      // Nothing. UW-010 is the loan-level price adjustments, and a sheet that
      // applies none does not satisfy it — claiming it here would put the
      // requirement behind a base rate.
      satisfies: [],
    },

    async quoteProducts(scenario: PricingScenario): Promise<readonly PriceQuote[]> {
      requireQuotableScenario(scenario);
      await sleep(latencyMs);
      return sheet(scenario);
    },

    async quoteForBorrower(
      file: LoanFile,
      token: PurposeToken,
      scenario: PricingScenario,
      representativeFico: number,
    ): Promise<readonly PriceQuote[]> {
      requireCategory(token, "credit_report");
      requireSubject(token, file);
      requireQuotableScenario(scenario);
      requireScorableFico(representativeFico);
      await sleep(latencyMs);
      return sheet(scenario);
    },
  };
}

/* ── Desktop Underwriter ────────────────────────────────────────────────── */

/**
 * A casefile identifier in DU's shape, derived from ours.
 *
 * DU mints its own and we cannot guess what it would choose, so the fixture
 * needs some rule and the rule has to be DETERMINISTIC: `applications.
 * du_casefile_id` is write-once, and a fixture that answered a resubmission
 * with a fresh identifier would make an ordinary retry raise. Derived from the
 * casefile that is stable across resubmissions, so two answers about one loan
 * agree.
 *
 * Ten digits, because that is the shape DU's identifiers have and because the
 * column is a `VARCHAR(30)` that our own 36-character UUID does not fit.
 */
function fixtureCasefileId(ausCasefileId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < ausCasefileId.length; i++) {
    hash ^= ausCasefileId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return String(hash >>> 0)
    .padStart(10, "0")
    .slice(0, 10);
}

/**
 * The fixture that answers a submission without sending one.
 *
 * It runs the same guard a real adapter must, which is the part worth being
 * careful about here more than anywhere else in this file: a fixture that
 * transmitted on the applicant's token alone would train the codebase to
 * assemble submissions nobody but the applicant had authorized, and the first
 * real adapter would inherit an assembly path that has never once been asked
 * for a co-borrower's signature.
 *
 * What it does NOT do is in `DuConnector`'s own comment. The shortest version:
 * it sends nothing, so it needs no seller/servicer number, cannot time out, and
 * has never seen the response format.
 */
export function fixtureDuConnector(options: FixtureOptions = {}): DuConnector {
  const { latencyMs, du } = resolve(options);
  return {
    capabilities: {
      provider: "fixture-du",
      mode: "fixture",
      // UW-001 is the submission and UW-002 the recommendation that comes back.
      // UW-003 — every verification message turned into a trackable condition —
      // is not this port's: the messages arrive here and something above has to
      // do that with them.
      satisfies: ["UW-001", "UW-002"],
    },
    async submit(
      submission: DuSubmission,
      tokens: readonly PurposeToken[],
    ): Promise<ConnectorResult<DuResponse>> {
      requireEveryBorrowerAuthorized(submission, tokens);
      // An empty body reaches DU as a malformed casefile rather than as an
      // error anybody can read, and an adapter is the last place that can tell
      // the difference. Shared with the real one so it is not a courtesy the
      // fixture happens to do.
      requireDocument(submission);
      await sleep(latencyMs);

      const duCasefileId = submission.duCasefileId ?? fixtureCasefileId(submission.ausCasefileId);
      const respondedAt = new Date().toISOString();
      const response: DuResponse =
        du === "error"
          ? {
              status: "errored",
              // Null: DU refused the casefile before opening one, which is the
              // state a resubmission has to be able to tell from a case that
              // exists and came back Refer.
              duCasefileId: null,
              messages: [
                {
                  category: "Submission",
                  code: "0001",
                  text: "The casefile could not be evaluated.",
                },
              ],
              respondedAt,
            }
          : {
              status: "answered",
              duCasefileId,
              recommendation: du,
              messages: [
                {
                  category: "Risk/Eligibility",
                  code: "0021",
                  text: `Desktop Underwriter recommendation: ${du}.`,
                },
              ],
              respondedAt,
            };

      return result(response, "fixture-du", `du-${submission.ausCasefileId}`);
    },
  };
}

/**
 * The vendored survey, served as though fetched.
 *
 * `FFIEC_SURVEY` in `@hm/shared` is the CFPB's file as it stood the last time
 * somebody ran `npm run apor:vendor`, with the ETag and Last-Modified the server
 * sent for it. Answering "unchanged" to its own ETag is what lets the ingest
 * script be run twice against a development database and do nothing the
 * second time, exactly as it would against the live server.
 */
function serveVendored(
  doc: { url: string; lastModified: string; etag: string },
  body: string,
  latencyMs: number,
): AporSeriesConnector["fetchSurvey"] {
  return async (opts = {}) => {
    await sleep(latencyMs);
    const unchanged =
      (opts.ifNoneMatch !== undefined && opts.ifNoneMatch === doc.etag) ||
      (opts.ifModifiedSince !== undefined && opts.ifModifiedSince === doc.lastModified);
    if (unchanged) return { status: "unchanged", etag: doc.etag };
    return {
      status: "fetched",
      document: {
        csv: body,
        url: doc.url,
        retrievedAt: new Date().toISOString(),
        lastModified: doc.lastModified,
        etag: doc.etag,
      },
    };
  };
}

export function fixtureAporSeriesConnector(options: FixtureOptions = {}): AporSeriesConnector {
  const { latencyMs } = resolve(options);
  return {
    capabilities: {
      provider: "fixture-ffiec-survey",
      mode: "fixture",
      satisfies: ["UW-008"],
    },
    fetchTable: serveVendored(FFIEC_YIELD_TABLE_FIXED, FFIEC_YIELD_TABLE_FIXED.body, latencyMs),
    fetchSurvey: serveVendored(FFIEC_SURVEY, FFIEC_SURVEY.csv, latencyMs),
    // A calculator that reads the vendored table, so the check always agrees
    // with the table it is checking. Honest about what it is: offline, the
    // fixture can answer from nothing else.
    async rateSpreadCheck({ weekOf, termYears }) {
      await sleep(latencyMs);
      const [m, d, y] = [weekOf.slice(5, 7), weekOf.slice(8, 10), weekOf.slice(0, 4)];
      const row = FFIEC_YIELD_TABLE_FIXED.body
        .split(/\r?\n/)
        .find((line) => line.startsWith(`${m}/${d}/${y}|`));
      if (!row)
        return { status: "unavailable", reason: `the vendored table has no week of ${weekOf}` };
      const rate = Number(row.split("|")[termYears]);
      return Number.isFinite(rate)
        ? { status: "answered", apor: rate }
        : { status: "unavailable", reason: `the vendored table has no ${termYears}-year column` };
    },
  };
}

/**
 * Mail that goes nowhere and remembers everything.
 *
 * The outbox is what a test reads to see that an invitation went to the
 * right address with a link in it — and it is the ONLY place the token can
 * be read back from, which is what makes a test of "the token is never
 * stored" possible: the test holds the link, the database holds the hash,
 * and nothing else holds either.
 */
export interface FixtureMailConnector extends MailConnector {
  readonly outbox: MailMessage[];
}

export function fixtureMailConnector(options: FixtureOptions = {}): FixtureMailConnector {
  const { latencyMs } = resolve(options);
  const outbox: MailMessage[] = [];
  return {
    capabilities: { provider: "fixture-mail", mode: "fixture", satisfies: [] },
    outbox,
    async send(message: MailMessage): Promise<MailOutcome> {
      await sleep(latencyMs);
      outbox.push(message);
      return {
        status: "sent",
        externalId: `fixture-mail-${outbox.length}`,
        provider: "fixture-mail",
      };
    },
  };
}

export function fixtureRegistry(options: FixtureOptions = {}): ConnectorRegistry {
  return {
    identity: fixtureIdentityConnector(options),
    credit: fixtureCreditConnector(options),
    bank: fixtureBankConnector(options),
    payroll: fixturePayrollConnector(options),
    irs: fixtureIrsConnector(options),
    esign: fixtureEsignConnector(options),
    propertyData: fixturePropertyDataConnector(options),
    screening: fixtureScreeningConnector(options),
    liens: fixtureLienConnector(options),
    pricing: fixturePricingConnector(options),
    du: fixtureDuConnector(options),
    aporSeries: fixtureAporSeriesConnector(options),
    mail: fixtureMailConnector(options),
  };
}
