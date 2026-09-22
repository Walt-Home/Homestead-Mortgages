/**
 * The port, held to his numbers.
 *
 * His 20.1 spec carries worked examples to the cent and acceptance tests
 * that name the figures; his engine's answers for the sample book on 21
 * September 2026 are recorded in the connectors' servicing fixture. A port
 * that reproduces both is the same arithmetic; one that does not is a
 * different engine wearing his vocabulary, which is the thing this file
 * exists to refuse.
 */

import { describe, expect, it } from "vitest";
import { plainDate } from "@hm/kernel/calendar";
import {
  DEFAULT_PROGRAM,
  borrowerInterestRule,
  buildCandidate,
  computeBenefit,
  defaultSchedule,
  fireRule,
  levelPaymentPct,
  monthsBetween,
  npvOfDelta,
  offerFrequencyCapGate,
  payoffEstimate,
  perDiem365,
  prepaidInterest,
  rateDeltaBps,
  resolicitCooldownGate,
  reviewLoan,
  scheduledUpb,
  watchRatePct,
  type UniverseLoan,
} from "../engine.js";
import { reasonsInWords } from "../words.js";

const d = plainDate;

/** His worked example 1: $565,000 at 7.000 %, twenty-four payments in, on the run of Thu Oct 1, 2026. */
const EXAMPLE_ONE: UniverseLoan = {
  loan_id: "example-1",
  status: "active",
  product_code: "FRM30",
  amortization: "fixed",
  note_date: d("2024-09-18"),
  first_payment_date: d("2024-11-01"),
  consummation_date: d("2024-09-18"),
  original_upb_cents: 56_500_000n,
  original_term_months: 360,
  note_rate_pct: "7.000",
  pi_cents: 375_896n,
  payments_made: 24,
  upb_cents: 55_310_641n,
  next_due_date: d("2026-11-01"),
  remaining_term_months: 336,
  escrowed: true,
  escrow_monthly_cents: 150_000n,
  net_escrow_deposit_estimate_cents: 300_000n,
  mi_status: "none",
  mi_monthly_cents: 0n,
  occupancy: "primary",
  property_type: "sfr",
  units: 1,
  property_state: "AZ",
  value_estimate: {
    source: "partner_fmv",
    value_cents: 80_000_000n,
    as_of: d("2026-08-31"),
    confidence: "medium",
  },
  representative_score: 748,
  regx_days_delinquent: 0,
  bankruptcy_active: false,
  foreclosure_referred: false,
  lossmit_plan_active: false,
  deceased_or_sii_pending: false,
  transfer_out_pending: false,
  refi_do_not_solicit: false,
  arm_first_adjustment_date: null,
};

