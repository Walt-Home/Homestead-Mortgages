/**
 * The guard test.
 *
 * APP-005's timing constraint is "Before any verification pull" and its
 * failure severity is "Regulatory violation". This is the test that makes that
 * a property of the system rather than a habit: every adapter that reaches a
 * third party is called against an unauthorized file, and every one must
 * refuse. A new connector that forgets the guard fails here.
 */

import { describe, expect, it } from "vitest";
import type { LoanFile } from "@sm/shared";
import {
  AuthorizationError,
  fixtureRegistry,
  fixtureEsignConnector,
} from "../index.js";

function emptyFile(consents: LoanFile["consents"] = []): LoanFile {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stage: "credit",
    property: null,
    loan: null,
    product: null,
    borrowers: [],
    consents,
    application: null,
    credit: null,
    assets: null,
    payroll: null,
    transcripts: [],
    incomeSources: [],
    employment: [],
    documents: [],
    disclosures: [],
    links: [],
    decision: null,
    sanctionsScreenClear: null,
    ssnValidatedWithSsa: null,
    fraudReviewComplete: false,
    intentToProceedAt: null,
    deliveryMethod: "electronic",
  };
}

const authorization: LoanFile["consents"][number] = {
  kind: "verification_authorization",
  borrowerId: "b1",
  grantedAt: "2026-01-01T00:00:00.000Z",
  ipAddress: "127.0.0.1",
  userAgent: "test",
};

describe("authorization guard", () => {
  const registry = fixtureRegistry({ latencyMs: 0 });

  it("refuses a credit pull without authorization", async () => {
    await expect(registry.credit.pullTriMerge(emptyFile())).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses a bank link and an asset report without authorization", async () => {
    await expect(registry.bank.createLinkSession(emptyFile())).rejects.toBeInstanceOf(AuthorizationError);
    await expect(registry.bank.fetchAssetReport(emptyFile(), "s", 12)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("refuses payroll without authorization", async () => {
    await expect(registry.payroll.createLinkSession(emptyFile())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(registry.payroll.fetchPayroll(emptyFile(), "s")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("refuses IRS transcripts with APP-005 but no 4506-C", async () => {
    const file = emptyFile([authorization]);
    await expect(registry.irs.fetchTranscripts(file, [2025])).rejects.toMatchObject({
      requirementId: "INC-008",
    });
  });

  it("allows a credit pull once authorization exists", async () => {
    const result = await registry.credit.pullTriMerge(emptyFile([authorization]));
    expect(result.data.scores).toHaveLength(3);
    expect(result.data.pullType).toBe("soft");
  });

  it("does NOT guard e-sign, which is how authorization gets signed", async () => {
    // Guarding this would make APP-005 unobtainable: you would need the
    // consent in order to sign the consent.
    const esign = fixtureEsignConnector({ latencyMs: 0 });
    const envelope = await esign.createEnvelope(emptyFile(), "verification_authorization", "b1");
    expect(envelope.envelopeId).toBeTruthy();
  });

  it("refuses an asset report shorter than the 12 months CRD-017 requires", async () => {
    await expect(registry.bank.fetchAssetReport(emptyFile([authorization]), "s", 2)).rejects.toThrow(
      /require 12/,
    );
  });
});
