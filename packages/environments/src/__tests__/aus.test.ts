/**
 * aus-decision: the grader is the shadow AUS itself, imported and run on the
 * production path against a frozen APOR table pinned by its hash; it gives
 * the verified minimal file and the worked cases to the figure; the rulebook
 * followed through the tools lands where the engine does on every generated
 * file and on unfiltered draws the guard never saw; the guard keeps out every
 * region where the engine raises a question of policy; the run does not
 * depend on the machine's time zone; and each edge and configuration that
 * decides an answer turns up.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addDays, parts, plainDate } from "@hm/kernel/calendar";
import { monthsBetween } from "@hm/refi-review";
import { FEE_SCHEDULE, underwrite } from "@hm/underwriting";
import { describe, expect, it } from "vitest";
import { auditEpisode, type AuditRecord } from "../audit.js";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { solveNow } from "../refi/reference.js";
import { rngFor } from "../rng.js";
import {
  AUS_EDGES,
  AUS_FINGERPRINT,
  AUS_GROUPS,
  AUS_HELDOUT_SUITE,
  AUS_RULEBOOK,
  AUS_SPEC_CASES,
  AusReferencePolicy,
  BLOCKABLE,
  FINDING_CODES,
  FROZEN_APOR_SHA256,
  FROZEN_APOR_TABLE,
  NTB,
  OUTCOMES,
  RECOMMENDATIONS,
  analyzeAus,
  ausDecision,
  ausEdgeOf,
  ausFairToGrade,
  ausInScope,
  ausOutOfScope,
  ausPayload,
  ausSpecTasks,
  ausSteps,
  ausTaskId,
  decide,
  drawAusCandidate,
  drawAusTask,
  estimatesOf,
  executeAusTool,
  expectedAus,
  fileOf,
  generateAusSuite,
  generateAusTask,
  gradeAusAgainst,
  parseAusSubmission,
  type AusAnalysis,
  type AusAnswer,
  type AusBorrower,
  type AusTask,
} from "../aus/index.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const refinance = (t: AusTask) => t.loan.purpose !== "purchase";

/** The fields where the rulebook, followed through the tools, lands somewhere other than the engine. */
const byRulesMisses = (task: AusTask): string[] => {
  let raw: unknown;
  try {
    raw = solveNow(ausSteps, JSON.parse(JSON.stringify(ausPayload(task))), executeAusTool);
  } catch (e) {
    return [`${task.id} threw ${e instanceof Error ? e.message : String(e)}`];
  }
  const parsed = parseAusSubmission(raw);
  if (!parsed.ok) return [`${task.id} ${parsed.error}`];
  return gradeAusAgainst(expectedAus(task), parsed.answer, refinance(task))
    .fields.filter((f) => !f.ok)
    .map((f) => `${task.id} ${f.field} ${f.expected}/${f.got}`);
};

const solveAll = async (tasks: readonly AusTask[]) => {
  const misses: string[] = [];
  let turns = 0;
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(ausDecision, task, new AusReferencePolicy());
    turns = Math.max(turns, r.turns);
    calls = Math.max(calls, r.tool_calls);
    if (!r.grade.pass) {
      const wrong = r.grade.fields
        .filter((f) => !f.ok)
        .map((f) => `${f.field} ${f.expected}/${f.got}`);
      misses.push(`${task.id} ${r.outcome} ${r.error ?? ""} ${wrong.join("; ")}`);
    }
  }
  return { misses, turns, calls };
};

const SPEC = ausSpecTasks();
const [WORKED] = SPEC as [AusTask];
/** A task with some of it changed, and the lender's estimates the engine's for what changed. */
const withFile = (base: AusTask, patch: Partial<AusTask>): AusTask => {
  const t = { ...base, ...patch };
  return { ...t, lender_estimates: estimatesOf(t) };
};
const borrower1 = WORKED.borrowers[0]!;
const withBorrower = (b: Partial<AusBorrower>, base = WORKED): AusTask =>
  withFile(base, { borrowers: [{ ...base.borrowers[0]!, ...b }, ...base.borrowers.slice(1)] });
const credit1 = borrower1.credit!;
const codes = (t: AusTask) => decide(t).aus!.findings.map((f) => f.code);
const blockedOf = (t: AusTask) => [
  ...new Set(
    decide(t)
      .derivations.filter((d) => d.blockedBy?.length)
      .map((d) => d.requirementId),
  ),
];

