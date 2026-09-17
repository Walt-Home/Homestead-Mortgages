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
import type { Borrower, CreditReport, DepositAccount, LoanFile, Tradeline } from "@hm/shared";
import { DerivationLog, round } from "../derive.js";
import {
  housingPitia,
  loanToValue,
  monthlyLiabilities,
  representativeFico,
  reserves,
} from "../calculations.js";
import { runComplianceTests } from "../compliance.js";
import { maxLtvFor } from "../aus.js";
import { afterIdentity } from "./support/in-memory-file.js";
import { pointsAndFeesLimit, REGULATION_Z_THRESHOLDS } from "../guidelines.js";

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
      estateType: "FeeSimple",
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
      amortization: "Fixed",
      noteRate: 6,
      // Noon, so the New York calendar date is the 15th too. A midnight-UTC
      // instant is Sunday the 14th in the zone the rate-set date is read in.
      rateQuotedAt: "2026-06-15T12:00:00.000Z",
      prepaymentPenalty: false,
      overlays: [],
    },
    borrowers: [],
    invitedBorrowers: [],
    vestings: [],
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
    const result = representativeFico(file({ credit: scores([620, 680, 800]) }), log);
    expect(result?.representative).toBe(680);
    expect(result?.forEligibility).toBe(680);
    expect(result?.averageMedian).toBeNull();
  });

  it("takes the lower of two", () => {
    const log = new DerivationLog();
    expect(representativeFico(file({ credit: scores([720, 690]) }), log)?.representative).toBe(690);
  });

  it("blocks rather than guessing when there is no report", () => {
    const log = new DerivationLog();
    expect(representativeFico(file({ credit: null }), log)).toBeNull();
    expect(log.all()[0]?.blockedBy).toContain("credit report");
  });

  /*
   * Two people, two reports. The loan's representative score is the lowest
   * of the two, which is what pricing reads; the 620 minimum on a loan with
   * more than one borrower is tested against the average of the two
   * (Selling Guide B3-5.1-02). Read off one report, a two-person loan's score
   * was one person's, and the DTI beneath it was short the other's debts.
   */
  describe("with more than one borrower", () => {
    const person = (id: string, first: string, last: string): Borrower => ({
      ...file().borrowers[0]!,
      id,
      partyId: `party-${id}`,
      firstName: first,
      lastName: last,
    });
    const dana = person("b1", "Dana", "Whitfield");
    const theo = person("b2", "Theo", "Okafor");
    const two = (hers: CreditReport | null, his: CreditReport | null): LoanFile =>
      file({
        borrowers: [dana, theo],
        credit: hers,
        reports: [
          { partyId: dana.partyId, credit: hers, assets: null, payroll: null, transcripts: [] },
          { partyId: theo.partyId, credit: his, assets: null, payroll: null, transcripts: [] },
        ],
      });

    it("prices on the lowest and tests the minimum on the average", () => {
      const log = new DerivationLog();
      const result = representativeFico(two(scores([700, 720, 740]), scores([600, 605, 660])), log);
      expect(result).toEqual({ representative: 605, forEligibility: 663, averageMedian: 663 });
      const labels = log.all().map((d) => d.label);
      expect(labels).toEqual([
        "Representative FICO (Dana Whitfield)",
        "Representative FICO (Theo Okafor)",
        "Representative FICO",
        "Average median credit score",
      ]);
      expect(log.all()[2]?.inputs).toEqual({ "Dana Whitfield": 720, "Theo Okafor": 605 });
    });

    it("blocks the loan's score while anybody's report is missing, and names them", () => {
      const log = new DerivationLog();
      expect(representativeFico(two(scores([700, 720, 740]), null), log)).toBeNull();
      expect(log.all()[0]?.blockedBy).toEqual(["credit report for Theo Okafor"]);
    });

    it("reads a file assembled without per-person reports as Borrower 1's alone", () => {
      const log = new DerivationLog();
      const inMemory = { ...two(scores([700, 720, 740]), null), reports: undefined };
      expect(representativeFico(inMemory, log)).toBeNull();
      expect(log.all()[0]?.blockedBy).toEqual(["credit report for Theo Okafor"]);
    });

    it("counts a joint account once in the household's liabilities", () => {
      const line = (id: string, creditor: string, payment: number): Tradeline => ({
        id,
        creditorName: creditor,
        type: "installment",
        balance: 10_000,
        monthlyPayment: payment,
        openedDate: "2023-05-01",
        disputed: false,
        paymentHistory: [],
        maxDelinquency: 0,
      });
      const hers = {
        ...scores([700, 720, 740]),
        tradelines: [line("h1", "Auto Co", 400), line("h2", "Card Co", 50)],
      };
      // The same auto loan on his report, under his report's own id.
      const his = {
        ...scores([600, 605, 660]),
        tradelines: [line("t9", "Auto Co", 400), line("t2", "Student Co", 150)],
      };
      const log = new DerivationLog();
      expect(monthlyLiabilities(two(hers, his), log)).toBe(600);
      expect(log.all()[0]?.inputs).toMatchObject({
        tradelines_counted: 3,
        borrowers_with_credit: 2,
        joint_tradelines_deduplicated: 1,
      });
    });

    it("counts every connected bank's accounts, a joint account once, in reserves", () => {
      const account = (id: string, mask: string, balance: number): DepositAccount => ({
        id,
        institution: "Fixture Bank",
        type: "checking",
        mask,
        currentBalance: balance,
        balanceHistory: [],
        usedForQualifying: true,
      });
      const report = (id: string, accounts: DepositAccount[]) => ({
        reportId: id,
        generatedAt: "",
        monthsCovered: 12,
        vendorAuthorizedForDu: true,
        accounts,
        largeDeposits: [],
        identifiedRentPayments: 0,
        alternativeReferences: [],
        incomeSources: [],
        employments: [],
        incomeConfidence: "verified" as const,
        gifts: [],
        borrowedFunds: [],
        earnestMoneyVerified: true,
      });
      const hers = report("hers", [account("a1", "1111", 20_000), account("a2", "2222", 5_000)]);
      const his = report("his", [account("z1", "2222", 5_000), account("z2", "3333", 15_000)]);
      const f: LoanFile = {
        ...two(null, null),
        assets: hers,
        reports: [
          { partyId: dana.partyId, credit: null, assets: hers, payroll: null, transcripts: [] },
          { partyId: theo.partyId, credit: null, assets: his, payroll: null, transcripts: [] },
        ],
      };
      const log = new DerivationLog();
      // 20,000 + 5,000 + 15,000: the shared account is not 10,000.
      expect(reserves(f, 2_000, 0, log).eligiblePostCloseAssets).toBe(40_000);
      const eligible = log.all().find((d) => d.label === "Eligible post-close assets");
      expect(eligible?.inputs).toMatchObject({
        borrowers_with_assets: 2,
        borrowers_without_assets: 0,
        joint_accounts_deduplicated: 1,
      });
    });

    it("computes reserves on whoever has connected a bank, and says how many have not", () => {
      const f: LoanFile = {
        ...two(null, null),
        reports: [
          {
            partyId: dana.partyId,
            credit: null,
            assets: {
              reportId: "hers",
              generatedAt: "",
              monthsCovered: 12,
              vendorAuthorizedForDu: true,
              accounts: [
                {
                  id: "a1",
                  institution: "B",
                  type: "checking",
                  mask: "1",
                  currentBalance: 30_000,
                  balanceHistory: [],
                  usedForQualifying: true,
                },
              ],
              largeDeposits: [],
              identifiedRentPayments: 0,
              alternativeReferences: [],
              incomeSources: [],
              employments: [],
              incomeConfidence: "verified",
              gifts: [],
              borrowedFunds: [],
              earnestMoneyVerified: true,
            },
            payroll: null,
            transcripts: [],
          },
          { partyId: theo.partyId, credit: null, assets: null, payroll: null, transcripts: [] },
        ],
      };
      const log = new DerivationLog();
      expect(reserves(f, 2_000, 0, log).eligiblePostCloseAssets).toBe(30_000);
      const eligible = log.all().find((d) => d.label === "Eligible post-close assets");
      expect(eligible?.inputs).toMatchObject({
        borrowers_with_assets: 1,
        borrowers_without_assets: 1,
      });
    });
  });
});

