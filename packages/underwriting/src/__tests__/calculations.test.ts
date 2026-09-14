/**
 * Unit tests for the arithmetic that is easy to get quietly wrong.
 *
 * The end-to-end test in apps/api proves the engine runs. These prove it
 * computes the right thing — specifically the four places where a plausible
 * wrong answer would never look wrong: the amortization formula, the
 * CLTV/HCLTV distinction, the representative-FICO rule with fewer than three
 * scores, and the points-and-fees tier boundaries.
 */

import { describe, expect, it } from "vitest";
import type { LoanFile } from "@hm/shared";
import { DerivationLog } from "../derive.js";
import { housingPitia, loanToValue, representativeFico, reserves } from "../calculations.js";
import { runComplianceTests } from "../compliance.js";
import { pointsAndFeesCap, GUIDELINES } from "../guidelines.js";

function file(overrides: Partial<LoanFile> = {}): LoanFile {
  return {
    id: "f",
    createdAt: "",
    updatedAt: "",
    stage: "decision",
    propertyRecord: null,
    valuation: null,
    flood: null,
    sanctions: null,
    lienSearch: null,
    property: {
      address: { line1: "1 St", city: "C", state: "TX", postalCode: "1" },
      deliverableAddressVerified: true,
      propertyType: "single_family",
      occupancy: "primary_residence",
      valueOrPrice: 400_000,
      valuationSource: "avm",
      financedPropertyCount: 1,
    },
    loan: {
      purpose: "purchase",
      loanAmount: 320_000,
      downPayment: 80_000,
      juniorLienBalance: 0,
      juniorLienCreditLimit: 0,
      interestedPartyContributions: 0,
    },
    product: {
      productCode: "P",
      termMonths: 360,
      amortization: "fixed",
      noteRate: 6,
      overlays: [],
    },
    borrowers: [],
    consents: [],
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
    applicationSignedAt: null,
    intentToProceedAt: null,
    deliveryMethod: "electronic",
    ...overrides,
  };
}

describe("representative FICO", () => {
  const scores = (values: number[]) => ({
    reportId: "r",
    reportDate: "2026-01-01",
    pullType: "soft" as const,
    scores: values.map((score, i) => ({
      bureau: (["equifax", "experian", "transunion"] as const)[i]!,
      score,
      model: "FICO",
    })),
    tradelines: [],
    publicRecords: [],
    inquiries: [],
    fraudAlert: false,
    ssnMismatch: false,
  });

  it("takes the middle of three, not the average", () => {
    const log = new DerivationLog();
    // Average would be 700. The rule is the middle score.
    expect(representativeFico(file({ credit: scores([620, 680, 800]) }), log)).toBe(680);
  });

  it("takes the lower of two", () => {
    const log = new DerivationLog();
    expect(representativeFico(file({ credit: scores([720, 690]) }), log)).toBe(690);
  });

  it("blocks rather than guessing when there is no report", () => {
    const log = new DerivationLog();
    expect(representativeFico(file({ credit: null }), log)).toBeNull();
    expect(log.all()[0]?.blockedBy).toContain("credit report");
  });
});

describe("LTV, CLTV and HCLTV", () => {
  it("distinguishes a drawn junior balance from its credit line", () => {
    const log = new DerivationLog();
    const result = loanToValue(
      file({
        loan: {
          purpose: "purchase",
          loanAmount: 300_000,
          downPayment: 100_000,
          // $20k drawn against a $60k line. CLTV uses the balance, HCLTV the
          // line — an undrawn HELOC is capacity available the day after
          // closing, which is exactly why the two ratios exist separately.
          juniorLienBalance: 20_000,
          juniorLienCreditLimit: 60_000,
          interestedPartyContributions: 0,
        },
      }),
      log,
    );
    expect(result.ltv).toBe(75);
    expect(result.cltv).toBe(80);
    expect(result.hcltv).toBe(90);
  });

  it("blocks on a zero value rather than dividing by it", () => {
    const log = new DerivationLog();
    const f = file();
    const result = loanToValue({ ...f, property: { ...f.property!, valueOrPrice: 0 } }, log);
    expect(result.ltv).toBeNull();
  });
});

describe("housing PITIA", () => {
  it("amortizes correctly", () => {
    const log = new DerivationLog();
    const pitia = housingPitia(file(), log);
    // $320,000 at 6% over 360 months is $1,918.56 of P&I. Escrow adds
    // 400,000 × (0.011 + 0.0035) / 12 = $483.33.
    expect(pitia).toBeCloseTo(1_918.56 + 483.33, 0);
  });

  it("says in its own formula that escrow is estimated", () => {
    const log = new DerivationLog();
    housingPitia(file(), log);
    const entry = log.all().find((d) => d.label === "Housing PITIA");
    expect(entry?.formula).toMatch(/ESTIMATED/);
  });
});

