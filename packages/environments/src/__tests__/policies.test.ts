/**
 * escrow-policy and regz-policy state their environments' rules as policies,
 * so the thing to prove is that nothing the grading depends on was lost in
 * the rewriting: every field, code and term the step rulebook names, and
 * every threshold and rounding, appears in the policy; no numbered
 * procedure survives; and the reference still passes under it.
 */

import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { ESCROW_POLICY, escrowPolicy, renderEscrowPolicyTask } from "../escrow/policy-env.js";
import {
  ESCROW_RULEBOOK,
  EscrowReferencePolicy,
  escrowSpecTasks,
  generateEscrowSuite,
} from "../escrow/index.js";
import { REGZ_POLICY, regzPolicy, renderRegzPolicyTask } from "../regz/policy-env.js";
import { REGZ_RULEBOOK, RegzReferencePolicy, generateRegzSuite } from "../regz/index.js";

/** Every snake_case name in a text: the fields, the codes, the tools. */
const names = (text: string): Set<string> =>
  new Set(text.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? []);
const missing = (rulebook: string, policy: string) =>
  [...names(rulebook)].filter((n) => !policy.includes(n));
const procedural = (text: string) => [/\bStep \d/.test(text), /^\d+\. /m.test(text)];

describe("escrow-policy", () => {
  it("names every field, code and term the step rulebook names", () => {
    expect(missing(ESCROW_RULEBOOK, ESCROW_POLICY)).toEqual([]);
  });

  it("states every threshold, constant and rounding the grading turns on", () => {
    for (const fact of [
      "round half up",
      "round down",
      "÷ 12",
      "÷ 6",
      "12 months",
      "24 months",
      "60 months",
      "30 or fewer",
      "5000 cents",
      "as_of + 30 days",
      "statement_sent_on + 30 days",
      "× 100 is more than current_escrow_payment_cents × 25",
      "more than 15000",
      "more than 250000",
      "(100 + cpi_change_pct) ÷ 100",
      "1 for annual, 2 for semiannual, 4 for quarterly, 12 for monthly",
      "tax_personal_property_mh",
    ])
      expect(ESCROW_POLICY, fact).toContain(fact);
  });

  it("says each decision and its precedence, and gives no numbered procedure", () => {
    for (const d of ["balanced", "retain", "refund", "credit", "shortage"])
      expect(ESCROW_POLICY).toContain(`"${d}"`);
    expect(ESCROW_POLICY).toContain("the decision is the first of these that applies");
    expect(procedural(ESCROW_POLICY)).toEqual([false, false]);
  });

  it("asks for the policy in the task, and the reference still passes under it", async () => {
    const [spec] = escrowSpecTasks();
    expect(renderEscrowPolicyTask(spec!)).toMatch(/Apply the policy/);
    expect(renderEscrowPolicyTask(spec!)).not.toMatch(/rulebook/);
    for (const t of [...escrowSpecTasks(), ...generateEscrowSuite("heldout", 1, 30)]) {
      expect(
        (await runEpisode(escrowPolicy, t, new EscrowReferencePolicy())).grade.pass,
        t.id,
      ).toBe(true);
    }
  });
});

describe("regz-policy", () => {
  it("names every field, code and term the step rulebook names", () => {
    expect(missing(REGZ_RULEBOOK, REGZ_POLICY)).toEqual([]);
  });

  it("states every 2026 threshold and every rounding the grading turns on", () => {
    for (const fact of [
      "$137,958",
      "$82,775",
      "$27,592",
      "$17,245",
      "$4,139",
      "$1,380",
      "$832,750",
      "3% of the total loan amount",
      "5% of the total loan amount",
      "8% of the total loan amount",
      "2.25",
      "3.5",
      "6.5",
      "1.5 points",
      "2.5",
      "60 months",
      "more than 80%",
      "10, 15, 20 or 30 years",
      "round half up",
      "one decimal place",
      "round(total loan amount in cents × percent ÷ 100)",
      "manufactured home",
    ])
      expect(REGZ_POLICY, fact).toContain(fact);
  });

  it("says where each answer cannot be decided, and gives no numbered procedure", () => {
    expect(REGZ_POLICY).toContain("is answered null");
    expect(REGZ_POLICY).toContain("null in every other case");
    expect(procedural(REGZ_POLICY)).toEqual([false, false]);
  });

  it("asks for the policy in the task, and the reference still passes under it", async () => {
    const tasks = generateRegzSuite("heldout", 1, 30);
    expect(renderRegzPolicyTask(tasks[0]!)).toMatch(/Apply the policy/);
    expect(renderRegzPolicyTask(tasks[0]!)).not.toMatch(/rulebook/);
    for (const t of tasks) {
      expect((await runEpisode(regzPolicy, t, new RegzReferencePolicy())).grade.pass, t.id).toBe(
        true,
      );
    }
  });
});
