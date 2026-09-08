/**
 * The whole flow, end to end, without a database.
 *
 * This walks a fixture borrower through screens 1–8 as an in-memory LoanFile
 * and asserts the thing the product actually promises: that connecting
 * accounts retires requirements, that the ones left are the ones that genuinely
 * apply, and that the decision explains itself.
 *
 * It is the test that would catch the failure mode nobody notices — an engine
 * that returns a clean, confident answer built on inputs it never had.
 */

import { describe, expect, it } from "vitest";
import {
  mintPurposeToken,
  type Consent,
  type DataCategory,
  type Grant,
  type LoanFile,
  type PurposeToken,
} from "@hm/shared";
import { fixtureRegistry, PERSONAS, PURPOSE_FOR } from "@hm/connectors";
import { assessAll, outstanding, progress } from "@hm/requirements";
import { underwrite } from "@hm/underwriting";

const REFERENCE = new Date("2026-06-15T12:00:00.000Z");
const registry = fixtureRegistry({ latencyMs: 0, persona: "clean_w2", referenceDate: REFERENCE });

const PARTY = "11111111-1111-1111-1111-111111111111";
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
    grantedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
  },
  {
    id: "grant-4506c",
    partyId: PARTY,
    purpose: "irs_4506c",
    dataCategories: ["tax_transcript"],
    grantedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
  },
];

/** A token for `category`, minted through the same pure function the API uses. */
function token(category: DataCategory): PurposeToken {
  const r = mintPurposeToken({
    partyId: PARTY,
    purpose: PURPOSE_FOR[category],
    dataCategory: category,
    grants: GRANTS,
    now: REFERENCE,
  });
  if (!r.ok) throw new Error(`test setup: ${r.message}`);
  return r.token;
}

const consent = (kind: Consent["kind"]): Consent => ({
  kind,
  borrowerId: "b1",
  grantedAt: REFERENCE.toISOString(),
  ipAddress: "127.0.0.1",
  userAgent: "test",
});

/** Screens 1 and 2 — everything the borrower types. */
function afterIdentity(): LoanFile {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    createdAt: REFERENCE.toISOString(),
    updatedAt: REFERENCE.toISOString(),
    stage: "credit",
    propertyRecord: null,
    valuation: null,
    flood: null,
    sanctions: null,
    lienSearch: null,
    property: {
      address: { line1: "1 Example St", city: "Austin", state: "TX", postalCode: "78701" },
      deliverableAddressVerified: true,
      propertyType: "single_family",
      occupancy: "primary_residence",
      valueOrPrice: 650_000,
      valuationSource: "attom_estimate",
      financedPropertyCount: 1,
    },
    loan: {
      purpose: "purchase",
      loanAmount: 520_000,
      downPayment: 130_000,
      juniorLienBalance: 0,
      juniorLienCreditLimit: 0,
      interestedPartyContributions: 0,
    },
    product: {
      productCode: "CONF-30-FIXED",
      termMonths: 360,
      amortization: "fixed",
      noteRate: 6.25,
      overlays: [],
    },
    borrowers: [
      {
        id: "b1",
        partyId: "11111111-1111-1111-1111-111111111111",
        firstName: "Dana",
        lastName: "Whitfield",
        dateOfBirth: "1988-04-12",
        ssn: { last4: "4321", vaultHandle: "vault:4321:test" },
        email: "dana@example.com",
        phone: "512-555-0100",
        currentAddress: { line1: "9 Rent Rd", city: "Austin", state: "TX", postalCode: "78704" },
        maritalStatus: "unmarried",
        citizenship: "us_citizen",
        identityVerification: {
          verificationId: "fixture-idv.b1",
          status: "verified",
          verifiedAt: "2026-06-15T12:00:00.000Z",
        },
        nonBorrowingSpouseSignatureRequired: false,
        preferredLanguage: "en",
        demographics: {
          ethnicity: "declined",
          race: "declined",
          sex: "declined",
          visualObservationNoted: false,
        },
        firstTimeHomebuyer: true,
        isMilitary: false,
        currentHousing: "rent",
        monthlyRent: 2_150,
      },
    ],
    consents: [consent("verification_authorization"), consent("econsent")],
    application: {
      receivedAt: REFERENCE.toISOString(),
      sixPieces: {
        name: true,
        income: true,
        ssn: true,
        propertyAddress: true,
        valueEstimate: true,
        loanAmount: true,
      },
    },
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
    sanctionsScreenClear: true,
    ssnValidatedWithSsa: null,
    fraudReviewComplete: false,
    applicationSignedAt: null,
    intentToProceedAt: null,
    deliveryMethod: "electronic",
  };
}

