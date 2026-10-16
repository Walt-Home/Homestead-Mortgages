/**
 * The generator: a task is a function of its name, the splits never meet,
 * every loan is internally consistent, and every branch of the rules turns
 * up often enough to be measured.
 */

import { describe, expect, it } from "vitest";
import { levelPaymentPct, scheduledUpb } from "@hm/refi-review";
import { toJsonLine } from "../record.js";
import {
  HELDOUT_SUITE,
  expectedReview,
  generateSuite,
  generateTask,
  reasonCode,
  taskPayload,
} from "../refi/index.js";

describe("a task is a function of its name", () => {
  it("rebuilds the same task from the same coordinates, alone or in a suite", () => {
    const suite = generateSuite("train", 7, 30);
    expect(toJsonLine(generateTask("train", 7, 17))).toBe(toJsonLine(suite[17]));
    expect(toJsonLine(generateSuite("train", 7, 30))).toBe(toJsonLine(suite));
  });

  it("never draws a held-out loan into training", () => {
    const fingerprint = (t: ReturnType<typeof generateTask>) => toJsonLine(taskPayload(t));
    const heldout = new Set(
      generateSuite("heldout", HELDOUT_SUITE.seed, HELDOUT_SUITE.n).map(fingerprint),
    );
    const train = generateSuite("train", HELDOUT_SUITE.seed, 2000).map(fingerprint);
    expect(heldout.size).toBe(HELDOUT_SUITE.n);
    expect(train.filter((f) => heldout.has(f))).toEqual([]);
  });
});

describe("every loan is internally consistent", () => {
  it("has the payment, balance and remaining term its own terms give", () => {
    for (const t of generateSuite("train", 3, 500)) {
      const l = t.loan;
      expect(l.pi_cents).toBe(
        levelPaymentPct(l.original_upb_cents, l.note_rate_pct, l.original_term_months),
      );
      expect(l.upb_cents).toBe(
        scheduledUpb(
          l.original_upb_cents,
          l.note_rate_pct,
          l.original_term_months,
          l.payments_made,
        ),
      );
      expect(l.remaining_term_months).toBe(l.original_term_months - l.payments_made);
      expect(l.remaining_term_months).toBeGreaterThan(0);
      expect(l.upb_cents).toBeGreaterThan(0n);
      expect(l.value_estimate.value_cents).toBeGreaterThan(0n);
      expect(l.next_due_date > t.review_date).toBe(true);
    }
  });
});

describe("every branch of the rules turns up", () => {
  const reviews = generateSuite("train", 1, 2000).map(expectedReview);

  it("draws every verdict at a measurable rate", () => {
    const share = (v: string) => reviews.filter((r) => r.verdict === v).length / reviews.length;
    for (const v of ["candidate", "watching", "not_now", "excluded"])
      expect(share(v), v).toBeGreaterThan(0.12);
  });

  it("draws every reason code the rulebook names", () => {
    const seen = new Set(reviews.flatMap((r) => r.reasons.map(reasonCode)));
    for (const code of [
      "not_active",
      "bankruptcy_active",
      "foreclosure_referred",
      "lossmit_plan_active",
      "deceased_or_sii_pending",
      "transfer_out_pending",
      "delinquent",
      "marketing_suppression",
      "cooldown",
      "frequency_cap",
      "not_priceable",
      "not_priced",
      "rate_delta_below_floor",
      "npv_not_positive",
      "seven_year_not_lower",
      "prescreen_failed",
      "state_rule_failed",
      "reset_costs_more",
      "implausible_value",
      "value_stale",
    ]) {
      expect(seen.has(code), code).toBe(true);
    }
  });

  it("draws the rare paths: the Massachusetts rule, same term first, an unrounded loan amount", () => {
    expect(reviews.filter((r) => r.state_determination?.applies).length).toBeGreaterThan(20);
    expect(reviews.filter((r) => r.offer?.present_same_term_first).length).toBeGreaterThan(20);
    expect(
      reviews.filter((r) => r.candidate && !r.candidate.rounded_to_thousand).length,
    ).toBeGreaterThan(20);
  });
});
