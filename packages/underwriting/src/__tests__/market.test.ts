/**
 * The three priced figures, and the places each of them would go quietly wrong.
 *
 * Every claim here is about a number that decides a legal test, so the failures
 * these guard against all look like answers rather than like errors: an APOR
 * from the wrong week, an APR that is really the note rate, a points-and-fees
 * total that is really the whole closing cost, and a HOEPA test that says "not
 * high-cost" having tested one of its two triggers.
 */

import { describe, expect, it } from "vitest";
import type { LoanFile } from "@hm/shared";
import { APOR_TABLE, loadAporTable, lookupApor, type AporTable } from "../apor.js";
import { annualPercentageRate } from "../apr.js";
import { runComplianceTests } from "../compliance.js";
import { DerivationLog, round } from "../derive.js";
import { closingCosts, FEE_SCHEDULE } from "../fee-schedule.js";

/** A short series with the same shape as the shipped one. */
const SERIES: AporTable = {
  source: "test",
  termYears: [30, 15],
  weeks: [
    { weekOf: "2026-06-01", fixed: [6.25, 5.48] },
    { weekOf: "2026-06-08", fixed: [6.22, 5.46] },
    { weekOf: "2026-06-15", fixed: [6.2, 5.43] },
  ],
};

const on = (date: string) => new Date(`${date}T12:00:00.000Z`);

describe("the weekly table refuses what it cannot answer", () => {
  it("answers the week the rate was set, not the latest week it holds", () => {
    // The whole reason the series is dated. Regulation Z compares against the
    // week the rate was set, so a loan quoted a fortnight ago is measured
    // against a fortnight ago — and the three weeks here differ, so taking the
    // last row would give a different and confidently wrong answer.
    const answer = lookupApor(SERIES, on("2026-06-03"), 360, "Fixed");
    expect(answer).toMatchObject({ found: true, rate: 6.25, weekOf: "2026-06-01" });
  });

  it("stays on a week for all seven of its days", () => {
    expect(lookupApor(SERIES, on("2026-06-07"), 360, "Fixed")).toMatchObject({
      weekOf: "2026-06-01",
    });
  });

  it("reads the column for the term, not the first one", () => {
    expect(lookupApor(SERIES, on("2026-06-15"), 180, "Fixed")).toMatchObject({
      found: true,
      rate: 5.43,
      termYears: 15,
    });
  });

  it("goes stale loudly rather than answering off an older week", () => {
    // The failure this file exists for. A rate set after the last row is a rate
    // the table has no week for, and the nearest week it does hold is the wrong
    // answer arriving as a right-looking one.
    const stale = lookupApor(SERIES, on("2026-07-20"), 360, "Fixed");
    expect(stale.found).toBe(false);
    expect(stale).toMatchObject({ reason: expect.stringContaining("2026-06-15") });
  });

  it("refuses a rate set before the series begins", () => {
    expect(lookupApor(SERIES, on("2026-05-20"), 360, "Fixed").found).toBe(false);
  });

  it("refuses a term it has no column for", () => {
    expect(lookupApor(SERIES, on("2026-06-15"), 240, "Fixed").found).toBe(false);
  });

  it("refuses an adjustable rate, which is compared against a different series", () => {
    expect(lookupApor(SERIES, on("2026-06-15"), 360, "AdjustableRate").found).toBe(false);
  });
});

