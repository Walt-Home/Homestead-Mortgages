/**
 * The guard test.
 *
 * APP-005's timing constraint is "Before any verification pull" and its
 * failure severity is "Regulatory violation". This is the test that makes that
 * a property of the system rather than a habit.
 *
 * It used to call every adapter against an unauthorized FILE and assert a
 * refusal. That could not test the thing that was actually wrong: the guard
 * took a file and no subject, so on a two-borrower file one person's signature
 * authorized a pull about the other. Now every person-keyed method takes a
 * `PurposeToken` naming one borrower, and the tests here are about who can
 * get one.
 */

import { describe, expect, it } from "vitest";
import type { Borrower, Consent, LoanFile, PurposeToken } from "@hm/shared";
import {
  ADDRESS_BOOK,
  AddressNotFoundError,
  AuthorizationError,
  fixtureRegistry,
  fixtureEsignConnector,
  purposeFor,
  requireCategory,
} from "../index.js";

function borrower(id: string): Borrower {
  return {
    id,
    firstName: "Test",
    lastName: id,
    dateOfBirth: "1990-01-01",
    ssn: { last4: "0000", vaultHandle: `vault:${id}` },
    email: `${id}@example.test`,
    phone: "5555550100",
    currentAddress: { line1: "1 Fixture St", city: "Demo City", state: "CA", postalCode: "94000" },
    maritalStatus: "unmarried",
    citizenship: "us_citizen",
    identityVerification: null,
    nonBorrowingSpouseSignatureRequired: false,
    preferredLanguage: "en",
    demographics: null,
    firstTimeHomebuyer: null,
    isMilitary: false,
    currentHousing: "rent",
  };
}

function consent(kind: Consent["kind"], borrowerId: string, revokedAt?: string): Consent {
  return {
    kind,
    borrowerId,
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...(revokedAt ? { revokedAt } : {}),
    ipAddress: "127.0.0.1",
    userAgent: "test",
  };
}

function fileWith(borrowers: Borrower[], consents: Consent[] = []): LoanFile {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stage: "credit",
    property: null,
    loan: null,
    product: null,
    borrowers,
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

const A = borrower("b1");
const B = borrower("b2");

/** One borrower, who has signed APP-005. The ordinary case. */
const authorized = () => fileWith([A], [consent("verification_authorization", "b1")]);

describe("who can get a token", () => {
  it("refuses a borrower who is not on the file at all", () => {
    expect(() => purposeFor(fileWith([A]), "b2", "credit_report")).toThrow(AuthorizationError);
  });

  it("refuses a borrower on the file who has not consented", () => {
    expect(() => purposeFor(fileWith([A]), "b1", "credit_report")).toThrow(AuthorizationError);
  });

  it("REFUSES to let one borrower's signature authorize a pull about another", () => {
    // The defect this whole change exists to close. A and B are both on the
    // file. A signed. The old guard found "an active consent on the file" and
    // let B's credit be pulled on A's signature.
    const file = fileWith([A, B], [consent("verification_authorization", "b1")]);
    expect(purposeFor(file, "b1", "credit_report").partyId).toBe("b1");
    expect(() => purposeFor(file, "b2", "credit_report")).toThrow(AuthorizationError);
  });

  it("refuses once the consent is revoked", () => {
    const file = fileWith(
      [A],
      [consent("verification_authorization", "b1", "2026-02-01T00:00:00.000Z")],
    );
    expect(() => purposeFor(file, "b1", "credit_report")).toThrow(/revoked/);
  });

  it("issues a token for the borrower who actually signed", () => {
    const token = purposeFor(authorized(), "b1", "credit_report");
    expect(token.partyId).toBe("b1");
    expect(token.dataCategory).toBe("credit_report");
    expect(token.purpose).toBe("fcra_written_instruction");
  });

  it("cites APP-005 on a refusal, which is what the client routes on", () => {
    try {
      purposeFor(fileWith([A]), "b1", "bank_transactions");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AuthorizationError).requirementId).toBe("APP-005");
    }
  });
});

describe("a token is for one kind of data", () => {
  it("refuses IRS transcripts on an APP-005 signature alone", () => {
    // A 4506-C is a different permission. The old `assert4506cExecuted(file)`
    // checked for any 4506-C on the file by anybody; this refuses before an
    // adapter is even reached, and names the requirement.
    try {
      purposeFor(authorized(), "b1", "tax_transcript");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AuthorizationError).requirementId).toBe("INC-008");
    }
  });

  it("mints for transcripts once the 4506-C is executed", () => {
    const file = fileWith(
      [A],
      [consent("verification_authorization", "b1"), consent("form_4506c", "b1")],
    );
    expect(purposeFor(file, "b1", "tax_transcript").purpose).toBe("irs_4506c");
  });

  it("refuses a token at the adapter when it is for something else", () => {
    // A caller holding a bank token must not reach the credit adapter. The
    // token proves a permission; `requireCategory` proves it is the permission
    // for the data about to be fetched.
    const bankToken = purposeFor(authorized(), "b1", "bank_transactions");
    expect(() => requireCategory(bankToken, "credit_report")).toThrow(AuthorizationError);
  });
});