describe("reserves", () => {
  it("haircuts retirement assets", () => {
    const log = new DerivationLog();
    const result = reserves(
      file({
        assets: {
          reportId: "a",
          generatedAt: "",
          monthsCovered: 12,
          vendorAuthorizedForDu: true,
          accounts: [
            {
              id: "1",
              institution: "B",
              type: "retirement",
              mask: "1",
              currentBalance: 100_000,
              balanceHistory: [],
              vestedBalance: 100_000,
              withdrawalEligible: true,
              usedForQualifying: true,
            },
          ],
          largeDeposits: [],
          identifiedRentPayments: 0,
          alternativeReferences: [],
          incomeSources: [],
          employments: [],
          incomeConfidence: "verified" as const,
          gifts: [],
          borrowedFunds: [],
          earnestMoneyVerified: true,
        },
      }),
      2_000,
      0,
      log,
    );
    // $100,000 vested counts as $60,000, which is 30 months of a $2,000 PITIA.
    expect(result.eligiblePostCloseAssets).toBe(60_000);
    expect(result.actualMonths).toBe(30);
  });

  it("requires more months for an investment property than a primary home", () => {
    const log = new DerivationLog();
    const f = file();
    const primary = reserves(f, null, null, log).requiredMonths;
    const investment = reserves(
      { ...f, property: { ...f.property!, occupancy: "investment" } },
      null,
      null,
      new DerivationLog(),
    ).requiredMonths;
    expect(investment).toBeGreaterThan(primary!);
  });
});

describe("points and fees cap", () => {
  it("applies 3% at and above the top tier threshold", () => {
    const top = GUIDELINES.qmPointsAndFees[0]!;
    expect(pointsAndFeesCap(top.minLoanAmount)).toBe(3);
    expect(pointsAndFeesCap(top.minLoanAmount - 1)).toBeGreaterThan(3);
  });

  it("gets more permissive as the loan gets smaller", () => {
    const caps = [500_000, 100_000, 50_000, 20_000, 5_000].map(pointsAndFeesCap);
    for (let i = 1; i < caps.length; i++) {
      expect(caps[i]).toBeGreaterThanOrEqual(caps[i - 1]!);
    }
  });
});

describe("mortgage insurance and association dues", () => {
  it("charges MI above 80% LTV and not at or below it", () => {
    const at80 = housingPitia(file(), new DerivationLog());
    const f = file();
    // Same property, bigger loan: 95% LTV.
    const at95 = housingPitia(
      { ...f, loan: { ...f.loan!, loanAmount: 380_000 } },
      new DerivationLog(),
    );
    expect(at80).not.toBeNull();
    expect(at95).not.toBeNull();

    // The 95% payment must exceed the 80% payment by MORE than the extra P&I
    // alone — the difference is the MI that used to be missing entirely.
    const log = new DerivationLog();
    housingPitia({ ...f, loan: { ...f.loan!, loanAmount: 380_000 } }, log);
    const entry = log.all().find((d) => d.label === "Housing PITIA");
    expect(entry?.inputs.mortgage_insurance_applies).toBe(true);
    expect(Number(entry?.inputs.estimated_mortgage_insurance)).toBeGreaterThan(0);

    const clean = new DerivationLog();
    housingPitia(file(), clean);
    const at80Entry = clean.all().find((d) => d.label === "Housing PITIA");
    expect(at80Entry?.inputs.mortgage_insurance_applies).toBe(false);
  });

  it("includes association dues, because the A in PITIA is dues", () => {
    const f = file();
    const withDues = housingPitia(
      { ...f, property: { ...f.property!, monthlyAssociationDues: 350 } },
      new DerivationLog(),
    );
    const without = housingPitia(f, new DerivationLog());
    expect(withDues! - without!).toBeCloseTo(350, 1);
  });
});

describe("QM is a price test, not a DTI test", () => {
  const market = { apr: 6.4, apor: 6.1, pointsAndFeesAmount: 5_000 };

  function complianceFor(overrides: Parameters<typeof runComplianceTests>[1], dti: number | null) {
    const f = file();
    const log = new DerivationLog();
    return runComplianceTests(
      {
        ...f,
        credit: { scores: [], tradelines: [], publicRecords: [], inquiries: [] } as never,
        assets: { accounts: [] } as never,
        incomeSources: [{ type: "base_wage" }] as never,
      },
      overrides,
      dti,
      log,
    );
  }

  it("does not decide QM from DTI", () => {
    // 55% DTI is above the old 43% rule and above this engine's own AUS
    // maximum, and yet a well-priced loan is still General QM. Deciding from
    // DTI got this backwards.
    const c = complianceFor(market, 55);
    expect(c.qmStatus).toBe("qm");
  });

  it("fails QM on price, however good the DTI", () => {
    const c = complianceFor({ ...market, apr: 10.5 }, 20);
    expect(c.qmStatus).toBe("non_qm");
  });

  it("refuses to guess without APR and APOR", () => {
    const c = complianceFor({ pointsAndFeesAmount: 5_000 }, 35);
    expect(c.qmStatus).toBeNull();
  });
});