describe("the loader catches the edits a lookup cannot", () => {
  it("refuses a series with a week missing from the middle", () => {
    // A hole is indistinguishable from the end of the series at lookup time:
    // both are "no row for this week", and the lookup answers the week before.
    // So it has to be caught on the way in.
    expect(() =>
      loadAporTable({
        ...SERIES,
        weeks: [SERIES.weeks[0]!, SERIES.weeks[2]!],
      }),
    ).toThrow(/hole/);
  });

  it("refuses a week that does not begin on a Monday", () => {
    expect(() =>
      loadAporTable({ ...SERIES, weeks: [{ weekOf: "2026-06-03", fixed: [6.2, 5.4] }] }),
    ).toThrow(/Monday/);
  });

  it("refuses a row with a rate missing from it", () => {
    expect(() =>
      loadAporTable({ ...SERIES, weeks: [{ weekOf: "2026-06-01", fixed: [6.2] }] }),
    ).toThrow(/term columns/);
  });

  it("loads the series this deployment ships", () => {
    expect(APOR_TABLE.weeks.length).toBeGreaterThan(0);
    expect(APOR_TABLE.termYears).toContain(30);
  });

  /**
   * The alarm, and the only test in this repository that is allowed to read the
   * clock.
   *
   * `apor.ts` says the shipped series "WILL stop answering, on the Monday after
   * the last row below, and that is the alarm working". It was half true. The
   * table does stop answering — but nothing rang. Every other test pins its
   * quote to `APOR_TABLE.weeks.at(-1)` precisely so it does not inherit the
   * clock, which is right for a test about application states and leaves the
   * suite fully green on the day every real borrower's file starts blocking
   * UW-008, failing all four compliance tests, and ending `referred` with no
   * edge out of `in_underwriting`. That is the regression this whole commit
   * exists to remove, reinstating itself on a timer, invisibly.
   *
   * So this one test reads `new Date()` on purpose. It fails on the first
   * Monday the series does not reach, in CI, before a borrower finds out —
   * which is the difference between an alarm and a comment claiming there is
   * one. When it fails, the fix is to add the weeks the FFIEC has since
   * published. It is NOT to extend the series forward with invented rows; a
   * fabricated APOR answers a legal test confidently and wrongly, where a
   * missing one only refuses.
   */
  it("still covers the week we are in, so the staleness alarm is a failing test and not a comment", () => {
    const answer = lookupApor(APOR_TABLE, new Date(), 360, "Fixed");
    expect(
      answer,
      `The shipped APOR series ends the week of ${APOR_TABLE.weeks[APOR_TABLE.weeks.length - 1]!.weekOf} ` +
        "and no longer covers today, so every file quoted today blocks UW-008 and ends `referred`. " +
        "Add the weeks the FFIEC has published since. Do not invent them.",
    ).toMatchObject({ found: true });
  });
});

describe("one schedule, three totals", () => {
  const priced = closingCosts(FEE_SCHEDULE, 332_000)!;

  it("keeps the three apart, because they are different subsets", () => {
    // If any two of these were equal the schedule would have stopped answering
    // one of the questions asked of it — most likely by having every line
    // flagged the same way.
    expect(priced.pointsAndFees).toBeLessThan(priced.total);
    expect(priced.prepaidFinanceCharges).toBeLessThan(priced.total);
  });

  it("leaves a bona fide third-party charge out of both regulated subsets", () => {
    const appraisal = FEE_SCHEDULE.lines.find((l) => l.name === "Appraisal fee")!;
    expect([appraisal.financeCharge, appraisal.pointsAndFees]).toEqual([false, false]);
    // And it is still a closing cost, which is what a refinance recoups.
    expect(priced.total).toBeGreaterThan(priced.pointsAndFees + appraisal.amount - 1);
  });

  it("scales the percentage lines with the loan and leaves the flat ones alone", () => {
    const small = closingCosts(FEE_SCHEDULE, 100_000)!;
    const big = closingCosts(FEE_SCHEDULE, 400_000)!;
    expect(big.pointsAndFees - small.pointsAndFees).toBeCloseTo(0.005 * 300_000, 2);
  });

  it("has no priced schedule for a loan of nothing", () => {
    expect(closingCosts(FEE_SCHEDULE, 0)).toBeNull();
  });
});

