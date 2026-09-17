/**
 * The guard test.
 *
 * APP-005's timing constraint is "Before any verification pull" and its
 * failure severity is "Regulatory violation". This is the test that makes that
 * a property of the system rather than a habit.
 *
 * Every person-keyed method takes a `PurposeToken`. This package no longer
 * reads a loan file's consents to make one — the minter is in the API and
 * reads the authorizations table — so the tests here mint from GRANTS
 * directly, through the same pure function the API uses, and are about what
 * an adapter does with the token it is handed. Who may have a token at all
 * is tested against the real database in apps/api.
 */

import { describe, expect, it } from "vitest";
import {
  mintPurposeToken,
  type Borrower,
  type DataCategory,
  type Grant,
  type LoanFile,
  type PurposeToken,
} from "@hm/shared";
import {
  ADDRESS_BOOK,
  AddressNotFoundError,
  AuthorizationError,
  fixtureRegistry,
  fixtureEsignConnector,
  PURPOSE_FOR,
  requireCategory,
  SHEET_LOCK_DAYS,
} from "../index.js";

const PARTY = "11111111-1111-1111-1111-111111111111";
/** A real person with real grants of their own, who is on no borrower row here. */
const NOT_ON_THE_FILE = "99999999-9999-9999-9999-999999999999";
/** The file every token here is minted on, and the one `file()` returns. */
const FILE = "00000000-0000-0000-0000-000000000000";
const NOW = new Date("2026-09-08T12:00:00.000Z");

function borrower(id: string): Borrower {
  return {
    id,
    partyId: PARTY,
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
    declaration: null,
    residences: [],
  };
}

function fileWith(borrowers: Borrower[]): LoanFile {
  return {
    id: FILE,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stage: "credit",
    property: null,
    loan: null,
    product: null,
    borrowers,
    invitedBorrowers: [],
    vestings: [],
    consents: [],
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

/** The two origination grants a signed file holds. */
const GRANTS: Grant[] = [
  {
    id: "grant-app-005",
    partyId: PARTY,
    purpose: "fcra_written_instruction",
    dataCategories: [
      "credit_report",
      "bank_transactions",
      "payroll_income",
      "sanctions_screening",
      "public_record_liens",
    ],
    grantedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-12-30T00:00:00.000Z",
    revokedAt: null,
  },
  {
    id: "grant-4506c",
    partyId: PARTY,
    purpose: "irs_4506c",
    dataCategories: ["tax_transcript"],
    grantedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-12-30T00:00:00.000Z",
    revokedAt: null,
  },
];

/** A token for `category`, minted the way the API mints one. */
function token(category: DataCategory, grants: Grant[] = GRANTS): PurposeToken {
  return tokenFor(PARTY, category, grants);
}

/** The same, for a named party — the grants are rewritten to be that party's. */
function tokenFor(partyId: string, category: DataCategory, grants: Grant[] = GRANTS): PurposeToken {
  const r = mintPurposeToken({
    partyId,
    fileId: FILE,
    purpose: PURPOSE_FOR[category],
    dataCategory: category,
    grants: grants.map((g) => ({ ...g, partyId })),
    now: NOW,
  });
  if (!r.ok) throw new Error(`test setup: ${r.message}`);
  return r.token;
}

const A = borrower("b1");
const file = () => fileWith([A]);

/** A loan to price. It names no person, which is the point of the type. */
const SCENARIO = {
  purpose: "purchase",
  occupancy: "primary_residence",
  propertyType: "single_family",
  state: "TX",
  loanAmount: 332_000,
  propertyValue: 415_000,
  lockDays: SHEET_LOCK_DAYS,
} as const;

/**
 * Every port that takes a `PurposeToken`, and every port that cannot.
 *
 * Two lists rather than one, because "unguarded" is a decision with reasons —
 * the address / person split for the property lookups, and the two that are how
 * an authorization gets signed and gets a name on it at all. Splitting them
 * here is what lets the suite insist that a NEW port land in one or the other.
 */
const GUARDED_PORTS = [
  "credit",
  "bank",
  "payroll",
  "irs",
  "screening",
  "liens",
  "pricing",
  "du",
] as const;
type GuardedPort = (typeof GUARDED_PORTS)[number];
const UNGUARDED_PORTS = ["identity", "esign", "propertyData", "aporSeries", "mail"] as const;

describe("a token is for one kind of data", () => {
  it("refuses a token at the adapter when it is for something else", () => {
    // The token proves a permission; `requireCategory` proves it is the
    // permission for the data about to be fetched. A caller holding a bank
    // token must not reach the credit adapter.
    expect(() => requireCategory(token("bank_transactions"), "credit_report")).toThrow(
      AuthorizationError,
    );
  });

  it("cites the requirement the refused category is gated by", () => {
    try {
      requireCategory(token("credit_report"), "tax_transcript");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AuthorizationError).requirementId).toBe("INC-008");
    }
  });

  it("cannot be minted for transcripts on an APP-005 grant alone", () => {
    const r = mintPurposeToken({
      partyId: PARTY,
      fileId: FILE,
      purpose: PURPOSE_FOR.tax_transcript,
      dataCategory: "tax_transcript",
      grants: GRANTS.filter((g) => g.purpose !== "irs_4506c"),
      now: NOW,
    });
    expect(r).toMatchObject({ ok: false, reason: "no_grant" });
  });
});

