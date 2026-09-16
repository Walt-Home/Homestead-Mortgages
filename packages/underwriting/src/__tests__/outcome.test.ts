/**
 * The word the engine reaches, and the two it must never confuse.
 *
 * "We could not compute this" and "we computed it and you passed" used to
 * collapse into `approved_with_conditions`, because `determineOutcome` fell
 * through to it for both `refer` and `refer_with_caution`. Every case below is
 * one of the four ways out of that function, pinned so the fall-through cannot
 * quietly widen again.
 *
 * It runs the real engine over the real fixture borrower — `connectedThrough`
 * is the same walk the four screens perform — rather than a hand-built
 * `Decision`, because the interesting claims here are about which inputs
 * blocked, and a fixture that asserts its own blocking proves nothing. That
 * walk is why this package's tests reach for `@hm/connectors`: the fixture
 * adapters are the only honest source of a credit report and an asset report,
 * and `determineOutcome` has to be tested in the workspace that holds it.
 */

import { describe, expect, it } from "vitest";
import { APOR_TABLE } from "../apor-yield.js";
import type { LoanFile } from "@hm/shared";
import { underwrite } from "../aus.js";
import { REFERENCE, connectedThrough } from "./support/in-memory-file.js";

const now = REFERENCE.toISOString();

/** Enough market data that all four compliance tests compute. */
const MARKET = { apr: 6.44, apor: 6.1, pointsAndFeesAmount: 9_800, totalLoanAmount: 328_750 };
const FEES = { estimatedFees: 9_800, estimatedPrepaids: 4_200 };

interface Options {
  market?: Record<string, number>;
  estimatedFees?: number;
  estimatedPrepaids?: number;
}

const decide = (file: LoanFile, options: Options = {}) =>
  underwrite(file, { aporTable: APOR_TABLE, casefileId: "outcome-test", now, ...options });

const fullyConnected = () => connectedThrough("clean_w2", "irs");

/** The same borrower against a different loan. Screen 1 is the only difference. */
function borrowing(file: LoanFile, loanAmount: number): LoanFile {
  return {
    ...file,
    loan: { ...file.loan!, loanAmount, downPayment: file.property!.valueOrPrice - loanAmount },
  };
}

/**
 * The same borrower on a loan the engine will not state an APR for.
 *
 * 92.3% of value, which is mortgage insurance, which is a finance charge this
 * engine holds only an estimated rate card for — so `apr.ts` refuses rather
 * than states one, and UW-006 and UW-008 block on it. It is the shape of file
 * that still refers now that the fee schedule and the average prime offer table
 * are derived, and it is a real loan rather than a fixture with a field
 * removed: 92% LTV is inside every eligibility limit this engine checks.
 */
const insured = (file: LoanFile) => borrowing(file, 600_000);

describe("a refer is referred", () => {
  it("gives an input it could not compute its own word", async () => {
    const decision = decide(insured(await fullyConnected()));

    // No APR, so the QM and HPML tests block and HOEPA cannot answer on the
    // fee trigger alone.
    const blocked = decision.derivations.filter((d) => d.blockedBy?.length);
    expect(blocked.map((d) => d.label)).toContain("Annual percentage rate");
    expect(decision.compliance.qmStatus).toBeNull();
    expect(decision.compliance.isHpml).toBeNull();
    expect(decision.aus?.recommendation).toBe("refer");
    expect(decision.outcome).toBe("referred");
  });

  it("still lists the conditions the findings it DID compute produced", async () => {
    // A referral is not a reason to stop reporting work. The DTI finding on
    // this borrower computed from real inputs and is still owed to them.
    const decision = decide(insured(await fullyConnected()));
    expect(decision.aus!.findings.length).toBeGreaterThan(0);
    expect(decision.conditions).toHaveLength(decision.aus!.findings.length);
  });

  it("carries no adverse action reasons", async () => {
    // Nothing was decided, so nobody is owed a notice. An empty list here
    // would be a decline with no reasons; a populated one would be a decline
    // nobody made.
    const decision = decide(insured(await fullyConnected()));
    expect(decision.adverseActionReasons).toBeUndefined();
  });

  it("is not what a computed finding produces", async () => {
    // The same borrower with the market data supplied: nothing blocks, the DTI
    // finding is real, and the word is the one that has always meant
    // "findings we did compute".
    const decision = decide(borrowing(await fullyConnected(), 380_000), {
      market: MARKET,
      ...FEES,
    });

    expect(decision.derivations.some((d) => d.blockedBy?.length)).toBe(false);
    expect(decision.aus?.recommendation).toBe("refer_with_caution");
    expect(decision.outcome).toBe("approved_with_conditions");
  });

  it("records the manual-underwrite derivation for refer_with_caution too", async () => {
    // UW-011's own condition counts refer_with_caution, so a requirement that
    // applies had no derivation behind it — a figure on the decision screen
    // with nothing to show for it.
    const decision = decide(borrowing(await fullyConnected(), 380_000), {
      market: MARKET,
      ...FEES,
    });
    expect(decision.derivations.map((d) => d.requirementId)).toContain("UW-011");
  });
});