describe("the APR is not the note rate", () => {
  const LOAN = { loanAmount: 332_000, noteRate: 6.25, termMonths: 360, amortization: "Fixed" };

  it("is the note rate exactly when nothing is paid at closing", () => {
    // The only case where substituting one for the other is right, and the
    // check that the solver is solving the right equation: with no prepaid
    // finance charge the amount financed is the loan, so the rate that
    // discounts the payments back to it is the note rate.
    const zero = annualPercentageRate({
      ...LOAN,
      prepaidFinanceCharges: 0,
      mortgageInsuranceApplies: false,
    });
    expect(zero).toMatchObject({ computed: true });
    expect(zero.computed && zero.apr).toBeCloseTo(6.25, 3);
  });

  it("rises above it once there are prepaid finance charges", () => {
    const priced = closingCosts(FEE_SCHEDULE, LOAN.loanAmount)!;
    const result = annualPercentageRate({
      ...LOAN,
      prepaidFinanceCharges: priced.prepaidFinanceCharges,
      mortgageInsuranceApplies: false,
    });
    expect(result.computed).toBe(true);
    const apr = result.computed ? result.apr : 0;
    expect(apr).toBeGreaterThan(LOAN.noteRate);
    // Close enough to the note rate that the substitution would pass casual
    // inspection, and far enough that it moves a spread test.
    expect(apr - LOAN.noteRate).toBeGreaterThan(0.05);
    expect(apr - LOAN.noteRate).toBeLessThan(0.2);
  });

  it("refuses a loan carrying mortgage insurance rather than estimating one", () => {
    const result = annualPercentageRate({
      ...LOAN,
      prepaidFinanceCharges: 4_150,
      mortgageInsuranceApplies: true,
    });
    expect(result).toMatchObject({ computed: false });
    expect(result.computed === false && result.reason).toContain("mortgage insurance");
  });

  it("refuses a product that does not amortize the way the method assumes", () => {
    expect(
      annualPercentageRate({
        ...LOAN,
        amortization: "AdjustableRate",
        prepaidFinanceCharges: 0,
        mortgageInsuranceApplies: false,
      }).computed,
    ).toBe(false);
  });

  it("brackets the root instead of asserting one, so no loan gets a saturated APR", () => {
    // Bisection against a bracket that excludes the root does not fail: it
    // converges on the bound and returns it. With the old flat ceiling of 100%
    // a month, a $1,600 loan carrying $1,598 of this lender's prepaid finance
    // charges recorded a computed APR of exactly 1200.000% — a fabricated
    // number with a derivation behind it, which is the one thing no figure on a
    // decision may be.
    const tiny = annualPercentageRate({
      loanAmount: 1_600,
      noteRate: 6.25,
      termMonths: 360,
      amortization: "Fixed",
      prepaidFinanceCharges: 1_598,
      mortgageInsuranceApplies: false,
    });
    expect(tiny.computed).toBe(true);
    if (!tiny.computed) return;
    expect(tiny.apr).not.toBe(1_200);
    expect(tiny.apr).toBeCloseTo(5_910.885, 2);
    // And the loan every borrower actually has is untouched by the widening.
    const ordinary = annualPercentageRate({
      loanAmount: 400_000,
      noteRate: 6.75,
      termMonths: 360,
      amortization: "Fixed",
      prepaidFinanceCharges: 3_590,
      mortgageInsuranceApplies: false,
    });
    expect(ordinary.computed && ordinary.apr).toBe(6.838);
  });

  it("keeps the omitted odd-days interest inside Regulation Z's own tolerance", () => {
    // No file here carries a disbursement date, so interest from disbursement
    // to the first payment period is left out. This is the bound that makes
    // that defensible: a full month of it — the most there can ever be — moves
    // the APR by less than the eighth of a point §1026.22(a)(2) allows a
    // disclosed APR to be out by.
    const priced = closingCosts(FEE_SCHEDULE, LOAN.loanAmount)!;
    const oddDays = (LOAN.loanAmount * (LOAN.noteRate / 100) * 30) / 365;
    const without = annualPercentageRate({
      ...LOAN,
      prepaidFinanceCharges: priced.prepaidFinanceCharges,
      mortgageInsuranceApplies: false,
    });
    const with30 = annualPercentageRate({
      ...LOAN,
      prepaidFinanceCharges: priced.prepaidFinanceCharges + oddDays,
      mortgageInsuranceApplies: false,
    });
    expect(without.computed && with30.computed).toBe(true);
    const gap = (with30.computed ? with30.apr : 0) - (without.computed ? without.apr : 0);
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(0.125);
  });
});

/** A refinance with terms the net tangible benefit test can run on. */
function refinance(): LoanFile {
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
      valueOrPrice: 500_000,
      valuationSource: "avm",
      financedPropertyCount: 1,
    },
    loan: {
      purpose: "rate_term_refinance",
      loanAmount: 300_000,
      downPayment: 0,
      juniorLienBalance: 0,
      juniorLienCreditLimit: 0,
      interestedPartyContributions: 0,
      existingLoan: {
        servicer: "S",
        loanNumber: "1",
        balance: 300_000,
        rate: 7.5,
        monthlyPayment: 2_200,
      },
    },
    product: {
      productCode: "P",
      termMonths: 360,
      amortization: "Fixed",
      noteRate: 6.25,
      rateQuotedAt: "2026-06-15T00:00:00.000Z",
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
  };
}

