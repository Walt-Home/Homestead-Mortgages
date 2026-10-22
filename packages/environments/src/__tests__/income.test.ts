/**
 * qualifying-income: the grader is the servicing app's income engine and no
 * other (each port is its file byte for byte but the imports), and the
 * service conventions it restates are held to the service's own lines; it
 * gives spec §22.3's worked examples to the cent; it reproduces each place
 * the engine departs from its spec, and the guard keeps every one out; the
 * rulebook followed through the tools lands where the engine does on every
 * generated application and on unfiltered draws the guard never saw; and
 * each configuration that decides an answer turns up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addDays, addMonths, daysBetween, type PlainDate } from "@hm/kernel/calendar";
import type { EventStore } from "@hm/kernel/events";
import { describe, expect, it } from "vitest";
import { auditEpisode, type AuditRecord } from "../audit.js";
import { runEpisode } from "../episode.js";
import { drawsHeldoutStream, namespaceOf } from "../heldout-guard.js";
import { sha256, toJsonLine } from "../record.js";
import { solveNow } from "../refi/reference.js";
import { rngFor } from "../rng.js";
import {
  ASSISTANCE_PAY_CEILING_CENTS,
  FLOAT_SAFE_HIGH_WEEKS,
  INCOME_EDGES,
  INCOME_FINGERPRINT,
  INCOME_HELDOUT_SUITE,
  INCOME_RULEBOOK,
  INCOME_SPEC_NAMES,
  INCOME_TOOLS,
  IncomeReferencePolicy,
  ROW_FIELDS,
  analyzeIncome,
  drawIncomeCandidate,
  drawIncomeTask,
  exactHourlyClass,
  exactTrend,
  executeIncomeTool,
  expectedIncome,
  generateIncomeSuite,
  generateIncomeTask,
  gradeIncomeAgainst,
  incomeAimOf,
  incomeEdgeOf,
  incomeFairToGrade,
  incomeInScope,
  incomeOutOfScope,
  incomePayload,
  incomeSpecTasks,
  incomeSteps,
  incomeTaskId,
  monthsIncludedTrend,
  PAYSTUB_MAX_AGE_DAYS,
  PERIODS_PER_YEAR,
  parseIncomeSubmission,
  qualifyingIncome,
  renderIncomeTask,
  sourcesOf,
  type ChildSupportSource,
  type HourlySource,
  type IncomeAnswer,
  type IncomeSource,
  type IncomeTask,
  type SocialSecuritySource,
  type SourceRow,
  type VariableSource,
} from "../income/index.js";
import * as engine from "../income/ported/ops-22-3.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const servicing = (p: string) => readFileSync(here(`../../../../apps/servicing/src/${p}`), "utf8");
const imports = (text: string) => text.split("\n").filter((l) => l.startsWith("import "));
const withoutImports = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith("import "))
    .join("\n");
/** Each import line with its module path removed: what it imports, and how. */
const importHeads = (text: string) => imports(text).map((l) => l.replace(/ from "[^"]+";$/, ""));
/** The port's two rewrites, and no more: the kernel's paths become the package's, a sibling's .ts its .js. */
const rewritten = (lines: readonly string[]) =>
  lines.map((l) =>
    l
      .replace(/"\.\.\/\.\.\/kernel\/(calendar|money|events)\/[a-z-]+\.ts"/g, '"@hm/kernel/$1"')
      .replace(/"\.\/([a-z0-9-]+)\.ts"/g, '"./$1.js"'),
  );
/** A run of source lines with the lines the grader cites them by. */
const cited = (file: string, from: number, to: number) =>
  [
    `${file}:${from}-${to}`,
    ...servicing(file)
      .split("\n")
      .slice(from - 1, to),
  ].join("\n");

/** The engine's calculateIncome, which appends an event: a store that keeps nothing. */
const NO_STORE = { append: (e: object) => ({ ...e, id: "e" }) } as unknown as EventStore;
const dispatched = (income_type: engine.IncomeType, inputs: Record<string, unknown>) =>
  engine.calculateIncome(NO_STORE, {
    application_id: "A",
    borrower_id: "B",
    income_id: "I",
    income_type,
    inputs,
  }).calculation;

const SPEC = incomeSpecTasks();
const rowsOf = (t: IncomeTask) => expectedIncome(t).sources;
/** A spec file with its first borrower's sources replaced. */
const withSources = (t: IncomeTask, sources: IncomeSource[]): IncomeTask => ({
  ...t,
  borrowers: [{ ...t.borrowers[0]!, sources }],
});

const byRulesMisses = (task: IncomeTask): string[] => {
  let raw: unknown;
  try {
    raw = solveNow(incomeSteps, JSON.parse(JSON.stringify(incomePayload(task))), executeIncomeTool);
  } catch (e) {
    return [`${task.id} threw ${e instanceof Error ? e.message : String(e)}`];
  }
  const parsed = parseIncomeSubmission(raw);
  if (!parsed.ok) return [`${task.id} ${parsed.error}`];
  return gradeIncomeAgainst(expectedIncome(task), parsed.answer)
    .fields.filter((f) => !f.ok)
    .map((f) => `${task.id} ${f.field} ${f.expected}/${f.got}`);
};

const solveAll = async (tasks: readonly IncomeTask[]) => {
  const misses: string[] = [];
  let calls = 0;
  let turns = 0;
  for (const task of tasks) {
    const r = await runEpisode(qualifyingIncome, task, new IncomeReferencePolicy());
    calls = Math.max(calls, r.tool_calls);
    turns = Math.max(turns, r.turns);
    if (!r.grade.pass) {
      const wrong = r.grade.fields
        .filter((f) => !f.ok)
        .map((f) => `${f.field} ${f.expected}/${f.got}`);
      misses.push(`${task.id} ${r.outcome} ${r.error ?? ""} ${wrong.join("; ")}`);
    }
  }
  return { misses, calls, turns };
};

describe("qualifying-income", () => {
  it("grades with the servicing app's income engine: each port is its file but for the imports", () => {
    for (const file of ["ops-22-3", "ops-22-1"]) {
      const original = servicing(`domain/verification/${file}.ts`);
      const port = readFileSync(here(`../income/ported/${file}.ts`), "utf8");
      expect(withoutImports(port), file).toBe(withoutImports(original));
      expect(imports(port), file).toEqual(rewritten(imports(original)));
      // The same names, imported the same way, from the kernel the servicing app's copy is.
      expect(importHeads(port), file).toEqual(importHeads(original));
      for (const line of imports(port))
        expect(line, file).toMatch(
          / from "(@hm\/kernel\/(calendar|money|events)|\.\/ops-22-1\.js)";$/,
        );
    }
    // Every import is one line: the rewrite cannot miss half of a statement.
    for (const file of ["ops-22-3", "ops-22-1"])
      expect(
        servicing(`domain/verification/${file}.ts`)
          .split("\n")
          .filter((l) => /^import\b/.test(l) && !l.endsWith(";")),
      ).toEqual([]);
  });

  it("holds the conventions it restates to the service's own lines", () => {
    // A re-vendor that changes any of these fails here: revisit the grader, the rulebook and their citations.
    expect(cited("domain/verification/ops-22-3.ts", 764, 777)).toMatchInlineSnapshot(`
      "domain/verification/ops-22-3.ts:764-777
        switch (r.income_type) {
          case "base_salary": case "second_job": case "military_base": case "military_allowance": calculation = i.monthly_cents !== undefined ? { ...baseMonthly(c("monthly_cents"), flags), income_type: r.income_type } : { ...baseSalary(c("annual_salary_cents"), flags), income_type: r.income_type }; break;
          case "base_hourly_fixed": calculation = hourlyBase({ rate_cents: c("rate_cents"), guaranteed_hours_per_week: n("guaranteed_hours_per_week"), hours_min: n("hours_min"), hours_max: n("hours_max"), avg_hours_per_week: n("avg_hours_per_week") }); break;
          case "base_hourly_variable": if (i.ytd_cents === undefined) { calculation = hourlyBase({ rate_cents: c("rate_cents"), guaranteed_hours_per_week: n("guaranteed_hours_per_week"), hours_min: n("hours_min"), hours_max: n("hours_max"), avg_hours_per_week: n("avg_hours_per_week") }); break; }
          // falls through: a variable-hours source with YTD / prior-year earnings is trended under R3 (B3-3.3-01: "Variable base income refers to a fixed hourly rate with fluctuating hours")
          case "overtime": case "bonus": case "commission": case "tip": case "seasonal": case "rsu": {
            const s = i.stabilization as { since: string; cents_since: bigint | string; months_since: number } | null | undefined;
            const v = variableIncome({ income_type: r.income_type, ytd_cents: c("ytd_cents"), ytd_months: n("ytd_months")!, prior_year_cents: c("prior_year_cents"), stable_band_pct: n("stable_band_pct", STABLE_BAND_PCT_DEFAULT)!, history_months: n("history_months"), stabilization: s ? { since: D(s.since), cents_since: BigInt(s.cents_since), months_since: Number(s.months_since) } : null });
            trendDetail = v.trend_detail; calculation = v; break; }
          case "social_security_retirement": case "social_security_disability": case "social_security_survivor_dependent": calculation = socialSecurity({ amount_cents: c("amount_cents"), record: (i.record as SocialSecurityInput["record"]) ?? "own", benefit: (i.benefit as SocialSecurityInput["benefit"]) ?? "retirement", documented_nontaxable_pct: n("documented_nontaxable_pct"), continuance_end_date: dt("continuance_end_date") }); break;
          case "child_support": case "alimony": case "separate_maintenance": calculation = supportIncome({ amount_cents: c("amount_cents"), kind: r.income_type, receipts_months: n("receipts_months", 0)!, receipts_full_regular_timely: i.receipts_full_regular_timely !== false, agreement_document_id: typeof i.agreement_document_id === "string" ? i.agreement_document_id : null, child_date_of_birth: dt("child_date_of_birth"), term_end_date: dt("term_end_date"), state_extends_support_to: dt("state_extends_support_to") }); break;
          case "retirement_distribution": case "annuity_pension": calculation = retirementDistribution({ monthly_cents: c("monthly_cents"), eligible_balances_cents: ((i.eligible_balances_cents as (bigint | string)[] | undefined) ?? []).map((b) => BigInt(b)), unrestricted_penalty_free: i.unrestricted_penalty_free !== false }); break;
          case "public_assistance": case "section_8_homeownership": calculation = publicAssistance({ monthly_cents: c("monthly_cents"), agency_letter_document_id: typeof i.agency_letter_document_id === "string" ? i.agency_letter_document_id : null, duration_end_date: dt("duration_end_date") }); break;
          case "temporary_leave": calculation = temporaryLeaveIncome({ regular_income_cents: c("regular_income_cents"), leave_income_cents: i.leave_income_cents === null || i.leave_income_cents === undefined ? null : c("leave_income_cents"), return_date: dt("return_date")!, first_payment_due_date: dt("first_payment_due_date")!, borrower_intent_to_return_document_id: String(i.borrower_intent_to_return_document_id ?? ""), employer_return_confirmation_document_id: String(i.employer_return_confirmation_document_id ?? "") }); break;"
    `);
    expect(cited("domain/verification/ops-22-3.ts", 778, 781)).toMatchInlineSnapshot(`
      "domain/verification/ops-22-3.ts:778-781
          case "rental_subject": case "rental_non_subject": case "rental_departing_residence": case "rental_short_term": {
            const rr = subjectRental({ gross_rent_cents: c("gross_rent_cents"), pitia_cents: c("pitia_cents"), transaction: (i.transaction as "purchase" | "refinance") ?? "purchase", management_experience_months: n("management_experience_months"), fair_rental_days: n("fair_rental_days"), lease_term_months: n("lease_term_months"), on_1040: i.on_1040 !== false });
            calculation = calc({ income_type: r.income_type, formula_version: rr.formula_version, inputs: { gross_rent_cents: String(c("gross_rent_cents")), pitia_cents: String(c("pitia_cents")), management_experience_months: n("management_experience_months"), fair_rental_days: n("fair_rental_days"), offset_only: rr.offset_only, liability_added_cents: String(rr.liability_added_cents) },
              steps: [{ label: "net = round(gross × 75%)", cents: String(rr.net_cents) }, { label: "anri = net − PITIA", cents: String(rr.anri_cents) }, { label: rr.offset_only ? "positive ANRI, < 12 months experience → offset only" : rr.anri_cents < 0n ? "negative ANRI → monthly obligation (22.5)" : "positive ANRI → income", cents: String(rr.income_added_cents) }], monthly_qualifying_cents: rr.income_added_cents, reason: rr.reason }); break; }"
    `);
    expect(cited("domain/verification/ops-22-3.ts", 791, 791)).toMatchInlineSnapshot(`
      "domain/verification/ops-22-3.ts:791-791
        const regb = regbCheck({ income_type: calculation.reclassified_to ?? r.income_type, regb_flags: flags, formula_version: calculation.formula_version, factor: r.factor ?? null, history_months: n("history_months") });"
    `);
    expect(cited("app/tools/section22-3.ts", 74, 74)).toMatchInlineSnapshot(`
      "app/tools/section22-3.ts:74-74
                  income_calculator_report_id: optStr(i, "income_calculator_report_id"), evidence_document_ids: list<string>(i, "evidence_document_ids"), used_for_qualifying: r.calculation.monthly_qualifying_cents > 0n || r.calculation.gross_up_cents > 0n, offset_only: r.calculation.inputs.offset_only === true, calculation_id: calc_id }, ctx);"
    `);
    expect(cited("app/tools/section22-3.ts", 81, 85)).toMatchInlineSnapshot(`
      "app/tools/section22-3.ts:81-85
              case "continuance": {
                need(i, "income_id", "income_type"); const noteDate = noteDateOf(i, ctx, app);
                const r = evaluateContinuance(ctx.events, { application_id: app, income_id: str(i, "income_id"), income_type: str(i, "income_type") as IncomeType, note_date: noteDate, continuance_end_date: optDate(i, "continuance_end_date"), ...(i.continuance_basis ? { continuance_basis: str(i, "continuance_basis") as "documented_3y" } : {}), qualifying_cents: cents(i.qualifying_cents) }, ctx.actor);
                if (!r.pass) put(rt, "application_income", str(i, "income_id"), { id: str(i, "income_id"), used_for_qualifying: false, exclusion_reason: r.written_reason }, ctx);
                return { income_id: str(i, "income_id"), pass: r.pass, required_through: r.required_through, continuance_end_date: r.continuance_end_date, qualifying_cents: r.qualifying_cents, written_reason: r.written_reason }; }"
    `);
    expect(cited("app/tools/section22-3.ts", 88, 88)).toMatchInlineSnapshot(`
      "app/tools/section22-3.ts:88-88
              case "total": { need(i, "sources"); return totalQualifying(list(i, "sources")); }"
    `);
    expect(cited("domain/verification/evaluators-22-3.ts", 16, 23)).toMatchInlineSnapshot(`
      "domain/verification/evaluators-22-3.ts:16-23
        "22.3.continuance3y": (f) => {
          const note = s(f, "scheduled_note_date"); if (!note) return no("continuance: scheduled_note_date is required to test three years from the note date");
          const endRaw = f.continuance_end_date; const end = typeof endRaw === "string" && endRaw ? D(endRaw) : null;
          const basis = (s(f, "continuance_basis") || (end ? "documented_3y" : "no_expiration")) as ContinuanceBasis;
          if (basis === "n_a") return no("continuance: not documented (B3-3.1-01: the lender must document that the income is expected to continue for at least three years from the note date)");
          const r = continuance3y(end, D(note), basis);
          return r.pass ? ok : no(r.reason ?? "continuance: ends before note date + 3 years");
        },"
    `);
  });

  describe("gives spec §22.3's worked examples to the cent", () => {
    const [r13, t5, t5none, t6fixed, t6var, t7, t8, t9exp, t9new, t9loss, t13] = SPEC.map(rowsOf);
    const totals = SPEC.map((t) => expectedIncome(t));

    it("names every case", () => {
      expect(SPEC).toHaveLength(INCOME_SPEC_NAMES.length);
    });

    it("R2 and R13: $75,000.00 is $6,250.00, example A is $921.43, Social Security $2,075.00, total $9,246.43", () => {
      expect(r13!.map((r) => [r.method, r.monthly_qualifying_cents, r.gross_up_cents])).toEqual([
        ["base_salary", "625000", "0"],
        ["variable_trending", "92143", "0"],
        ["social_security", "200000", "7500"],
        ["rental_subject", "0", "0"],
      ]);
      expect(r13![1]!.trend).toBe("increasing");
      expect(totals[0]).toMatchObject({
        total_qualifying_cents: "924643",
        obligations_from_rental_cents: "35000",
      });
    });

    it("T5: example B stabilized since 1 April is $950.00; with no evidence it is 0", () => {
      expect(t5![0]).toMatchObject({ trend: "decreasing", monthly_qualifying_cents: "95000" });
      expect(analyzeIncome(SPEC[1]!).results[0]!.trend_detail).toMatchObject({
        prior_monthly_cents: 120_000n,
        ytd_monthly_cents: 95_000n,
        change_pct: "-2083",
      });
      expect(t5none![0]).toMatchObject({
        trend: "decreasing",
        monthly_qualifying_cents: "0",
        counted: false,
        exclusion_reason: "not_stabilized",
      });
    });

    it("T6: $32.50 × 40 guaranteed hours is $5,633.33; 28 to 44 hours is variable and trended", () => {
      expect(t6fixed![0]).toMatchObject({
        method: "base_hourly_fixed",
        monthly_qualifying_cents: "563333",
      });
      expect(t6var![0]).toMatchObject({
        method: "variable_base_trending",
        trend: "increasing",
        monthly_qualifying_cents: "495857",
      });
    });

    it("T7: $2,000.00 on the borrower's own record is 30,000 nontaxable, 7,500 gross-up, 207,500", () => {
      expect(t7![0]).toMatchObject({
        nontaxable_cents: "30000",
        gross_up_cents: "7500",
        continuance_end_date: null,
        counted: true,
      });
      expect(totals[5]!.total_qualifying_cents).toBe("207500");
    });

    it("T8 and R6: $800.00 of child support grosses up to $1,000.00; ending 3 March 2029 it fails", () => {
      expect(t8).toEqual([
        {
          income_id: "INC-1",
          method: "support",
          trend: null,
          monthly_qualifying_cents: "80000",
          nontaxable_cents: "80000",
          gross_up_cents: "20000",
          continuance_end_date: "2029-03-03",
          counted: false,
          exclusion_reason: "continuance_3y",
          liability_added_cents: "0",
        },
        {
          income_id: "INC-2",
          method: "support",
          trend: null,
          monthly_qualifying_cents: "80000",
          nontaxable_cents: "80000",
          gross_up_cents: "20000",
          continuance_end_date: "2029-11-07",
          counted: true,
          exclusion_reason: null,
          liability_added_cents: "0",
        },
      ]);
      expect(analyzeIncome(SPEC[6]!).required_through).toBe("2029-11-06");
      expect(totals[6]!.total_qualifying_cents).toBe("100000");
    });

    it("T9: $2,400.00 nets $1,800.00; +$150.00 with experience, an offset without, $350.00 owed at $2,150.00", () => {
      expect(analyzeIncome(SPEC[7]!).results[0]!.rental).toMatchObject({
        net_cents: 180_000n,
        anri_cents: 15_000n,
      });
      expect(t9exp![0]).toMatchObject({ monthly_qualifying_cents: "15000", counted: true });
      expect(t9new![0]).toMatchObject({
        monthly_qualifying_cents: "0",
        counted: false,
        exclusion_reason: "offset_only",
      });
      expect(t9loss![0]).toMatchObject({
        monthly_qualifying_cents: "0",
        counted: false,
        exclusion_reason: null,
        liability_added_cents: "35000",
      });
      expect(totals[9]!.obligations_from_rental_cents).toBe("35000");
    });

    it("T13: part-time base salary takes the full-time formula, and passes the Reg B check", () => {
      expect(t13![0]).toMatchObject({ method: "base_salary", monthly_qualifying_cents: "180000" });
      expect(analyzeIncome(SPEC[10]!).results[0]!.calculation.formula_version).toBe(
        engine.formulaForType("base_salary"),
      );
      expect(() =>
        engine.regbCheck({
          income_type: "base_salary",
          regb_flags: ["part_time"],
          formula_version: engine.FORMULAS.base_salary,
          factor: "0.9",
        }),
      ).toThrow(/REGB_1002_6_B_NO_DISCOUNT/);
    });

    it("is solved by the rulebook through the tools, every case", () => {
      expect(SPEC.flatMap(byRulesMisses)).toEqual([]);
      expect(SPEC.every(incomeInScope)).toBe(true);
    });
  });

  it("says what the engine does where the spec says two things, and the rulebook says the same", () => {
    const ss = (amount: bigint, pct: number | null = null) =>
      engine.socialSecurity({
        amount_cents: amount,
        record: "own",
        benefit: "retirement",
        documented_nontaxable_pct: pct,
      });
    // Two roundings (R6's formula), not the preamble's one: $1,000.10 grosses up $37.51, not $37.50.
    expect(ss(100_010n)).toMatchObject({ nontaxable_cents: 15_002n, gross_up_cents: 3_751n });
    expect((100_010n * 375n + 5_000n) / 10_000n).toBe(3_750n);
    expect(INCOME_RULEBOOK).toContain("That is two roundings");
    // A documented share of 14% still takes 15%; 15.01% is used.
    expect(ss(200_000n, 14).nontaxable_cents).toBe(30_000n);
    expect(ss(200_000n, 15.01)).toMatchObject({
      nontaxable_cents: 30_020n,
      gross_up_cents: 7_505n,
    });
    // The 10% band is the engine's constant, inclusive: 36 to 40 is fixed, 35.9 to 40 is not.
    expect(engine.HOURLY_MINOR_VARIANCE_PCT).toBe(10);
    const cls = (lo: number, hi: number) =>
      engine.hourlyClassification({ rate_cents: 1n, hours_min: lo, hours_max: hi });
    expect([cls(36, 40), cls(35.9, 40), cls(36, 40.1)]).toEqual([
      "base_hourly_fixed",
      "base_hourly_variable",
      "base_hourly_variable",
    ]);
    expect(INCOME_RULEBOOK).toContain("10% exactly included");
    // The stable band is 5%, inclusive: 855,000 over 9 months against 1,200,000 is exactly −5%.
    expect(
      engine.assessTrend({ ytd_cents: 855_000n, ytd_months: 9, prior_year_cents: 1_200_000n })
        .trend,
    ).toBe("stable");
    expect(
      engine.assessTrend({ ytd_cents: 854_999n, ytd_months: 9, prior_year_cents: 1_200_000n })
        .trend,
    ).toBe("decreasing");
    expect(INCOME_RULEBOOK).toContain("a decline of 5% exactly included");
    // An end on note + 36 months passes (T8's "after 6 November" read as on or after).
    expect(
      engine.continuance3y("2029-11-06" as PlainDate, "2026-11-06" as PlainDate, "documented_3y")
        .pass,
    ).toBe(true);
    expect(
      engine.continuance3y("2029-11-05" as PlainDate, "2026-11-06" as PlainDate, "documented_3y")
        .pass,
    ).toBe(false);
    expect(INCOME_RULEBOOK).toContain("An end on required_through itself passes");
    // An alimony award with no term passes, and the rulebook says so.
    expect(engine.continuance3y(null, "2026-11-06" as PlainDate, "documented_3y").pass).toBe(true);
    expect(INCOME_RULEBOOK).toContain("an award with no term (null) has no defined end");
    // A 29 February birthday clamps: 2012-02-29 turns 18 on 2030-02-28.
    expect(engine.continuanceEndFromChildAge("2012-02-29" as PlainDate)).toBe("2030-02-28");
    expect(INCOME_RULEBOOK).toContain("a 29 February birth date gives 28 February");
  });

  it("pins what a model is told, and states each of the engine's figures as the engine has it", () => {
    // Any edit to the rulebook or the tools changes what every model is told: bump
    // INCOME_ENVIRONMENT_VERSION with this pin.
    expect(INCOME_FINGERPRINT.environment).toMatchInlineSnapshot(`
      {
        "name": "qualifying-income",
        "rulebook_sha256": "53b0625c8d4d00a3bf9757f98d06bed061c778a8d646468273d94bb8dcf72bf1",
        "tools_sha256": "33cc914558f518c1f7fa0a92a35b066a897c6d6d5be325e94c0da31bbab735ba",
        "version": "1.0.0",
      }
    `);
    // The engine's constants, and the figures it writes inline, each in the rulebook's words.
    const months = engine.CONTINUANCE_YEARS * 12;
    for (const phrase of [
      `scheduled_note_date + ${months} months (date_add with months: ${months};`,
      `(hours_per_week_max − hours_per_week_min) × 100 ≤ ${engine.HOURLY_MINOR_VARIANCE_PCT} × hours_per_week_max`,
      "monthly = round(rate_cents × H × 52 ÷ 12)",
      "(ytd_cents × 12 > prior_year_cents × ytd_months)",
      `(ytd_cents × 1200 ≥ prior_year_cents × ytd_months × ${100 - engine.STABLE_BAND_PCT_DEFAULT})`,
      "history_months under 12: monthly is 0 and exclusion_reason is history_under_12_months",
      "monthly = round((ytd_cents + prior_year_cents) ÷ (ytd_months + 12))",
      "overtime, commission or tip (B3-3.3-02): monthly = round(stabilization.cents_since ÷ stabilization.months_since)",
      "variable hourly (B3-3.3-01): monthly = round(ytd_cents ÷ ytd_months)",
      `documented_nontaxable_pct when that is above ${engine.SS_NONTAXABLE_PCT_DEFAULT}, and otherwise ${engine.SS_NONTAXABLE_PCT_DEFAULT}`,
      `gross_up = round(nontaxable × ${engine.GROSS_UP_PCT} ÷ 100)`,
      `gross_up = round(monthly × ${engine.GROSS_UP_PCT} ÷ 100)`,
      "receipts_months under 6, or receipts not full, regular and timely",
      `child_date_of_birth + ${engine.CHILD_SUPPORT_AGE_END * 12} months`,
      "or state_extends_support_to when that is later",
      `at least ${months} × monthly_cents`,
      `net = round(form_1007_gross_rent_cents × ${engine.RENTAL_NET_PCT} ÷ 100)`,
      `schedule_e_fair_rental_days of ${engine.FAIR_RENTAL_DAYS_FULL_YEAR} or more, or management_experience_months of ${engine.MANAGEMENT_EXPERIENCE_MONTHS} or more`,
      "Such a source with a continuance_end_date before required_through does not continue three years",
    ])
      expect(INCOME_RULEBOOK).toContain(phrase);
    // The figures the engine writes inline rather than names: six months of receipts, a year of
    // history, 36 months of balances, the later of 18 and an extension.
    const support = (receipts_months: number) =>
      engine.supportIncome({
        amount_cents: 80_000n,
        kind: "alimony",
        receipts_months,
        receipts_full_regular_timely: true,
        agreement_document_id: "decree",
      }).reason;
    expect([support(5), support(6)]).toEqual(["receipt_history_insufficient", null]);
    const history = (history_months: number) =>
      engine.variableIncome({
        income_type: "overtime",
        ytd_cents: 855_000n,
        ytd_months: 9,
        prior_year_cents: 1_080_000n,
        history_months,
      }).reason;
    expect([history(11), history(12)]).toEqual(["history_under_12_months", null]);
    const balances = (short: bigint) =>
      engine.retirementDistribution({
        monthly_cents: 100_000n,
        eligible_balances_cents: [100_000n * BigInt(months) - short],
        unrestricted_penalty_free: true,
      }).reason;
    expect([balances(0n), balances(1n)]).toEqual([null, "continuance_assets_insufficient"]);
    const end = (ext: string) =>
      engine.supportIncome({
        amount_cents: 80_000n,
        kind: "child_support",
        receipts_months: 12,
        receipts_full_regular_timely: true,
        agreement_document_id: "decree",
        child_date_of_birth: "2011-03-03" as PlainDate,
        state_extends_support_to: ext as PlainDate,
      }).continuance_end_date;
    expect([end("2029-06-30"), end("2028-06-30")]).toEqual(["2029-06-30", "2029-03-03"]);
  });

  it("reproduces each place the engine departs from its spec, which v1 keeps out", () => {
    // The 10% test in floating point: at exactly 10%, 30 of the 80 whole high weeks from 1 to 80
    // read variable, where exact arithmetic reads fixed. 33.3 to 37 is one.
    const flips = Array.from({ length: 80 }, (_, k) => k + 1).filter(
      (hi) =>
        engine.hourlyClassification({
          rate_cents: 1n,
          hours_min: Number((0.9 * hi).toFixed(1)),
          hours_max: hi,
        }) === "base_hourly_variable",
    );
    expect(flips).toHaveLength(30);
    expect(flips).toContain(37);
    expect(FLOAT_SAFE_HIGH_WEEKS).not.toContain(37);
    expect(FLOAT_SAFE_HIGH_WEEKS.every((hi) => !flips.includes(hi))).toBe(true);
    // D1: an annuity or pension is sent to the retirement-account test and excluded with no balances.
    expect(dispatched("annuity_pension", { monthly_cents: 250_000n })).toMatchObject({
      monthly_qualifying_cents: 0n,
      reason: "continuance_assets_insufficient",
    });
    // D5: a bonus is trended unannualized. An unchanged $12,000.00 reads increasing at $1,142.86.
    const bonus = (ytd: bigint) =>
      dispatched("bonus", {
        ytd_cents: ytd,
        ytd_months: 9,
        prior_year_cents: 1_200_000n,
        history_months: 36,
      });
    expect(bonus(1_200_000n)).toMatchObject({
      trend: "increasing",
      monthly_qualifying_cents: 114_286n,
    });
    expect(engine.bonusMonthly(1_200_000n).monthly_cents).toBe(100_000n);
    expect(bonus(1_000_000n)).toMatchObject({
      trend: "increasing",
      monthly_qualifying_cents: 104_762n,
    });
    // D2: a fixed range with no average is paid on the high week.
    expect(
      dispatched("base_hourly_fixed", { rate_cents: 2_500n, hours_min: 36, hours_max: 40 })
        .monthly_qualifying_cents,
    ).toBe(433_333n);
    expect(
      dispatched("base_hourly_fixed", {
        rate_cents: 2_500n,
        hours_min: 36,
        hours_max: 40,
        avg_hours_per_week: 38,
      }).monthly_qualifying_cents,
    ).toBe(411_667n);
    // D14: guaranteed hours win over a higher average.
    expect(
      dispatched("base_hourly_fixed", {
        rate_cents: 2_500n,
        guaranteed_hours_per_week: 32,
        avg_hours_per_week: 38,
      }).monthly_qualifying_cents,
    ).toBe(346_667n);
    // D3: hours are rounded to tenths first: $20.00 × 37.25 hours is $3,232.67, exactly $3,228.33.
    expect(
      dispatched("base_hourly_fixed", { rate_cents: 2_000n, guaranteed_hours_per_week: 37.25 })
        .monthly_qualifying_cents,
    ).toBe(323_267n);
    // D16: the dispatch drops Average Hours, and the Reg B check would refuse its formula anyway.
    const averageHours = {
      ytd_cents: 4_000_000n,
      ytd_months: 9,
      prior_year_cents: 6_000_000n,
      history_months: 36,
      average_hours: {
        avg_monthly_hours: 160,
        months_of_hours: 12,
        current_hourly_rate_cents: 3_250n,
      },
    };
    expect(dispatched("base_hourly_variable", averageHours)).toMatchObject({
      monthly_qualifying_cents: 0n,
      reason: "not_stabilized",
    });
    const direct = engine.variableIncome({ ...averageHours, income_type: "base_hourly_variable" });
    expect(direct.monthly_qualifying_cents).toBe(520_000n);
    expect(() =>
      engine.regbCheck({
        income_type: "base_hourly_variable",
        regb_flags: [],
        formula_version: direct.formula_version,
      }),
    ).toThrow(/REGB_1002_6_B_NO_DISCOUNT/);
    // D4: no history, or 12 to 23 months with no offsetting factors, pays in full.
    const a = { ytd_cents: 855_000n, ytd_months: 9, prior_year_cents: 1_080_000n };
    expect(dispatched("overtime", a).monthly_qualifying_cents).toBe(92_143n);
    expect(dispatched("overtime", { ...a, history_months: 15 }).monthly_qualifying_cents).toBe(
      92_143n,
    );
    expect(dispatched("overtime", { ...a, history_months: 11 }).monthly_qualifying_cents).toBe(0n);
    // D6: no end date passes, on a dependent's record and for child support with no birth date.
    const dependent = dispatched("social_security_survivor_dependent", {
      amount_cents: 200_000n,
      record: "dependent",
    });
    expect(dependent).toMatchObject({
      continuance_basis: "documented_3y",
      continuance_end_date: null,
    });
    expect(engine.continuance3y(null, "2026-11-06" as PlainDate, "documented_3y").pass).toBe(true);
    expect(
      dispatched("child_support", {
        amount_cents: 80_000n,
        receipts_months: 12,
        agreement_document_id: "d",
      }),
    ).toMatchObject({ continuance_end_date: null, monthly_qualifying_cents: 80_000n });
    // D13: the birth date overrides the decree's own shorter term.
    expect(
      dispatched("child_support", {
        amount_cents: 80_000n,
        receipts_months: 12,
        agreement_document_id: "d",
        child_date_of_birth: "2015-01-01",
        term_end_date: "2028-06-30",
      }).continuance_end_date,
    ).toBe("2033-01-01");
    // D7: a refinance's rental takes the purchase formula.
    expect(
      engine.subjectRental({
        gross_rent_cents: 240_000n,
        pitia_cents: 165_000n,
        transaction: "refinance",
        fair_rental_days: 365,
      }).income_added_cents,
    ).toBe(15_000n);
    // D11: the ADU cap is 30% of whatever total it is handed: 189,000 on the other income, 279,000 on all of it.
    const adu = (total: bigint) =>
      engine.aduCap({
        total_qualifying_cents: total,
        adu_net_cents: 300_000n,
        transaction: "purchase",
      }).allowed_cents;
    expect([adu(630_000n), adu(930_000n)]).toEqual([189_000n, 279_000n]);
    // D9: leave past the first payment takes the lesser figure, with no reserves supplement.
    expect(
      engine.temporaryLeaveIncome({
        regular_income_cents: 500_000n,
        leave_income_cents: 200_000n,
        return_date: "2027-02-01" as PlainDate,
        first_payment_due_date: "2027-01-01" as PlainDate,
        borrower_intent_to_return_document_id: "a",
        employer_return_confirmation_document_id: "b",
      }).monthly_qualifying_cents,
    ).toBe(200_000n);
    // D10: a start before the note date with the bridge documented is refused: the bridge is 0 months.
    expect(
      engine.offerOption2({
        note_date: "2026-11-18" as PlainDate,
        start_date: "2026-11-01" as PlainDate,
        monthly_income_cents: 500_000n,
        non_contingent: true,
        fully_executed: true,
        transaction: "purchase",
        occupancy: "principal_residence",
        units: 1,
        fixed_base_income: true,
        family_or_interested_party: false,
        reserves_months_pitia: 0,
        bridge_reserves_documented: true,
      }).available,
    ).toBe(false);
    // D8: the Reg B word list refuses legitimate exclusion reasons; the grader never sends it one.
    for (const why of [
      "retirement account balances cover fewer than 36 months of distributions",
      "documents exceed the allowable age",
    ])
      expect(() =>
        engine.regbCheck({
          income_type: "retirement_distribution",
          regb_flags: [],
          formula_version: engine.FORMULAS.retirement,
          exclusion_reason: why,
        }),
      ).toThrow(/REGB_1002_6_B_NO_DISCOUNT/);
    // E15: a prior year of nothing reads increasing; E4: a weekly period's months rounded to four
    // places read stable what exact arithmetic reads increasing.
    expect(
      engine.assessTrend({ ytd_cents: 855_000n, ytd_months: 9, prior_year_cents: 0n }).trend,
    ).toBe("increasing");
    const week = 12 / 52;
    expect(
      engine.assessTrend({ ytd_cents: 19_231n, ytd_months: week, prior_year_cents: 1_000_000n })
        .trend,
    ).toBe("stable");
    expect(19_231 * 12 > 1_000_000 * week).toBe(true);
  });

  it("keeps out each region where the engine departs from its spec, on a constructed case", () => {
    const [r13] = SPEC;
    const base = r13!.borrowers[0]!.sources;
    const salary = base[0]!;
    const overtime = base[1] as VariableSource;
    const ssOwn = base[2] as SocialSecuritySource;
    const hourly = SPEC[3]!.borrowers[0]!.sources[0] as HourlySource;
    const child = SPEC[6]!.borrowers[0]!.sources[1] as ChildSupportSource;
    const out = (sources: IncomeSource[], over: Partial<IncomeTask["application"]> = {}) =>
      incomeOutOfScope({
        ...withSources(r13!, sources),
        application: { ...r13!.application, ...over },
      });
    // The file the guard admits.
    expect(out([salary, overtime, ssOwn, base[3]!])).toBeNull();
    const range = {
      guaranteed_hours_per_week: null,
      hours_per_week_min: 36,
      hours_per_week_max: 40,
      avg_hours_per_week: 38,
    };
    expect(out([{ ...hourly, ...range }])).toBeNull();
    // D2, D14, D3, and the floating-point 10% test.
    expect(out([{ ...hourly, ...range, avg_hours_per_week: null }])).toMatch(/D2/);
    expect(
      out([{ ...hourly, hours_per_week_min: 36, hours_per_week_max: 40, avg_hours_per_week: 38 }]),
    ).toMatch(/D14/);
    expect(out([{ ...hourly, guaranteed_hours_per_week: 37.25 }])).toMatch(/D3/);
    expect(
      out([
        {
          ...hourly,
          ...range,
          hours_per_week_min: 33.3,
          hours_per_week_max: 37,
          avg_hours_per_week: 35,
        },
      ]),
    ).toMatch(/floating point/);
    expect(
      exactHourlyClass({
        guaranteed_hours_per_week: null,
        hours_per_week_min: 33.3,
        hours_per_week_max: 37,
      }),
    ).toBe("base_hourly_fixed");
    // D4, E4, E15, E14. Twenty-one months to a September paystub is a whole year's W-2.
    expect(out([{ ...overtime, history_months: 21 }])).toMatch(/D4/);
    expect(
      out([{ ...overtime, history_months: 21, offsetting_factors: ["licensed in the field"] }]),
    ).toBeNull();
    expect(out([{ ...overtime, ytd_months: 9.25 }])).toMatch(/E4/);
    expect(out([{ ...overtime, ytd_through: "2026-09-20" as PlainDate }])).toMatch(/E4/);
    expect(out([{ ...overtime, prior_year_cents: 0n }])).toMatch(/E15/);
    expect(out([{ ...overtime, history_months: 9 }])).toMatch(/E15/);
    const flat = { since: "2026-04-01" as PlainDate, cents_since: 570_000n, months_since: 6 };
    expect(out([{ ...overtime, stabilization: flat }])).toBeNull();
    expect(out([{ ...overtime, stabilization: { ...flat, months_since: 5.5 } }])).toMatch(/E14/);
    expect(out([{ ...overtime, stabilization: { ...flat, cents_since: 900_000n } }])).toMatch(
      /E14/,
    );
    // E15 on a W-2 covering six months of the prior year (15 months of history to a September
    // paystub): R3 reads $10,800.00 as $900.00 a month and example A as increasing, B3-3.3-02's
    // months included as $1,800.00 a month and decreasing.
    const part = { history_months: 15, offsetting_factors: ["licensed in the field"] };
    expect(out([{ ...overtime, ...part }])).toMatch(/trend R3's twelve months.*E15/);
    expect(monthsIncludedTrend({ ...overtime, ...part })).toBe("decreasing");
    // Increasing both ways, it is still averaged over 21 months where the Guide's are 15.
    expect(out([{ ...overtime, ...part, prior_year_cents: 300_000n }])).toMatch(
      /averaged over twelve.*E15/,
    );
    // A decline both ways is kept: its figure is the run since stabilization, which reads no prior year.
    expect(
      out([{ ...overtime, ...part, prior_year_cents: 1_440_000n, stabilization: flat }]),
    ).toBeNull();
    // Under 12 months the figure is 0 both ways, and the trend is kept where the two agree.
    expect(out([{ ...overtime, history_months: 11, prior_year_cents: 100_000n }])).toBeNull();
    expect(out([{ ...overtime, history_months: 11, prior_year_cents: 200_000n }])).toMatch(/E15/);
    // One paystub a borrower, no more than 30 days older than the application (B3-3.2-01).
    const earlier: VariableSource = {
      ...overtime,
      income_id: "INC-9",
      ytd_through: "2026-09-15" as PlainDate,
      ytd_months: 8.5,
    };
    expect(out([overtime, earlier])).toMatch(/two paystubs/);
    expect(out([overtime], { application_date: "2026-10-30" as PlainDate })).toBeNull();
    expect(out([overtime], { application_date: "2026-10-31" as PlainDate })).toMatch(/30 days/);
    expect(out([overtime], { application_date: "2026-09-29" as PlainDate })).toMatch(/after/);
    // Fixed hours with under a year of history, which the engine never reads.
    expect(out([{ ...hourly, history_months: 11 }])).toMatch(/under a year/);
    // D6.
    expect(out([{ ...ssOwn, record: "dependent" }])).toMatch(/D6/);
    expect(out([{ ...ssOwn, benefit_end_date: "2040-01-01" as PlainDate }])).toMatch(/D6/);
    expect(out([{ ...child, child_date_of_birth: null as unknown as PlainDate }])).toMatch(/D6/);
    // D13.
    expect(out([{ ...child, term_end_date: "2028-06-30" } as unknown as IncomeSource])).toMatch(
      /D13/,
    );
    // D1, D5, D11, D9, D10 and D7's other rentals cannot be carried; a source of their type is refused.
    for (const type of [
      "annuity_pension",
      "bonus",
      "rental_adu",
      "temporary_leave",
      "employment_offer",
      "rental_non_subject",
    ])
      expect(out([{ ...salary, type } as unknown as IncomeSource]), type).toMatch(/out of v1/);
    // D7: a refinance.
    expect(out([salary], { transaction: "refinance" as "purchase" })).toMatch(/D7/);
    // Rent on a home the borrower lives in, and two subject properties.
    expect(out([base[3]!], { occupancy: "principal_residence" })).toMatch(/lives in/);
    expect(out([base[3]!, { ...base[3]!, income_id: "INC-9" }])).toMatch(/two subject/);
  });

  it("never lets a fact Regulation B protects change a figure", () => {
    const strip = (t: IncomeTask): IncomeTask => ({
      ...t,
      borrowers: t.borrowers.map((b) => ({
        ...b,
        age: 40,
        retired: false,
        sources: b.sources.map(
          (s) =>
            ({
              ...s,
              regb_flags: [],
              ...("part_time" in s ? { part_time: false } : {}),
            }) as IncomeSource,
        ),
      })),
    });
    const tasks = [...SPEC, ...generateIncomeSuite("train", 4, 400)];
    for (const t of tasks)
      expect(toJsonLine(expectedIncome(strip(t))), t.id).toBe(toJsonLine(expectedIncome(t)));
    expect(INCOME_RULEBOOK).toContain(
      "never lower a figure, never apply a factor below 1, and never exclude a source",
    );
    // No fact Regulation B bars asking about or assuming is ever on a file (§1002.5(d)(3), §1002.6(b)(3)).
    expect(
      JSON.stringify(tasks.map(incomePayload), (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    ).not.toMatch(/pregnan|childbearing|family_plan|maternity|leave/i);
  }, 60_000);

  it("fails an answer wrong in any one field on exactly that row, and passes no answer with a field wrong", () => {
    const want = expectedIncome(SPEC[0]!);
    const graded = (task: IncomeTask, answer: IncomeAnswer) => {
      // Every answer here is one the schema allows: the grader, not the parser, refuses it.
      expect(parseIncomeSubmission(answer).ok).toBe(true);
      const g = gradeIncomeAgainst(expectedIncome(task), answer);
      return { ...g, wrong: g.fields.filter((f) => !f.ok).map((f) => f.field) };
    };
    const bump = (v: string) => String(BigInt(v) + 1n);
    // Each field of a row, changed to another legal value on a spec row where it is not the default.
    const r13 = SPEC[0]!;
    const t8 = SPEC[6]!;
    const cases: [IncomeTask, string, keyof SourceRow, (r: SourceRow) => unknown][] = [
      [r13, "INC-1", "method", () => "base_hourly_fixed"],
      [r13, "INC-2", "trend", () => "stable"],
      [r13, "INC-2", "monthly_qualifying_cents", (r) => bump(r.monthly_qualifying_cents)],
      [r13, "INC-3", "nontaxable_cents", (r) => bump(r.nontaxable_cents)],
      [r13, "INC-3", "gross_up_cents", (r) => bump(r.gross_up_cents)],
      [t8, "INC-1", "continuance_end_date", () => "2029-03-04"],
      [t8, "INC-1", "continuance_end_date", () => null],
      [t8, "INC-2", "counted", () => false],
      [t8, "INC-1", "exclusion_reason", () => null],
      [t8, "INC-1", "exclusion_reason", () => "receipt_history_insufficient"],
      [r13, "INC-4", "liability_added_cents", (r) => bump(r.liability_added_cents)],
    ];
    expect(new Set(cases.map(([, , k]) => k))).toEqual(
      new Set(ROW_FIELDS.filter((k) => k !== "income_id")),
    );
    for (const [task, id, key, change] of cases) {
      const right = expectedIncome(task);
      const answer = {
        ...right,
        sources: right.sources.map((r) =>
          r.income_id === id ? ({ ...r, [key]: change(r) } as SourceRow) : r,
        ),
      };
      const g = graded(task, answer);
      const n = right.sources.length + 1;
      expect([g.wrong, g.pass, g.score], `${id} ${key}`).toEqual([
        [`source[${id}]`],
        false,
        (n - 1) / n,
      ]);
    }
    // The file is one field: either total off by a cent fails it, and only it.
    for (const file of [
      { total_qualifying_cents: "924644" },
      { obligations_from_rental_cents: "35001" },
    ]) {
      const g = graded(r13, { ...want, ...file });
      expect([g.wrong, g.pass, g.score]).toEqual([["file"], false, 4 / 5]);
    }
    // A missing row fails that source; a row for a source the file does not have is a field of its own.
    const missing = graded(r13, { ...want, sources: want.sources.slice(1) });
    expect([missing.wrong, missing.pass, missing.score]).toEqual([["source[INC-1]"], false, 4 / 5]);
    const both = graded(r13, {
      ...want,
      sources: [...want.sources.slice(1), { ...want.sources[0]!, income_id: "INC-9" }],
    });
    expect([both.wrong, both.pass, both.score]).toEqual([
      ["source[INC-1]", "source[INC-9]"],
      false,
      4 / 6,
    ]);
    const g = gradeIncomeAgainst(want, want);
    expect([g.pass, g.score, g.fields.length]).toEqual([true, 1, 5]);
    expect(gradeIncomeAgainst(want, null)).toMatchObject({ pass: false, score: 0 });
  });

  it("is audited figure by figure, every source's included", async () => {
    const task = SPEC[0]!;
    const result = await runEpisode(qualifyingIncome, task, new IncomeReferencePolicy());
    const record: AuditRecord = {
      task: { id: task.id, split: task.split, index: task.index, rendered: renderIncomeTask(task) },
      policy: { id: "reference" },
      result: result as unknown as AuditRecord["result"],
    };
    // The reference reads or computes every figure with a tool: nothing done in its head.
    expect(auditEpisode(record).mental).toEqual([]);
    // A source's figure no tool returned is flagged by the source it sits on, beside a total's.
    const answer = result.answer!;
    const doctored: AuditRecord = {
      ...record,
      result: {
        ...record.result,
        answer: {
          ...answer,
          sources: answer.sources.map((r) =>
            r.income_id === "INC-2" ? { ...r, monthly_qualifying_cents: "92144" } : r,
          ),
          total_qualifying_cents: "924644",
        },
      },
    };
    expect(auditEpisode(doctored).mental).toEqual([
      "sources[INC-2].monthly_qualifying_cents",
      "total_qualifying_cents",
    ]);
  });

  it("reads a submission strictly, as the schema says, and bounces what does not fit", () => {
    const want = expectedIncome(SPEC[0]!);
    const ok = (x: unknown) => parseIncomeSubmission(x).ok;
    const [first, ...rest] = want.sources;
    const row = (over: Record<string, unknown>) => ({
      ...want,
      sources: [{ ...first!, ...over }, ...rest],
    });
    expect(ok(want)).toBe(true);
    expect(ok(null)).toBe(false);
    expect(ok([])).toBe(false);
    expect(ok({ ...want, sources: undefined })).toBe(false);
    expect(ok({ ...want, note: "extra" })).toBe(false);
    expect(ok({ sources: want.sources, total_qualifying_cents: "1" })).toBe(false);
    expect(ok({ ...want, sources: [first, first, ...rest] })).toBe(false);
    expect(ok(row({ income_id: "" }))).toBe(false);
    expect(ok(row({ method: "salary" }))).toBe(false);
    expect(ok(row({ trend: "flat" }))).toBe(false);
    expect(ok(row({ monthly_qualifying_cents: 625000 }))).toBe(false);
    expect(ok(row({ monthly_qualifying_cents: "6250.00" }))).toBe(false);
    expect(ok(row({ gross_up_cents: "-1" }))).toBe(false);
    expect(ok(row({ continuance_end_date: "11/06/2029" }))).toBe(false);
    expect(ok(row({ counted: "true" }))).toBe(false);
    expect(ok(row({ exclusion_reason: "part_time" }))).toBe(false);
    expect(ok(row({ why: "salary" }))).toBe(false);
    const missing: Record<string, unknown> = { ...first! };
    delete missing["liability_added_cents"];
    expect(ok({ ...want, sources: [missing, ...rest] })).toBe(false);
    expect(ok({ ...want, total_qualifying_cents: 924643 })).toBe(false);
    // What the schema allows is read as the grader reads it: a leading zero is the same cents.
    const parsed = parseIncomeSubmission(row({ monthly_qualifying_cents: "0625000" }));
    expect(parsed.ok && gradeIncomeAgainst(want, parsed.answer).pass).toBe(true);
    // And the schema the model is shown says the same.
    const schema = INCOME_TOOLS.find((t) => t.name === "submit_income")!.input_schema as Record<
      string,
      unknown
    >;
    expect(schema["additionalProperties"]).toBe(false);
  });

  it("gives an answer that answers nothing, copies the stated amounts, or labels without money little credit", () => {
    const held = generateIncomeSuite("heldout", INCOME_HELDOUT_SUITE.seed, INCOME_HELDOUT_SUITE.n);
    const METHOD: Record<string, SourceRow["method"]> = {
      base_salary: "base_salary",
      hourly: "base_hourly_fixed",
      overtime: "variable_trending",
      commission: "variable_trending",
      tip: "variable_trending",
      social_security: "social_security",
      child_support: "support",
      alimony: "support",
      separate_maintenance: "support",
      retirement_distribution: "retirement",
      public_assistance: "public_assistance",
      rental_subject: "rental_subject",
    };
    const stated = (s: IncomeSource): bigint =>
      s.type === "base_salary"
        ? s.pay_rate_cents
        : s.type === "social_security"
          ? s.monthly_benefit_cents
          : s.type === "rental_subject"
            ? s.form_1007_gross_rent_cents
            : "monthly_cents" in s
              ? s.monthly_cents
              : s.ytd_cents;
    const plainRow = (s: IncomeSource, monthly: bigint, counted: boolean): SourceRow => ({
      income_id: s.income_id,
      method: METHOD[s.type]!,
      trend: null,
      monthly_qualifying_cents: String(monthly),
      nontaxable_cents: "0",
      gross_up_cents: "0",
      continuance_end_date: null,
      counted,
      exclusion_reason: null,
      liability_added_cents: "0",
    });
    const mean = (f: (t: IncomeTask, want: IncomeAnswer) => IncomeAnswer) =>
      held.reduce((sum, t) => {
        const want = expectedIncome(t);
        return sum + gradeIncomeAgainst(want, f(t, want)).score;
      }, 0) / held.length;
    const nothing = mean((t) => ({
      sources: sourcesOf(t).map((s) => plainRow(s, 0n, false)),
      total_qualifying_cents: "0",
      obligations_from_rental_cents: "0",
    }));
    const copied = mean((t) => ({
      sources: sourcesOf(t).map((s) => plainRow(s, stated(s), true)),
      total_qualifying_cents: String(sourcesOf(t).reduce((a, s) => a + stated(s), 0n)),
      obligations_from_rental_cents: "0",
    }));
    const labels = mean((_t, want) => ({
      sources: want.sources.map((r) => ({
        ...r,
        monthly_qualifying_cents: "0",
        nontaxable_cents: "0",
        gross_up_cents: "0",
        liability_added_cents: "0",
      })),
      total_qualifying_cents: "0",
      obligations_from_rental_cents: "0",
    }));
    // No rule at all: each stated amount and stated end copied, everything counted, nothing excluded.
    const statedEnd = (s: IncomeSource): string | null =>
      s.type === "social_security"
        ? s.benefit_end_date
        : s.type === "alimony" || s.type === "separate_maintenance"
          ? s.term_end_date
          : s.type === "public_assistance"
            ? s.duration_end_date
            : null;
    const unchecked = mean((t) => ({
      sources: sourcesOf(t).map((s) => ({
        ...plainRow(s, stated(s), true),
        continuance_end_date: statedEnd(s),
      })),
      total_qualifying_cents: String(sourcesOf(t).reduce((a, s) => a + stated(s), 0n)),
      obligations_from_rental_cents: "0",
    }));
    // Measured at 1.0.0 (docs/environments.md).
    expect([nothing, copied, labels, unchecked].map((x) => x.toFixed(4))).toMatchInlineSnapshot(`
      [
        "0.0024",
        "0.1540",
        "0.1381",
        "0.1914",
      ]
    `);
    expect(nothing).toBeLessThan(0.02);
    expect(copied).toBeLessThan(0.2);
    expect(labels).toBeLessThan(0.2);
    expect(unchecked).toBeLessThan(0.25);
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    const r = await solveAll([
      ...SPEC,
      ...generateIncomeSuite("heldout", INCOME_HELDOUT_SUITE.seed, INCOME_HELDOUT_SUITE.n),
    ]);
    expect(r.misses).toEqual([]);
    // Inside the episode's 80 turns even for a model that makes one tool call a turn: the
    // reference's call count, submission included, is that model's turn count.
    expect(r.calls).toBeLessThan(70);
    expect(r.turns).toBeLessThanOrEqual(6);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    const r = await solveAll(generateIncomeSuite("train", 11, 300));
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(70);
  }, 120_000);

  it("is fair to grade on every first draw, and every hourly source's class is the exact one", () => {
    const draws = Array.from({ length: 600 }, (_, i) => drawIncomeTask("train", 3, i));
    expect(draws.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    const held = generateIncomeSuite("heldout", INCOME_HELDOUT_SUITE.seed, INCOME_HELDOUT_SUITE.n);
    let hourly = 0;
    for (const t of [...draws.map((x) => x.task), ...held]) {
      expect(incomeInScope(t), t.id).toBe(true);
      const n = sourcesOf(t).length;
      expect(n >= 3 && n <= 6, t.id).toBe(true);
      for (const r of analyzeIncome(t).results) {
        if (r.source.type === "hourly") {
          hourly += 1;
          // The engine's floating-point 10% test, against the exact test in tenths of an hour.
          expect(r.hourly_class, r.source.income_id).toBe(exactHourlyClass(r.source));
        }
        if (r.trend_detail) expect(r.trend_detail.trend).toBe(exactTrend(r.source as never));
      }
    }
    expect(hourly).toBeGreaterThan(200);
  }, 60_000);

  it("holds the rulebook to the engine on candidates nothing filtered", () => {
    // The guard and the fairness filter would hide a disagreement; the candidates they would see show none.
    const unfair: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      const id = incomeTaskId("train", 99, i);
      const task = drawIncomeCandidate(rngFor(id), id, "train", 99, i);
      const why = incomeOutOfScope(task);
      if (why) unfair.push(`${id} ${why}`);
      else unfair.push(...byRulesMisses(task));
    }
    expect(unfair).toEqual([]);
    expect(incomeFairToGrade(SPEC[0]!)).toBe(true);
  }, 120_000);

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump INCOME_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generateIncomeSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"93dd34f6d68aef63873832c1553895b19cac2f0b1c145e0b3c5c741d09c8dcbc"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out application into training", () => {
    expect(toJsonLine(generateIncomeTask("train", 7, 17))).toBe(
      toJsonLine(generateIncomeSuite("train", 7, 30)[17]),
    );
    const fp = (t: IncomeTask) => toJsonLine(incomePayload(t));
    const held = new Set(generateIncomeSuite("heldout", 1, 200).map(fp));
    expect(generateIncomeSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
    // The guard knows this suite: its namespace is listed, and a held-out id is its own stream.
    expect(namespaceOf(incomeTaskId("train", 1, 0))).toBe("qualifying-income/1.0.0");
    expect(drawsHeldoutStream(incomeTaskId("heldout", 1, 0).replace("/heldout/", "/train/"))).toBe(
      false,
    );
  }, 60_000);

  describe("each edge, and the configurations that decide an answer, turn up", () => {
    const tasks = generateIncomeSuite("train", 1, 1300);
    /** A source's facts, read by name. */
    type Facts = Record<string, unknown>;
    const runs = tasks.flatMap((t) => {
      const a = analyzeIncome(t);
      const rows = rowsOf(t);
      return a.results.map((r) => ({
        t,
        r,
        s: r.source as unknown as Facts,
        row: rows.find((x) => x.income_id === r.source.income_id)!,
        req: a.required_through,
      }));
    });
    type Run = (typeof runs)[number];
    const count = (f: (x: Run) => boolean) => runs.filter(f).length;
    const big = (v: unknown) => BigInt(v as bigint);
    const dayBefore = (d: PlainDate) => addDays(d, -1);
    const is = (x: Run, ...types: string[]) => types.includes(String(x.s["type"]));

    it("cycles through every edge, a hundred files each, and every aim on the held-out suite", () => {
      expect(new Set(tasks.map((_, i) => incomeEdgeOf(i)))).toEqual(new Set(INCOME_EDGES));
      const aims = (n: number) =>
        new Set(Array.from({ length: n }, (_, i) => `${incomeEdgeOf(i)}/${incomeAimOf(i)}`));
      expect(aims(200)).toEqual(aims(1300));
    });

    it("draws every method, trend and exclusion the rulebook names", () => {
      expect(new Set(runs.map((x) => x.row.method)).size).toBe(9);
      expect(new Set(runs.map((x) => x.row.trend))).toEqual(
        new Set([null, "stable", "increasing", "decreasing"]),
      );
      expect(new Set(runs.map((x) => x.row.exclusion_reason)).size).toBe(9);
      expect(count((x) => !x.row.counted)).toBeGreaterThan(600);
    });

    it("draws salaries on a half cent and paid every period", () => {
      const periods: Record<string, bigint> = {
        annual: 1n,
        monthly: 12n,
        semimonthly: 24n,
        biweekly: 26n,
        weekly: 52n,
      };
      const annual = (x: Run) =>
        big(x.s["pay_rate_cents"]) * periods[String(x.s["pay_frequency"])]!;
      expect(count((x) => is(x, "base_salary") && annual(x) % 12n === 6n)).toBeGreaterThan(40);
      for (const f of ["weekly", "biweekly", "semimonthly", "monthly"])
        expect(
          count((x) => x.s["pay_frequency"] === f),
          f,
        ).toBeGreaterThan(70);
    });

    it("draws hours at exactly 10% of the high week, a tenth past it, guaranteed, inside and wide", () => {
      const tenths = (h: unknown) => Math.round(Number(h) * 10);
      const hi = (x: Run) => tenths(x.s["hours_per_week_max"]);
      const spread = (x: Run) => hi(x) - tenths(x.s["hours_per_week_min"]);
      const ranged = (x: Run) => is(x, "hourly") && x.s["guaranteed_hours_per_week"] === null;
      expect(
        count((x) => ranged(x) && spread(x) * 10 === hi(x) && x.row.method === "base_hourly_fixed"),
      ).toBeGreaterThan(15);
      expect(
        count(
          (x) =>
            ranged(x) &&
            (spread(x) - 1) * 10 === hi(x) &&
            x.row.method === "variable_base_trending",
        ),
      ).toBeGreaterThan(15);
      expect(
        count((x) => is(x, "hourly") && x.s["guaranteed_hours_per_week"] !== null),
      ).toBeGreaterThan(120);
      expect(count((x) => ranged(x) && x.row.method === "base_hourly_fixed")).toBeGreaterThan(90);
      expect(count((x) => x.row.method === "variable_base_trending")).toBeGreaterThan(150);
    });

    it("draws the trend exactly 5% down and a cent under, level and a cent over, in whole and half months", () => {
      const m2 = (x: Run) => BigInt(Math.round(Number(x.s["ytd_months"]) * 2));
      const ytd = (x: Run, plus: bigint) => big(x.s["ytd_cents"]) + plus;
      const prior = (x: Run) => big(x.s["prior_year_cents"]);
      const at95 = (x: Run, plus: bigint) => ytd(x, plus) * 2400n - prior(x) * m2(x) * 95n;
      const level = (x: Run, plus: bigint) => ytd(x, plus) * 24n - prior(x) * m2(x);
      const trended = (x: Run) => x.row.trend !== null;
      expect(
        count((x) => trended(x) && at95(x, 0n) === 0n && x.row.trend === "stable" && x.row.counted),
      ).toBeGreaterThan(20);
      expect(
        count(
          (x) => trended(x) && at95(x, 1n) === 0n && x.row.exclusion_reason === "not_stabilized",
        ),
      ).toBeGreaterThan(10);
      expect(
        count(
          (x) => trended(x) && at95(x, 1n) === 0n && x.row.trend === "decreasing" && x.row.counted,
        ),
      ).toBeGreaterThan(8);
      expect(
        count((x) => trended(x) && level(x, 0n) === 0n && x.row.trend === "stable"),
      ).toBeGreaterThan(10);
      expect(
        count((x) => trended(x) && level(x, -1n) === 0n && x.row.trend === "increasing"),
      ).toBeGreaterThan(10);
      expect(count((x) => trended(x) && !Number.isInteger(x.s["ytd_months"]))).toBeGreaterThan(400);
      expect(count((x) => trended(x) && Number.isInteger(x.s["ytd_months"]))).toBeGreaterThan(400);
    });

    it("draws decreasing income under each formula: since stabilization, year-to-date, and none", () => {
      const rounded = (a: unknown, b: unknown) => String(Math.round(Number(a) / Number(b)));
      const run = (x: Run) => x.s["stabilization"] as Facts | null;
      const decreasing = (x: Run) =>
        x.row.trend === "decreasing" && x.row.counted && run(x) !== null;
      const since = (x: Run) => rounded(run(x)!["cents_since"], run(x)!["months_since"]);
      const ytd = (x: Run) => rounded(x.s["ytd_cents"], x.s["ytd_months"]);
      expect(
        count(
          (x) =>
            decreasing(x) &&
            x.row.method === "variable_trending" &&
            x.row.monthly_qualifying_cents === since(x) &&
            since(x) !== ytd(x),
        ),
      ).toBeGreaterThan(100);
      expect(
        count(
          (x) =>
            decreasing(x) &&
            x.row.method === "variable_base_trending" &&
            x.row.monthly_qualifying_cents === ytd(x) &&
            since(x) !== ytd(x),
        ),
      ).toBeGreaterThan(30);
      expect(count((x) => x.row.exclusion_reason === "not_stabilized")).toBeGreaterThan(100);
    });

    it("draws 11 months of history against 12, and 23 against 24", () => {
      const history = (x: Run, n: number) => x.row.trend !== null && x.s["history_months"] === n;
      expect(
        count((x) => history(x, 11) && x.row.exclusion_reason === "history_under_12_months"),
      ).toBeGreaterThan(30);
      expect(count((x) => history(x, 12) && x.row.counted)).toBeGreaterThan(20);
      expect(count((x) => history(x, 23) && x.row.counted)).toBeGreaterThan(20);
      expect(count((x) => history(x, 24) && x.row.counted)).toBeGreaterThan(15);
      // A W-2 that covers part of the prior year is drawn only where R3's twelve months and
      // B3-3.3-02's months included read it alike: the same trend, and from 12 months of history a
      // decline, whose figure never reads the prior year.
      const partYear = runs.filter(
        (x) =>
          x.row.trend !== null && Number(x.s["history_months"]) < Number(x.s["ytd_months"]) + 12,
      );
      const id = (x: Run) => `${x.t.id} ${x.r.source.income_id}`;
      expect(
        partYear.filter((x) => monthsIncludedTrend(x.s as never) !== x.row.trend).map(id),
      ).toEqual([]);
      expect(
        partYear
          .filter((x) => Number(x.s["history_months"]) >= 12 && x.row.trend !== "decreasing")
          .map(id),
      ).toEqual([]);
      const under = (x: Run, trend: string) =>
        partYear.includes(x) && Number(x.s["history_months"]) < 12 && x.row.trend === trend;
      expect(count((x) => under(x, "increasing"))).toBeGreaterThan(40);
      expect(count((x) => under(x, "decreasing"))).toBeGreaterThan(20);
      expect(count((x) => partYear.includes(x) && history(x, 12) && x.row.counted)).toBeGreaterThan(
        20,
      );
    });

    it("draws Social Security's share at 14%, 15.01% and above, its two roundings, and another's record on the line", () => {
      const ss = (x: Run) => is(x, "social_security");
      const pct = (x: Run) => x.s["documented_nontaxable_pct"];
      expect(count((x) => ss(x) && pct(x) === 14)).toBeGreaterThan(20);
      expect(count((x) => ss(x) && pct(x) === 15.01)).toBeGreaterThan(12);
      expect(count((x) => ss(x) && Number(pct(x)) > 15.01)).toBeGreaterThan(60);
      const twoRoundings = (a: bigint) =>
        (((a * 1500n + 5000n) / 10000n) * 25n + 50n) / 100n !== (a * 375n + 5000n) / 10000n;
      expect(
        count((x) => ss(x) && pct(x) === null && twoRoundings(big(x.s["monthly_benefit_cents"]))),
      ).toBeGreaterThan(80);
      expect(
        count(
          (x) =>
            ss(x) && x.s["record"] !== "own" && x.s["benefit_end_date"] === x.req && x.row.counted,
        ),
      ).toBeGreaterThan(8);
      expect(
        count(
          (x) =>
            ss(x) &&
            x.s["benefit_end_date"] === dayBefore(x.req) &&
            x.row.exclusion_reason === "continuance_3y",
        ),
      ).toBeGreaterThan(8);
    });

    it("draws child support on the line, a day short, extended or not, born on 29 February, short or late in receipt, or with no decree", () => {
      const cs = (x: Run) => is(x, "child_support");
      const extended = (x: Run) => cs(x) && x.s["state_extends_support_to"] !== null;
      const eighteenth = (x: Run) => addMonths(x.s["child_date_of_birth"] as PlainDate, 216);
      const receipts = (x: Run) => Number(x.s["receipts_months"]);
      const short = (x: Run) => x.row.exclusion_reason === "receipt_history_insufficient";
      expect(
        count((x) => cs(x) && x.row.continuance_end_date === x.req && x.row.counted),
      ).toBeGreaterThan(10);
      expect(
        count(
          (x) =>
            cs(x) &&
            x.row.continuance_end_date === dayBefore(x.req) &&
            x.row.exclusion_reason === "continuance_3y",
        ),
      ).toBeGreaterThan(10);
      expect(count((x) => extended(x) && eighteenth(x) < x.req && x.row.counted)).toBeGreaterThan(
        8,
      );
      expect(
        count((x) => extended(x) && x.row.exclusion_reason === "continuance_3y"),
      ).toBeGreaterThan(8);
      // An extension that falls before the 18th birthday: support runs to the later, the birthday,
      // including where the birthday reaches the line and the extension does not.
      const early = (x: Run) =>
        extended(x) && (x.s["state_extends_support_to"] as PlainDate) < eighteenth(x);
      expect(
        count((x) => early(x) && x.row.continuance_end_date === eighteenth(x) && x.row.counted),
      ).toBeGreaterThan(15);
      expect(
        count(
          (x) =>
            early(x) && (x.s["state_extends_support_to"] as PlainDate) < x.req && x.row.counted,
        ),
      ).toBeGreaterThan(5);
      expect(
        count(
          (x) =>
            cs(x) &&
            x.s["child_date_of_birth"] === "2012-02-29" &&
            x.req === "2030-03-01" &&
            x.row.continuance_end_date === "2030-02-28" &&
            x.row.exclusion_reason === "continuance_3y",
        ),
      ).toBeGreaterThan(6);
      expect(count((x) => cs(x) && receipts(x) === 5 && short(x))).toBeGreaterThan(10);
      expect(count((x) => cs(x) && receipts(x) === 6 && x.row.counted)).toBeGreaterThan(6);
      expect(
        count(
          (x) =>
            cs(x) && receipts(x) >= 6 && x.s["receipts_full_regular_timely"] === false && short(x),
        ),
      ).toBeGreaterThan(15);
      expect(count((x) => x.row.exclusion_reason === "no_agreement")).toBeGreaterThan(20);
    });

    it("draws alimony with no term, a term on the line and a day short, and separate maintenance", () => {
      const sp = (x: Run) => is(x, "alimony", "separate_maintenance");
      const term = (x: Run) => x.s["term_end_date"];
      expect(count((x) => sp(x) && term(x) === null && x.row.counted)).toBeGreaterThan(80);
      expect(count((x) => sp(x) && term(x) === x.req && x.row.counted)).toBeGreaterThan(10);
      expect(
        count(
          (x) =>
            sp(x) && term(x) === dayBefore(x.req) && x.row.exclusion_reason === "continuance_3y",
        ),
      ).toBeGreaterThan(10);
      expect(count((x) => is(x, "separate_maintenance"))).toBeGreaterThan(60);
    });

    it("draws retirement balances at 36 months exactly and a cent short, restricted access, and several accounts", () => {
      const rd = (x: Run) => is(x, "retirement_distribution");
      const balances = (x: Run) => x.s["account_balances_cents"] as bigint[];
      const cover = (x: Run) =>
        balances(x).reduce((a, b) => a + b, 0n) - big(x.s["monthly_cents"]) * 36n;
      expect(count((x) => rd(x) && cover(x) === 0n && x.row.counted)).toBeGreaterThan(15);
      expect(
        count(
          (x) =>
            rd(x) &&
            cover(x) === -1n &&
            x.row.exclusion_reason === "continuance_assets_insufficient",
        ),
      ).toBeGreaterThan(15);
      expect(
        count((x) => rd(x) && x.s["unrestricted_penalty_free"] === false && !x.row.counted),
      ).toBeGreaterThan(25);
      expect(count((x) => rd(x) && balances(x).length > 1)).toBeGreaterThan(150);
    });

    it("draws public assistance ending on the line and a day short, with no end, and with no letter", () => {
      const pa = (x: Run) => is(x, "public_assistance");
      const end = (x: Run) => x.s["duration_end_date"];
      expect(count((x) => pa(x) && end(x) === x.req && x.row.counted)).toBeGreaterThan(15);
      expect(
        count(
          (x) =>
            pa(x) && end(x) === dayBefore(x.req) && x.row.exclusion_reason === "continuance_3y",
        ),
      ).toBeGreaterThan(15);
      expect(count((x) => pa(x) && end(x) === null && x.row.counted)).toBeGreaterThan(60);
      expect(count((x) => x.row.exclusion_reason === "agency_letter_missing")).toBeGreaterThan(25);
    });

    it("draws rent with 365 Fair Rental Days and 364, 12 months' experience and 11, netting to nothing, a loss, and a half cent", () => {
      const rent = (x: Run) => is(x, "rental_subject");
      const anri = (x: Run) => x.r.rental!.anri_cents;
      const frd = (x: Run) => Number(x.s["schedule_e_fair_rental_days"] ?? 0);
      const months = (x: Run) => Number(x.s["management_experience_months"] ?? 0);
      const offset = (x: Run) => x.row.exclusion_reason === "offset_only";
      const gain = (x: Run) => rent(x) && anri(x) > 0n;
      expect(
        count((x) => gain(x) && frd(x) === 365 && months(x) < 12 && x.row.counted),
      ).toBeGreaterThan(15);
      expect(
        count((x) => gain(x) && frd(x) === 364 && months(x) < 12 && offset(x)),
      ).toBeGreaterThan(8);
      expect(
        count((x) => gain(x) && months(x) === 12 && frd(x) < 365 && x.row.counted),
      ).toBeGreaterThan(8);
      expect(
        count((x) => gain(x) && months(x) === 11 && frd(x) < 365 && offset(x)),
      ).toBeGreaterThan(8);
      expect(
        count(
          (x) =>
            rent(x) &&
            anri(x) === 0n &&
            x.r.rental!.experienced &&
            !x.row.counted &&
            x.row.exclusion_reason === null,
        ),
      ).toBeGreaterThan(8);
      expect(count((x) => rent(x) && anri(x) === 0n && offset(x))).toBeGreaterThan(8);
      expect(
        count((x) => rent(x) && anri(x) < 0n && x.row.liability_added_cents !== "0"),
      ).toBeGreaterThan(25);
      expect(
        count(
          (x) =>
            rent(x) &&
            big(x.s["form_1007_gross_rent_cents"]) % 4n === 2n &&
            anri(x) >= -1n &&
            anri(x) <= 1n,
        ),
      ).toBeGreaterThan(10);
    });

    it("draws households of two, and retired borrowers with the income Regulation B protects", () => {
      const counted = (t: IncomeTask, s: IncomeSource) =>
        rowsOf(t).find((r) => r.income_id === s.income_id)!.counted;
      expect(
        tasks.filter(
          (t) =>
            t.borrowers.length === 2 &&
            t.borrowers.every((b) => b.sources.some((s) => counted(t, s))),
        ).length,
      ).toBeGreaterThan(200);
      expect(
        tasks.filter((t) => t.borrowers.some((b) => b.retired && b.age >= 62)).length,
      ).toBeGreaterThan(150);
      const flagged = (x: Run, flag: string) => (x.s["regb_flags"] as string[]).includes(flag);
      expect(count((x) => flagged(x, "part_time") && x.row.counted)).toBeGreaterThan(80);
      expect(count((x) => flagged(x, "age_related") && x.row.counted)).toBeGreaterThan(80);
      expect(count((x) => flagged(x, "public_assistance") && x.row.counted)).toBeGreaterThan(150);
    });

    it("draws only households that could exist, each with one paystub no more than 30 days old", () => {
      const broken: string[] = [];
      for (const t of tasks)
        for (const b of t.borrowers) {
          const fail = (why: string) => broken.push(`${t.id} ${b.borrower_id}: ${why}`);
          const of = (...types: string[]) =>
            b.sources.filter((s) => types.includes(s.type)) as unknown as Facts[];
          const jobs = of("base_salary", "hourly");
          const fullTime = jobs.some((j) => j["part_time"] === false);
          const earns = of("base_salary", "hourly", "overtime", "commission", "tip").length > 0;
          const hours = (j: Facts) =>
            Number(j["guaranteed_hours_per_week"] ?? j["avg_hours_per_week"]);
          const annualPay = (j: Facts) =>
            j["type"] === "base_salary"
              ? Number(j["pay_rate_cents"]) *
                PERIODS_PER_YEAR[j["pay_frequency"] as keyof typeof PERIODS_PER_YEAR]
              : Number(j["rate_cents"]) * hours(j) * 52;
          // Work: one base job, part-time under 30 hours, overtime on a full-time job, tips on a
          // job, one stream of each kind of variable pay.
          if (jobs.length > 1) fail("two base jobs");
          for (const h of of("hourly"))
            if (h["part_time"] !== hours(h) < 30) fail("part-time not under 30 hours");
          if (of("overtime").length > 0 && !fullTime) fail("overtime with no full-time job");
          if (of("tip").length > 0 && jobs.length === 0) fail("tips with no job");
          for (const type of ["overtime", "commission", "tip"])
            if (of(type).length > 1) fail(`two ${type} streams`);
          // One Social Security benefit: on the borrower's own record a retirement benefit from 62,
          // or a disability benefit before 67 beside no earnings.
          const ss = of("social_security");
          if (ss.length > 1) fail("two Social Security benefits");
          for (const s of ss)
            if (
              s["record"] === "own" &&
              !(s["benefit"] === "retirement"
                ? b.age >= 62
                : s["benefit"] === "disability" && !earns && b.age < 67)
            )
              fail(`an own-record ${String(s["benefit"])} benefit at ${b.age}`);
          // A history from 16, a management record from 18, a child born to a parent of 16 to 55
          // and paid for no longer than it has lived.
          for (const s of b.sources)
            if ("history_months" in s && s.history_months > (b.age - 16) * 12)
              fail(`${s.income_id}: a history begun before 16`);
          for (const s of of("rental_subject"))
            if (Number(s["management_experience_months"] ?? 0) > (b.age - 18) * 12)
              fail("property managed before 18");
          for (const s of of("child_support")) {
            const dob = s["child_date_of_birth"] as PlainDate;
            const lived = daysBetween(dob, t.application.application_date);
            const parentAt = b.age - lived / 365.25;
            if (parentAt < 16 || parentAt > 55) fail(`a parent of ${parentAt.toFixed(1)} at birth`);
            if (addMonths(dob, Number(s["receipts_months"])) > t.application.application_date)
              fail("support received longer than the child has lived");
          }
          // Retired past 62 and in no full-time job; assistance beside no job over its ceiling,
          // one award of it, one spousal award.
          if (b.retired && (b.age < 62 || fullTime)) fail("retired under 62 or in a full-time job");
          const assistance = of("public_assistance");
          if (assistance.length > 1) fail("two public assistance awards");
          if (
            assistance.length > 0 &&
            jobs.some((j) => annualPay(j) > ASSISTANCE_PAY_CEILING_CENTS)
          )
            fail("public assistance beside a job over its ceiling");
          if (of("alimony", "separate_maintenance").length > 1) fail("two spousal awards");
          // One paystub, dated before the application and no more than 30 days before it.
          const paystubs = new Set(
            b.sources.flatMap((s) => ("ytd_through" in s ? [s.ytd_through] : [])),
          );
          if (paystubs.size > 1) fail("two paystubs");
          for (const d of paystubs) {
            const age = daysBetween(d, t.application.application_date);
            if (age <= 0 || age > PAYSTUB_MAX_AGE_DAYS) fail(`a paystub ${age} days old`);
          }
        }
      expect(broken).toEqual([]);
      // And the households are still varied: an own-record benefit before 62 on disability, one
      // past 62 beside work, and assistance beside a job.
      const own = (x: Run, benefit: string) =>
        is(x, "social_security") && x.s["record"] === "own" && x.s["benefit"] === benefit;
      expect(count((x) => own(x, "disability"))).toBeGreaterThan(50);
      expect(
        count(
          (x) =>
            own(x, "retirement") &&
            x.t.borrowers
              .find((b) => b.sources.some((s) => s.income_id === x.r.source.income_id))!
              .sources.some((s) => s.type === "base_salary" || s.type === "hourly"),
        ),
      ).toBeGreaterThan(50);
    });
  });
});
