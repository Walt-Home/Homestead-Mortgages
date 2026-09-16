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
import { FFIEC_SURVEY, FFIEC_YIELD_TABLE_FIXED, type LoanFile } from "@hm/shared";
import { loadAporTable, lookupApor, type AporTable } from "../apor.js";
import { effectiveMonday, parseSurveyCsv } from "../apor-survey.js";
import { APOR_TABLE, parseYieldTable } from "../apor-yield.js";
import { annualPercentageRate } from "../apr.js";
import { runComplianceTests } from "../compliance.js";
import { resolveMarketInputs } from "../market.js";
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

  /**
   * The rate-set date is a CALENDAR date, and a calendar needs a zone.
   *
   * §1026.35(a)(1) compares against the APOR "as of the date the interest rate
   * is set", and the table is published per Monday-to-Sunday week. Taking the
   * UTC calendar date off the stored instant moves every quote made after 20:00
   * Eastern into the following week — first a blocked test, then, once Monday's
   * row lands, a comparison against a week the loan was not priced in, recorded
   * on an append-only decision that names the week it used.
   *
   * The fixture rate sheet manufactures exactly that instant: `sheetWindow`
   * floored to midnight, so a Sunday-evening quote was stamped Monday 00:00Z.
   */
  describe("the day the rate was set is the lender's day", () => {
    it("reads 01:00Z on Monday as the Sunday before it, in June", () => {
      // 2026-06-15T01:00Z is Sunday the 14th at 21:00 in New York (EDT, UTC-4),
      // which is the last week the CFPB has published.
      const answer = lookupApor(SERIES, new Date("2026-06-15T01:00:00.000Z"), 360, "Fixed");
      expect(answer).toMatchObject({ found: true, weekOf: "2026-06-08", setOn: "2026-06-14" });
    });

    it("reads 04:30Z on Monday as Monday, which is the new week", () => {
      const answer = lookupApor(SERIES, new Date("2026-06-15T04:30:00.000Z"), 360, "Fixed");
      expect(answer).toMatchObject({ found: true, weekOf: "2026-06-15", setOn: "2026-06-15" });
    });

    it("moves that boundary an hour in winter, because the offset does", () => {
      // The same two half-hours in January, when New York is EST (UTC-5): the
      // day rolls at 05:00Z rather than 04:00Z. A fixed offset would get one of
      // these two wrong for eight months of the year.
      const winter: AporTable = loadAporTable({
        source: "test",
        termYears: [30],
        weeks: [
          { weekOf: "2026-01-05", fixed: [6.4] },
          { weekOf: "2026-01-12", fixed: [6.37] },
        ],
      });
      expect(lookupApor(winter, new Date("2026-01-12T04:30:00.000Z"), 360, "Fixed")).toMatchObject({
        weekOf: "2026-01-05",
        setOn: "2026-01-11",
      });
      expect(lookupApor(winter, new Date("2026-01-12T05:30:00.000Z"), 360, "Fixed")).toMatchObject({
        weekOf: "2026-01-12",
        setOn: "2026-01-12",
      });
    });

    it("reports the same date in the reason as it matched on", () => {
      // The refusal string used to be built from the UTC date while the match
      // was made on the raw instant, so a stale lookup could name a day the
      // comparison never used.
      const stale = lookupApor(SERIES, new Date("2026-07-20T01:00:00.000Z"), 360, "Fixed");
      expect(stale).toMatchObject({ found: false, reason: expect.stringContaining("2026-07-19") });
    });

    it("records the date and the zone on the derivation that reads it", () => {
      const log = new DerivationLog();
      const f = refinance();
      resolveMarketInputs(
        { ...f, product: { ...f.product!, rateQuotedAt: "2026-06-15T01:00:00.000Z" } },
        log,
        SERIES,
      );
      const entry = log.all().find((d) => d.label === "Average prime offer rate")!;
      expect(entry.inputs).toMatchObject({
        rate_quoted_at: "2026-06-15T01:00:00.000Z",
        rate_set_on: "2026-06-14",
        rate_set_time_zone: "America/New_York",
        week_of: "2026-06-08",
      });
    });
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
   * Where the alarm went.
   *
   * This used to be the one test allowed to read the clock: it failed the
   * first Monday the checked-in table no longer covered today. That table is
   * gone. The series a deployment compares against is fetched into the
   * database by `scripts/fetch-apor.ts`, which exits non-zero when what it
   * leaves behind does not cover the current week, and `/api/health` reports
   * the same fact for the deploy workflow to assert. The alarm now rings in
   * the environment where a borrower would have hit it, and this test asserts
   * the deterministic thing instead: the fixture table is the vendored survey,
   * through the same computation, ending the Monday after its last Thursday.
   */
  it("is the vendored PUBLISHED table, ending on its last Monday", () => {
    const rows = parseYieldTable(FFIEC_YIELD_TABLE_FIXED.body);
    expect(APOR_TABLE.weeks[APOR_TABLE.weeks.length - 1]!.weekOf).toBe(
      rows[rows.length - 1]!.weekOf,
    );
    expect(APOR_TABLE.source).toContain(FFIEC_YIELD_TABLE_FIXED.lastModified);
    // And the survey's last Thursday is four days before it: the two documents
    // are published together, and a fixture where they had drifted apart would
    // cross-check the wrong weeks.
    const survey = parseSurveyCsv(FFIEC_SURVEY.csv);
    expect(effectiveMonday(survey[survey.length - 1]!.surveyDate)).toBe(
      rows[rows.length - 1]!.weekOf,
    );
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
        paymentBasis: "principal_and_interest",
      },
    },
    product: {
      productCode: "P",
      termMonths: 360,
      amortization: "Fixed",
      noteRate: 6.25,
      // Noon: a midnight-UTC instant is Sunday the 14th in New York.
      rateQuotedAt: "2026-06-15T12:00:00.000Z",
      prepaymentPenalty: false,
      overlays: [],
    },
    borrowers: [],
    invitedBorrowers: [],
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

  it("compares bright lines in thousandths, so 8.28 against 6.78 is 1.5 and not 1.4999999999999991", () => {
    // A raw double difference misses a threshold it equals. The APR is three
    // places and the APOR two, so the spread is exact in thousandths.
    const at = runComplianceTests(refinance(), { apr: 8.28, apor: 6.78 }, 30, new DerivationLog());
    expect(at.hpmlSpread).toBe(1.5);
    expect(at.isHpml).toBe(true);
    const hoepa = runComplianceTests(
      refinance(),
      { apr: 13.28, apor: 6.78 },
      30,
      new DerivationLog(),
    );
    expect(hoepa.hpmlSpread).toBe(6.5);
    // "more than 6.5" — exactly 6.5 is not high-cost on the rate trigger.
    expect(hoepa.isHighCost === true && hoepa.pointsAndFeesRatio === null).toBe(false);
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

  /**
   * §1026.32(a)(1)(ii) tiers the fee trigger, and the flat 5% was a DENIAL.
   *
   * Below the indexed small-loan bound the rule is the LESSER of 8% of the
   * total loan amount and a flat dollar cap, and that pair is always above 5%
   * of the same total — so a flat 5% never under-flagged, it over-flagged. An
   * over-flag is not the safe side: one high-cost finding is a denial ahead of
   * every other branch in `determineOutcome`, and the borrower gets a
   * Regulation B notice naming a rule that does not fire on their loan.
   */
  describe("HOEPA's fee trigger is tiered", () => {
    const small = (loanAmount: number): LoanFile => {
      const base = refinance();
      return { ...base, loan: { ...base.loan!, loanAmount } };
    };

    it("does not fire on a small loan the flat 5% would have declined", () => {
      // $1,300 of points and fees on an $18,700 total loan amount. The flat 5%
      // allowed $935 and fired; the rule allows the lesser of 8% ($1,496) and
      // $1,380, so $1,300 is under it and this loan is not high-cost.
      const result = runComplianceTests(
        small(20_000),
        { apr: 7.2, apor: 6.1, pointsAndFeesAmount: 1_300, totalLoanAmount: 18_700 },
        30,
        new DerivationLog(),
      );
      expect(result.pointsAndFeesRatio).toBeGreaterThan(5);
      expect(result.hoepaTriggers?.pointsAndFees).toBe(false);
      expect(result.isHighCost).toBe(false);
    });

    it("still fires when the fees pass the dollar cap", () => {
      // This lender's own schedule on a $25,000 loan: $1,715 against $1,380.
      const priced = closingCosts(FEE_SCHEDULE, 25_000)!;
      const result = runComplianceTests(
        small(25_000),
        {
          apr: 7.2,
          apor: 6.1,
          pointsAndFeesAmount: priced.pointsAndFees,
          totalLoanAmount: round(25_000 - priced.prepaidFinanceCharges, 2),
        },
        30,
        new DerivationLog(),
      );
      expect(priced.pointsAndFees).toBe(1_715);
      expect(result.hoepaTriggers?.pointsAndFees).toBe(true);
      expect(result.isHighCost).toBe(true);
    });

    it("uses the 5% tier at the small-loan bound itself", () => {
      // The tier is chosen by the §1026.43(b)(5) loan amount — the note
      // principal — so a loan of exactly the bound is in the 5% tier whatever
      // the fees did to the total it is measured against.
      const log = new DerivationLog();
      runComplianceTests(
        small(27_592),
        { apr: 7.2, apor: 6.1, pointsAndFeesAmount: 1_200, totalLoanAmount: 26_000 },
        30,
        log,
      );
      const entry = log.all().find((d) => d.label === "HOEPA high-cost")!;
      expect(entry.inputs.fee_trigger_basis).toContain("§1026.32(a)(1)(ii)(A)");
      expect(entry.inputs.fee_trigger_limit_dollars).toBe(1_300);
    });
  });

  /**
   * The third trigger, §1026.32(a)(1)(iii), which was simply not asked.
   *
   * `isHighCost: false` was asserted on two of three questions — the same
   * asymmetry the two-trigger version of this file was written to end, one
   * layer down. And a boolean can only answer half of it: no penalty proves the
   * trigger false, a penalty proves nothing, because one inside 36 months and
   * under 2% of the amount prepaid is lawful and not high-cost.
   */
  describe("the prepayment penalty is the third trigger", () => {
    const withPenalty = (prepaymentPenalty: boolean): LoanFile => {
      const base = refinance();
      return { ...base, product: { ...base.product!, prepaymentPenalty } };
    };
    const clean = { apr: 7.2, apor: 6.1, pointsAndFeesAmount: 3_000, totalLoanAmount: 297_000 };

    it("settles on false when the product cannot charge one", () => {
      const result = runComplianceTests(withPenalty(false), clean, 30, new DerivationLog());
      expect(result.hoepaTriggers).toEqual({
        apr: false,
        pointsAndFees: false,
        prepaymentPenalty: false,
      });
      expect(result.isHighCost).toBe(false);
    });

    it("blocks on a product that can, naming the term and the cap", () => {
      const log = new DerivationLog();
      const result = runComplianceTests(withPenalty(true), clean, 30, log);
      expect(result.isHighCost).toBeNull();
      expect(result.hoepaTriggers?.prepaymentPenalty).toBeNull();
      const blocked = log.all().find((d) => d.label === "HOEPA high-cost test")?.blockedBy ?? [];
      expect(blocked.join(" ")).toContain("36 months after consummation");
      expect(blocked.join(" ")).toContain("2% of the amount prepaid");
    });

    it("does not stop another trigger from settling it true", () => {
      // One trigger is enough, and an unknown third does not un-fire a known
      // first: a rate 7 points over APOR is high-cost whatever the penalty is.
      const result = runComplianceTests(
        withPenalty(true),
        { ...clean, apr: 13.2 },
        30,
        new DerivationLog(),
      );
      expect(result.isHighCost).toBe(true);
      expect(result.hoepaTriggers?.apr).toBe(true);
    });
  });

  describe("what the existing loan does and does not know", () => {
    const withExisting = (over: Partial<NonNullable<LoanFile["loan"]>["existingLoan"]>): LoanFile => {
      const base = refinance();
      return {
        ...base,
        loan: { ...base.loan!, existingLoan: { ...base.loan!.existingLoan!, ...over } },
      };
    };

    it("publishes no rate delta when nothing on file carries the old rate", () => {
      // A credit bureau's mortgage tradeline has no rate. The pull wrote 0, so
      // this published (0 - 6.25) = -6.25 — a number with no derivation behind
      // it, on a decision where that is the one thing a number may not be.
      const result = runComplianceTests(
        withExisting({ rate: null }),
        { closingCostTotal: 6_000 },
        30,
        new DerivationLog(),
      );
      expect(result.netTangibleBenefit!.rateDelta).toBeNull();
      // The recoup is a payment test and does not need the rate, so it still runs.
      expect(result.netTangibleBenefit!.recoupMonths).toBeGreaterThan(0);
    });

    it("blocks the recoup when the old payment may carry escrow", () => {
      const log = new DerivationLog();
      const result = runComplianceTests(
        withExisting({ paymentBasis: "scheduled_payment" }),
        { closingCostTotal: 6_000 },
        30,
        log,
      );
      expect(result.netTangibleBenefit).toBeUndefined();
      expect(log.all().find((d) => d.requirementId === "APP-019")?.blockedBy?.[0]).toContain(
        "may include escrow",
      );
    });

    it("refers a refinance whose existing loan is not on the file at all", () => {
      // This used to run no test and record nothing, so a file missing the very
      // thing APP-019 measures could still decide. Silence is not a pass.
      const base = refinance();
      const { existingLoan: _dropped, ...loan } = base.loan!;
      const log = new DerivationLog();
      const result = runComplianceTests(
        { ...base, loan },
        { closingCostTotal: 6_000 },
        30,
        log,
      );
      expect(result.netTangibleBenefit).toBeUndefined();
      expect(log.all().find((d) => d.requirementId === "APP-019")?.blockedBy).toEqual([
        "the existing loan (APP-018)",
      ]);
    });
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