describe("the arithmetic, against his worked example 1", () => {
  it("levels the payment, schedules the balance and prices the per diem to the cent", () => {
    expect(levelPaymentPct(56_500_000n, "7.000", 360)).toBe(375_896n);
    expect(scheduledUpb(56_500_000n, "7.000", 360, 24)).toBe(55_310_641n);
    expect(perDiem365(55_310_641n, "7.000")).toBe(10_608n);
  });

  it("estimates the payoff through the disbursement date and the prepaid interest through month end", () => {
    const payoff = payoffEstimate(EXAMPLE_ONE, d("2026-11-12"));
    expect(payoff).toMatchObject({ days: 11, per_diem_cents: 10_608n, payoff_cents: 55_427_329n });
    const prepaid = prepaidInterest(56_000_000n, "6.125", d("2026-11-12"));
    expect(prepaid).toMatchObject({
      days: 19,
      per_diem_cents: 9_397n,
      prepaid_interest_cents: 178_543n,
    });
  });

  it("is his 20.1-T11: $560,000 at 6.125 % is $3,402.62, and $3,402.63 does not reproduce", () => {
    expect(levelPaymentPct(56_000_000n, "6.125", 360)).toBe(340_262n);
    expect(levelPaymentPct(56_000_000n, "6.125", 360)).not.toBe(340_263n);
  });

  it("discounts the delta over the holding period at the new rate, and measures the rate move in basis points", () => {
    expect(npvOfDelta(35_634n, "6.125", 84)).toBe(2_429_278n);
    expect(rateDeltaBps("7.000", "6.125")).toBe(87.5);
    expect(monthsBetween(d("2023-02-06"), d("2026-11-06"))).toBe(45);
  });

  it("builds his candidate and his benefit: 20.1-T1 to the cent", () => {
    const asOf = d("2026-10-01");
    const schedule = defaultSchedule(asOf);
    expect(schedule).toEqual({
      consummation_date: "2026-11-06",
      disbursement_date: "2026-11-12",
      first_payment_date: "2027-01-01",
    });
    const { candidate } = buildCandidate(EXAMPLE_ONE, { as_of: asOf });
    expect(candidate.loan_amount_cents).toBe(56_000_000n);
    expect(candidate.rounded_to_thousand).toBe(true);
    const m = computeBenefit(
      EXAMPLE_ONE,
      candidate,
      { note_rate_pct: "6.125", source: "test" },
      DEFAULT_PROGRAM,
    );
    expect(m.candidate_pi_cents).toBe(340_262n);
    expect(m.rate_delta_bps).toBe(87.5);
    expect(m.pi_delta_cents).toBe(35_634n);
    expect(m.npv_cents).toBe(2_429_278n);
    expect(m.lifetime_interest_delta_cents).toBe(-4_496_095n);
    const review = reviewLoan(EXAMPLE_ONE, {
      as_of: asOf,
      rate: { note_rate_pct: "6.125", source: "test" },
    });
    expect(review.verdict).toBe("candidate");
    expect(review.reasons).toEqual([
      "rate_delta",
      "npv_positive",
      "seven_year_delta_positive",
      "prescreen",
      "state_rule",
    ]);
    expect(review.offer).toMatchObject({
      new_rate_pct: "6.125",
      new_pi_cents: "340262",
      pi_delta_cents: "35634",
    });
  });
});

describe("the rules around the arithmetic", () => {
  it("20.1-T6: the Massachusetts borrower's-interest rule passes on a lower payment and rate, and blocks with neither", () => {
    const base = {
      property_state: "MA",
      existing_consummation_date: d("2023-02-06"),
      candidate_consummation_date: d("2026-11-06"),
      rules: { MA: { statute: "M.G.L. c.183 §28C", window_months: 60 } },
      borrower_paid_costs_cents: 0n,
    };
    const pass = borrowerInterestRule({ ...base, pi_delta_cents: 35_634n, rate_delta_bps: 87.5 });
    expect(pass).toMatchObject({
      applies: true,
      months_since_consummation: 45,
      pass: true,
      factors: ["payment_reduction", "rate_reduction"],
    });
    const block = borrowerInterestRule({ ...base, pi_delta_cents: 0n, rate_delta_bps: 0 });
    expect(block).toMatchObject({ applies: true, pass: false, factors: [] });
    // Outside the window, or outside Massachusetts, it does not apply.
    expect(
      borrowerInterestRule({ ...base, property_state: "AZ", pi_delta_cents: 0n, rate_delta_bps: 0 })
        .applies,
    ).toBe(false);
  });

  it("20.1-T7: the cooldown after a decline closes the proactive path for ninety days", () => {
    const g = resolicitCooldownGate({ declined_on: d("2026-10-09"), as_of: d("2026-12-15") });
    expect(g).toMatchObject({ open: false, opens_on: "2027-01-07" });
    expect(
      resolicitCooldownGate({ declined_on: d("2026-10-09"), as_of: d("2027-01-07") }).open,
    ).toBe(true);
    expect(resolicitCooldownGate({ declined_on: null, as_of: d("2026-12-15") }).open).toBe(true);
  });

  it("caps offers at two per rolling year", () => {
    const g = offerFrequencyCapGate({
      offered_at: [d("2026-03-01"), d("2026-06-01")],
      as_of: d("2026-10-01"),
    });
    expect(g).toMatchObject({ open: false, opens_on: "2027-03-01" });
    expect(
      offerFrequencyCapGate({ offered_at: [d("2026-03-01")], as_of: d("2026-10-01") }).open,
    ).toBe(true);
  });

  it("20.1-T8: a thirty-year reset that costs more in interest fires only when the same-term option also saves", () => {
    const m = {
      rate_delta_bps: 50,
      npv_cents: 100_000n,
      seven_year_total_cost_delta_cents: 50_000n,
      lifetime_interest_delta_cents: 1_000_000n,
      same_term_npv_cents: 80_000n,
    };
    const gates = { prescreen_ok: true, state_rule_ok: true, suppression_reasons: [] };
    expect(fireRule(m, DEFAULT_PROGRAM, gates)).toMatchObject({
      fire: true,
      present_same_term_first: true,
    });
    expect(fireRule({ ...m, same_term_npv_cents: -1n }, DEFAULT_PROGRAM, gates)).toMatchObject({
      fire: false,
      reasons: ["lifetime_interest_delta > 0 and same_term_npv ≤ 0"],
    });
  });

  it("33.2-T3: the watch rate is the current rate minus 25 bps, floored to the eighth", () => {
    expect(watchRatePct("5.875")).toBe("5.625");
    expect(watchRatePct("7.250")).toBe("7.000");
    expect(watchRatePct("6.300")).toBe("6.000");
  });

  it("says a fire-rule miss in his words, without the figure", () => {
    expect(
      reasonsInWords([
        "rate_delta_bps -50 < 25",
        "npv_cents -417560 ≤ 0",
        "delinquent",
        "bankruptcy_active",
      ]),
    ).toEqual([
      "the rate reduction is under the program's floor",
      "the savings over the holding period are not positive",
      "the loan is not current",
      "an active bankruptcy",
    ]);
  });
});