describe("the onboarding flow", () => {
  it("retires requirements as each connector lands", async () => {
    let file = afterIdentity();
    const before = progress(file);

    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    file = { ...file, credit: credit.data };
    const afterCredit = progress(file);

    const bankOutcome = await registry.bank.fetchAssetReport(
      file,
      token("bank_transactions"),
      { sessionId: "s" },
      12,
    );
    if (bankOutcome.status !== "ready") throw new Error("fixture must answer immediately");
    const bank = bankOutcome.result;
    file = { ...file, assets: bank.data };
    const afterBank = progress(file);

    const payroll = await registry.payroll.fetchPayroll(file, token("payroll_income"), "s");
    file = {
      ...file,
      payroll: payroll.data,
      incomeSources: payroll.data.incomeSources,
      employment: payroll.data.employments,
    };
    const afterPayroll = progress(file);

    // Each connection satisfies strictly more than the one before it.
    expect(afterCredit.satisfied).toBeGreaterThan(before.satisfied);
    expect(afterBank.satisfied).toBeGreaterThan(afterCredit.satisfied);
    expect(afterPayroll.satisfied).toBeGreaterThan(afterBank.satisfied);
  });

  it("never lets satisfied progress go backwards", async () => {
    // The invariant that matters more than any single count: connecting an
    // account may only ever increase what is satisfied. It went 23 → 21 here
    // once — five income requirements were vacuously satisfied against empty
    // arrays while their applicability was still unknown, then resolved to
    // inapplicable when payroll returned. See progress() in engine.ts.
    let file = afterIdentity();
    const counts = [progress(file).satisfied];

    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    file = { ...file, credit: credit.data };
    counts.push(progress(file).satisfied);

    const bankOutcome = await registry.bank.fetchAssetReport(
      file,
      token("bank_transactions"),
      { sessionId: "s" },
      12,
    );
    if (bankOutcome.status !== "ready") throw new Error("fixture must answer immediately");
    const bank = bankOutcome.result;
    file = { ...file, assets: bank.data };
    counts.push(progress(file).satisfied);

    const payroll = await registry.payroll.fetchPayroll(file, token("payroll_income"), "s");
    file = {
      ...file,
      payroll: payroll.data,
      incomeSources: payroll.data.incomeSources,
      employment: payroll.data.employments,
    };
    counts.push(progress(file).satisfied);

    file = { ...file, consents: [...file.consents, consent("form_4506c")] };
    const irs = await registry.irs.fetchTranscripts(file, token("tax_transcript"), []);
    file = { ...file, transcripts: irs.data };
    counts.push(progress(file).satisfied);

    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
  });

  it("shrinks the undetermined set as data arrives", async () => {
    let file = afterIdentity();
    const before = progress(file).undetermined;

    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    file = { ...file, credit: credit.data };
    const bankOutcome = await registry.bank.fetchAssetReport(
      file,
      token("bank_transactions"),
      { sessionId: "s" },
      12,
    );
    if (bankOutcome.status !== "ready") throw new Error("fixture must answer immediately");
    const bank = bankOutcome.result;
    file = { ...file, assets: bank.data };
    const payroll = await registry.payroll.fetchPayroll(file, token("payroll_income"), "s");
    file = {
      ...file,
      payroll: payroll.data,
      incomeSources: payroll.data.incomeSources,
      employment: payroll.data.employments,
    };

    // "We might still ask" must actually get smaller. If it did not, the
    // conditions are not reading the data the connectors returned.
    expect(progress(file).undetermined).toBeLessThan(before);
  });

  it("never marks an unsatisfied requirement as satisfied on an empty file", () => {
    const file = afterIdentity();
    const satisfied = assessAll(file)
      .filter((a) => a.satisfaction.status === "satisfied")
      .map((a) => a.requirement.id);

    // Nothing that depends on a connector may be satisfied before one runs.
    expect(satisfied).not.toContain("CRD-001");
    expect(satisfied).not.toContain("AST-001");
    expect(satisfied).not.toContain("INC-002");
    expect(satisfied).not.toContain("UW-001");
  });

  it("orders outstanding work by regulatory exposure first", () => {
    const items = outstanding(afterIdentity());
    const severities = items.map((i) => i.requirement.failureSeverity);
    const firstRework = severities.indexOf("rework_delay");
    const lastRegulatory = severities.lastIndexOf("regulatory_violation");
    if (firstRework !== -1 && lastRegulatory !== -1) {
      expect(lastRegulatory).toBeLessThan(firstRework);
    }
  });
});

