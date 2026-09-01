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
  AssetReport,
  Consent,
  CreditReport,
  LoanFile,
  PayrollData,
  TaxTranscript,
} from "@hm/shared";
import type {
  BankConnector,
  ConnectorRegistry,
  ConnectorResult,
  CreditConnector,
  EsignConnector,
  IrsConnector,
  LinkSession,
  PayrollConnector,
} from "../ports/index.js";
import { assert4506cExecuted, assertVerificationAuthorized } from "../guard.js";
import { PERSONAS, type PersonaId, DEFAULT_PERSONA } from "../fixtures/personas.js";

export interface FixtureOptions {
  readonly persona?: PersonaId;
  /** Simulated round-trip time. Set to 0 in tests. */
  readonly latencyMs?: number;
  /** Reference date the persona's relative dates are generated from. */
  readonly referenceDate?: Date;
}

interface Resolved {
  readonly persona: PersonaId;
  readonly latencyMs: number;
  readonly ref: Date;
}

function resolve(options: FixtureOptions): Resolved {
  return {
    persona: options.persona ?? DEFAULT_PERSONA,
    latencyMs: options.latencyMs ?? 900,
    ref: options.referenceDate ?? new Date(),
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
    async pullTriMerge(file: LoanFile): Promise<ConnectorResult<CreditReport>> {
      assertVerificationAuthorized(file);
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
    async createLinkSession(file: LoanFile): Promise<LinkSession> {
      assertVerificationAuthorized(file);
      return session("bank", ref);
    },
    async fetchAssetReport(
      file: LoanFile,
      _sessionId: string,
      monthsRequested: number,
    ): Promise<ConnectorResult<AssetReport>> {
      assertVerificationAuthorized(file);
      // The 12-month window is not a preference. CRD-017's cash flow assessment
      // and CRD-018's rent history both need twelve, and a shorter report
      // satisfies neither — so a caller asking for less is a bug, not a choice.
      if (monthsRequested < 12) {
        throw new Error(
          `Asset report requested for ${monthsRequested} months; CRD-017 and CRD-018 require 12.`,
        );
      }
      await sleep(latencyMs);
      return result(PERSONAS[persona].assets(ref), "fixture-bank", `assets-${persona}`);
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
    async createLinkSession(file: LoanFile): Promise<LinkSession> {
      assertVerificationAuthorized(file);
      return session("payroll", ref);
    },
    async fetchPayroll(file: LoanFile, _sessionId: string): Promise<ConnectorResult<PayrollData>> {
      assertVerificationAuthorized(file);
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
      taxYears: readonly number[],
    ): Promise<ConnectorResult<readonly TaxTranscript[]>> {
      assert4506cExecuted(file);
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

function decodeEnvelope(
  envelopeId: string,
): { kind: Consent["kind"]; borrowerId: string } | null {
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

export function fixtureRegistry(options: FixtureOptions = {}): ConnectorRegistry {
  return {
    credit: fixtureCreditConnector(options),
    bank: fixtureBankConnector(options),
    payroll: fixturePayrollConnector(options),
    irs: fixtureIrsConnector(options),
    esign: fixtureEsignConnector(options),
  };
}