describe("what the tests downstream do with those figures", () => {
  it("recoups every closing cost, not just what the lender keeps", () => {
    // Recouping the points and fees alone halves the number a borrower is told
    // it takes to break even, and passes a refinance that fails.
    const priced = closingCosts(FEE_SCHEDULE, 300_000)!;
    const log = new DerivationLog();
    const result = runComplianceTests(
      refinance(),
      { pointsAndFeesAmount: priced.pointsAndFees, closingCostTotal: priced.total },
      30,
      log,
    );
    const saving = result.netTangibleBenefit!.paymentDelta;
    expect(result.netTangibleBenefit!.recoupMonths).toBeCloseTo(priced.total / saving, 0);
    expect(priced.total / saving).toBeGreaterThan(priced.pointsAndFees / saving);
  });

  it("blocks the benefit test on the closing cost total, not on the fee subset", () => {
    const log = new DerivationLog();
    const result = runComplianceTests(
      refinance(),
      { pointsAndFeesAmount: 3_000, totalLoanAmount: 297_000 },
      30,
      log,
    );
    expect(result.netTangibleBenefit).toBeUndefined();
    expect(log.all().find((d) => d.requirementId === "APP-019")?.blockedBy).toEqual([
      "closing cost total",
    ]);
  });

  it("will not call a loan not-high-cost having tested one of the two triggers", () => {
    // The fee schedule always prices, so the fee trigger always answers. With
    // no APR the rate trigger cannot, and a two-valued OR reported `false` —
    // a clean HOEPA determination on a loan whose rate nobody compared to
    // anything.
    const log = new DerivationLog();
    const result = runComplianceTests(
      refinance(),
      { pointsAndFeesAmount: 3_000, totalLoanAmount: 297_000 },
      30,
      log,
    );
    expect(result.pointsAndFeesPass).toBe(true);
    expect(result.isHighCost).toBeNull();
    expect(log.all().find((d) => d.label === "HOEPA high-cost test")?.blockedBy).toEqual([
      "APR/APOR, for the rate trigger",
    ]);
  });

  it("still says high-cost on one trigger alone, because one is enough", () => {
    // The asymmetry is the point: `true` needs one trigger, `false` needs both.
    const log = new DerivationLog();
    const result = runComplianceTests(
      refinance(),
      { pointsAndFeesAmount: 30_000, totalLoanAmount: 270_000, closingCostTotal: 33_000 },
      30,
      log,
    );
    expect(result.isHighCost).toBe(true);
  });

  /**
   * §1026.32(b)(4): the ratio is measured against the TOTAL loan amount — the
   * loan less what is paid at closing for the credit itself — not against the
   * note amount. The difference is the fees' own share of the loan, so it is
   * invisible on a big loan and decisive on a small one, always in the
   * permissive direction.
   */
  it("measures points and fees against the total loan amount, not the note amount", () => {
    const base = refinance();
    const small: LoanFile = { ...base, loan: { ...base.loan!, loanAmount: 36_000 } };
    const priced = closingCosts(FEE_SCHEDULE, 36_000)!;
    const result = runComplianceTests(
      small,
      {
        pointsAndFeesAmount: priced.pointsAndFees,
        totalLoanAmount: 36_000 - priced.prepaidFinanceCharges,
      },
      30,
      new DerivationLog(),
    );
    // 1,770 of 36,000 is 4.92% and passes the 5% HOEPA trigger; 1,770 of the
    // 34,230 actually financed is 5.17% and does not. Dividing by the note
    // amount approved a high-cost mortgage and stored a decision saying so.
    expect(round((priced.pointsAndFees / 36_000) * 100)).toBeLessThan(5);
    expect(result.pointsAndFeesRatio!).toBeGreaterThan(5);
    expect(result.isHighCost).toBe(true);
  });

  it("does not apply HOEPA or HPML to a loan on something that is not a home", () => {
    // §1026.32(a)(1) and §1026.35(a)(1) both reach a loan secured by the
    // consumer's PRINCIPAL dwelling. This lender's flat fees are 5.8% of a
    // $30,000 loan, so without a coverage check a small second-home purchase
    // fired the fee trigger — and one high-cost finding is a denial ahead of
    // every other branch, so a borrower was declined, and told why, on a rule
    // that does not reach their loan.
    const base = refinance();
    const secondHome: LoanFile = {
      ...base,
      property: { ...base.property!, occupancy: "second_home" },
      loan: { ...base.loan!, loanAmount: 30_000 },
    };
    const log = new DerivationLog();
    const result = runComplianceTests(
      secondHome,
      { apr: 13.6, apor: 6.55, pointsAndFeesAmount: 1_740, totalLoanAmount: 28_260 },
      30,
      log,
    );
    expect(result.isHighCost).toBeNull();
    expect(result.isHpml).toBeNull();
    // Recorded, not blocked: we know the answer is that the rule does not reach
    // the loan, and a blocked derivation would force `refer` instead.
    const hoepa = log.all().find((d) => d.label === "HOEPA high-cost test")!;
    expect(hoepa.blockedBy).toBeUndefined();
    expect(hoepa.value).toBe("out_of_scope");
  });

  it("calls a spread of exactly 1.5 an HPML, because the rule says 'or more'", () => {
    // Two independent ways this used to record an HPML as not one: a strict >
    // against the threshold, and a spread rounded to hundredths before the test.
    const exactly = runComplianceTests(
      refinance(),
      { apr: 7.8, apor: 6.3 },
      30,
      new DerivationLog(),
    );
    expect(exactly.hpmlSpread).toBe(1.5);
    expect(exactly.isHpml).toBe(true);

    const justUnder = runComplianceTests(
      refinance(),
      { apr: 7.799, apor: 6.3 },
      30,
      new DerivationLog(),
    );
    expect(justUnder.isHpml).toBe(false);
  });

  it("denies General QM at exactly the threshold, because that rule says 'or more' too", () => {
    // ATR has to be documented before the price test decides anything: without
    // credit, assets and income the answer is "non_qm" for a reason that has
    // nothing to do with the spread, and a boundary test would pass blind.
    const priced = (): LoanFile => ({
      ...refinance(),
      credit: {} as LoanFile["credit"],
      assets: {} as LoanFile["assets"],
      incomeSources: [{} as LoanFile["incomeSources"][number]],
    });
    expect(runComplianceTests(priced(), {}, 30, new DerivationLog()).atrDetermination).toBe(
      "documented",
    );
    // §1026.43(e)(2)(vi) disqualifies a loan whose APR exceeds APOR by 2.25 or
    // more percentage points, so QM lives strictly below the cap. Labelling it
    // "qm" hands over the §1026.43(e)(1) presumption of compliance.
    const at = runComplianceTests(priced(), { apr: 8.55, apor: 6.3 }, 30, new DerivationLog());
    expect(at.qmStatus).toBe("non_qm");
    expect(at.qmType).toBeUndefined();

    const below = runComplianceTests(priced(), { apr: 8.549, apor: 6.3 }, 30, new DerivationLog());
    expect(below.qmStatus).toBe("qm");
  });

  it("reports a refinance that never recoups as null months, not a number JSON cannot carry", () => {
    // Infinity survives in memory and becomes null in jsonb, so the stored
    // decision said the test failed and could not say by how much. Null is the
    // honest value, and it is unambiguous: a test that never ran leaves
    // `netTangibleBenefit` undefined entirely.
    const base = refinance();
    const worse: LoanFile = {
      ...base,
      loan: {
        ...base.loan!,
        existingLoan: { ...base.loan!.existingLoan!, monthlyPayment: 100 },
      },
    };
    const result = runComplianceTests(worse, { closingCostTotal: 6_000 }, 30, new DerivationLog());
    expect(result.netTangibleBenefit!.recoupMonths).toBeNull();
    expect(result.netTangibleBenefit!.paymentDelta).toBeLessThanOrEqual(0);
    expect(JSON.parse(JSON.stringify(result.netTangibleBenefit)).recoupMonths).toBeNull();
  });
});