describe("the adapters, with and without a token", () => {
  const registry = fixtureRegistry({ latencyMs: 0 });

  it("cannot be called without one", () => {
    // The check is the parameter. This is enforced by the compiler, and if it
    // ever stops erroring the guard has quietly become a convention again.
    // @ts-expect-error a person-keyed method requires a PurposeToken
    const call = () => registry.credit.pullTriMerge(file());
    expect(call).toBeDefined();
  });

  it("refuses a forged token", () => {
    // @ts-expect-error a PurposeToken cannot be constructed outside @hm/shared
    const forged: PurposeToken = {
      partyId: PARTY,
      fileId: FILE,
      purpose: "fcra_written_instruction",
      dataCategory: "credit_report",
      authorizationId: "made-up",
      mintedAt: NOW.toISOString(),
    };
    expect(forged).toBeDefined();
  });

  it("pulls credit for the party named on the token", async () => {
    const result = await registry.credit.pullTriMerge(file(), token("credit_report"));
    expect(result.data.scores).toHaveLength(3);
    expect(result.data.pullType).toBe("soft");
  });

  it("refuses a credit pull on a bank token", async () => {
    await expect(
      registry.credit.pullTriMerge(file(), token("bank_transactions")),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses transcripts on a credit token", async () => {
    await expect(
      registry.irs.fetchTranscripts(file(), token("credit_report"), [2025]),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("fetches transcripts on a 4506-C token", async () => {
    const result = await registry.irs.fetchTranscripts(file(), token("tax_transcript"), []);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it("refuses an asset report shorter than the 12 months CRD-017 requires", async () => {
    await expect(
      registry.bank.fetchAssetReport(file(), token("bank_transactions"), { sessionId: "s" }, 2),
    ).rejects.toThrow(/require 12/);
  });

  it("screens sanctions on the right token", async () => {
    const screened = await registry.screening.screenSanctions(file(), token("sanctions_screening"));
    expect(screened.data.listsChecked.length).toBeGreaterThan(0);
    expect(typeof screened.data.clear).toBe("boolean");
  });

  it("refuses every person-keyed pull when the token names somebody else", async () => {
    // The party is half of what a token says, and until this the adapters read
    // only the other half. Every route happens to mint from the primary
    // borrower, so a real permission belonging to somebody who is not on this
    // file — not on any file — fetched this file's data from all six of these.
    // Rule 4 puts the guard in the adapters precisely so that a check the
    // routes merely happen to perform is not the check.
    //
    // Every port the registry has, `du` included. That one neither reads nor
    // writes a person's data — it SENDS it — so leaving it out of the sweep
    // would exempt the only adapter where a missing refusal is somebody's
    // information arriving at Fannie Mae.
    const stranger = (category: DataCategory) => tokenFor(NOT_ON_THE_FILE, category);
    const calls: readonly (readonly [GuardedPort, string, () => Promise<unknown>])[] = [
      ["credit", "credit", () => registry.credit.pullTriMerge(file(), stranger("credit_report"))],
      [
        "bank",
        "bank session",
        () => registry.bank.createLinkSession(file(), stranger("bank_transactions")),
      ],
      [
        "bank",
        "asset report",
        () =>
          registry.bank.fetchAssetReport(
            file(),
            stranger("bank_transactions"),
            { sessionId: "s" },
            12,
          ),
      ],
      [
        "payroll",
        "payroll session",
        () => registry.payroll.createLinkSession(file(), stranger("payroll_income")),
      ],
      [
        "payroll",
        "payroll",
        () => registry.payroll.fetchPayroll(file(), stranger("payroll_income"), "s"),
      ],
      [
        "irs",
        "transcripts",
        () => registry.irs.fetchTranscripts(file(), stranger("tax_transcript"), []),
      ],
      [
        "screening",
        "screening",
        () => registry.screening.screenSanctions(file(), stranger("sanctions_screening")),
      ],
      [
        "liens",
        "liens",
        () => registry.liens.searchLiens(file(), stranger("public_record_liens"), "0114230209"),
      ],
      [
        "pricing",
        "credit-priced quote",
        () => registry.pricing.quoteForBorrower(file(), stranger("credit_report"), SCENARIO, 740),
      ],
      [
        "du",
        "du submission",
        () =>
          registry.du.submit(
            {
              applicationId: "aaaaaaaa-0000-4000-8000-00000000000a",
              loanFileId: FILE,
              ausCasefileId: "aa1b2c3d-0000-4000-8000-000000000001",
              duCasefileId: null,
              borrowers: [
                { partyId: PARTY, borrowerOrdinal: 1, dataCategories: ["credit_report"] },
              ],
              document: "<MESSAGE/>",
            },
            [stranger("credit_report")],
          ),
      ],
    ];

    // The list above is the claim; this is what keeps it whole. A port added to
    // `GUARDED_PORTS` and not exercised here would otherwise be a name on a
    // list nothing calls.
    expect(new Set(calls.map(([port]) => port))).toEqual(new Set(GUARDED_PORTS));

    for (const [, name, call] of calls) {
      await expect(call(), name).rejects.toBeInstanceOf(AuthorizationError);
    }
  });

  it("has an opinion about every port the registry offers", () => {
    // Rule 4 says this file calls every adapter against an unauthorized file.
    // That sentence stops being true the moment a port is added and nobody
    // comes back here, and the failure is silent: the sweep above still passes
    // over the ports it already knew. So a new port has to be classified
    // before this suite goes green, and "it is deliberately unguarded" is an
    // answer — stating it is the part that may not be skipped.
    expect(new Set(Object.keys(registry))).toEqual(
      new Set<string>([...GUARDED_PORTS, ...UNGUARDED_PORTS]),
    );
  });

  it("refuses a lien search with no APN rather than reporting a clean result", async () => {
    // A search keyed on nothing finds nothing, and "no liens found" is the
    // worst possible way to render that.
    await expect(
      registry.liens.searchLiens(file(), token("public_record_liens"), ""),
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
    const esign = fixtureEsignConnector({ latencyMs: 0 });
    const envelope = await esign.createEnvelope(file(), "verification_authorization", "b1");
    expect(envelope.envelopeId).toBeTruthy();
  });

  it("does NOT guard property lookups, which run on screen 1 before any consent", async () => {
    const address = ADDRESS_BOOK[0]!;
    const record = await registry.propertyData.lookupRecord(address);
    expect(record.data.apn).toBeTruthy();
    expect(record.data.ownerOfRecord).toBeTruthy();
    const suggestions = await registry.propertyData.suggestAddresses(address.line1);
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("does NOT guard the rate sheet, which screen 1 quotes from before any consent", async () => {
    // The other half of the pricing port, and the reason it sits in
    // GUARDED_PORTS above rather than here: `quoteForBorrower` sends a
    // representative FICO to a vendor and is guarded, while `quoteProducts`
    // asks what a loan of this size on this kind of property costs and names
    // nobody. Screen 1 quotes a payment before APP-005 is signed, so guarding
    // this one would make the flow unreachable from its own first step — the
    // same trap the property lookups document.
    const quotes = await registry.pricing.quoteProducts(SCENARIO);
    expect(quotes.length).toBeGreaterThan(0);
    // The `@ts-expect-error` is the real assertion and it holds at compile
    // time. The runtime line beneath it used to be `expect(call).toBeDefined()`
    // over an arrow function, which is true of every arrow function ever
    // written — so if the type check were ever satisfied some other way, the
    // test would have stayed green. Passing the token changes the answer not at
    // all, and that is what is asserted now.
    // @ts-expect-error the scenario names a loan, and a token cannot be given
    const ignored = await registry.pricing.quoteProducts(SCENARIO, token("credit_report"));
    expect(ignored.map((q) => q.productCode)).toEqual(quotes.map((q) => q.productCode));
  });

  it("does NOT guard the CFPB survey, which is a publication and names nobody", async () => {
    // The average prime offer rate is computed from a public weekly file that
    // carries no borrower, no address and no loan. There is nothing an
    // authorization could be FOR, so the call takes no token — and, as with the
    // rate sheet, the type is the assertion: handing it one is a compile error.
    const fetched = await registry.aporSeries.fetchSurvey();
    expect(fetched.status).toBe("fetched");
    if (fetched.status === "fetched") {
      expect(fetched.document.csv.startsWith("Date,")).toBe(true);
      expect(fetched.document.etag).toBeTruthy();
    }
    const table = await registry.aporSeries.fetchTable();
    expect(table.status).toBe("fetched");
    if (table.status === "fetched") {
      expect(table.document.csv.startsWith("Term of Loan in Years|")).toBe(true);
    }
    expect(
      await registry.aporSeries.rateSpreadCheck({ weekOf: "2026-09-14", termYears: 30 }),
    ).toEqual({ status: "answered", apor: 6.84 });
    // @ts-expect-error a survey is keyed on nothing, and a token cannot be given
    const again = await registry.aporSeries.fetchSurvey(token("credit_report"));
    expect(again.status).toBe("fetched");
  });

  it("does NOT guard the ID scan, which is how the authorization gets a name on it", async () => {
    const session = await registry.identity.createVerificationSession(file(), "b1");
    expect(session.verificationId).toBeTruthy();
    const result = await registry.identity.getVerification(session.verificationId);
    expect(result?.status).toBe("verified");
    expect(result?.documentName).toBeTruthy();
    expect(result?.documentAddress?.line1).toBeTruthy();
  });

  it("refuses to invent a record for an address it does not hold", async () => {
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