describe("the LTV ceiling", () => {
  it("drops to 95 when a co-borrower will not live in the home", () => {
    const f = afterIdentity();
    const dana = { ...f.borrowers[0]!, occupiesProperty: true };
    expect(maxLtvFor({ ...f, borrowers: [dana] })).toBe(97);
    expect(
      maxLtvFor({
        ...f,
        borrowers: [dana, { ...dana, id: "b2", partyId: "p2", occupiesProperty: false }],
      }),
    ).toBe(95);
    // Unknown is not "no": a file assembled without the role keeps the purpose's ceiling.
    expect(
      maxLtvFor({
        ...f,
        borrowers: [dana, { ...dana, id: "b2", partyId: "p2", occupiesProperty: undefined }],
      }),
    ).toBe(97);
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
  /**
   * The cap is a DOLLAR limit, compared in whole cents.
   *
   * Two things used to be wrong here at once. The tiers were percentages where
   * §1026.43(e)(3)(i)(B) and (D) state flat dollars, and the pass was decided
   * on the ratio ROUNDED to hundredths — so $6,000.40 against a $6,000 cap
   * rounded to 3.00% and passed. `pointsAndFeesRatio` is still recorded,
   * because the screen shows it and a CHECK on `decisions` reads it, but it is
   * no longer what decides anything.
   */
  function feesOn(
    loanAmount: number,
    totalLoanAmount: number,
    pointsAndFeesAmount: number,
  ): ReturnType<typeof runComplianceTests> {
    const f = file();
    return runComplianceTests(
      { ...f, loan: { ...f.loan!, loanAmount } },
      { pointsAndFeesAmount, totalLoanAmount },
      30,
      new DerivationLog(),
    );
  }

  it("applies 3% of the total loan amount at and above the top tier", () => {
    const top = REGULATION_Z_THRESHOLDS[2026]!.qmPointsAndFees[0]!.minLoanAmount;
    // 3% of 195,000 is 5,850 exactly, so this pins the boundary from both sides.
    expect(feesOn(200_000, 195_000, 5_850).pointsAndFeesPass).toBe(true);
    expect(feesOn(200_000, 195_000, 5_850.01).pointsAndFeesPass).toBe(false);
    expect(top).toBe(137_958);
  });

  it("applies tier (B) as a flat $4,139 rather than a percentage", () => {
    // At a $137,000 loan the old 3.9% allowed $5,343, which is $1,204 of points
    // and fees over what the rule allows — a loan that is not a qualified
    // mortgage handed the §1026.43(e)(1) presumption of compliance.
    expect(feesOn(137_000, 135_000, 4_139).pointsAndFeesPass).toBe(true);
    expect(feesOn(137_000, 135_000, 4_139.01).pointsAndFeesPass).toBe(false);
    expect(feesOn(137_000, 135_000, 5_343).pointsAndFeesPass).toBe(false);
    // And below the tier the old approximation was the other way: 3.9% of an
    // $83,000 total is $3,237, failing a loan the rule passes at $4,139.
    expect(feesOn(83_000, 83_000, 3_500).pointsAndFeesPass).toBe(true);
  });

  it("gets more permissive as the loan gets smaller", () => {
    // The old version of this compared the tiers' percentages, which two of the
    // five tiers do not have. Measured against each loan's OWN total the claim
    // still holds and is the one worth making — a flat $1,380 is 7.1% of a
    // $19,400 total and 1.4% of a $100,000 one, so a fixed denominator would
    // make the table look non-monotone when it is the denominator moving.
    const shares = [500_000, 100_000, 50_000, 20_000, 5_000].map((loan) => {
      const total = round(loan * 0.97, 2);
      const limit = pointsAndFeesLimit(loan, total, REGULATION_Z_THRESHOLDS[2026]!);
      return limit.limitCents / (total * 100);
    });
    for (let i = 1; i < shares.length; i++) {
      expect(shares[i]).toBeGreaterThanOrEqual(shares[i - 1]!);
    }
    expect(shares[0]).toBeCloseTo(0.03, 4);
    expect(shares.at(-1)).toBeCloseTo(0.08, 4);
  });

  it("decides in cents, so $6,000.40 against a $6,000 cap fails", () => {
    // 3% of 200,000 is 6,000. The ratio rounds to 3 either way; the test does
    // not, because the test is not the screen.
    const over = feesOn(205_000, 200_000, 6_000.4);
    expect(over.pointsAndFeesRatio).toBe(3);
    expect(over.pointsAndFeesPass).toBe(false);
  });

  it("refuses a year whose thresholds it does not hold", () => {
    // A December file recomputed in January is judged on the year its rate was
    // set, and a year this engine has never seen is a blocked derivation naming
    // what is missing — not the newest table it happens to carry.
    const f = file();
    const log = new DerivationLog();
    const result = runComplianceTests(
      { ...f, product: { ...f.product!, rateQuotedAt: "2027-02-01T12:00:00.000Z" } },
      { pointsAndFeesAmount: 5_000, totalLoanAmount: 315_000 },
      30,
      log,
    );
    expect(result.pointsAndFeesPass).toBeNull();
    expect(log.all().find((d) => d.label === "Points and fees test")?.blockedBy?.[0]).toContain(
      "thresholds indexed for 2027",
    );
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

  function documented(over: Partial<LoanFile> = {}): LoanFile {
    const f = file();
    return {
      ...f,
      credit: { scores: [], tradelines: [], publicRecords: [], inquiries: [] } as never,
      assets: { accounts: [] } as never,
      incomeSources: [{ type: "base_wage" }] as never,
      ...over,
    };
  }

  function complianceFor(overrides: Parameters<typeof runComplianceTests>[1], dti: number | null) {
    return runComplianceTests(documented(), overrides, dti, new DerivationLog());
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

  /**
   * §1026.43(e)(2)(vi)(D): a first-lien covered transaction secured by a
   * MANUFACTURED HOME under the top indexed bound gets 6.5 points, not 2.25 or
   * 3.5. The engine had the three non-manufactured tiers only, so it labelled a
   * loan `non_qm` against a threshold the rule does not apply to it — the wrong
   * direction is restrictive here, but it is still a legal determination stored
   * on an append-only decision.
   */
  describe("the manufactured-home tier", () => {
    const manufactured = (loanAmount: number): LoanFile => {
      const f = file();
      return documented({
        property: { ...f.property!, propertyType: "manufactured" },
        loan: { ...f.loan!, loanAmount },
      });
    };
    const houseAt = (loanAmount: number): LoanFile => {
      const f = file();
      return documented({ loan: { ...f.loan!, loanAmount } });
    };
    // Four points over APOR: past 3.5 and well short of 6.5.
    const priced = { apr: 10.1, apor: 6.1 };

    it("gives a manufactured home under the top bound 6.5 points", () => {
      const log = new DerivationLog();
      const c = runComplianceTests(manufactured(100_000), priced, 30, log);
      expect(c.qmStatus).toBe("qm");
      const entry = log.all().find((d) => d.label === "QM status")!;
      expect(entry.inputs.threshold_paragraph).toBe("§1026.43(e)(2)(vi)(D)");
      expect(entry.inputs.manufactured_home).toBe(true);
    });

    it("measures the same spread on a house against 3.5", () => {
      const c = runComplianceTests(houseAt(100_000), priced, 30, new DerivationLog());
      expect(c.qmStatus).toBe("non_qm");
    });

    it("stops at the top bound, where (A)'s 2.25 takes over", () => {
      const log = new DerivationLog();
      const c = runComplianceTests(manufactured(137_958), priced, 30, log);
      expect(c.qmStatus).toBe("non_qm");
      expect(log.all().find((d) => d.label === "QM status")!.inputs.threshold_paragraph).toBe(
        "§1026.43(e)(2)(vi)(A)",
      );
    });

    it("will not decide QM with no property on the file at all", () => {
      // Which is what it did: the property type is an input to the threshold,
      // so deciding without one measured a manufactured home against a house's
      // tier and called the result a legal determination.
      const log = new DerivationLog();
      const c = runComplianceTests(documented({ property: null }), priced, 30, log);
      expect(c.qmStatus).toBeNull();
      expect(log.all().find((d) => d.label === "QM status")?.blockedBy).toContain(
        "the type of the property securing this loan",
      );
    });
  });
});
