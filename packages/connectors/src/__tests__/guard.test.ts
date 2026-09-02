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
import type { LoanFile } from "@hm/shared";
import {
  ADDRESS_BOOK,
  AddressNotFoundError,
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
    propertyRecord: null,
    valuation: null,
    flood: null,
    sanctions: null,
    lienSearch: null,
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
    applicationSignedAt: null,
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
    await expect(registry.credit.pullTriMerge(emptyFile())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("refuses a bank link and an asset report without authorization", async () => {
    await expect(registry.bank.createLinkSession(emptyFile())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
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
    await expect(
      registry.bank.fetchAssetReport(emptyFile([authorization]), "s", 2),
    ).rejects.toThrow(/require 12/);
  });

  it("refuses sanctions screening without authorization", async () => {
    await expect(registry.screening.screenSanctions(emptyFile())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("refuses a lien search without authorization", async () => {
    await expect(registry.liens.searchLiens(emptyFile(), "439-28-014")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  /**
   * The two unguarded newcomers, and why.
   *
   * Both run on screens 1 and 2, before the authorization exists. Guarding
   * either would make the flow unreachable from its own first step — the same
   * trap e-sign documents above. These assertions exist so that staying
   * unguarded is a decision the suite records, not an omission it missed.
   */
  it("does NOT guard property lookups, which run on screen 1 before any consent", async () => {
    const address = ADDRESS_BOOK[0]!;
    const record = await registry.propertyData.lookupRecord(address);
    expect(record.data.apn).toBeTruthy();
    // Nothing here keys on a person: it is a building and a county record.
    expect(record.data.ownerOfRecord).toBeTruthy();

    const suggestions = await registry.propertyData.suggestAddresses(address.line1);
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("does NOT guard the ID scan, which is how the authorization gets a name on it", async () => {
    const session = await registry.identity.createVerificationSession(emptyFile(), "b1");
    expect(session.verificationId).toBeTruthy();
    const result = await registry.identity.getVerification(session.verificationId);
    expect(result?.status).toBe("verified");
    // Name, date of birth and address come off the document, which is what
    // lets screen 2 ask for seven things instead of eleven.
    expect(result?.documentName).toBeTruthy();
    expect(result?.documentAddress?.line1).toBeTruthy();
  });

  it("refuses a lien search with no APN rather than reporting a clean result", async () => {
    // A search keyed on nothing finds nothing, and "no liens found" is the
    // worst possible way to render that.
    await expect(registry.liens.searchLiens(emptyFile([authorization]), "")).rejects.toThrow(
      /requires an APN/,
    );
  });

  it("refuses to invent a record for an address it does not hold", async () => {
    // The failure that matters: falling back to another persona's record would
    // put fabricated square footage in front of a borrower and ask them to
    // confirm it. Not knowing is a legitimate answer; guessing is not.
    const unknown = {
      line1: "1 Nowhere Lane",
      city: "Springfield",
      state: "IL",
      postalCode: "62701",
    };
    await expect(registry.propertyData.lookupRecord(unknown)).rejects.toBeInstanceOf(
      AddressNotFoundError,
    );
    await expect(registry.propertyData.estimateValue(unknown)).rejects.toBeInstanceOf(
      AddressNotFoundError,
    );
  });

  it("holds a record for every address it suggests", async () => {
    // A suggestion the borrower can pick and we cannot then describe fails
    // AFTER they have committed to it. Every entry in the book must resolve.
    for (const address of ADDRESS_BOOK) {
      const record = await registry.propertyData.lookupRecord(address);
      expect(record.data.apn).toBeTruthy();
    }
  });

  it("screens sanctions once authorization exists", async () => {
    const screened = await registry.screening.screenSanctions(emptyFile([authorization]));
    expect(screened.data.listsChecked.length).toBeGreaterThan(0);
    expect(typeof screened.data.clear).toBe("boolean");
  });
});
