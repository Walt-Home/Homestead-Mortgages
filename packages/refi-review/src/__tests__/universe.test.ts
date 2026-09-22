/**
 * The sample book through the port, against the verdicts his engine gave it.
 *
 * On 21 September 2026 his platform reviewed the same twelve loans off the
 * same tape at a candidate rate of 6.375 % and wrote twelve verdicts, which
 * the connectors' servicing fixture recorded code for code. Fed the same
 * facts, the same day and the same rate, this port has to say the same
 * thing — down to the figure inside a fire-rule miss, because that figure
 * is the whole arithmetic chain in one number.
 *
 * Five of his twelve were `not_priceable`: his pricing had no cost schedule
 * for their states. Ours prices through a port with no such schedule, so
 * those five get a priced verdict here, and the test says which they are.
 */

import { describe, expect, it } from "vitest";
import { NORTHLIGHT, profileById, readBook, sampleBook } from "@hm/partner-book";
import { plainDate } from "@hm/kernel/calendar";
import { reviewLoan, type Review } from "../engine.js";
import { universeLoanOf, type ObservedLoan, type Observation } from "../universe.js";

const AS_OF = plainDate("2026-09-21");
/**
 * The candidate rate his 20.4 solve chose per loan off the FAKE sheet — the
 * lowest rate whose premium covers the costs and the loan's own LLPA. Loan 3
 * (FICO 781, LTV 0.71) cleared at 6.125 %; the others at 6.375 %. The port
 * takes the rate from a port, so the test hands it what his solve found.
 */
const RATE_FOR: Record<string, string> = { "NL-100003": "6.125" };
const rateFor = (n: string) => ({
  note_rate_pct: RATE_FOR[n] ?? "6.375",
  source: "his FAKE sheet",
});

/** What his engine wrote for each loan that day, from the connectors' fixture. */
const HIS: Record<string, { verdict: Review["verdict"]; reasons: string[] }> = {
  "NL-100001": {
    verdict: "candidate",
    reasons: ["rate_delta", "npv_positive", "seven_year_delta_positive", "prescreen", "state_rule"],
  },
  "NL-100002": { verdict: "watching", reasons: ["seven_year_total_cost_delta ≤ 0"] },
  "NL-100003": {
    verdict: "watching",
    reasons: [
      "rate_delta_bps -62.5 < 25",
      "npv_cents -417560 ≤ 0",
      "seven_year_total_cost_delta ≤ 0",
      "lifetime_interest_delta > 0 and same_term_npv ≤ 0",
    ],
  },
  "NL-100008": { verdict: "excluded", reasons: ["delinquent"] },
  "NL-100009": {
    verdict: "watching",
    reasons: [
      "rate_delta_bps -50 < 25",
      "seven_year_total_cost_delta ≤ 0",
      "lifetime_interest_delta > 0 and same_term_npv ≤ 0",
    ],
  },
  "NL-100010": { verdict: "excluded", reasons: ["foreclosure_referred"] },
  "NL-100011": { verdict: "excluded", reasons: ["bankruptcy_active"] },
};
/** The five his pricing refused; ours prices them. */
const HIS_UNPRICED = ["NL-100004", "NL-100005", "NL-100006", "NL-100007", "NL-100012"];