describe("the review's state machine", () => {
  it("excludes what his universe excludes, before any arithmetic", () => {
    const asOf = d("2026-10-01");
    const rate = { note_rate_pct: "6.125", source: "test" };
    expect(
      reviewLoan({ ...EXAMPLE_ONE, bankruptcy_active: true }, { as_of: asOf, rate }),
    ).toMatchObject({
      verdict: "excluded",
      reasons: ["bankruptcy_active"],
      candidate: null,
    });
    expect(
      reviewLoan({ ...EXAMPLE_ONE, regx_days_delinquent: 30 }, { as_of: asOf, rate }).reasons,
    ).toEqual(["delinquent"]);
    expect(
      reviewLoan({ ...EXAMPLE_ONE, status: "not_active" }, { as_of: asOf, rate }).reasons,
    ).toEqual(["not_active"]);
  });

  it("is not now behind a gate, and watching when the numbers are not there", () => {
    const asOf = d("2026-10-01");
    const rate = { note_rate_pct: "6.125", source: "test" };
    const gated = reviewLoan(EXAMPLE_ONE, {
      as_of: asOf,
      rate,
      gate_facts: { declined_on: d("2026-09-01"), offered_at: [] },
    });
    expect(gated.verdict).toBe("not_now");
    expect(gated.reasons).toContain("cooldown");
    const flat = reviewLoan(EXAMPLE_ONE, {
      as_of: asOf,
      rate: { note_rate_pct: "7.000", source: "test" },
    });
    expect(flat.verdict).toBe("watching");
    expect(flat.reasons[0]).toBe("rate_delta_bps 0 < 25");
    expect(flat.facts.watch_rate_pct).toBe("6.750");
  });

  it("is watching with not_priceable and not_priced when the port has no rate, as his engine says it", () => {
    const r = reviewLoan(EXAMPLE_ONE, { as_of: d("2026-10-01"), rate: null });
    expect(r.verdict).toBe("watching");
    expect(r.reasons).toEqual(["not_priceable", "not_priced"]);
    expect(r.metrics).toBeNull();
  });

  it("is not now on a value older than two years, whatever the numbers say", () => {
    const stale = {
      ...EXAMPLE_ONE,
      value_estimate: {
        ...EXAMPLE_ONE.value_estimate,
        as_of: d("2024-01-01"),
        confidence: "low" as const,
      },
    };
    const r = reviewLoan(stale, {
      as_of: d("2026-10-01"),
      rate: { note_rate_pct: "6.125", source: "test" },
    });
    expect(r.verdict).toBe("not_now");
    expect(r.reasons).toContain("value_stale");
  });
});
