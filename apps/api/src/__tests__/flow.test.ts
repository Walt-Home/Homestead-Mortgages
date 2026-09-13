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
import { fixtureRegistry, PERSONAS } from "@hm/connectors";
import type { LoanFile } from "@hm/shared";
import { assessAll, outstanding, progress } from "@hm/requirements";
import { underwrite } from "@hm/underwriting";
import { REFERENCE, afterIdentity, consent, token } from "./support/in-memory-file.js";

const registry = fixtureRegistry({ latencyMs: 0, persona: "clean_w2", referenceDate: REFERENCE });

/** "Rent payment history identified", the one requirement a housing basis gates. */
const RENTER_REQUIREMENT = "CRD-018";

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

  /**
   * A housing basis nobody stated is not a renter.
   *
   * `borrowers.current_housing` was NOT NULL with a default of "rent", so
   * `renter_limited_mortgage_history` — which tests only `=== "own"` — answered
   * "yes, a renter" about every borrower in the product, on a question no
   * screen asked. The column is nullable now, and the condition has to answer
   * the third value rather than fall through to the renter branch.
   */
  function withNoStatedHousing(file: LoanFile): LoanFile {
    return {
      ...file,
      borrowers: file.borrowers.map((b) => ({
        ...b,
        currentHousing: null,
        monthlyRent: undefined,
      })),
    };
  }

  /**
   * With the credit report in hand, so the condition has everything BUT the
   * basis. Before the pull it answers null for want of a tradeline history and
   * the housing basis decides nothing, which would make the pair below agree
   * for the wrong reason.
   */
  async function afterCredit(): Promise<LoanFile> {
    const file = afterIdentity();
    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    return { ...file, credit: credit.data };
  }

  it("cannot say whether an unasked borrower rents", async () => {
    const file = await afterCredit();
    const stated = assessAll(file).find((a) => a.requirement.id === RENTER_REQUIREMENT);
    const unasked = assessAll(withNoStatedHousing(file)).find(
      (a) => a.requirement.id === RENTER_REQUIREMENT,
    );

    expect(stated!.applies).not.toBeNull();
    expect(unasked!.applies).toBeNull();
  });

  it("counts an unasked borrower as undetermined rather than decided", async () => {
    // Rule 2, in the one number a borrower reads: applicability is three-valued
    // and `progress()` counts only what definitely applies. An unknown basis
    // moves the requirement into "we might still ask", which is the honest
    // place for it, rather than leaving it answered from a default.
    const file = await afterCredit();
    const stated = progress(file);
    const unasked = progress(withNoStatedHousing(file));

    expect(unasked.undetermined).toBe(stated.undetermined + 1);
  });

  it("still never lets satisfied progress go backwards with no basis stated", async () => {
    // The regression the counts test guards, walked again on a file whose
    // housing basis is unknown for the whole walk. A third value that made the
    // count move backwards would be the 23 → 21 failure in a new costume.
    let file = withNoStatedHousing(afterIdentity());
    const counts = [progress(file).satisfied];

    const credit = await registry.credit.pullTriMerge(file, token("credit_report"));
    file = { ...file, credit: credit.data };
    counts.push(progress(file).satisfied);

    const payroll = await registry.payroll.fetchPayroll(file, token("payroll_income"), "s");
    file = {
      ...file,
      payroll: payroll.data,
      incomeSources: payroll.data.incomeSources,
      employment: payroll.data.employments,
    };
    counts.push(progress(file).satisfied);

    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
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
    // Nor wear a decided word at all. `referred` is the outcome's own way of
    // saying the recommendation could not be turned into a decision.
    expect(decision.outcome).toBe("referred");
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