describe("the decision", () => {
  async function fullyConnected(): Promise<LoanFile> {
    let file = afterIdentity();
    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    file = { ...file, credit: credit.data };
    const bankOutcome = await registry.bank.fetchAssetReport(
      file,
      token("bank_transactions"),
      { sessionId: "s" },
      12,
    );
    if (bankOutcome.status !== "ready") throw new Error("fixture must answer immediately");
    const bank = bankOutcome.result;
    file = { ...file, assets: bank.data };
    const payroll = await registry.payroll.fetchPayroll(file, token("payroll_income"), "s");
    file = {
      ...file,
      payroll: payroll.data,
      incomeSources: payroll.data.incomeSources,
      employment: payroll.data.employments,
      consents: [...file.consents, consent("form_4506c")],
    };
    const irs = await registry.irs.fetchTranscripts(file, token("tax_transcript"), []);
    return { ...file, transcripts: irs.data };
  }

  it("computes ratios from connected data", async () => {
    const decision = underwrite(await fullyConnected(), {
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
    });

    expect(decision.ratios.dtiBack).not.toBeNull();
    expect(decision.ratios.ltv).toBeCloseTo(80, 0);
    expect(decision.ratios.totalQualifyingIncome).toBe(
      PERSONAS.clean_w2.payroll(REFERENCE).incomeSources[0]!.monthlyAmount,
    );
  });

  it("records a derivation for every number it reports", async () => {
    const decision = underwrite(await fullyConnected(), {
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
    });

    const labels = decision.derivations.map((d) => d.label);
    expect(labels).toContain("Back-end DTI");
    expect(labels).toContain("LTV");
    expect(labels).toContain("Housing PITIA");
    expect(labels).toContain("Representative FICO");

    for (const d of decision.derivations) {
      // A derivation with neither a formula nor a blocking reason is a number
      // with no explanation, which is exactly what screen 8 must never show.
      expect(d.formula === "not computed" ? d.blockedBy?.length : d.formula.length).toBeTruthy();
    }
  });

  it("refers rather than approves when an input could not be computed", async () => {
    // No APR, no APOR and no fee schedule, so the compliance tests are blocked.
    const decision = underwrite(await fullyConnected(), {
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
    });

    expect(decision.derivations.some((d) => d.blockedBy?.length)).toBe(true);
    expect(decision.aus?.recommendation).toBe("refer");
    // And it must NOT quietly claim a clean bill of health.
    expect(decision.outcome).not.toBe("clear_to_close");
  });

  it("stamps the engine so a shadow decision is never mistaken for an agency one", async () => {
    const decision = underwrite(await fullyConnected(), {
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
    });
    expect(decision.aus?.engine).toBe("shadow");
  });

  it("blocks the compliance tests it has no market data for", async () => {
    const decision = underwrite(await fullyConnected(), {
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
    });
    expect(decision.compliance.isHpml).toBeNull();
    expect(decision.compliance.pointsAndFeesPass).toBeNull();
  });

  it("runs the compliance tests once market data is supplied", async () => {
    const decision = underwrite(await fullyConnected(), {
      casefileId: "test-casefile",
      now: REFERENCE.toISOString(),
      market: { apr: 6.44, apor: 6.1, pointsAndFeesAmount: 9_800 },
      estimatedFees: 9_800,
      estimatedPrepaids: 4_200,
    });

    expect(decision.compliance.isHpml).toBe(false);
    expect(decision.compliance.pointsAndFeesPass).toBe(true);
    expect(decision.compliance.isHighCost).toBe(false);
  });
});