function reviews(): Map<string, Review> {
  const b = sampleBook();
  const book = readBook(
    profileById("m3-v1"),
    NORTHLIGHT.slug,
    "2026-09-01",
    { filename: "northlight.xlsx", bytes: b.tape },
    { filename: "supplement.csv", bytes: new TextEncoder().encode(b.supplement) },
  );
  const out = new Map<string, Review>();
  for (const { record, facts } of book.records) {
    const loan: ObservedLoan = {
      loan_id: record.sourceLoanKey,
      state: "monitoring_only",
      rate_type: record.terms.rateType,
      note_rate_bps: Math.round(Number(record.terms.noteRatePct) * 100),
      term_months: record.terms.termMonths,
      original_principal_cents: record.terms.originalPrincipalCents,
      originated_on: record.terms.originatedOn,
      first_payment_on: record.terms.firstPaymentOn,
      maturity_on: record.terms.maturityOn,
      occupancy: record.terms.occupancy,
      property_state: record.property.state,
    };
    const obs: Observation = {
      as_of: record.servicing.asOf,
      status: record.servicing.status,
      principal_balance_cents: record.servicing.principalBalanceCents,
      escrow_balance_cents: record.servicing.escrowBalanceCents,
      scheduled_payment_cents: record.servicing.scheduledPaymentCents,
      current_rate_pct: record.servicing.currentRatePct,
      next_payment_due_on: record.servicing.nextPaymentDueOn,
      delinquency_days: record.servicing.delinquencyDays,
      facts,
    };
    const u = universeLoanOf(loan, obs, AS_OF);
    if ("skipped" in u) throw new Error(`${record.sourceLoanKey}: ${u.skipped}`);
    out.set(
      record.sourceLoanKey,
      reviewLoan(u.row, { as_of: AS_OF, rate: rateFor(record.sourceLoanKey) }),
    );
  }
  return out;
}

describe("the sample book, reviewed here", () => {
  const all = reviews();

  it("reads loan 1 off the tape the way his rule 1 does", () => {
    const r = all.get("NL-100001")!;
    expect(r.facts).toMatchObject({
      note_rate_pct: "7.250",
      upb_cents: "44136613",
      pi_cents: "306979",
      value_cents: "60500000",
      value_source: "partner_fmv",
      value_confidence: "medium",
      ltv: "0.7295",
      remaining_term_months: 337,
      days_delinquent: 0,
    });
  });

  it("gives loan 1 his candidate, figure for figure", () => {
    const r = all.get("NL-100001")!;
    expect(r.verdict).toBe("candidate");
    expect(r.candidate?.loan_amount_cents).toBe(44_800_000n);
    expect(r.offer).toMatchObject({
      current_rate_pct: "7.250",
      new_rate_pct: "6.375",
      current_pi_cents: "306979",
      new_pi_cents: "279494",
      pi_delta_cents: "27485",
      rate_delta_bps: 87.5,
      remaining_term_months: 337,
      new_term_months: 360,
    });
  });

  it("says what his engine said for every loan it priced or excluded, reason for reason", () => {
    for (const [n, his] of Object.entries(HIS)) {
      const r = all.get(n)!;
      expect(`${n}: ${r.verdict}`).toBe(`${n}: ${his.verdict}`);
      expect(`${n}: ${r.reasons.join(" | ")}`).toBe(`${n}: ${his.reasons.join(" | ")}`);
    }
    expect(all.get("NL-100009")?.facts.watch_rate_pct).toBe("5.625");
  });

  it("prices the five his pricing refused, and says so", () => {
    for (const n of HIS_UNPRICED) {
      const r = all.get(n)!;
      expect(r.metrics, n).not.toBeNull();
      expect(["candidate", "watching"], n).toContain(r.verdict);
      expect(r.reasons, n).not.toContain("not_priceable");
    }
  });

  it("skips a row the tape cannot describe, with the reason", () => {
    const loan: ObservedLoan = {
      loan_id: "x",
      state: "monitoring_only",
      rate_type: "fixed",
      note_rate_bps: 700,
      term_months: 360,
      original_principal_cents: 1n,
      originated_on: null,
      first_payment_on: null,
      maturity_on: null,
      occupancy: null,
      property_state: null,
    };
    const obs: Observation = {
      as_of: "2026-09-01T00:00:00.000Z",
      status: "CURRENT",
      principal_balance_cents: 100n,
      escrow_balance_cents: null,
      scheduled_payment_cents: null,
      current_rate_pct: null,
      next_payment_due_on: null,
      delinquency_days: null,
      facts: {},
    };
    expect(universeLoanOf(loan, obs, AS_OF)).toEqual({ skipped: "no first_payment_date" });
  });
});
