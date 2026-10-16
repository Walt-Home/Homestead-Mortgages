/**
 * The grader, held to the spec and to a cent.
 *
 * The phase gate for this environment: the grader agrees with the
 * servicing spec's own cases — worked example 1 to the cent, and the
 * verdict the spec states for each rule around it — and an answer one cent
 * off any figure is not a pass.
 */

import { describe, expect, it } from "vitest";
import {
  OFFER_FIELDS,
  SPEC_CASES,
  expectedAnswer,
  expectedReview,
  gradeAnswer,
  parseSubmission,
  reasonCode,
  specTasks,
  type RefiAnswer,
} from "../refi/index.js";

const [workedExample] = specTasks();
if (!workedExample) throw new Error("no spec tasks");

describe("the grader agrees with the spec", () => {
  it("gives every spec case the verdict the spec states", () => {
    for (const [i, task] of specTasks().entries()) {
      expect(expectedReview(task).verdict, SPEC_CASES[i]?.name).toBe(SPEC_CASES[i]?.verdict);
    }
  });

  it("is 20.1-T1 to the cent on worked example 1", () => {
    const want = expectedAnswer(expectedReview(workedExample));
    expect(want.verdict).toBe("candidate");
    expect(want.offer).toMatchObject({
      loan_amount_cents: "56000000",
      new_pi_cents: "340262",
      pi_delta_cents: "35634",
      rate_delta_bps: "87.5",
      npv_cents: "2429278",
      present_same_term_first: false,
    });
    const o = want.offer;
    if (!o) throw new Error("no offer");
    expect(BigInt(o.lifetime_interest_new_cents) - BigInt(o.lifetime_interest_existing_cents)).toBe(
      -4_496_095n,
    );
  });

  it("passes the spec's figures, and nothing else", () => {
    const want = expectedAnswer(expectedReview(workedExample));
    expect(gradeAnswer(workedExample, want)).toMatchObject({ pass: true, score: 1 });
  });

  it("fails an answer one cent off any figure, and says which", () => {
    const want = expectedAnswer(expectedReview(workedExample));
    const offer = want.offer;
    if (!offer) throw new Error("no offer");
    for (const f of OFFER_FIELDS) {
      const off: RefiAnswer = { ...want, offer: { ...offer, [f]: String(BigInt(offer[f]) + 1n) } };
      const g = gradeAnswer(workedExample, off);
      expect(g.pass, f).toBe(false);
      expect(g.fields.filter((x) => !x.ok).map((x) => x.field)).toEqual([`offer.${f}`]);
    }
  });

  it("fails a wrong verdict, a missing offer and a missing answer", () => {
    const want = expectedAnswer(expectedReview(workedExample));
    expect(gradeAnswer(workedExample, { ...want, verdict: "watching" }).pass).toBe(false);
    expect(gradeAnswer(workedExample, { ...want, offer: null }).pass).toBe(false);
    expect(gradeAnswer(workedExample, null)).toMatchObject({ pass: false, score: 0 });
  });

  it("reads reasons as a set of codes, not as the engine's sentences", () => {
    expect(reasonCode("rate_delta_bps -62.5 < 25")).toBe("rate_delta_below_floor");
    expect(reasonCode("npv_cents -417560 ≤ 0")).toBe("npv_not_positive");
    expect(reasonCode("seven_year_total_cost_delta ≤ 0")).toBe("seven_year_not_lower");
    expect(reasonCode("lifetime_interest_delta > 0 and same_term_npv ≤ 0")).toBe(
      "reset_costs_more",
    );
    const want = expectedAnswer(expectedReview(workedExample));
    expect(gradeAnswer(workedExample, { ...want, reasons: [...want.reasons].reverse() }).pass).toBe(
      true,
    );
  });
});

describe("a submission is read strictly", () => {
  const offer = expectedAnswer(expectedReview(workedExample)).offer;

  it("takes integer cents as strings or numbers, and a rate delta as a number", () => {
    const parsed = parseSubmission({
      verdict: "candidate",
      reasons: [],
      offer: { ...offer, npv_cents: 2429278, rate_delta_bps: 87.5 },
      watch_rate_pct: null,
    });
    expect(parsed.ok && parsed.answer.offer?.npv_cents).toBe("2429278");
  });

  it("refuses dollars, a verdict outside the four, and an unformatted watch rate", () => {
    expect(
      parseSubmission({
        verdict: "candidate",
        reasons: [],
        offer: { ...offer, npv_cents: "24292.78" },
      }).ok,
    ).toBe(false);
    expect(parseSubmission({ verdict: "approve", reasons: [], offer: null }).ok).toBe(false);
    expect(
      parseSubmission({ verdict: "watching", reasons: [], offer: null, watch_rate_pct: "6.75" }).ok,
    ).toBe(false);
  });
});
