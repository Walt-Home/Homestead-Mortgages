/**
 * lossmit-retention: the grader is the servicing app's hierarchy walk, plans
 * and deferral engines and no other (each port is its file byte for byte but
 * the imports), and the conventions it restates are held to the service's
 * own lines; it gives the spec's worked examples to the cent; every
 * generated file can be evaluated from the rulebook and the tools; the
 * guard keeps out each place the engine departs from its spec; and each
 * rung and edge turns up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addDays, federal, plainDate, type PlainDate } from "@hm/kernel/calendar";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { solveNow } from "../refi/reference.js";
import { rngFor } from "../rng.js";
import {
  LOSSMIT_EDGES,
  LOSSMIT_HELDOUT_SUITE,
  LOSSMIT_SPEC_CASES,
  LossmitReferencePolicy,
  RETENTION,
  SCREEN_REASONS,
  analyzeLossmit,
  drawLossmitCandidate,
  drawLossmitTask,
  executeLossmitTool,
  expectedLossmit,
  flexCriteriaHold,
  generateLossmitSuite,
  generateLossmitTask,
  gradeLossmitAgainst,
  lossmitArmOf,
  lossmitEdgeOf,
  lossmitFairToGrade,
  lossmitInScope,
  lossmitPayload,
  lossmitRetention,
  lossmitSpecTasks,
  lossmitSteps,
  lossmitTaskId,
  monthsDelinquent,
  monthsToMaturity,
  parseLossmitSubmission,
  pitiOf,
  type DeferralTermsAnswer,
  type ForbearanceTermsAnswer,
  type LossmitAnswer,
  type LossmitTask,
  type RepaymentTermsAnswer,
} from "../lossmit/index.js";
import {
  evaluationDeadlines,
  hierarchyWalk,
  HIERARCHY,
  tier,
} from "../lossmit/ported/evaluation.js";
import {
  forbearanceTerm,
  forbearanceTermDates,
  regxShortTermForbearance,
  repaymentTerms,
} from "../lossmit/ported/plans.js";
import { screen, timeline } from "../lossmit/ported/deferral.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const imports = (text: string) => text.split("\n").filter((l) => l.startsWith("import "));
const withoutImports = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith("import "))
    .join("\n");
/** Each import line with its module path removed: what it imports, and how. */
const importHeads = (text: string) => imports(text).map((l) => l.replace(/ from "[^"]+";$/, ""));
/** The one rewrite a port may carry: the kernel's paths become the package's. */
const rewritten = (lines: readonly string[]) =>
  lines.map((l) =>
    l.replace(/"\.\.\/\.\.\/kernel\/(calendar|money)\/[a-z-]+\.ts"/g, '"@hm/kernel/$1"'),
  );

const servicing = (path: string) =>
  readFileSync(here(`../../../../apps/servicing/src/${path}`), "utf8").split("\n");
/** A run of service lines, found by how the first begins, with the lines the grader cites them by. */
const serviceLines = (path: string, first: string, n: number) => {
  const lines = servicing(path);
  const start = lines.findIndex((l) => l.trimStart().startsWith(first));
  if (start < 0) return `${path}: no line beginning ${first}`;
  const file = path.split("/").pop()!;
  return [`${file}:${start + 1}-${start + n}`, ...lines.slice(start, start + n)].join("\n");
};

/** The fields where the rulebook, followed through the tools, lands somewhere other than the engine. */
const byRulesMisses = (task: LossmitTask): string[] => {
  let raw: unknown;
  try {
    raw = solveNow(
      lossmitSteps,
      JSON.parse(JSON.stringify(lossmitPayload(task))),
      executeLossmitTool,
    );
  } catch (e) {
    return [`${task.id} threw ${e instanceof Error ? e.message : String(e)}`];
  }
  const parsed = parseLossmitSubmission(raw);
  if (!parsed.ok) return [`${task.id} ${parsed.error}`];
  return gradeLossmitAgainst(expectedLossmit(task), parsed.answer)
    .fields.filter((f) => !f.ok)
    .map((f) => `${task.id} ${f.field} ${f.expected}/${f.got}`);
};

const solveAll = async (tasks: readonly LossmitTask[]) => {
  const misses: string[] = [];
  let turns = 0;
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(lossmitRetention, task, new LossmitReferencePolicy());
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

const SPEC = lossmitSpecTasks();
const [WORKED] = SPEC as [LossmitTask];
const d = plainDate;
type Over = {
  [K in keyof LossmitTask]?: LossmitTask[K] extends Record<string, unknown>
    ? Partial<LossmitTask[K]>
    : LossmitTask[K];
};
/** The worked loan with some of it changed. */
const workedWith = (over: Over, base: LossmitTask = WORKED): LossmitTask => ({
  ...base,
  ...over,
  loan: { ...base.loan, ...over.loan },
  borrower: { ...base.borrower, ...over.borrower },
  forbearance: { ...base.forbearance, ...over.forbearance },
  history: { ...base.history, ...over.history },
  deferral: { ...base.deferral, ...over.deferral },
});
const deferralTerms = (a: LossmitAnswer) => a.terms as DeferralTermsAnswer;
const planTerms = (a: LossmitAnswer) => a.terms as RepaymentTermsAnswer;
const forbearanceTerms = (a: LossmitAnswer) => a.terms as ForbearanceTermsAnswer;

describe("lossmit-retention", () => {
  it("grades with the servicing app's engines: each port is its file but for the imports", () => {
    const counts: Record<string, number> = { evaluation: 1, plans: 3, deferral: 4 };
    for (const file of ["evaluation", "plans", "deferral"]) {
      const original = servicing(`domain/lossmit/${file}.ts`).join("\n");
      const port = readFileSync(here(`../lossmit/ported/${file}.ts`), "utf8");
      expect(withoutImports(port), file).toBe(withoutImports(original));
      expect(imports(port), file).toEqual(rewritten(imports(original)));
      // The same names, imported the same way; and no sibling, so nothing else came along.
      expect(importHeads(port), file).toEqual(importHeads(original));
      expect(imports(port), file).toHaveLength(counts[file]!);
      expect(
        imports(port).every((l) => l.includes('"@hm/kernel/')),
        file,
      ).toBe(true);
    }
  });

  it("holds the conventions it restates to the service's own lines", () => {
    // A re-vendor that changes any of these fails here: revisit the grader, the rulebook and their citations.
    expect(serviceLines("domain/lossmit/ops.ts", "export function arrears(", 4))
      .toMatchInlineSnapshot(`
      "ops.ts:360-363
      export function arrears(i: { piti_cents: Cents; unpaid_installments: number; late_charge_cents: Cents; late_charges: number }): { installments_cents: Cents; late_charges_cents: Cents; total_cents: Cents } {
        const inst = BigInt(i.unpaid_installments) * i.piti_cents; const lc = BigInt(i.late_charges) * i.late_charge_cents;
        return { installments_cents: inst, late_charges_cents: lc, total_cents: inst + lc };
      }"
    `);
    expect(serviceLines("domain/lossmit/ops.ts", "export function capStructure(", 5))
      .toMatchInlineSnapshot(`
      "ops.ts:368-372
      export function capStructure(i: { prior_deferred_months: number; requested_months: number; cap?: number }): { cumulative: number; contractual_payment_required: boolean; months_allowed: number; installments_to_pay: number; alternative: "flex_mod" | null } {
        const cap = i.cap ?? 12; const cum = i.prior_deferred_months + i.requested_months; const room = Math.max(0, cap - i.prior_deferred_months);
        const allowed = Math.min(room, i.requested_months);
        return { cumulative: cum, contractual_payment_required: cum > cap, months_allowed: allowed, installments_to_pay: i.requested_months - allowed, alternative: cum > cap ? "flex_mod" : null };
      }"
    `);
    expect(serviceLines("domain/lossmit/ops.ts", "export function forbearanceBasisGate(", 2))
      .toMatchInlineSnapshot(`
      "ops.ts:216-217
      export function forbearanceBasisGate(i: { forborne_months_before: number; term_months: number; regx_basis?: RegxBasis | null }): { regx_short_term: boolean; forborne_months_after: number; basis_required: boolean; allowed: boolean; refusal: string | null } {
        const after = i.forborne_months_before + i.term_months; const shortTerm = regxShortTermForbearance(after);"
    `);
    expect(
      serviceLines(
        "domain/lossmit/ops.ts",
        '{ account: "late_charge_waivers", debit: i.late_charges_cents, credit: 0n, rule_ref: "12.6',
        1,
      ),
    ).toMatchInlineSnapshot(`
      "ops.ts:406-406
          { account: "late_charge_waivers", debit: i.late_charges_cents, credit: 0n, rule_ref: "12.6.deferral.late_charge_waiver" },"
    `);
    expect(serviceLines("domain/lossmit/ops-12-4.ts", "export function termComputation(", 5))
      .toMatchInlineSnapshot(`
      "ops-12-4.ts:66-70
      export function termComputation(i: Pick<TermRequest, "requested_months" | "cumulative_months" | "months_delinquent_at_start" | "start_on" | "last_scheduled_payment_date" | "repayment_component_months" | "mbs">): TermComputation {
        const mbsCap = i.mbs && i.last_scheduled_payment_date ? mbsMonthsToMaturity(i.start_on, i.last_scheduled_payment_date) : null;
        const combined = i.cumulative_months + (i.repayment_component_months ?? 0);
        const t = forbearanceTerm({ requested_months: i.requested_months, cumulative_months: i.cumulative_months, months_delinquent_at_start: i.months_delinquent_at_start, mbs_months_to_maturity: mbsCap, combined_months: combined });
        return { requested: i.requested_months, cap_increment: FB_INCREMENT_MAX, cap_cumulative: 12 - i.cumulative_months, cap_delinquency: 12 - i.months_delinquent_at_start, mbs_cap: mbsCap, cap_combined: 36 - combined, chosen: t.months, capped_by: t.capped_by, exception_required: t.exception_required };"
    `);
    expect(serviceLines("domain/lossmit/ops-12-6.ts", "const cap = capStructure(", 4))
      .toMatchInlineSnapshot(`
      "ops-12-6.ts:103-106
        const cap = capStructure({ prior_deferred_months: i.facts.cumulative_deferred_months, requested_months: i.facts.months_delinquent });
        const solicitation = basis === "post_forbearance" || basis === "post_repayment";
        const template = solicitation ? SOLICITATION_TEMPLATES[basis] : OFFER_TEMPLATE;
        const tl = timeline(i.facts.evaluation_date, { processing_month_elected: i.processing_month_elected === true });   // refuses an election the 15th still permits completing without"
    `);
    expect(
      serviceLines(
        "domain/lossmit/ops-12-6.ts",
        "months_deferred: s.months_deferred, cumulative_months_after",
        1,
      ),
    ).toMatchInlineSnapshot(`
      "ops-12-6.ts:109-109
          months_deferred: s.months_deferred, cumulative_months_after: i.facts.cumulative_deferred_months + s.months_deferred, contractual_payment_required: s.contractual_payment_required, installments_to_pay: cap.installments_to_pay,"
    `);
    expect(serviceLines("app/tools/section12.ts", 'need(i, "application_id"); const complete', 2))
      .toMatchInlineSnapshot(`
      "section12.ts:158-159
            need(i, "application_id"); const complete = date(i, "complete_on"); const t = tier(complete, optDate(i, "sale_on")); const provided = optDate(i, "provided_on") ?? complete;
            const dl = evaluationDeadlines(complete, provided, t, str(i, "state") || undefined); const outcome = str(i, "outcome") || "pending";"
    `);
    expect(serviceLines("app/tools/section12.ts", '{ name: "hierarchy.walk"', 1))
      .toMatchInlineSnapshot(`
      "section12.ts:165-165
        { name: "hierarchy.walk", kind: "read", handler: compute((i) => hierarchyWalk({ can_reinstate: flag(i, "can_reinstate"), hardship_temporary_unresolved: flag(i, "hardship_temporary_unresolved"), can_afford_repayment: flag(i, "can_afford_repayment"), deferral_eligible: flag(i, "deferral_eligible"), flexmod_eligible: flag(i, "flexmod_eligible"), liquidation_requested: flag(i, "liquidation_requested"), ...(str(i, "liquidation_option") ? { liquidation_option: str(i, "liquidation_option") as "short_sale" | "mortgage_release" } : {}), ...(i.liquidation_eligible === undefined ? {} : { liquidation_eligible: flag(i, "liquidation_eligible") }) })) },"
    `);
  });

  describe("gives the spec's worked examples to the cent", () => {
    const want = SPEC.map(expectedLossmit);
    const named = (prefix: string) => {
      const k = LOSSMIT_SPEC_CASES.findIndex((c) => c.name.startsWith(prefix));
      if (k < 0) throw new Error(`no spec case ${prefix}`);
      return want[k]!;
    };

    it("12.6 rule 3 / T1: NIB $7,370.68, $252.00 waived, $2,131.17 a month, in SMDU by 09-30", () => {
      const t1 = named("12.6 worked example");
      expect(t1.offered).toBe("payment_deferral");
      expect(t1.terms).toEqual({
        months_deferred: 4,
        installments_to_pay: 0,
        contractual_payment_required: false,
        cumulative_months_after: 4,
        nib_cents: "737068",
        late_charges_waived_cents: "25200",
        shortage_monthly_cents: "3100",
        new_payment_cents: "213117",
      });
      expect(t1.deferral_timeline).toEqual({
        processing_month: false,
        entry_deadline: "2026-09-30",
        lar_deadline: "2026-09-29",
        effective: "2026-10-01",
        custodian_by: "2026-10-26",
      });
      // 12.6-T7: provided 10-02, 14 days to 10-16, deemed rejected after 5 more on 10-21.
      expect(t1.regx).toMatchObject({
        window_days: 14,
        accept_by: "2026-10-16",
        deemed_rejected_on: "2026-10-21",
      });
    });

    it("12.6-T2, T3 and T4: the window, the prior deferral, the cap", () => {
      const six = named("12.6-T2: the same loan 6 months");
      expect(deferralTerms(six)).toMatchObject({
        months_deferred: 6,
        contractual_payment_required: true,
      });
      expect(named("12.6-T2: 7 months").deferral_screen).toEqual({
        eligible: false,
        reason: "INV_FNMA_D23204_DELQ_WINDOW",
      });
      expect(named("12.6-T2: 7 months").offered).toBe("flex_mod");
      expect(named("12.6-T3: a deferral effective").deferral_screen).toEqual({
        eligible: false,
        reason: "INV_FNMA_D23204_PRIOR_DEFERRAL_12M",
      });
      expect(named("12.6-T3: the same deferral").offered).toBe("payment_deferral");
      expect(named("12.6-T3: a disaster deferral").offered).toBe("payment_deferral");
      expect(deferralTerms(named("12.6-T4"))).toMatchObject({
        months_deferred: 3,
        installments_to_pay: 1,
        contractual_payment_required: true,
        cumulative_months_after: 12,
      });
      // 12.6-T2's one month, and T5's processing month, outside a v1 file (see the guard below).
      const facts = {
        origination_date: d("2021-10-01"),
        evaluation_date: d("2026-09-20"),
        cumulative_deferred_months: 0,
        months_to_maturity: 300,
      };
      expect(screen({ ...facts, months_delinquent: 1 })).toMatchObject({
        reason: "INV_FNMA_D23204_DELQ_WINDOW",
      });
      const t5 = timeline(d("2026-09-18"), { processing_month_elected: true });
      expect([t5.processing_month, t5.entry_deadline, t5.lar_deadline, t5.effective]).toEqual([
        true,
        "2026-10-31",
        "2026-10-30",
        "2026-11-01",
      ]);
    });

    it("12.5 rule 4 / T1: 6 months is 151.00%, 7 is over capacity, 8 is $803.25 at 138.25%", () => {
      const terms = (m: number) => {
        const t = repaymentTerms(642_600n, 210_000n, m);
        return [t.installment_cents, t.total_monthly_cents, t.pct_of_contractual, t.allowed];
      };
      expect(terms(6)).toEqual([107_100n, 317_100n, "151.00", false]);
      expect(terms(7)).toEqual([91_800n, 301_800n, "143.71", true]);
      expect(terms(8)).toEqual([80_325n, 290_325n, "138.25", true]);
      expect(terms(12).slice(0, 2)).toEqual([53_550n, 263_550n]);
      expect(named("12.5 worked example: $6,426.00")).toMatchObject({
        arrears: { months_delinquent: 3, late_charges_cents: "12600", arrears_cents: "642600" },
        offered: "repayment_plan",
        terms: {
          months: 8,
          installment_cents: "80325",
          final_installment_cents: "80325",
          total_monthly_cents: "290325",
          pct_of_contractual: "138.25",
          regx_short_term: false,
        },
      });
      // $2,500.00 a month affords no plan; 3 months delinquent, the deferral.
      const low = named("12.5 worked example: $2,500.00");
      expect(low.offered).toBe("payment_deferral");
      expect(deferralTerms(low)).toMatchObject({ months_deferred: 3, nib_cents: "474051" });
      // October's last day is a Saturday: the reporting deadline is Friday the 30th.
      expect(low.deferral_timeline?.lar_deadline).toBe("2026-10-30");
    });

    it("12.2 rule 7 / T1, T2, T9: decision by 11-06, accept by 11-16, deemed 11-21; NY 12-02; 7 days at 75", () => {
      expect(named("12.5 worked example: $6,426.00").regx).toEqual({
        tier: "ge_90",
        decision_due: "2026-11-06",
        window_days: 14,
        accept_by: "2026-11-16",
        appeal_rights: true,
        deemed_rejected_on: "2026-11-21",
      });
      expect(named("12.2 rule 7").regx).toMatchObject({ window_days: 30, accept_by: "2026-12-02" });
      expect(named("12.2-T2").regx).toMatchObject({
        tier: "lt_90",
        window_days: 7,
        appeal_rights: false,
        decision_due: "2026-12-01",
      });
    });

    it("12.4 rule 2 / T1, T2, T3: 3 + 3 + 3, then one month to 2027-07-31 with the exception required", () => {
      expect(
        SPEC.slice(-4)
          .map(expectedLossmit)
          .map((a) => {
            const f = forbearanceTerms(a);
            return [
              f.months,
              f.capped_by.join("+"),
              f.exception_required,
              f.term_start,
              f.term_end,
              f.regx_short_term,
            ];
          }),
      ).toEqual([
        [3, "increment_3", false, "2026-10-01", "2026-12-31", true],
        [3, "increment_3", false, "2027-01-01", "2027-03-31", true],
        [3, "increment_3", false, "2027-04-01", "2027-06-30", false],
        [1, "delinquency_12", true, "2027-07-01", "2027-07-31", false],
      ]);
      // A 2-month request at the fourth term is still one month, with the exception package.
      expect(
        forbearanceTerm({
          requested_months: 2,
          cumulative_months: 9,
          months_delinquent_at_start: 11,
        }),
      ).toEqual({ months: 1, capped_by: ["delinquency_12"], exception_required: true });
      expect([regxShortTermForbearance(6), regxShortTermForbearance(9)]).toEqual([true, false]);
    });

    it("and every spec case is in scope, fair to grade, and solved through the tools", () => {
      for (const t of SPEC) {
        expect(lossmitInScope(t), t.id).toBe(true);
        expect(lossmitFairToGrade(t), t.id).toBe(true);
        expect(byRulesMisses(t)).toEqual([]);
      }
    });
  });

  it("restates the conventions the engine leaves to its caller", () => {
    // 12.6 rule 1 counts unpaid installments, both ends included: June to September on 09-20 is 4,
    // and an installment due on the evaluation day is one of them.
    expect(monthsDelinquent(d("2026-06-01"), d("2026-09-20"))).toBe(4);
    expect(monthsDelinquent(d("2026-06-01"), d("2026-09-01"))).toBe(4);
    expect(monthsDelinquent(d("2026-06-01"), d("2026-08-31"))).toBe(3);
    // D11: the worked loan, first payment 2021-11-01 and 360 of them, matures 2051-10-01: 300
    // whole months from 2026-09-20, where the spec says 348. Either passes criterion 9.
    expect(monthsToMaturity(WORKED)).toBe(300);
    // PITI is P&I and escrow; the arrears carry late charges, the deferral's balance never does.
    expect(pitiOf(WORKED)).toBe(210_017n);
    const t1 = expectedLossmit(WORKED);
    expect(BigInt(t1.arrears.arrears_cents)).toBe(4n * 210_017n + 4n * 6_300n);
    expect(BigInt(deferralTerms(t1).nib_cents)).toBe(4n * 158_017n + 105_000n);
    // 12.2 rule 2's walk offers reinstatement whenever the funds cover the arrears, a temporary
    // hardship included (12.4's pre-expiry screen would not; v1 follows the walk).
    const funds = BigInt(t1.arrears.arrears_cents);
    for (const hardship of ["temporary_unresolved", "resolved", "permanent"] as const)
      expect(
        expectedLossmit(workedWith({ borrower: { hardship, funds_available_cents: funds } }))
          .offered,
      ).toBe("reinstatement");
    expect(
      expectedLossmit(workedWith({ borrower: { funds_available_cents: funds - 1n } })).offered,
    ).toBe("payment_deferral");
    // A permanent hardship never reaches the screen; a temporary one is offered forbearance.
    const permanent = expectedLossmit(workedWith({ borrower: { hardship: "permanent" } }));
    expect([permanent.offered, permanent.deferral_screen]).toEqual(["flex_mod", null]);
    // Exactly 12 months on passes each 12-month test; a month short fails.
    const atYear = expectedLossmit(
      workedWith({
        evaluation_date: d("2026-11-01"),
        notice_provided_on: d("2026-11-05"),
        loan: { next_due_date: d("2026-08-01"), unpaid_late_charges: 3 },
        history: { cumulative_deferred_months: 2, last_deferral_effective: d("2025-11-01") },
      }),
    );
    expect(atYear.offered).toBe("payment_deferral");
    // The forbearance term starts the 1st after the evaluation, a 31st-day month included.
    const may = expectedLossmit(
      workedWith({
        evaluation_date: d("2027-05-05"),
        notice_provided_on: d("2027-05-07"),
        loan: { next_due_date: d("2027-03-01"), unpaid_late_charges: 2 },
        borrower: { hardship: "temporary_unresolved" },
        forbearance: { forborne_months: 0, requested_months: 2 },
      }),
    );
    expect(forbearanceTerms(may)).toMatchObject({
      months: 2,
      capped_by: [],
      term_start: "2027-06-01",
      term_end: "2027-07-31",
    });
  });

  it("fails an answer one cent off on exactly that field, and charges for a section given or left out", () => {
    const want = expectedLossmit(WORKED);
    const wrong = (answer: unknown) =>
      gradeLossmitAgainst(want, answer as LossmitAnswer)
        .fields.filter((f) => !f.ok)
        .map((f) => f.field);
    expect(gradeLossmitAgainst(want, want).pass).toBe(true);
    expect(gradeLossmitAgainst(want, want).fields.map((f) => f.field)).toEqual([
      "arrears",
      "offered",
      "terms",
      "deferral_screen",
      "deferral_timeline",
      "regx",
    ]);
    expect(wrong({ ...want, terms: { ...deferralTerms(want), nib_cents: "737069" } })).toEqual([
      "terms",
    ]);
    expect(wrong({ ...want, arrears: { ...want.arrears, arrears_cents: "865267" } })).toEqual([
      "arrears",
    ]);
    expect(wrong({ ...want, regx: { ...want.regx, deemed_rejected_on: "2026-10-20" } })).toEqual([
      "regx",
    ]);
    expect(
      wrong({
        ...want,
        deferral_timeline: { ...want.deferral_timeline!, lar_deadline: "2026-09-30" },
      }),
    ).toEqual(["deferral_timeline"]);
    // A plan answered where the deferral is due: the offer, its terms, and the two deferral sections.
    const plan = expectedLossmit(SPEC[7]!);
    expect(
      wrong({
        ...want,
        offered: "repayment_plan",
        terms: plan.terms,
        deferral_screen: null,
        deferral_timeline: null,
      }),
    ).toEqual(["offered", "terms", "deferral_screen", "deferral_timeline"]);
    // Where the engine has no screen, an answer that gives one is graded on it, and fails.
    const planWant = expectedLossmit(SPEC[7]!);
    const graded = (a: LossmitAnswer) =>
      gradeLossmitAgainst(planWant, a).fields.map((f) => f.field);
    expect(graded(planWant)).toEqual(["arrears", "offered", "terms", "regx"]);
    expect(
      graded({
        ...planWant,
        deferral_screen: { eligible: false, reason: "INV_FNMA_D23204_MATURITY" },
      }),
    ).toEqual(["arrears", "offered", "terms", "deferral_screen", "regx"]);
    // No answer at all is every field wrong.
    expect(gradeLossmitAgainst(want, null).score).toBe(0);
  });

  it("reads a submission strictly, as the schema says, and bounces what does not fit", () => {
    const want = expectedLossmit(WORKED);
    const plan = expectedLossmit(SPEC[7]!);
    const term1 = expectedLossmit(SPEC[11]!);
    const ok = (x: unknown) => parseLossmitSubmission(x).ok;
    expect(ok(want)).toBe(true);
    expect(ok(plan)).toBe(true);
    expect(ok(term1)).toBe(true);
    // Every key required, and nothing the schema does not name.
    const { regx: _r, ...noRegx } = want;
    expect(ok(noRegx)).toBe(false);
    expect(ok({ ...want, notes: "x" })).toBe(false);
    expect(ok({ ...want, arrears: { ...want.arrears, extra: 1 } })).toBe(false);
    const { deferral_screen: _s, ...noScreen } = want;
    expect(ok(noScreen)).toBe(false);
    // Cents are integer strings; a percentage has two decimals; months are whole.
    expect(ok({ ...want, arrears: { ...want.arrears, arrears_cents: "8652.68" } })).toBe(false);
    expect(ok({ ...want, arrears: { ...want.arrears, arrears_cents: 865268 } })).toBe(false);
    expect(ok({ ...want, arrears: { ...want.arrears, arrears_cents: " 865268" } })).toBe(false);
    expect(ok({ ...want, arrears: { ...want.arrears, months_delinquent: "4" } })).toBe(false);
    expect(ok({ ...want, regx: { ...want.regx, accept_by: "2026-10-16T00:00" } })).toBe(false);
    expect(ok({ ...want, regx: { ...want.regx, window_days: 0 } })).toBe(false);
    expect(ok({ ...plan, terms: { ...planTerms(plan), pct_of_contractual: "138.3" } })).toBe(false);
    expect(ok({ ...plan, terms: { ...planTerms(plan), months: 8.5 } })).toBe(false);
    expect(ok({ ...want, offered: "short_sale" })).toBe(false);
    expect(ok({ ...want, regx: { ...want.regx, tier: "gt_37" } })).toBe(false);
    // The terms fit the offer, and a section stands where the walk puts it.
    expect(ok({ ...want, terms: planTerms(plan) })).toBe(false);
    expect(ok({ ...plan, offered: "reinstatement" })).toBe(false);
    expect(ok({ ...want, deferral_timeline: null })).toBe(false);
    expect(
      ok({ ...plan, deferral_screen: { eligible: false, reason: "INV_FNMA_D23204_MATURITY" } }),
    ).toBe(false);
    expect(
      ok({ ...want, deferral_screen: { eligible: false, reason: "INV_FNMA_D23204_MATURITY" } }),
    ).toBe(false);
    expect(
      ok({ ...want, deferral_screen: { eligible: true, reason: "INV_FNMA_D23204_MATURITY" } }),
    ).toBe(false);
    expect(ok({ ...want, offered: "flex_mod", terms: null, deferral_timeline: null })).toBe(false);
    // capped_by: names from the vocabulary, each once; the order is the engine's, put right rather than graded.
    const caps = (capped_by: unknown) => ({
      ...term1,
      terms: { ...forbearanceTerms(term1), capped_by },
    });
    expect(ok(caps(["increment_3", "increment_3"]))).toBe(false);
    expect(ok(caps(["requested"]))).toBe(false);
    expect(ok(caps(["combined_36"]))).toBe(false);
    const tie = expectedLossmit(
      workedWith({
        evaluation_date: d("2027-08-10"),
        notice_provided_on: d("2027-08-12"),
        loan: { next_due_date: d("2026-10-01"), unpaid_late_charges: 0 },
        borrower: { hardship: "temporary_unresolved" },
        forbearance: { forborne_months: 11, requested_months: 3 },
      }),
    );
    expect(forbearanceTerms(tie).capped_by).toEqual(["cumulative_12", "delinquency_12"]);
    const reversed = parseLossmitSubmission({
      ...tie,
      terms: { ...forbearanceTerms(tie), capped_by: ["delinquency_12", "cumulative_12"] },
    });
    expect(reversed.ok && gradeLossmitAgainst(tie, reversed.answer).pass).toBe(true);
  });

  describe("scores an answer that works out nothing for what it did", () => {
    const held = generateLossmitSuite(
      "heldout",
      LOSSMIT_HELDOUT_SUITE.seed,
      LOSSMIT_HELDOUT_SUITE.n,
    );
    const scored = (f: (t: LossmitTask) => LossmitAnswer) => {
      const grades = held.map((t) => {
        const a = f(t);
        const parsed = parseLossmitSubmission(JSON.parse(toJsonLine(a)));
        if (!parsed.ok) throw new Error(`${t.id}: ${parsed.error}`);
        return gradeLossmitAgainst(expectedLossmit(t), parsed.answer);
      });
      return {
        mean: grades.reduce((s, g) => s + g.score, 0) / grades.length,
        passed: grades.filter((g) => g.pass).length,
      };
    };
    // One option offered every time, every section it does not call for null, nothing worked out:
    // the arrears zero and the windows read straight off the task's own dates.
    const constant =
      (offered: "reinstatement" | "flex_mod") =>
      (t: LossmitTask): LossmitAnswer => ({
        arrears: { months_delinquent: 0, late_charges_cents: "0", arrears_cents: "0" },
        offered,
        terms: null,
        deferral_screen: null,
        deferral_timeline: null,
        regx: {
          tier: "ge_90",
          decision_due: t.evaluation_date,
          window_days: 14,
          accept_by: t.notice_provided_on,
          appeal_rights: true,
          deemed_rejected_on: t.notice_provided_on,
        },
      });
    // Every date and count right and no money: the arrears' count but not their amount, the offer
    // decided without comparing a figure (forbearance on a temporary hardship, Flex Modification on a
    // permanent one, and on a resolved one the deferral when the screen's dates pass), forbearance's
    // terms (they are all dates and counts), the screen, the deferral's clock and the windows.
    const datesOnly = (t: LossmitTask): LossmitAnswer => {
      const want = expectedLossmit(t);
      const a = analyzeLossmit(t);
      const base = {
        ...want,
        arrears: { ...want.arrears, late_charges_cents: "0", arrears_cents: "0" },
      };
      if (t.borrower.hardship === "temporary_unresolved")
        return {
          ...base,
          offered: "forbearance",
          terms: {
            months: a.forbearance.months,
            capped_by: a.forbearance.capped_by,
            exception_required: a.forbearance.exception_required,
            term_start: a.forbearance.start,
            term_end: a.forbearance.end,
            regx_short_term: a.forbearance.regx_short_term,
          },
          deferral_screen: null,
          deferral_timeline: null,
        };
      if (t.borrower.hardship === "permanent")
        return {
          ...base,
          offered: "flex_mod",
          terms: null,
          deferral_screen: null,
          deferral_timeline: null,
        };
      if (!a.screen.eligible)
        return {
          ...base,
          offered: "flex_mod",
          terms: null,
          deferral_screen: { eligible: false, reason: a.screen.reason as never },
          deferral_timeline: null,
        };
      const tl = timeline(t.evaluation_date, {
        processing_month_elected: t.deferral.processing_month_elected,
      });
      return {
        ...base,
        offered: "payment_deferral",
        terms: {
          months_deferred: a.screen.months_deferred,
          installments_to_pay: 0,
          contractual_payment_required: a.screen.contractual_payment_required,
          cumulative_months_after: t.history.cumulative_deferred_months + a.screen.months_deferred,
          nib_cents: "0",
          late_charges_waived_cents: "0",
          shortage_monthly_cents: "0",
          new_payment_cents: "0",
        },
        deferral_screen: { eligible: true, reason: null },
        deferral_timeline: {
          processing_month: tl.processing_month,
          entry_deadline: tl.entry_deadline,
          lar_deadline: tl.lar_deadline,
          effective: tl.effective,
          custodian_by: tl.custodian_by,
        },
      };
    };

    it("one option every time, nothing worked out: about a twentieth, and never a pass", () => {
      const reinstated = scored(constant("reinstatement"));
      const flex = scored(constant("flex_mod"));
      expect(reinstated.passed + flex.passed).toBe(0);
      expect(reinstated.mean).toBeLessThan(0.08);
      expect(flex.mean).toBeLessThan(0.08);
    });

    it("every date and count right and no money: about half the fields, and never a pass", () => {
      // The mean field score is read against this, never in place of the pass.
      const s = scored(datesOnly);
      expect(s.passed).toBe(0);
      expect(s.mean).toBeGreaterThan(0.4);
      expect(s.mean).toBeLessThan(0.6);
    });
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    // The generator keeps a draw only once the reference solves it, so a pass on a suite it built
    // would prove nothing by itself if anything had been redrawn. Every held-out file is its
    // index's first draw.
    const drawn = Array.from({ length: LOSSMIT_HELDOUT_SUITE.n }, (_, i) =>
      drawLossmitTask(LOSSMIT_HELDOUT_SUITE.split, LOSSMIT_HELDOUT_SUITE.seed, i),
    );
    expect(drawn.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    const r = await solveAll([...SPEC, ...drawn.map((x) => x.task)]);
    expect(r.misses).toEqual([]);
    // Inside the episode's 80 turns even for a model that makes one tool call a turn: the
    // reference's call count, submission included, is that model's turn count.
    expect(r.calls).toBeLessThan(70);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    const r = await solveAll(generateLossmitSuite("train", 11, 300));
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(70);
  }, 120_000);

  it("is fair to grade on every first draw, and stays out of the engine's regions of doubt", () => {
    const draws = Array.from({ length: 600 }, (_, i) => drawLossmitTask("train", 3, i));
    expect(draws.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    for (const { task } of draws) {
      expect(lossmitInScope(task)).toBe(true);
      expect(task.flexmod_eligible).toBe(true);
      expect(task.history.active_arrangements).toEqual([]);
    }
  });

  it("holds the rulebook to the engine on candidates nothing filtered", () => {
    // The fairness filter would hide a disagreement; the candidates it would see show none.
    const unfair: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      const id = lossmitTaskId("train", 99, i);
      const task = drawLossmitCandidate(rngFor(id), id, "train", 99, i);
      if (!lossmitInScope(task)) unfair.push(`${id} out of scope`);
      else unfair.push(...byRulesMisses(task));
    }
    expect(unfair).toEqual([]);
  }, 120_000);

  describe("keeps out each place the engine departs from its spec, and reproduces each", () => {
    const sevenBehind = { loan: { next_due_date: d("2026-03-01"), unpaid_late_charges: 7 } };

    it("D5: every retention option failing is a short sale offered with no test", () => {
      const walk = hierarchyWalk({
        can_reinstate: false,
        hardship_temporary_unresolved: false,
        can_afford_repayment: false,
        deferral_eligible: false,
        flexmod_eligible: false,
      });
      expect(walk.offered).toBe("short_sale");
      expect(walk.determinations.map((x) => `${x.option}:${x.result}`).slice(-2)).toEqual([
        "short_sale:offered",
        "mortgage_release:not_evaluated_ranking",
      ]);
      const failed = workedWith({ ...sevenBehind, flexmod_eligible: false });
      expect(analyzeLossmit(failed).walk.offered).toBe("short_sale");
      expect(lossmitInScope(failed)).toBe(false);
      expect(lossmitInScope(workedWith(sevenBehind))).toBe(true);
    });

    it("the Flex Modification rung only for a file that meets 12.8's own criteria", () => {
      // Each would be refused by the Flex Modification and go on to D5's short sale.
      const young = workedWith({
        ...sevenBehind,
        loan: { ...sevenBehind.loan, origination_date: d("2025-10-15") },
      });
      expect(expectedLossmit(young).deferral_screen?.reason).toBe("INV_FNMA_D23204_SEASONING_12M");
      const arrangement = workedWith({
        history: { active_arrangements: ["active_trial_period_plan"] },
      });
      expect(expectedLossmit(arrangement).deferral_screen?.reason).toBe(
        "INV_FNMA_D23204_CONFLICTING_ARRANGEMENT",
      );
      const trial = workedWith({ history: { last_failed_trial_on: d("2026-01-20") } });
      expect(expectedLossmit(trial).deferral_screen?.reason).toBe(
        "INV_FNMA_D23204_TRIAL_OR_MOD_12M",
      );
      const modified = workedWith({ history: { last_modification_effective: d("2026-01-01") } });
      const oneBehind = workedWith({
        loan: { next_due_date: d("2026-09-01"), unpaid_late_charges: 1 },
        borrower: { capacity_cents: 213_117n },
      });
      expect(expectedLossmit(oneBehind).deferral_screen?.reason).toBe(
        "INV_FNMA_D23204_DELQ_WINDOW",
      );
      for (const t of [young, arrangement, trial, modified, oneBehind]) {
        expect(expectedLossmit(t).offered, t.id).toBe("flex_mod");
        expect(flexCriteriaHold(t)).toBe(false);
        expect(lossmitInScope(t)).toBe(false);
      }
    });

    it("no sale 37 days out or less, where there is no (c)(1) duty but the engine sets 7 days", () => {
      const sixBehind = {
        loan: { next_due_date: d("2026-04-01"), unpaid_late_charges: 6 },
        state: "TX",
      };
      const at = (days: number) =>
        workedWith({ ...sixBehind, scheduled_sale_on: addDays(WORKED.evaluation_date, days) });
      expect(
        evaluationDeadlines(WORKED.evaluation_date, WORKED.notice_provided_on, "le_37").window_days,
      ).toBe(7);
      expect(
        [90, 89, 38, 37].map((n) =>
          tier(WORKED.evaluation_date, addDays(WORKED.evaluation_date, n)),
        ),
      ).toEqual(["ge_90", "lt_90", "lt_90", "le_37"]);
      expect(lossmitInScope(at(38))).toBe(true);
      expect(lossmitInScope(at(37))).toBe(false);
    });

    it("D7: a decision date on a weekend, which the spec moves back and the engine does not", () => {
      expect(evaluationDeadlines(d("2026-10-01"), d("2026-10-05"), "ge_90").decision_due).toBe(
        "2026-10-31",
      );
      const saturday = workedWith({
        evaluation_date: d("2026-10-01"),
        notice_provided_on: d("2026-10-05"),
        loan: { next_due_date: d("2026-07-01"), unpaid_late_charges: 3 },
      });
      expect(federal.isBusinessDay(d("2026-10-31"))).toBe(false);
      expect(lossmitInScope(saturday)).toBe(false);
      expect(
        lossmitInScope({
          ...saturday,
          evaluation_date: d("2026-10-03"),
          notice_provided_on: d("2026-10-05"),
        }),
      ).toBe(true);
    });

    it("a forbearance of no months: the walk offers it, and the servicing app's own term creation refuses it", () => {
      expect(
        forbearanceTerm({
          requested_months: 3,
          cumulative_months: 0,
          months_delinquent_at_start: 12,
        }),
      ).toEqual({
        months: 0,
        capped_by: ["delinquency_12"],
        exception_required: true,
      });
      expect(forbearanceTermDates(d("2026-10-01"), 0)).toEqual({
        start: "2026-10-01",
        end: "2026-09-30",
      });
      const twelve = workedWith({
        loan: { next_due_date: d("2025-10-01"), unpaid_late_charges: 3 },
        borrower: { hardship: "temporary_unresolved" },
        forbearance: { forborne_months: 0, requested_months: 3 },
      });
      expect(analyzeLossmit(twelve).walk.offered).toBe("forbearance");
      expect(lossmitInScope(twelve)).toBe(false);
    });

    it("D1: a deferral of no months or one, which the screen calls eligible; and two left to pay", () => {
      const base = {
        months_delinquent: 2,
        origination_date: d("2021-10-01"),
        evaluation_date: d("2026-09-20"),
        months_to_maturity: 300,
      };
      expect(screen({ ...base, cumulative_deferred_months: 12 })).toEqual({
        eligible: true,
        contractual_payment_required: true,
        months_deferred: 0,
      });
      expect(
        screen({ ...base, months_delinquent: 3, cumulative_deferred_months: 11 }),
      ).toMatchObject({
        eligible: true,
        months_deferred: 1,
      });
      const capped = (cumulative: number) =>
        workedWith({
          history: {
            cumulative_deferred_months: cumulative,
            last_deferral_effective: d("2024-06-01"),
          },
        });
      expect([9, 10, 11, 12].map((c) => lossmitInScope(capped(c)))).toEqual([
        true,
        false,
        false,
        false,
      ]);
      // 10 before and 4 now: 2 deferred and 2 to pay, where the spec's gate names one payment.
      expect(deferralTerms(expectedLossmit(capped(10)))).toMatchObject({
        months_deferred: 2,
        installments_to_pay: 2,
      });
    });

    it("36 months to maturity, which the spec's gate rows fail and the engine passes", () => {
      const at36 = workedWith({
        loan: { maturity_date: d("2029-10-01"), origination_date: d("1999-10-01") },
      });
      expect(monthsToMaturity(at36)).toBe(36);
      expect(expectedLossmit(at36).deferral_screen).toEqual({ eligible: true, reason: null });
      expect(lossmitInScope(at36)).toBe(false);
      const at37 = workedWith({
        loan: { maturity_date: d("2029-11-01"), origination_date: d("1999-11-01") },
      });
      expect(lossmitInScope(at37)).toBe(true);
      const at35 = workedWith({
        loan: { maturity_date: d("2029-09-01"), origination_date: d("1999-09-01") },
      });
      expect(expectedLossmit(at35).deferral_screen?.reason).toBe("INV_FNMA_D23204_MATURITY");
      expect(lossmitInScope(at35)).toBe(true);
    });

    it("criterion 2: a borrower who cannot make the new payment, which the screen never asks", () => {
      expect(lossmitInScope(workedWith({ borrower: { capacity_cents: 213_116n } }))).toBe(false);
      expect(lossmitInScope(workedWith({ borrower: { capacity_cents: 213_117n } }))).toBe(true);
    });

    it("D6: a processing month is an election, refused on the 15th; the spec's T5 calls it automatic", () => {
      const notElected = timeline(d("2026-09-18"));
      expect([
        notElected.processing_month,
        notElected.processing_month_permitted,
        notElected.entry_deadline,
      ]).toEqual([false, true, "2026-09-30"]);
      expect(() => timeline(d("2026-09-15"), { processing_month_elected: true })).toThrow(
        RangeError,
      );
      const fifteenth = workedWith({
        evaluation_date: d("2026-09-15"),
        notice_provided_on: d("2026-09-18"),
        deferral: { processing_month_elected: true },
      });
      expect(lossmitInScope(fifteenth)).toBe(false);
      expect(
        lossmitInScope({
          ...fifteenth,
          deferral: { ...fifteenth.deferral, processing_month_elected: false },
        }),
      ).toBe(true);
    });

    it("D8 and D9: no disaster row in the walk, and two names for one tier", () => {
      expect(HIERARCHY).not.toContain("disaster_payment_deferral");
      expect(tier(d("2026-09-20"), d("2026-11-19"))).toBe("lt_90");
      expect(
        serviceLines("domain/lossmit/application.ts", "return { protection_tier: d >= 90", 1),
      ).toContain('"gt_37"');
    });

    it("and the facts it is given cohere: a sale past 120 days with no plan running, never in New York", () => {
      const sale = { scheduled_sale_on: d("2026-12-31"), state: "TX" };
      expect(lossmitInScope(workedWith(sale))).toBe(false); // four behind
      const sixBehind = workedWith({
        ...sale,
        loan: { next_due_date: d("2026-04-01"), unpaid_late_charges: 6 },
      });
      expect(lossmitInScope(sixBehind)).toBe(true);
      expect(lossmitInScope({ ...sixBehind, state: "NY" })).toBe(false);
      expect(
        lossmitInScope({
          ...sixBehind,
          notice_provided_on: addDays(sixBehind.evaluation_date, 31),
        }),
      ).toBe(false);
      expect(lossmitInScope({ ...sixBehind, flexmod_eligible: false })).toBe(false);
      const plan = SPEC[13]!;
      expect(
        lossmitInScope({
          ...plan,
          scheduled_sale_on: addDays(plan.evaluation_date, 120),
          state: "TX",
        }),
      ).toBe(false);
    });
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump LOSSMIT_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generateLossmitSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"2eb5518025a2a4b25c9433457c90b02c65b216d2ac2baebc53ef1156e867c1e5"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out file into training", () => {
    expect(toJsonLine(generateLossmitTask("train", 7, 17))).toBe(
      toJsonLine(generateLossmitSuite("train", 7, 30)[17]),
    );
    const fp = (t: LossmitTask) => toJsonLine(lossmitPayload(t));
    const held = new Set(generateLossmitSuite("heldout", 1, 200).map(fp));
    expect(generateLossmitSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  });

  describe("each rung and edge turns up", () => {
    const runs = generateLossmitSuite("train", 1, 1000).map((t, i) => ({
      t,
      a: expectedLossmit(t),
      edge: lossmitEdgeOf(i),
    }));
    type Run = (typeof runs)[number];
    const count = (f: (x: Run) => boolean) => runs.filter(f).length;
    const offered = (o: string) => runs.filter((x) => x.a.offered === o);
    const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

    it("cycles through every edge, a hundred files each, and offers every option about a fifth of the time", () => {
      expect(new Set(runs.map((x) => x.edge))).toEqual(new Set(LOSSMIT_EDGES));
      expect(lossmitArmOf(10, 3)).toBe(1);
      for (const o of RETENTION) expect(offered(o).length, o).toBeGreaterThan(120);
    });

    it("draws the walk's own order: reinstatement whatever the hardship, and a cent either side of it", () => {
      for (const h of ["temporary_unresolved", "resolved", "permanent"])
        expect(
          count(({ t, a }) => a.offered === "reinstatement" && t.borrower.hardship === h),
          h,
        ).toBeGreaterThan(20);
      const funds = (x: Run) =>
        x.t.borrower.funds_available_cents - BigInt(x.a.arrears.arrears_cents);
      expect(count((x) => funds(x) === 0n)).toBeGreaterThan(45);
      expect(count((x) => funds(x) === 1n)).toBeGreaterThan(10);
      expect(count((x) => funds(x) === -1n)).toBeGreaterThan(20);
      expect(
        count(
          ({ t, a }) =>
            t.borrower.hardship === "permanent" &&
            a.offered === "flex_mod" &&
            a.deferral_screen === null,
        ),
      ).toBeGreaterThan(60);
      expect(count(({ a }) => a.arrears.months_delinquent === 1)).toBeGreaterThan(40);
    });

    it("draws each forbearance cap, alone and tied, at the cap and a month under, and across six forborne", () => {
      const terms = offered("forbearance").map((x) => ({ x, f: forbearanceTerms(x.a) }));
      const capped = (names: string) =>
        terms.filter(({ f }) => f.capped_by.join("+") === names).length;
      expect(capped("increment_3")).toBeGreaterThan(35);
      expect(capped("delinquency_12")).toBeGreaterThan(20);
      expect(capped("cumulative_12+delinquency_12")).toBeGreaterThan(10);
      expect(capped("increment_3+cumulative_12+delinquency_12")).toBeGreaterThan(5);
      expect(capped("increment_3+delinquency_12")).toBeGreaterThan(1);
      expect(capped("")).toBeGreaterThan(25);
      const total = ({ x, f }: (typeof terms)[number]) =>
        x.t.forbearance.forborne_months + f.months;
      expect(terms.filter((y) => total(y) === 12).length).toBeGreaterThan(15);
      expect(terms.filter((y) => total(y) === 11).length).toBeGreaterThan(5);
      expect(terms.filter(({ f }) => f.exception_required).length).toBeGreaterThan(25);
      expect(terms.filter(({ f }) => f.regx_short_term).length).toBeGreaterThan(50);
      expect(terms.filter(({ f }) => !f.regx_short_term).length).toBeGreaterThan(50);
      expect(terms.filter((y) => total(y) === 6 && y.f.regx_short_term).length).toBeGreaterThan(3);
      expect(terms.filter((y) => total(y) === 7 && !y.f.regx_short_term).length).toBeGreaterThan(3);
      // The term starts the day after the active one ends: every extension is decided in its term's last month.
      for (const { x } of terms)
        expect(x.a.arrears.months_delinquent).toBeGreaterThanOrEqual(
          x.t.forbearance.forborne_months,
        );
    });

    it("draws the repayment search at its limits", () => {
      const plans = offered("repayment_plan").map((x) => ({
        x,
        p: planTerms(x.a),
        P: pitiOf(x.t),
      }));
      expect(plans.filter(({ p }) => p.pct_of_contractual === "150.00").length).toBeGreaterThan(12);
      // The rounded-up installment over 150% where the exact quotient is not: the plan one month longer.
      const flipped = plans.filter(({ x, p, P }) => {
        const m = p.months - 1;
        const a = BigInt(x.a.arrears.arrears_cents);
        return (
          m >= 1 &&
          2n * (P * BigInt(m) + a) <= 3n * P * BigInt(m) &&
          repaymentTerms(a, P, m).allowed === false
        );
      });
      expect(flipped.length).toBeGreaterThan(12);
      expect(
        plans.filter(({ x, p }) => BigInt(p.total_monthly_cents) === x.t.borrower.capacity_cents)
          .length,
      ).toBeGreaterThan(30);
      // Truncated where rounding would differ, and the last installment absorbing the rounding.
      expect(
        plans.filter(
          ({ p, P }) =>
            (Number((BigInt(p.total_monthly_cents) * 1_000_000n) / P) / 10_000).toFixed(2) !==
            p.pct_of_contractual,
        ).length,
      ).toBeGreaterThan(40);
      expect(
        plans.filter(({ p }) => p.final_installment_cents !== p.installment_cents).length,
      ).toBeGreaterThan(80);
      expect(plans.filter(({ p }) => p.months === 12).length).toBeGreaterThan(8);
      expect(plans.filter(({ p }) => p.months <= 6).length).toBeGreaterThan(40);
      expect(plans.filter(({ p }) => p.regx_short_term).length).toBeGreaterThan(30);
      expect(plans.filter(({ p }) => !p.regx_short_term).length).toBeGreaterThan(30);
      // A cent short of a term's total moves the plan on.
      expect(
        plans.filter(
          ({ x, p, P }) =>
            p.months > 1 &&
            repaymentTerms(BigInt(x.a.arrears.arrears_cents), P, p.months - 1).total_monthly_cents -
              1n ===
              x.t.borrower.capacity_cents,
        ).length,
      ).toBeGreaterThan(10);
    });

    it("draws the screen's three failures v1 grades, alone and first, and none of the other three", () => {
      const reached = runs.filter((x) => x.a.deferral_screen !== null);
      const reason = (r: string) => reached.filter((x) => x.a.deferral_screen!.reason === r).length;
      for (const r of [
        "INV_FNMA_D23204_DELQ_WINDOW",
        "INV_FNMA_D23204_PRIOR_DEFERRAL_12M",
        "INV_FNMA_D23204_MATURITY",
      ])
        expect(reason(r) / reached.length, r).toBeGreaterThan(0.07);
      for (const r of SCREEN_REASONS.filter((x) => !/DELQ_WINDOW|PRIOR_DEFERRAL|MATURITY/.test(x)))
        expect(reason(r), r).toBe(0);
      // The first failure wins: outside the window with a later failure too, and a prior deferral before maturity.
      const within12 = (x: Run) =>
        x.t.history.last_deferral_effective !== null &&
        x.t.history.last_deferral_effective > addDays(x.t.evaluation_date, -365);
      expect(
        reached.filter(
          (x) =>
            x.a.deferral_screen!.reason === "INV_FNMA_D23204_DELQ_WINDOW" &&
            (within12(x) || monthsToMaturity(x.t) < 36),
        ).length,
      ).toBeGreaterThan(5);
      expect(
        reached.filter(
          (x) =>
            x.a.deferral_screen!.reason === "INV_FNMA_D23204_PRIOR_DEFERRAL_12M" &&
            monthsToMaturity(x.t) < 36,
        ).length,
      ).toBeGreaterThan(5);
      expect(reached.filter((x) => x.a.arrears.months_delinquent >= 7).length).toBeGreaterThan(15);
      expect(reached.filter((x) => monthsToMaturity(x.t) === 35).length).toBeGreaterThan(5);
    });

    it("draws the deferral at its boundaries, its gate and its clock", () => {
      const deferrals = offered("payment_deferral").map((x) => ({
        x,
        f: deferralTerms(x.a),
        tl: x.a.deferral_timeline!,
      }));
      const share = (f: (y: (typeof deferrals)[number]) => boolean) =>
        deferrals.filter(f).length / deferrals.length;
      expect(share(({ f }) => f.contractual_payment_required)).toBeGreaterThan(0.2);
      expect(deferrals.filter(({ f }) => f.installments_to_pay === 1).length).toBeGreaterThan(10);
      expect(
        deferrals.filter(({ x }) => x.a.arrears.months_delinquent === 6).length,
      ).toBeGreaterThan(20);
      expect(share(({ tl }) => tl.processing_month)).toBeGreaterThan(0.2);
      expect(
        deferrals.filter(
          ({ tl }) => addDays(tl.entry_deadline as PlainDate, -1) !== tl.lar_deadline,
        ).length,
      ).toBeGreaterThan(40);
      expect(deferrals.filter(({ x }) => monthsToMaturity(x.t) === 37).length).toBeGreaterThan(5);
      // Exactly a year on: the origination, a prior deferral, a modification, a failed trial.
      const yearAgo = (x: Run, date: string | null) =>
        date !== null &&
        date.slice(5) === x.t.evaluation_date.slice(5) &&
        Number(x.t.evaluation_date.slice(0, 4)) - Number(date.slice(0, 4)) === 1;
      expect(
        deferrals.filter(({ x }) => yearAgo(x, x.t.loan.origination_date)).length,
      ).toBeGreaterThan(5);
      expect(
        deferrals.filter(({ x }) => yearAgo(x, x.t.history.last_failed_trial_on)).length,
      ).toBeGreaterThan(2);
      const monthYearAgo = (x: Run, date: string | null) =>
        date !== null &&
        date ===
          `${Number(x.t.evaluation_date.slice(0, 4)) - 1}${x.t.evaluation_date.slice(4, 8)}01`;
      expect(
        deferrals.filter(({ x }) => monthYearAgo(x, x.t.history.last_deferral_effective)).length,
      ).toBeGreaterThan(5);
      expect(
        deferrals.filter(({ x }) => monthYearAgo(x, x.t.history.last_modification_effective))
          .length,
      ).toBeGreaterThan(2);
      // A disaster deferral within the year, which never counts.
      expect(
        deferrals.filter(
          ({ x }) =>
            x.t.history.last_disaster_deferral_effective !== null &&
            x.t.history.last_disaster_deferral_effective > addDays(x.t.evaluation_date, -365),
        ).length,
      ).toBeGreaterThan(8);
      // A shortage spread over 60 months exactly half a cent over, which rounds up.
      expect(
        deferrals.filter(({ x }) => x.t.deferral.escrow_shortage_cents % 60n === 30n).length,
      ).toBeGreaterThan(20);
      // Capacity exactly the new payment, and a cent short of the twelve-month plan.
      expect(
        deferrals.filter(({ x, f }) => x.t.borrower.capacity_cents === BigInt(f.new_payment_cents))
          .length,
      ).toBeGreaterThan(10);
      expect(
        deferrals.filter(
          ({ x }) =>
            repaymentTerms(BigInt(x.a.arrears.arrears_cents), pitiOf(x.t), 12).total_monthly_cents -
              1n ===
            x.t.borrower.capacity_cents,
        ).length,
      ).toBeGreaterThan(20);
    });

    it("draws Reg X's tiers at their boundaries, New York, and windows across weekends and holidays", () => {
      const days = (x: Run) =>
        x.t.scheduled_sale_on === null
          ? null
          : (Date.parse(x.t.scheduled_sale_on) - Date.parse(x.t.evaluation_date)) / 86_400_000;
      expect(count(({ a }) => a.regx.tier === "lt_90")).toBeGreaterThan(40);
      expect(count((x) => days(x) === null)).toBeGreaterThan(400);
      for (const n of [90, 89, 38])
        expect(
          count((x) => days(x) === n),
          String(n),
        ).toBeGreaterThan(n === 89 ? 1 : 3);
      expect(count((x) => days(x) !== null && days(x)! > 90)).toBeGreaterThan(40);
      expect(count(({ t, a }) => t.state === "NY" && a.regx.window_days === 30)).toBeGreaterThan(
        60,
      );
      for (const { t, a } of runs) {
        if (t.scheduled_sale_on !== null) {
          expect(t.state).not.toBe("NY");
          expect(a.arrears.months_delinquent).toBeGreaterThanOrEqual(5);
        }
        expect(federal.isBusinessDay(a.regx.decision_due as PlainDate)).toBe(true);
      }
      expect(
        count(({ a }) => dow(a.regx.accept_by) === 0 || dow(a.regx.accept_by) === 6),
      ).toBeGreaterThan(40);
      expect(
        count(
          ({ a }) =>
            ![0, 6].includes(dow(a.regx.accept_by)) &&
            !federal.isBusinessDay(a.regx.accept_by as PlainDate),
        ),
      ).toBeGreaterThan(20);
      expect(
        count(
          ({ a }) => dow(a.regx.deemed_rejected_on) === 0 || dow(a.regx.deemed_rejected_on) === 6,
        ),
      ).toBeGreaterThan(150);
    });
  });
});