describe("the adapters, with and without a token", () => {
  const registry = fixtureRegistry({ latencyMs: 0 });

  it("cannot be called without one", () => {
    // The check is the parameter. This is enforced by the compiler, and if it
    // ever stops erroring the guard has quietly become a convention again.
    // @ts-expect-error a person-keyed method requires a PurposeToken
    const call = () => registry.credit.pullTriMerge(authorized());
    expect(call).toBeDefined();
  });

  it("refuses a forged token", () => {
    // @ts-expect-error a PurposeToken cannot be constructed outside @hm/shared
    const forged: PurposeToken = {
      partyId: "b1",
      purpose: "fcra_written_instruction",
      dataCategory: "credit_report",
      authorizationId: "made-up",
      mintedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(forged).toBeDefined();
  });

  it("pulls credit for the borrower named on the token", async () => {
    const file = authorized();
    const result = await registry.credit.pullTriMerge(
      file,
      purposeFor(file, "b1", "credit_report"),
    );
    expect(result.data.scores).toHaveLength(3);
    expect(result.data.pullType).toBe("soft");
  });

  it("refuses a credit pull on a bank token", async () => {
    const file = authorized();
    await expect(
      registry.credit.pullTriMerge(file, purposeFor(file, "b1", "bank_transactions")),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses transcripts on a credit token", async () => {
    const file = fileWith(
      [A],
      [consent("verification_authorization", "b1"), consent("form_4506c", "b1")],
    );
    await expect(
      registry.irs.fetchTranscripts(file, purposeFor(file, "b1", "credit_report"), [2025]),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses an asset report shorter than the 12 months CRD-017 requires", async () => {
    const file = authorized();
    await expect(
      registry.bank.fetchAssetReport(
        file,
        purposeFor(file, "b1", "bank_transactions"),
        { sessionId: "s" },
        2,
      ),
    ).rejects.toThrow(/require 12/);
  });

  it("screens sanctions once authorized", async () => {
    const file = authorized();
    const screened = await registry.screening.screenSanctions(
      file,
      purposeFor(file, "b1", "sanctions_screening"),
    );
    expect(screened.data.listsChecked.length).toBeGreaterThan(0);
    expect(typeof screened.data.clear).toBe("boolean");
  });

  it("refuses a lien search with no APN rather than reporting a clean result", async () => {
    // A search keyed on nothing finds nothing, and "no liens found" is the
    // worst possible way to render that.
    const file = authorized();
    await expect(
      registry.liens.searchLiens(file, purposeFor(file, "b1", "public_record_liens"), ""),
    ).rejects.toThrow(/requires an APN/);
  });
});

/**
 * The unguarded ones, and why.
 *
 * These run before the authorization exists, and guarding any of them would
 * make the flow unreachable from its own first step. Their signatures take no
 * token and cannot be given one — the address/person split is in the types.
 * These assertions exist so that staying unguarded is a decision the suite
 * records, not an omission it missed.
 */
describe("what is deliberately not guarded", () => {
  const registry = fixtureRegistry({ latencyMs: 0 });

  it("does NOT guard e-sign, which is how authorization gets signed", async () => {
    // Guarding this would make APP-005 unobtainable: you would need the
    // consent in order to sign the consent.
    const esign = fixtureEsignConnector({ latencyMs: 0 });
    const envelope = await esign.createEnvelope(fileWith([A]), "verification_authorization", "b1");
    expect(envelope.envelopeId).toBeTruthy();
  });

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
    const session = await registry.identity.createVerificationSession(fileWith([A]), "b1");
    expect(session.verificationId).toBeTruthy();
    const result = await registry.identity.getVerification(session.verificationId);
    expect(result?.status).toBe("verified");
    expect(result?.documentName).toBeTruthy();
    expect(result?.documentAddress?.line1).toBeTruthy();
  });

  it("refuses to invent a record for an address it does not hold", async () => {
    // Falling back to another persona's record would put fabricated square
    // footage in front of a borrower and ask them to confirm it.
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
    for (const address of ADDRESS_BOOK) {
      const record = await registry.propertyData.lookupRecord(address);
      expect(record.data.apn).toBeTruthy();
    }
  });
});