describe("aus-decision", () => {
  it("grades with the engine itself, on the production path, against a frozen APOR table", () => {
    // A change here moves every score: bump AUS_ENVIRONMENT_VERSION, then the pin.
    expect(FROZEN_APOR_SHA256).toMatchInlineSnapshot(
      `"7cac97414e05f7cb4add3f526f9b3ea34c183baeb16b516883bef601af2320be"`,
    );
    expect(FROZEN_APOR_TABLE.weeks).toHaveLength(507);
    expect([FROZEN_APOR_TABLE.weeks[0]!.weekOf, FROZEN_APOR_TABLE.weeks.at(-1)!.weekOf]).toEqual([
      "2017-01-02",
      "2026-09-14",
    ]);
    expect(FROZEN_APOR_TABLE.termYears).toEqual([30, 20, 15, 10]);

    // The grader is `underwrite`, imported, called as the decision route calls it: no stated market.
    for (const t of [...SPEC, ...generateAusSuite("train", 2, 28)]) {
      const route = underwrite(fileOf(t), {
        aporTable: FROZEN_APOR_TABLE,
        casefileId: t.id,
        now: t.decided_at,
      });
      expect(decide(t)).toEqual(route);
      expect(route.pricedAgainst.feeScheduleVersion).toBe(FEE_SCHEDULE.version);
      if (route.pricedAgainst.aporWeekOf !== null)
        expect(route.pricedAgainst.aporSource).toBe(FROZEN_APOR_TABLE.source);
    }
    const grader = readFileSync(here("../aus/grader.ts"), "utf8");
    expect(grader).toMatch(/from "@hm\/underwriting"/);
    expect(grader).not.toMatch(
      /\bmarket\s*:|estimatedFees|estimatedPrepaids|(?<!FROZEN_)APOR_TABLE/,
    );
    // The two figures the task gives are the engine's own, or nothing is graded.
    expect(() =>
      analyzeAus({
        ...WORKED,
        lender_estimates: { ...WORKED.lender_estimates, housing_payment_cents: 313_245 },
      }),
    ).toThrow(/housing payment given/);
    expect(() =>
      analyzeAus({
        ...WORKED,
        lender_estimates: { ...WORKED.lender_estimates, closing_costs_cents: 642_501 },
      }),
    ).toThrow(/closing costs given/);
    // The apor tool reads the same frozen table.
    expect(JSON.parse(executeAusTool("apor", { date: "2026-06-15", term_years: 30 }))).toEqual({
      week_of: "2026-06-15",
      apor_pct: "6.57",
    });
    expect(() => executeAusTool("apor", { date: "2026-09-21", term_years: 30 })).toThrow(/no APOR/);
  });

  describe("gives the verified minimal file and the worked cases to the figure", () => {
    const want = (k: number) => expectedAus(SPEC[k]!);

    it("the minimal file: DTI 20.88, LTV 80, APOR 6.57 for the week of June 15, APR 6.587, clear to close", () => {
      expect(WORKED.lender_estimates).toEqual({
        housing_payment_cents: 313_244,
        closing_costs_cents: 642_500,
      });
      expect(want(0)).toEqual({
        representative_fico: 750,
        fico_for_minimum: 750,
        bankruptcy_seasoning_months: null,
        derogatory_seasoning_months: null,
        qualifying_income_cents: "1500000",
        transcript_variance_pct: null,
        monthly_liabilities_cents: "0",
        dti_front_pct: "20.88",
        dti_back_pct: "20.88",
        atr_documented: true,
        ltv_pct: "80.00",
        cltv_pct: "80.00",
        hcltv_pct: "80.00",
        max_ltv_pct: 97,
        ipc_ratio_pct: "0.00",
        ipc_cap_pct: 6,
        funds_to_close_cents: "10642500",
        required_reserve_months: 0,
        actual_reserve_months: "13.9",
        reserves_satisfied: true,
        points_and_fees_cents: "359000",
        total_loan_amount_cents: "39641000",
        points_and_fees_pass: true,
        is_high_cost: false,
        apor_week_of: "2026-06-15",
        apor_pct: "6.57",
        apr_pct: "6.587",
        qm_status: "qm",
        is_hpml: false,
        ntb_recoup_months: null,
        ntb_satisfied: null,
        findings: [],
        blocked: [],
        recommendation: "approve_eligible",
        outcome: "clear_to_close",
      });
    });

    it("$400,010 on $500,000 shows 80.00, and the APR it refuses blocks QM, HPML and HOEPA", () => {
      expect(want(1)).toMatchObject({
        ltv_pct: "80.00",
        apr_pct: null,
        qm_status: null,
        is_hpml: null,
        is_high_cost: null,
        points_and_fees_cents: "359005",
        blocked: ["UW-006", "UW-008", "UW-009"],
        outcome: "referred",
      });
    });

    it("97.01% is over the 97% maximum: a counteroffer, though the APR is refused", () => {
      expect(want(2)).toMatchObject({
        ltv_pct: "97.01",
        max_ltv_pct: 97,
        ipc_cap_pct: 3,
        findings: ["LTV_EXCEEDS_MAXIMUM"],
        recommendation: "approve_ineligible",
        outcome: "counteroffer",
      });
    });

    it("$3,619 of debts makes (3,132.44 + 3,619) / 15,000 = 45.0096%: 45.01, elevated", () => {
      expect(want(3)).toMatchObject({
        monthly_liabilities_cents: "361900",
        dti_front_pct: "20.88",
        dti_back_pct: "45.01",
        findings: ["DTI_ELEVATED"],
        outcome: "approved_with_conditions",
      });
    });

    it("the high-cost line falls between $37,307 and $37,308", () => {
      expect(want(4)).toMatchObject({
        points_and_fees_cents: "177654",
        total_loan_amount_cents: "3553046",
        points_and_fees_pass: false,
        is_high_cost: true,
        qm_status: "qm",
        is_hpml: false,
        findings: ["HOEPA_HIGH_COST", "POINTS_AND_FEES_EXCEEDED"],
        outcome: "denied",
      });
      expect(want(5)).toMatchObject({
        points_and_fees_pass: true,
        is_high_cost: false,
        findings: [],
        outcome: "clear_to_close",
      });
    });

    it("seasoning: 48 months meets 48; the older chapter 7 at 44 decides behind the chapter 13 at 30", () => {
      expect(want(6)).toMatchObject({ bankruptcy_seasoning_months: 48, findings: [] });
      expect(want(7)).toMatchObject({
        bankruptcy_seasoning_months: 44,
        findings: ["BANKRUPTCY_SEASONING"],
        outcome: "approved_with_conditions",
      });
    });

    it("two borrowers: the lowest own score prices, their average rounded half up is tested", () => {
      expect(want(8)).toMatchObject({ representative_fico: 665, fico_for_minimum: 708 });
    });

    it("a refinance saving $98.75 recoups $5,925 in exactly 60.0 months, and passes", () => {
      expect(SPEC[9]!.lender_estimates.closing_costs_cents).toBe(592_500);
      expect(want(9)).toMatchObject({
        funds_to_close_cents: "0",
        ntb_recoup_months: "60.0",
        ntb_satisfied: true,
        outcome: "clear_to_close",
      });
    });

    it("a rate set late on Sunday in New York is priced against the week before", () => {
      expect(want(10)).toMatchObject({ apor_week_of: "2026-06-08", apor_pct: "6.51" });
    });

    it("a co-borrower with no credit report blocks the scores, the debts and pricing", () => {
      expect(want(11)).toMatchObject({
        representative_fico: null,
        monthly_liabilities_cents: null,
        dti_front_pct: "24.26",
        dti_back_pct: null,
        atr_documented: false,
        blocked: ["CRD-002", "CRD-016", "UW-004", "UW-006", "UW-008", "UW-009", "UW-010"],
        outcome: "referred",
      });
    });

    it("and the rulebook, followed through the tools, lands on every one of them", () => {
      expect(SPEC).toHaveLength(AUS_SPEC_CASES.length);
      expect(SPEC.flatMap(byRulesMisses)).toEqual([]);
      for (const t of SPEC) expect(ausOutOfScope(t), t.id).toBeNull();
    });
  });

  it("fails an answer one cent off on exactly that field, and charges a net tangible benefit on a purchase", () => {
    const want = expectedAus(WORKED);
    const wrong = (answer: Partial<AusAnswer>) =>
      gradeAusAgainst(want, { ...want, ...answer }, false)
        .fields.filter((f) => !f.ok)
        .map((f) => f.field);
    expect(wrong({ funds_to_close_cents: "10642501" })).toEqual(["funds_to_close_cents"]);
    expect(wrong({ points_and_fees_cents: "359001" })).toEqual(["fees"]);
    expect(wrong({ total_loan_amount_cents: "39640999" })).toEqual(["fees"]);
    expect(wrong({ qualifying_income_cents: "1500001" })).toEqual(["income_and_debts"]);
    expect(wrong({ dti_back_pct: "20.89" })).toEqual(["dti"]);
    expect(wrong({ actual_reserve_months: "14.0" })).toEqual(["reserves"]);
    expect(wrong({ apr_pct: "6.588" })).toEqual(["apr"]);
    expect(wrong({ apor_pct: "6.58" })).toEqual(["apor"]);
    expect(wrong({ ipc_cap_pct: 9 })).toEqual(["collateral"]);
    expect(wrong({ outcome: "approved_with_conditions" })).toEqual(["decision"]);
    expect(wrong({ blocked: ["UW-008"] })).toEqual(["aus"]);
    const graded = gradeAusAgainst(want, want, false);
    expect([graded.pass, graded.fields.length]).toEqual([true, 11]);
    // A refinance has a twelfth field; a purchase answered with one is charged for it.
    const refi = expectedAus(SPEC[9]!);
    expect(gradeAusAgainst(refi, refi, true).fields).toHaveLength(12);
    const hedged = gradeAusAgainst(want, { ...want, ntb_satisfied: true }, false);
    expect([hedged.pass, hedged.fields.length, hedged.fields.at(-1)!.field]).toEqual([
      false,
      12,
      "ntb",
    ]);
  });

  it("grades every answer: each of the thirty-five, changed alone, fails its own field and no other", () => {
    const owner = Object.fromEntries([
      ...Object.entries(AUS_GROUPS).flatMap(([group, keys]) => keys.map((k) => [k, group])),
      ...NTB.map((k) => [k, "ntb"]),
    ]) as Record<keyof AusAnswer, string>;
    const choices: Partial<Record<keyof AusAnswer, readonly unknown[]>> = {
      recommendation: RECOMMENDATIONS,
      outcome: OUTCOMES,
      qm_status: ["qm", "non_qm", null],
    };
    /** Another value of the same shape: the next choice, a code more, a cent on, one in the last place. */
    const other = (key: keyof AusAnswer, v: unknown): unknown => {
      const among = choices[key];
      if (among) return among.find((c) => c !== v);
      if (key === "findings") return [...(v as string[]), "IPC_EXCEEDS_LIMIT"].sort();
      if (key === "blocked") return [...(v as string[]), "APP-019"].sort();
      if (typeof v === "boolean") return !v;
      if (typeof v === "number") return v + 1;
      if (v === null)
        return key.endsWith("_months")
          ? key === "actual_reserve_months" || key === "ntb_recoup_months"
            ? "1.0"
            : 1
          : key.endsWith("_cents")
            ? "1"
            : key === "apor_week_of"
              ? "2026-06-08"
              : key === "apr_pct"
                ? "6.001"
                : key === "representative_fico" || key === "fico_for_minimum"
                  ? 700
                  : key === "is_hpml" ||
                      key === "is_high_cost" ||
                      key === "points_and_fees_pass" ||
                      key === "reserves_satisfied" ||
                      key === "ntb_satisfied"
                    ? true
                    : "1.00";
      const text = String(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return addDays(plainDate(text), 1);
      if (/^-?\d+$/.test(text)) return String(BigInt(text) + 1n);
      const places = text.split(".")[1]!.length;
      return (Number(text) + 10 ** -places).toFixed(places);
    };
    // On a purchase, where a net tangible benefit reported is its own field, and on a refinance.
    for (const task of [WORKED, SPEC[11]!, SPEC[9]!]) {
      const want = expectedAus(task);
      expect(Object.keys(want).sort()).toEqual(Object.keys(owner).sort());
      for (const key of Object.keys(owner) as (keyof AusAnswer)[]) {
        const answer = { ...want, [key]: other(key, want[key]) };
        expect(parseAusSubmission(answer).ok, `${task.id} ${key}`).toBe(true);
        const failed = gradeAusAgainst(want, answer as AusAnswer, refinance(task))
          .fields.filter((f) => !f.ok)
          .map((f) => f.field);
        expect(failed, `${task.id} ${key}`).toEqual([owner[key]]);
      }
    }
  });

  it("pins what a model is told, and states each rule the way the grader applies it", () => {
    // Any edit to the rulebook or the tools changes what every model is told: bump
    // AUS_ENVIRONMENT_VERSION with this pin.
    expect(AUS_FINGERPRINT.environment).toMatchInlineSnapshot(`
      {
        "name": "aus-decision",
        "rulebook_sha256": "a0bb384057c3e0fb5da874cdb24e5ac83f3906abf4b5daf521ca4820bdbb9d8a",
        "tools_sha256": "3238cfd76c0756ba7f42c0d6d385e1d509a62ee42f01d39c5f6fa0491b190b93",
        "version": "1.0.0",
      }
    `);
    expect(ausDecision.tools.map((t) => t.name)).toEqual([
      "new_york_date",
      "annual_percentage_rate",
      "apor",
      "level_payment",
      "whole_months_between",
      "calculate",
      "submit_decision",
    ]);
    const stated = [
      // Step 1: representativeFico.
      "Each borrower's own score is the middle of their scores when their report has three, the lower when it has two, and the one when it has one.",
      "When any borrower has no credit report (credit is null), or a report with no scores, CRD-002 and UW-010 are blocked",
      "fico_for_minimum is the representative score when there is one borrower, and the average of the own scores, rounded to a whole number, when there are two.",
      // Steps 2 and 5: householdTradelines.
      "When any borrower has no credit report, CRD-016 is blocked. A report with no scores does not block it.",
      // Step 3: deciding, monthsBetween.
      'Its minimum is 24 months when its chapter is "13", and 48 months for any other chapter or none.',
      "the minimum is 84 months for a foreclosure and 48 for a short sale or a deed in lieu",
      "The bankruptcy with the smallest margin decides",
      // Step 4.
      "When no income source is of type base_wage, INC-004 is blocked.",
      "The transcript check (INC-009) runs only when every borrower has at least one transcript.",
      "documented = 12 × the sum of monthly_cents over every income source, whatever its continuance",
      "When it is more than 10.00 or less than −10.00, add TRANSCRIPT_VARIANCE (income).",
      // Step 5: debtToIncome.
      "When qualifying income is 0, UW-004 is blocked",
      "When dti_back_pct is more than 45.00, add DTI_ELEVATED (income).",
      // Step 6: maxLtvFor.
      "When any borrower has occupies_property false, the maximum is the lower of that and 95.",
      // Step 7: closingCosts, lookupApor, the APR's refusal.
      "points_and_fees_cents = round(the loan amount × 0.5 ÷ 100) + 109500 + 49500",
      "when the loan amount × 100 is more than the value × 80, exactly (not the rounded LTV",
      // Step 8: fundsToClose, reserves.
      "a retirement account counts 60% of its vested_balance_cents",
      "actual_reserve_months = (the eligible assets − funds to close) ÷ the housing payment, rounded to one place.",
      // Step 9: AST-016.
      "ipc_cap_pct is 2 for an investment property; otherwise 3 when ltv_pct is 90.01 or more, 6 when it is 75.01 or more, and 9 below that.",
      // Steps 10 to 14: runComplianceTests.
      "Regulation Z's thresholds are held for 2026 alone.",
      "HPML threshold: 1.5 points of spread; 2.5 when the loan amount is more than $832,750.",
      'When property.occupancy is not "primary_residence", is_high_cost is null and nothing is blocked',
      "the penalty trigger: false when product.prepayment_penalty is false, and null when it is true",
      // Step 15.
      'When existing_loan.payment_basis is not "principal_and_interest", both are null and APP-019 is blocked',
      "A saving of 0 or less: ntb_recoup_months is null and ntb_satisfied is false.",
      // Step 16: determineRecommendation, determineOutcome.
      'recommendation: "approve_ineligible" when any finding is in the eligibility category; otherwise "refer" when any requirement is blocked; otherwise "refer_with_caution" when there is any finding; otherwise "approve_eligible".',
      'outcome: "denied" when is_high_cost is true; otherwise "counteroffer" for approve_ineligible, "referred" for refer, "approved_with_conditions" for refer_with_caution, and "clear_to_close" for approve_eligible.',
    ];
    expect(stated.filter((rule) => !AUS_RULEBOOK.includes(rule))).toEqual([]);
    // Every code and requirement the rulebook names is one the submission may carry, and no other.
    for (const c of FINDING_CODES) expect(AUS_RULEBOOK).toContain(c);
    for (const b of BLOCKABLE) expect(AUS_RULEBOOK).toContain(b);
    // The questioned behaviors are not taught: the rulebook never says what happens past them.
    for (const unsaid of ["DTI_EXCEEDS_MAXIMUM", "FICO_BELOW_MINIMUM", "INC-026"])
      expect(AUS_RULEBOOK).not.toContain(unsaid);
  });

  it("reads a submission strictly, as the schema says, and bounces what does not fit", () => {
    const want = expectedAus(WORKED);
    const ok = (x: unknown) => parseAusSubmission(x).ok;
    expect(ok(want)).toBe(true);
    const { outcome: _omitted, ...missing } = want;
    expect(ok(missing)).toBe(false);
    expect(ok({ ...want, verdict: "clear" })).toBe(false);
    expect(ok({ ...want, ltv_pct: "80" })).toBe(false);
    expect(ok({ ...want, ltv_pct: 80 })).toBe(false);
    expect(ok({ ...want, apr_pct: "6.59" })).toBe(false);
    expect(ok({ ...want, apor_pct: "6.570" })).toBe(false);
    expect(ok({ ...want, funds_to_close_cents: "106425.00" })).toBe(false);
    expect(ok({ ...want, funds_to_close_cents: 10_642_500 })).toBe(false);
    expect(ok({ ...want, actual_reserve_months: "13.91" })).toBe(false);
    expect(ok({ ...want, representative_fico: "750" })).toBe(false);
    expect(ok({ ...want, max_ltv_pct: 97.5 })).toBe(false);
    expect(ok({ ...want, atr_documented: null })).toBe(false);
    expect(ok({ ...want, findings: ["FICO_BELOW_MINIMUM"] })).toBe(false);
    expect(ok({ ...want, findings: ["DTI_ELEVATED", "DTI_ELEVATED"] })).toBe(false);
    expect(ok({ ...want, blocked: ["INC-026"] })).toBe(false);
    expect(ok({ ...want, blocked: "UW-008" })).toBe(false);
    expect(ok({ ...want, recommendation: "approve" })).toBe(false);
    expect(ok({ ...want, outcome: "approved" })).toBe(false);
    expect(ok({ ...want, apor_week_of: "06/15/2026" })).toBe(false);
    expect(ok([want])).toBe(false);
    // A list is a set: its order is not the answer.
    const parsed = parseAusSubmission({
      ...want,
      blocked: ["UW-009", "UW-006", "UW-008"],
    });
    expect(parsed.ok && parsed.answer.blocked).toEqual(["UW-006", "UW-008", "UW-009"]);
  });

  it("gives an answer that works nothing little credit", () => {
    // The commonest label everywhere, a given figure copied where one is near, and no figure worked:
    // the floor the mean field score is read against.
    const tasks = generateAusSuite("heldout", AUS_HELDOUT_SUITE.seed, AUS_HELDOUT_SUITE.n);
    const scores = tasks.map((t) => {
      const nothing: AusAnswer = {
        representative_fico: t.borrowers[0]!.credit?.scores[0]?.score ?? null,
        fico_for_minimum: t.borrowers[0]!.credit?.scores[0]?.score ?? null,
        bankruptcy_seasoning_months: null,
        derogatory_seasoning_months: null,
        qualifying_income_cents: String(t.income_sources[0]!.monthly_cents),
        transcript_variance_pct: null,
        monthly_liabilities_cents: "0",
        dti_front_pct: null,
        dti_back_pct: null,
        atr_documented: true,
        ltv_pct: "80.00",
        cltv_pct: "80.00",
        hcltv_pct: "80.00",
        max_ltv_pct: 97,
        ipc_ratio_pct: "0.00",
        ipc_cap_pct: 9,
        funds_to_close_cents: String(t.lender_estimates.closing_costs_cents),
        required_reserve_months: 0,
        actual_reserve_months: null,
        reserves_satisfied: true,
        points_and_fees_cents: "0",
        total_loan_amount_cents: String(t.loan.amount_cents),
        points_and_fees_pass: true,
        is_high_cost: false,
        apor_week_of: null,
        apor_pct: null,
        apr_pct: t.product.note_rate_pct,
        qm_status: "qm",
        is_hpml: false,
        ntb_recoup_months: null,
        ntb_satisfied: refinance(t) ? true : null,
        findings: [],
        blocked: [],
        recommendation: "approve_eligible",
        outcome: "clear_to_close",
      };
      return gradeAusAgainst(expectedAus(t), nothing, refinance(t)).score;
    });
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    expect(mean).toBeLessThan(0.12);
    expect(mean.toFixed(3)).toMatchInlineSnapshot(`"0.101"`);
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    const r = await solveAll([
      ...SPEC,
      ...generateAusSuite("heldout", AUS_HELDOUT_SUITE.seed, AUS_HELDOUT_SUITE.n),
    ]);
    expect(r.misses).toEqual([]);
    // Inside the episode's 80 turns even for a model that makes one tool call a turn: the
    // reference's call count, submission included, is that model's turn count.
    expect(r.calls).toBeLessThan(70);
    expect(r.turns).toBeLessThan(10);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    const r = await solveAll(generateAusSuite("train", 11, 300));
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(70);
  }, 120_000);

  it("is fair to grade on every first draw, and stays out of the engine's regions of doubt", () => {
    // Every held-out file is its index's first draw, so the held-out pass is not the filter's doing.
    const held = Array.from({ length: AUS_HELDOUT_SUITE.n }, (_, i) =>
      drawAusTask("heldout", AUS_HELDOUT_SUITE.seed, i),
    );
    expect(held.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    const draws = Array.from({ length: 600 }, (_, i) => drawAusTask("train", 3, i));
    expect(draws.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    for (const { task } of draws) {
      expect(ausOutOfScope(task), task.id).toBeNull();
      expect(ausFairToGrade(task), task.id).toBe(true);
    }
  }, 60_000);

  it("holds the rulebook to the engine on candidates nothing filtered", () => {
    // The fairness filter would hide a disagreement; the candidates it would see show none.
    const unfair: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      const id = ausTaskId("train", 99, i);
      const task = drawAusCandidate(rngFor(id), id, "train", 99, i);
      const out = ausOutOfScope(task);
      if (out !== null) unfair.push(`${id} ${out}`);
      else unfair.push(...byRulesMisses(task));
    }
    expect(unfair).toEqual([]);
  }, 120_000);

  it("keeps out every region where the engine raises a question of policy", () => {
    const out = (t: AusTask) => ausOutOfScope(t);
    expect(out(WORKED)).toBeNull();
    const scored = (...scores: number[]) =>
      withBorrower({
        credit: {
          ...credit1,
          scores: scores.map((score, k) => ({ bureau: credit1.scores[k]!.bureau, score })),
        },
      });

    // A score under 620 is never ineligible: it refers through the pricing grid's floor alone.
    const low = scored(600, 610, 615);
    expect(codes(low)).toEqual(["FICO_BELOW_MINIMUM"]);
    expect(decide(low).outcome).toBe("referred");
    expect(out(low)).toBe("an own score under 620");
    const lowPair = withFile(WORKED, {
      borrowers: [
        borrower1,
        {
          ...borrower1,
          name: "Rowan Ashdown",
          credit: { ...credit1, scores: [{ bureau: "equifax", score: 600 }] },
          assets: { accounts: [] },
        },
      ],
    });
    expect(codes(lowPair)).toEqual([]);
    expect(out(lowPair)).toBe("an own score under 620");

    // A back-end ratio over 50 is an income finding, approved with conditions; and 50.0029 rounds to 50.00.
    const debts = (payment: number, monthly = 1_500_000) =>
      withFile(WORKED, {
        borrowers: [
          {
            ...borrower1,
            credit: {
              ...credit1,
              tradelines: [
                {
                  creditor: "Harbor Auto Finance",
                  type: "auto",
                  opened_on: "2023-04-11",
                  balance_cents: 3_000_000,
                  credit_limit_cents: null,
                  monthly_payment_cents: payment,
                  dti_exclusion: null,
                },
              ],
            },
          },
        ],
        income_sources: [
          { type: "base_wage", monthly_cents: monthly, continuance_established: true },
        ],
      });
    const over50 = debts(436_900);
    expect(expectedAus(WORKED).dti_back_pct).toBe("20.88");
    expect(decide(over50).ratios.dtiBack).toBe(50.01);
    expect(codes(over50)).toEqual(["DTI_EXCEEDS_MAXIMUM"]);
    expect(decide(over50).outcome).toBe("approved_with_conditions");
    expect(out(over50)).toBe("a back-end ratio over 50");
    const rounds50 = debts(436_900, 1_500_200);
    expect(decide(rounds50).ratios.dtiBack).toBe(50);
    expect(out(rounds50)).toBe("a back-end ratio over 50");
    // And 45.0036 rounds to 45.00, where the exact ratio is over 45.
    const rounds45 = debts(361_900, 1_500_200);
    expect([decide(rounds45).ratios.dtiBack, codes(rounds45)]).toEqual([45, []]);
    expect(out(rounds45)).toBe("a back-end ratio whose rounding crosses 45");

    // Funds to close are never compared with assets: $100,000 against $106,425 clears to close.
    const short = withBorrower({
      assets: { accounts: [{ ...borrower1.assets!.accounts[0]!, balance_cents: 10_000_000 }] },
    });
    expect(decide(short).outcome).toBe("clear_to_close");
    expect(out(short)).toBe("eligible assets short of the funds to close");

    // Neither non-QM nor higher-priced raises a finding.
    const priced = (note: string) =>
      withFile(WORKED, { product: { ...WORKED.product, note_rate_pct: note } });
    expect([decide(priced("9.000")).compliance.qmStatus, decide(priced("9.000")).outcome]).toEqual([
      "non_qm",
      "clear_to_close",
    ]);
    expect(out(priced("9.000"))).toBe("a non-QM result");
    expect([
      decide(priced("8.000")).compliance.qmStatus,
      decide(priced("8.000")).compliance.isHpml,
    ]).toEqual(["qm", true]);
    expect(decide(priced("8.000")).outcome).toBe("clear_to_close");
    expect(out(priced("8.000"))).toBe("a higher-priced result");

    // A refinance's maximum ignores occupancy: an investment property at 90% raises nothing.
    const refi = SPEC[9]!;
    const investmentRefi = withFile(refi, {
      property: { ...refi.property, occupancy: "investment" },
      loan: {
        ...refi.loan,
        amount_cents: 45_000_000,
        existing_loan: { ...refi.loan.existing_loan!, balance_cents: 44_000_000 },
      },
      borrowers: [{ ...borrower1, occupies_property: false }],
    });
    expect(decide(investmentRefi).aus!.findings.map((f) => f.code)).not.toContain(
      "LTV_EXCEEDS_MAXIMUM",
    );
    expect(out(investmentRefi)).toBe("a refinance of a second home or investment property");

    // INC-004 blocks a household with no base wage, though the sheet scopes it to wage earners.
    const selfEmployed = withFile(WORKED, {
      income_sources: [
        { type: "self_employment", monthly_cents: 1_500_000, continuance_established: true },
      ],
    });
    expect([blockedOf(selfEmployed), decide(selfEmployed).outcome]).toEqual([
      ["INC-004"],
      "referred",
    ]);
    expect(out(selfEmployed)).toBe("a household with no wage income");
    // A wage earner whose base wage is not on file is in scope: INC-004 reaches them either way.
    const commissioned = withFile(WORKED, {
      income_sources: [
        { type: "commission", monthly_cents: 1_500_000, continuance_established: true },
      ],
    });
    expect(out(commissioned)).toBeNull();

    // INC-009 runs on everyone with transcripts, though the sheet scopes it to variable income.
    const transcribed = withBorrower({
      transcripts: [{ tax_year: 2025, wages_cents: 18_000_000 }],
    });
    expect(decide(transcribed).derivations.some((d) => d.requirementId === "INC-009")).toBe(true);
    expect(out(transcribed)).toBe(
      "transcripts on a household with no variable, self-employed or rental income",
    );

    // Ability to repay reads Borrower 1's asset report, not the household's.
    const theirs = withFile(WORKED, {
      borrowers: [
        { ...borrower1, assets: null },
        { ...borrower1, name: "Rowan Ashdown", assets: borrower1.assets },
      ],
    });
    expect([
      decide(theirs).compliance.atrDetermination,
      decide(theirs).compliance.qmStatus,
      decide(theirs).outcome,
    ]).toEqual(["not_documented", "non_qm", "clear_to_close"]);
    expect(out(theirs)).toBe("asset reports from some borrowers and not others");

    // Bright lines compared on a rounded figure, where the exact one is on the other side.
    const ltvAt = (loan: number) =>
      withFile(WORKED, { loan: { ...WORKED.loan, amount_cents: loan } });
    expect([decide(ltvAt(48_502_000)).ratios.ltv, codes(ltvAt(48_502_000))]).toEqual([97, []]);
    expect(out(ltvAt(48_502_000))).toBe("an LTV whose rounding crosses its maximum");
    expect(decide(ltvAt(37_502_000)).ratios.ltv).toBe(75);
    expect(out(ltvAt(37_502_000))).toBe("an LTV whose rounding crosses a contribution band");
    const contributing = (ipc: number, value = 50_000_000) =>
      withFile(WORKED, {
        property: { ...WORKED.property, value_cents: value },
        loan: {
          ...WORKED.loan,
          interested_party_contributions_cents: ipc,
          amount_cents: (value * 8) / 10,
        },
      });
    expect(codes(contributing(3_001_000))).toEqual([]);
    expect(out(contributing(3_001_000))).toBe(
      "a contribution ratio whose rounding crosses its cap",
    );
    // 9,095.05 on 101,000 is exactly 9.005%: the engine rounds it down in binary, past a 9% cap.
    const half = withFile(WORKED, {
      property: { ...WORKED.property, value_cents: 10_100_000 },
      loan: {
        ...WORKED.loan,
        amount_cents: 7_070_000,
        interested_party_contributions_cents: 909_505,
      },
      income_sources: [
        { type: "base_wage", monthly_cents: 600_000, continuance_established: true },
      ],
    });
    expect(decide(half).derivations.find((d) => d.requirementId === "AST-016")?.value).toBe(9);
    expect(out(half)).toBe("a contribution ratio on a half");
    // Reserves: a second home's 2 months, met by 1.96 rounded to 2.0.
    const secondHome = (balance: number) =>
      withFile(WORKED, {
        property: { ...WORKED.property, occupancy: "second_home" },
        borrowers: [
          {
            ...borrower1,
            occupies_property: false,
            assets: { accounts: [{ ...borrower1.assets!.accounts[0]!, balance_cents: balance }] },
          },
        ],
      });
    const twoMonths = secondHome(10_642_500 + Math.ceil(313_244 * 1.96));
    expect([decide(twoMonths).reserves.actualMonths, decide(twoMonths).reserves.satisfied]).toEqual(
      [2, true],
    );
    expect(out(twoMonths)).toBe("reserve months whose rounding crosses the requirement");
    expect(out(secondHome(10_642_500 + 313_244 * 2))).toBeNull();
    // The recoup: $5,925 over a $98.68 saving is 60.04 months, rounded to 60.0.
    const recoup = withFile(refi, {
      loan: {
        ...refi.loan,
        existing_loan: { ...refi.loan.existing_loan!, monthly_payment_cents: 179_865 + 9_868 },
      },
    });
    expect(decide(recoup).compliance.netTangibleBenefit).toMatchObject({
      recoupMonths: 60,
      satisfied: true,
    });
    expect(out(recoup)).toBe("a recoup whose rounding crosses 60 months");

    // Seasoning counts calendar months and ignores the day: 27 July 2022 to 20 June 2026 is 47.
    const discharged = (on: string, filed = "2022-02-14") =>
      withBorrower({
        credit: {
          ...credit1,
          public_records: [{ type: "bankruptcy", date: filed, chapter: "7", discharged_on: on }],
        },
      });
    const late = discharged("2022-07-27");
    expect(decide(late).derivations.find((d) => d.requirementId === "CRD-006")?.value).toBe(47);
    expect(monthsBetween(plainDate("2022-07-27"), plainDate("2026-06-20"))).toBe(46);
    expect(out(late)).toBe("a seasoning record dated on the 1st or after the decision's day");
    expect(out(discharged("2022-07-01", "2022-03-01"))).toBe(
      "a seasoning record dated on the 1st or after the decision's day",
    );
    expect(out(discharged("2022-06-15"))).toBeNull();
    // Two records of one kind on one margin.
    const tied = withBorrower({
      credit: {
        ...credit1,
        public_records: [
          { type: "bankruptcy", date: "2021-02-08", chapter: "7", discharged_on: "2022-06-15" },
          { type: "bankruptcy", date: "2018-02-08", chapter: "13", discharged_on: "2024-06-15" },
        ],
      },
    });
    expect(out(tied)).toBe("two seasoning records of one kind with the same margin or date");

    // Two different debts sharing the key a joint debt is known by are merged by the engine.
    const auto = (payment: number) => ({
      creditor: "Harbor Auto Finance",
      type: "auto" as const,
      opened_on: "2023-04-11",
      balance_cents: 3_000_000,
      credit_limit_cents: null,
      monthly_payment_cents: payment,
      dti_exclusion: null,
    });
    const merged = withFile(WORKED, {
      borrowers: [
        { ...borrower1, credit: { ...credit1, tradelines: [auto(40_000)] } },
        {
          ...borrower1,
          name: "Rowan Ashdown",
          credit: { ...credit1, tradelines: [auto(55_000)] },
          assets: { accounts: [] },
        },
      ],
    });
    expect(decide(merged).derivations.find((d) => d.label === "Monthly liabilities")?.value).toBe(
      400,
    );
    expect(out(merged)).toBe("two different tradelines or accounts sharing one key");
    const joint = withFile(WORKED, {
      borrowers: [
        merged.borrowers[0]!,
        { ...merged.borrowers[1]!, credit: { ...credit1, tradelines: [auto(40_000)] } },
      ],
    });
    expect(out(joint)).toBeNull();

    // The collateral the engine's maximum does not read.
    const typed = (type: AusTask["property"]["type"], loan: number) =>
      withFile(WORKED, {
        property: { ...WORKED.property, type },
        loan: { ...WORKED.loan, amount_cents: loan },
      });
    expect(out(typed("two_to_four_unit", 45_000_000))).toBe("a two-to-four-unit property over 75%");
    expect(out(typed("manufactured", 42_500_000))).toBe("a manufactured home over 80%");
    expect(
      out(
        withFile(WORKED, {
          property: { ...WORKED.property, value_cents: 100_000_000 },
          loan: { ...WORKED.loan, amount_cents: 90_000_000 },
          income_sources: [
            { type: "base_wage", monthly_cents: 4_000_000, continuance_established: true },
          ],
          borrowers: [
            {
              ...borrower1,
              assets: {
                accounts: [{ ...borrower1.assets!.accounts[0]!, balance_cents: 30_000_000 }],
              },
            },
          ],
        }),
      ),
    ).toBe("a loan over the conforming limit above 80%");
    const heloc = withFile(refi, {
      loan: {
        ...refi.loan,
        junior_lien_balance_cents: 10_000_000,
        junior_lien_credit_limit_cents: 18_000_000,
      },
    });
    expect(out(heloc)).toBeNull();
    const overLine = withFile(refi, {
      loan: {
        ...refi.loan,
        junior_lien_balance_cents: 10_000_000,
        junior_lien_credit_limit_cents: 18_500_100,
      },
    });
    expect(out(overLine)).toBe("junior liens over the maximum");
    // A purchase's second lien pays part of the price, which funds to close never subtracts.
    const piggyback = withFile(WORKED, {
      loan: {
        ...WORKED.loan,
        junior_lien_balance_cents: 5_000_000,
        junior_lien_credit_limit_cents: 5_000_000,
      },
    });
    expect(decide(piggyback).derivations.find((d) => d.label === "Funds to close")?.value).toBe(
      106_425,
    );
    expect(out(piggyback)).toBe("junior liens on a purchase");

    // A refinance whose loan pays out more than the payoff and the costs: funds below zero.
    const cashBack = withFile(refi, {
      loan: {
        ...refi.loan,
        existing_loan: { ...refi.loan.existing_loan!, balance_cents: 29_000_000 },
      },
    });
    expect(out(cashBack)).toBe("funds to close below zero");

    // A finding or a blocked requirement the rulebook does not name.
    const injected =
      (extra: AusAnalysis["decision"]["derivations"][number]) =>
      (t: AusTask): AusAnalysis => {
        const x = analyzeAus(t);
        return {
          ...x,
          decision: { ...x.decision, derivations: [...x.decision.derivations, extra] },
        };
      };
    expect(
      ausInScope(
        WORKED,
        injected({ requirementId: "UW-012", label: "x", value: 1, formula: "", inputs: {} }),
      ),
    ).toBe(true);
    expect(
      ausInScope(
        WORKED,
        injected({
          requirementId: "INC-026",
          label: "x",
          value: null,
          formula: "",
          inputs: {},
          blockedBy: ["x"],
        }),
      ),
    ).toBe(false);
  });

  it("puts every case a wrong reading of one rule turns on into the held-out suite, three or more of each", () => {
    // Each line is the held-out files on which a wrong reading of one rule answers differently
    // from the engine. A suite without them scores the wrong reading as it scores the right one.
    const held = generateAusSuite("heldout", AUS_HELDOUT_SUITE.seed, AUS_HELDOUT_SUITE.n).map(
      (t) => ({ t, a: expectedAus(t), x: analyzeAus(t) }),
    );
    type H = (typeof held)[number];
    const milli = (x: string) => Math.round(Number(x) * 1000);
    const spread = (h: H) =>
      h.a.apr_pct === null || h.a.apor_pct === null
        ? null
        : milli(h.a.apr_pct) - milli(h.a.apor_pct);
    const own = (b: AusBorrower) => {
      const s = (b.credit?.scores ?? []).map((x) => x.score).sort((p, q) => p - q);
      return s.length >= 3 ? s[1]! : (s[0] ?? null);
    };
    const reference = (p: { date: string; discharged_on: string | null }) =>
      p.discharged_on ?? p.date;
    /** Two or more records of a kind, and the one that decides is not the most recent. */
    const olderDecides = (h: H, id: string, bankruptcy: boolean) => {
      const records = h.t.borrowers
        .flatMap((b) => b.credit?.public_records ?? [])
        .filter((p) => (p.type === "bankruptcy") === bankruptcy);
      const decided = h.x.decision.derivations.find((d) => d.requirementId === id);
      const at = decided?.inputs[bankruptcy ? "discharge_date" : "event_date"];
      return records.length > 1 && at !== records.map(reference).sort().at(-1);
    };
    const nyDate = (h: H) =>
      h.x.decision.derivations.find((d) => d.label === "Average prime offer rate")?.inputs[
        "rate_set_on"
      ] ?? null;
    const weekOn = (date: string, term: number) => {
      try {
        return (
          JSON.parse(executeAusTool("apor", { date, term_years: term / 12 })) as { week_of: string }
        ).week_of;
      } catch {
        return null;
      }
    };
    const cases: Record<string, (h: H) => boolean> = {
      "the most recent record decides": (h) =>
        olderDecides(h, "CRD-006", true) || olderDecides(h, "CRD-007", false),
      "two own scores averaged and truncated": (h) =>
        h.t.borrowers.length === 2 &&
        h.a.fico_for_minimum !== null &&
        ((own(h.t.borrowers[0]!) ?? 0) + (own(h.t.borrowers[1]!) ?? 0)) % 2 === 1,
      "a back-end ratio of 45.00 elevated": (h) => h.a.dti_back_pct === "45.00",
      "45.01 truncated to 45.00": (h) => h.a.dti_back_pct === "45.01",
      "a ratio of 50.00 past the maximum": (h) => h.a.dti_back_pct === "50.00",
      "an LTV at its maximum past it": (h) => h.a.ltv_pct === `${h.a.max_ltv_pct}.00`,
      "a non-occupant co-borrower's 95% ignored": (h) =>
        h.a.max_ltv_pct === 95 && milli(h.a.ltv_pct) > 95_000,
      "the APR given on an LTV that shows 80.00": (h) =>
        h.a.ltv_pct === "80.00" && h.a.apr_pct === null,
      "the 75% band closed at 75.00": (h) =>
        h.a.ltv_pct === "75.00" && milli(h.a.ipc_ratio_pct) > 6_000,
      "a contribution at its cap past it": (h) => h.a.ipc_ratio_pct === `${h.a.ipc_cap_pct}.00`,
      "reserve months at the requirement short of it": (h) =>
        h.a.required_reserve_months > 0 &&
        h.a.actual_reserve_months === `${h.a.required_reserve_months}.0`,
      "a recoup of 60.0 past the threshold": (h) => h.a.ntb_recoup_months === "60.0",
      "a variance of 10.00 past the tolerance": (h) =>
        h.a.transcript_variance_pct === "10.00" || h.a.transcript_variance_pct === "-10.00",
      "the rate-set date read in UTC": (h) => {
        const ny = nyDate(h);
        const utc = h.t.product.rate_set_at.slice(0, 10);
        return (
          ny !== null && ny !== utc && weekOn(utc, h.t.product.term_months) !== h.a.apor_week_of
        );
      },
      "a 2025 rate judged on 2026's thresholds": (h) => String(nyDate(h)).startsWith("2025"),
      "the HPML line of 1.5 on a jumbo loan": (h) =>
        h.t.loan.amount_cents > 83_275_000 && (spread(h) ?? 0) >= 1_500,
      "the General QM line of 2.25 on every loan": (h) =>
        h.a.qm_status === "qm" && (spread(h) ?? 0) >= 2_250,
      "HOEPA reaching a second home or investment property": (h) =>
        h.t.property.occupancy !== "primary_residence" && h.a.points_and_fees_pass === false,
      "a saving of nothing satisfied": (h) =>
        h.a.ntb_satisfied === false && h.a.ntb_recoup_months === null,
      "UW-010 left open beside a blocked CRD-002": (h) => h.a.blocked.includes("CRD-002"),
      "a base wage under review taken for none": (h) =>
        h.t.income_sources.some((s) => s.type === "base_wage") &&
        h.t.income_sources.every((s) => s.continuance_established !== true),
    };
    const thin = Object.entries(cases)
      .map(([name, f]) => [name, held.filter(f).length] as const)
      .filter(([, n]) => n < 3);
    expect(thin).toEqual([]);
  });

  it("names the outcome as an episode's verdict for the audit, and reads no figure as arithmetic done in its head", async () => {
    const r = await runEpisode(ausDecision, WORKED, new AusReferencePolicy());
    const record: AuditRecord = {
      task: { id: WORKED.id, split: "spec", index: 0, rendered: ausDecision.render(WORKED) },
      policy: { id: "reference" },
      result: r as unknown as AuditRecord["result"],
    };
    const row = auditEpisode(record);
    expect(row.verdict).toBe("clear_to_close");
    expect(row.mental).toEqual([]);
  });

  it("decides the same in every time zone", () => {
    const run = (zone: string) => {
      const child = spawnSync(process.execPath, ["--import", "tsx", here("./aus-time-zone.ts")], {
        env: { ...process.env, TZ: zone },
        encoding: "utf8",
      });
      expect(child.status, child.stderr).toBe(0);
      return JSON.parse(child.stdout.trim()) as {
        zone: string;
        offset: number;
        month: number;
        tasks: number;
        sha256: string;
      };
    };
    const york = run("America/New_York");
    const tokyo = run("Asia/Tokyo");
    // Each child ran in its zone: 23:30 UTC on 30 June is still June in New York and July in Tokyo.
    expect([york.zone, york.offset, york.month]).toEqual(["America/New_York", 240, 5]);
    expect([tokyo.zone, tokyo.offset, tokyo.month]).toEqual(["Asia/Tokyo", -540, 6]);
    expect(york.tasks).toBe(SPEC.length + 140);
    expect(tokyo.sha256).toBe(york.sha256);
  }, 120_000);

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump AUS_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(
        generateAusSuite("heldout", AUS_HELDOUT_SUITE.seed, AUS_HELDOUT_SUITE.n)
          .map(toJsonLine)
          .join(""),
      ),
    ).toMatchInlineSnapshot(`"b6f3623d60c9a1a5e7a6b68a5e92e6236631e1d31b07a3a34cccb7893b3c29c1"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out file into training", () => {
    expect(toJsonLine(generateAusTask("train", 7, 17))).toBe(
      toJsonLine(generateAusSuite("train", 7, 30)[17]),
    );
    const fp = (t: AusTask) => toJsonLine(ausPayload(t));
    const held = new Set(generateAusSuite("heldout", 1, 200).map(fp));
    expect(generateAusSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  }, 60_000);

  describe("each outcome and edge turns up", () => {
    const runs = generateAusSuite("train", 1, AUS_EDGES.length * 200).map((t, i) => ({
      t,
      a: expectedAus(t),
      x: analyzeAus(t),
      edge: ausEdgeOf(i),
    }));
    type Run = (typeof runs)[number];
    const count = (f: (r: Run) => boolean) => runs.filter(f).length;
    const on = (edge: string, f: (r: Run) => boolean) => count((r) => r.edge === edge && f(r));
    const exactLtv = (r: Run) => (r.t.loan.amount_cents * 10_000) / r.t.property.value_cents;

    it("cycles through every edge, two hundred files each", () => {
      for (const e of AUS_EDGES)
        expect(
          count((r) => r.edge === e),
          e,
        ).toBe(200);
    });

    it("reaches every outcome, recommendation, finding and blocked requirement", () => {
      for (const o of OUTCOMES)
        expect(
          count((r) => r.a.outcome === o),
          o,
        ).toBeGreaterThan(40);
      for (const rec of RECOMMENDATIONS)
        expect(
          count((r) => r.a.recommendation === rec),
          rec,
        ).toBeGreaterThan(40);
      for (const f of FINDING_CODES)
        expect(
          count((r) => r.a.findings.includes(f)),
          f,
        ).toBeGreaterThan(10);
      for (const b of BLOCKABLE)
        expect(
          count((r) => r.a.blocked.includes(b)),
          b,
        ).toBeGreaterThan(10);
      // An eligibility finding while inputs block is a counteroffer; a high-cost loan is denied over both.
      expect(
        count((r) => r.a.outcome === "counteroffer" && r.a.blocked.length > 0),
      ).toBeGreaterThan(20);
      expect(count((r) => r.a.outcome === "denied" && r.a.blocked.length > 0)).toBeGreaterThan(5);
      expect(count((r) => r.a.outcome === "referred" && r.a.findings.length > 0)).toBeGreaterThan(
        20,
      );
    });

    it("draws the 80% line exactly, a dollar over it showing 80.00, and each maximum and a hundredth past it", () => {
      expect(on("ltv_eighty", (r) => exactLtv(r) === 8000 && r.a.apr_pct !== null)).toBeGreaterThan(
        20,
      );
      expect(
        on(
          "ltv_eighty",
          (r) => r.a.ltv_pct === "80.00" && exactLtv(r) > 8000 && r.a.apr_pct === null,
        ),
      ).toBeGreaterThan(20);
      for (const max of [97, 90, 85, 95]) {
        expect(
          on("ltv_maximum", (r) => r.a.max_ltv_pct === max && exactLtv(r) === max * 100),
          `${max}`,
        ).toBeGreaterThan(5);
        expect(
          on(
            "ltv_maximum",
            (r) => r.a.max_ltv_pct === max && r.a.findings.includes("LTV_EXCEEDS_MAXIMUM"),
          ),
          `${max} over`,
        ).toBeGreaterThan(5);
      }
      expect(
        on("ltv_maximum", (r) => refinance(r.t) && r.a.findings.includes("LTV_EXCEEDS_MAXIMUM")),
      ).toBeGreaterThan(5);
    });

    it("draws the back-end ratio at 45.00, 45.01 and 50.00, with joint, excluded and pending lines", () => {
      for (const at of ["45.00", "45.01", "50.00"])
        expect(
          on("dti", (r) => r.a.dti_back_pct === at),
          at,
        ).toBeGreaterThan(20);
      expect(
        on("dti", (r) =>
          r.x.decision.derivations.some(
            (d) =>
              d.label === "Monthly liabilities" &&
              (d.inputs["joint_tradelines_deduplicated"] as number) > 0,
          ),
        ),
      ).toBeGreaterThan(20);
      expect(
        count((r) =>
          r.t.borrowers.some((b) => b.credit?.tradelines.some((t) => t.dti_exclusion !== null)),
        ),
      ).toBeGreaterThan(100);
      expect(
        count(
          (r) =>
            r.t.income_sources.some((s) => s.continuance_established !== true) &&
            r.a.qualifying_income_cents !== "0",
        ),
      ).toBeGreaterThan(100);
    });

    it("draws a low bureau the middle score passes over, an own score of 620, one and two scores, an average on a half, and no scores", () => {
      const own = (b: AusBorrower) => {
        const s = b.credit!.scores.map((x) => x.score).sort((p, q) => p - q);
        return s.length >= 3 ? s[1]! : s[0]!;
      };
      expect(
        on(
          "scores",
          (r) =>
            r.t.borrowers[0]!.credit!.scores.some((s) => s.score < 620) &&
            r.a.representative_fico !== null,
        ),
      ).toBeGreaterThan(10);
      expect(on("scores", (r) => r.a.representative_fico === 620)).toBeGreaterThan(20);
      for (const n of [1, 2, 3])
        expect(
          count((r) => r.t.borrowers[0]!.credit?.scores.length === n),
          `${n}`,
        ).toBeGreaterThan(20);
      expect(
        on(
          "scores",
          (r) =>
            r.t.borrowers.length === 2 &&
            (own(r.t.borrowers[0]!) + own(r.t.borrowers[1]!)) % 2 === 1,
        ),
      ).toBeGreaterThan(20);
      expect(
        on("scores", (r) => r.a.blocked.includes("CRD-002") && !r.a.blocked.includes("CRD-016")),
      ).toBeGreaterThan(20);
    });

    it("draws each seasoning minimum met and missed by a month, a filing date for a reference, and an older record deciding", () => {
      const record = (r: Run, id: string) =>
        r.x.decision.derivations.find((d) => d.requirementId === id);
      for (const [id, minimum] of [
        ["CRD-006", 24],
        ["CRD-006", 48],
        ["CRD-007", 84],
        ["CRD-007", 48],
      ] as const) {
        for (const months of [minimum, minimum - 1])
          expect(
            on(
              "seasoning",
              (r) =>
                record(r, id)?.value === months &&
                record(r, id)?.inputs["minimum_months"] === minimum,
            ),
            `${id} ${minimum} at ${months}`,
          ).toBeGreaterThan(3);
      }
      expect(
        on("seasoning", (r) =>
          r.t.borrowers.some((b) =>
            b.credit?.public_records.some(
              (p) => p.type === "bankruptcy" && p.discharged_on === null,
            ),
          ),
        ),
      ).toBeGreaterThan(5);
      // The deciding record is not the most recent.
      expect(
        on("seasoning", (r) => {
          const xs = r.t.borrowers
            .flatMap((b) => b.credit?.public_records ?? [])
            .filter((p) => p.type === "bankruptcy");
          const latest = [...xs].sort((p, q) =>
            (q.discharged_on ?? q.date) < (p.discharged_on ?? p.date) ? -1 : 1,
          )[0];
          return (
            xs.length === 2 &&
            record(r, "CRD-006")?.inputs["discharge_date"] !==
              (latest?.discharged_on ?? latest?.date)
          );
        }),
      ).toBeGreaterThan(10);
      expect(
        on(
          "seasoning",
          (r) => r.t.borrowers.length === 2 && r.t.borrowers[1]!.credit!.public_records.length > 0,
        ),
      ).toBeGreaterThan(10);
    });

    it("draws late Sunday in New York, the year's first day each side of midnight there, the table's last day, an ARM, 25 years and a penalty", () => {
      const ny = (r: Run) =>
        r.x.decision.derivations.find((d) => d.label === "Average prime offer rate")?.inputs[
          "rate_set_on"
        ];
      const sunday = (r: Run) => {
        const d = plainDate(r.t.product.rate_set_at.slice(0, 10));
        return new Date(`${d}T12:00:00Z`).getUTCDay() === 1 && ny(r) === addDays(d, -1);
      };
      expect(on("rate_set", sunday)).toBeGreaterThan(10);
      expect(
        on(
          "rate_set",
          (r) => ny(r) === "2025-12-31" && r.a.qm_status === null && r.a.blocked.includes("UW-007"),
        ),
      ).toBeGreaterThan(10);
      expect(
        on("rate_set", (r) => ny(r) === "2026-01-01" && r.a.qm_status === "qm"),
      ).toBeGreaterThan(10);
      expect(
        on("rate_set", (r) => ny(r) === "2026-09-20" && r.a.apor_week_of === "2026-09-14"),
      ).toBeGreaterThan(10);
      expect(
        on("rate_set", (r) => r.t.product.rate_set_at >= "2026-09-21T04" && r.a.apor_pct === null),
      ).toBeGreaterThan(10);
      expect(on("rate_set", (r) => r.t.product.amortization === "AdjustableRate")).toBeGreaterThan(
        10,
      );
      expect(
        on(
          "rate_set",
          (r) => r.t.product.term_months === 300 && r.a.apr_pct !== null && r.a.apor_pct === null,
        ),
      ).toBeGreaterThan(10);
      expect(
        on("rate_set", (r) => r.t.product.prepayment_penalty && r.a.blocked.includes("UW-009")),
      ).toBeGreaterThan(5);
      expect(
        on("rate_set", (r) => r.t.product.prepayment_penalty && r.a.outcome === "clear_to_close"),
      ).toBeGreaterThan(5);
    });

    it("draws spreads under each line: HPML at 1.5 and 2.5, each General QM threshold on its tier, a manufactured home", () => {
      const spread = (r: Run) =>
        r.a.apr_pct === null || r.a.apor_pct === null
          ? null
          : Math.round(Number(r.a.apr_pct) * 1000) - Math.round(Number(r.a.apor_pct) * 1000);
      const loan = (r: Run) => r.t.loan.amount_cents;
      expect(
        on("price_tests", (r) => r.a.is_hpml === false && (spread(r) ?? 0) >= 1375),
      ).toBeGreaterThan(20);
      expect(
        on(
          "price_tests",
          (r) => loan(r) > 83_275_000 && (spread(r) ?? 0) >= 1500 && r.a.is_hpml === false,
        ),
      ).toBeGreaterThan(10);
      expect(on("price_tests", (r) => loan(r) === 83_275_000)).toBeGreaterThan(2);
      expect(
        on(
          "price_tests",
          (r) => loan(r) >= 13_795_800 && r.a.is_hpml === null && (spread(r) ?? 0) >= 2000,
        ),
      ).toBeGreaterThan(10);
      expect(
        on(
          "price_tests",
          (r) => loan(r) < 13_795_800 && loan(r) >= 8_277_500 && (spread(r) ?? 0) >= 2250,
        ),
      ).toBeGreaterThan(10);
      expect(
        on("price_tests", (r) => loan(r) < 8_277_500 && (spread(r) ?? 0) >= 3500),
      ).toBeGreaterThan(10);
      expect(
        on("price_tests", (r) => r.t.property.type === "manufactured" && (spread(r) ?? 0) >= 2250),
      ).toBeGreaterThan(10);
      for (const r of runs) {
        // Never a spread a test would call higher-priced or non-QM.
        expect(r.a.qm_status).not.toBe("non_qm");
        expect(r.a.is_hpml).not.toBe(true);
      }
    });

    it("draws the high-cost line to the dollar, the small-loan tiers, and a second home's counteroffer", () => {
      expect(
        on("small_loan", (r) => r.t.loan.amount_cents === 3_730_700 && r.a.outcome === "denied"),
      ).toBeGreaterThan(3);
      expect(
        on(
          "small_loan",
          (r) => r.t.loan.amount_cents === 3_730_800 && r.a.points_and_fees_pass === true,
        ),
      ).toBeGreaterThan(3);
      for (const loan of [2_759_100, 2_759_200, 1_724_600])
        expect(
          on("small_loan", (r) => r.t.loan.amount_cents === loan),
          `${loan}`,
        ).toBeGreaterThan(2);
      expect(
        on(
          "small_loan",
          (r) =>
            r.t.property.occupancy !== "primary_residence" &&
            r.a.outcome === "counteroffer" &&
            r.a.is_high_cost === null,
        ),
      ).toBeGreaterThan(20);
      expect(
        on("small_loan", (r) => r.a.outcome === "denied" && r.a.apr_pct === null),
      ).toBeGreaterThan(5);
    });

    it("draws a scheduled payment, a saving of nothing, and the recoup at 60.0 and 60.1", () => {
      expect(on("ntb", (r) => r.a.blocked.includes("APP-019"))).toBeGreaterThan(20);
      expect(
        on("ntb", (r) => r.a.ntb_satisfied === false && r.a.ntb_recoup_months === null),
      ).toBeGreaterThan(20);
      expect(
        on("ntb", (r) => r.a.ntb_recoup_months === "60.0" && r.a.ntb_satisfied === true),
      ).toBeGreaterThan(20);
      expect(
        on("ntb", (r) => r.a.ntb_recoup_months === "60.1" && r.a.ntb_satisfied === false),
      ).toBeGreaterThan(20);
      expect(on("ntb", (r) => r.t.loan.existing_loan!.rate_pct === null)).toBeGreaterThan(5);
    });

    it("draws reserves at the requirement and a tenth under it, retirement at 60%, joint and unused accounts", () => {
      for (const required of [2, 6])
        for (const satisfied of [true, false])
          expect(
            on(
              "reserves",
              (r) =>
                r.a.required_reserve_months === required &&
                r.a.reserves_satisfied === satisfied &&
                Math.abs(Number(r.a.actual_reserve_months) - required) < 0.15,
            ),
            `${required} ${satisfied}`,
          ).toBeGreaterThan(5);
      expect(
        on(
          "reserves",
          (r) => r.t.property.occupancy === "primary_residence" && r.a.required_reserve_months > 0,
        ),
      ).toBeGreaterThan(20);
      expect(
        count((r) =>
          r.t.borrowers.some((b) => b.assets?.accounts.some((a) => a.type === "retirement")),
        ),
      ).toBeGreaterThan(100);
      expect(
        count((r) =>
          r.x.decision.derivations.some(
            (d) => (d.inputs["joint_accounts_deduplicated"] as number) > 0,
          ),
        ),
      ).toBeGreaterThan(100);
      expect(
        count((r) => r.t.borrowers.some((b) => b.assets?.accounts.some((a) => !a.used_to_qualify))),
      ).toBeGreaterThan(100);
    });

    it("draws contributions at each cap and a hundredth over, and the 75% and 90% band lines", () => {
      for (const cap of [9, 6, 3, 2]) {
        expect(
          on("ipc", (r) => r.a.ipc_cap_pct === cap && r.a.ipc_ratio_pct === `${cap}.00`),
          `${cap}`,
        ).toBeGreaterThan(3);
        expect(
          on("ipc", (r) => r.a.ipc_cap_pct === cap && r.a.findings.includes("IPC_EXCEEDS_LIMIT")),
          `${cap} over`,
        ).toBeGreaterThan(3);
      }
      for (const line of ["75.00", "75.01", "90.00", "90.01"])
        expect(
          on("ipc", (r) => r.a.ltv_pct === line),
          line,
        ).toBeGreaterThan(3);
    });

    it("draws the transcript variance at 10.00 and 10.01 either way, two borrowers' latest years, and one without", () => {
      for (const v of ["10.00", "10.01", "-10.00", "-10.01"])
        expect(
          on("transcripts", (r) => r.a.transcript_variance_pct === v),
          v,
        ).toBeGreaterThan(10);
      expect(
        on(
          "transcripts",
          (r) => r.t.borrowers.length === 2 && r.a.transcript_variance_pct !== null,
        ),
      ).toBeGreaterThan(20);
      expect(
        on(
          "transcripts",
          (r) =>
            r.t.borrowers.some((b) => b.transcripts.length === 2) &&
            r.a.transcript_variance_pct !== null,
        ),
      ).toBeGreaterThan(20);
      expect(
        on(
          "transcripts",
          (r) =>
            r.t.borrowers.some((b) => b.transcripts.length > 0) &&
            r.a.transcript_variance_pct === null,
        ),
      ).toBeGreaterThan(10);
    });

    it("draws a missing credit report, no asset reports, no established income, and a wage earner with no base wage", () => {
      expect(
        on(
          "missing",
          (r) =>
            r.t.borrowers.length === 2 &&
            r.t.borrowers[1]!.credit === null &&
            r.t.borrowers[0]!.credit !== null,
        ),
      ).toBeGreaterThan(20);
      expect(on("missing", (r) => r.t.borrowers[0]!.credit === null)).toBeGreaterThan(20);
      expect(on("missing", (r) => r.a.blocked.includes("AST-004"))).toBeGreaterThan(20);
      expect(
        on("missing", (r) => r.a.qualifying_income_cents === "0" && r.a.dti_front_pct === null),
      ).toBeGreaterThan(20);
      expect(
        on("missing", (r) => r.a.blocked.includes("INC-004") && r.a.qm_status === "qm"),
      ).toBeGreaterThan(20);
      for (const r of runs.filter((x) => !x.a.atr_documented)) expect(r.a.qm_status).toBeNull();
    });

    it("keeps every record off the 1st and on or before the decision's day, so calendar and whole months agree", () => {
      for (const r of runs) {
        const day = parts(plainDate(r.t.decided_at.slice(0, 10))).d;
        for (const b of r.t.borrowers)
          for (const p of b.credit?.public_records ?? []) {
            const ref = plainDate(p.discharged_on ?? p.date);
            expect(parts(ref).d).toBeGreaterThan(1);
            expect(parts(ref).d).toBeLessThanOrEqual(day);
          }
      }
    });
  });
});