describe("what still outranks a referral", () => {
  it("calls an ineligible loan a counteroffer, with its reasons", async () => {
    // 97.9% LTV on a primary purchase, with the compliance tests blocked. An
    // eligibility finding is computed from real inputs, so it beats an input
    // nobody could compute — this is the one decided word a real-flow file can
    // reach on staging today.
    const decision = decide(borrowing(await fullyConnected(), 636_350));

    expect(decision.ratios.ltv).toBeCloseTo(97.9, 1);
    expect(decision.aus?.recommendation).toBe("approve_ineligible");
    expect(decision.outcome).toBe("counteroffer");
    expect(decision.outcome).not.toBe("referred");
    expect(decision.outcome).not.toBe("approved_with_conditions");
    // UW-016 is satisfied by a non-empty array, and it applies on a
    // counteroffer as much as on a denial.
    expect(decision.adverseActionReasons?.length).toBeGreaterThan(0);
  });

  it("denies a loan it has computed to be high-cost, and names the trigger", async () => {
    // `isHighCost` is true only when HOEPA actually ran. A failure we found
    // beats an input we could not reach.
    const decision = decide(await fullyConnected(), {
      market: { apr: 13.6, apor: 6.55, pointsAndFeesAmount: 5_200, totalLoanAmount: 328_750 },
      ...FEES,
    });

    expect(decision.compliance.isHighCost).toBe(true);
    expect(decision.outcome).toBe("denied");
    expect(decision.adverseActionReasons).toContain("HOEPA high-cost: the rate is above the limit");
  });

  it("reaches clear to close when nothing blocked and nothing was found", async () => {
    const decision = decide(borrowing(await fullyConnected(), 340_000), {
      market: MARKET,
      ...FEES,
    });

    expect(decision.aus?.recommendation).toBe("approve_eligible");
    expect(decision.aus?.findings).toHaveLength(0);
    expect(decision.outcome).toBe("clear_to_close");
  });
});

describe("the invariant", () => {
  /**
   * The generalized form of the bug: a decision built on an input nobody could
   * compute must never wear an approval word. Stated over the derivations
   * rather than over one fixture, so a new blocked test anywhere in the engine
   * is covered the day it is added.
   */
  const APPROVALS = ["approved_with_conditions", "clear_to_close"];

  it("never approves on a blocked input", async () => {
    const file = await fullyConnected();
    const cases = [
      decide(file),
      decide(insured(file)),
      decide(borrowing(file, 636_350)),
      decide(file, {
        market: { apr: 13.6, apor: 6.55, pointsAndFeesAmount: 5_200, totalLoanAmount: 328_750 },
        ...FEES,
      }),
      decide(borrowing(file, 380_000), { market: MARKET, ...FEES }),
      decide(borrowing(file, 340_000), { market: MARKET, ...FEES }),
    ];

    for (const decision of cases) {
      if (!decision.derivations.some((d) => d.blockedBy?.length)) continue;
      expect(APPROVALS, decision.outcome).not.toContain(decision.outcome);
    }
  });

  it("has a case that would fail it", async () => {
    // A test whose precondition is never met passes for the wrong reason.
    const blocked = decide(insured(await fullyConnected()));
    expect(blocked.derivations.some((d) => d.blockedBy?.length)).toBe(true);
  });
});
