/**
 * pmi-termination: the grader is the servicing app's mortgage-insurance
 * engine and no other (each port is its file byte for byte but the imports),
 * and the conventions it restates are held to the service's own lines; it
 * gives §10's worked examples to the cent; every generated task can be
 * solved from the rulebook and the tools, on unfiltered draws too; the guard
 * keeps out each place the engine departs from its spec, each reproduced
 * here; and each edge and configuration that decides an answer turns up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addBusinessDays,
  addDays,
  addMonths,
  daysBetween,
  endOfMonth,
  isLeapYear,
  isWeekend,
  plainDate,
  servicer,
  type PlainDate,
} from "@hm/kernel/calendar";
import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { rngFor } from "../rng.js";
import {
  PMI_EDGES,
  PMI_HELDOUT_SUITE,
  PmiReferencePolicy,
  REQUEST_REASONS,
  analyzePmi,
  anniversaryOnOrBefore,
  drawPmiCandidate,
  drawPmiTask,
  expectedPmi,
  generatePmiSuite,
  generatePmiTask,
  gradePmiAgainst,
  parsePmiSubmission,
  pmiEdgeOf,
  pmiFairToGrade,
  pmiInScope,
  pmiPayload,
  pmiSpecTasks,
  pmiTaskId,
  pmiTermination,
  executePmiTool,
  refundPlanAt,
  scheduleVersions,
  type PmiAnswer,
  type PmiTask,
} from "../pmi/index.js";
import {
  originalValue,
  paymentHistory,
  seasoningMonths,
  valueCheck,
} from "../pmi/ported/cancellation.js";
import { applyFifo, fnmaDelinquencyStatus } from "../pmi/ported/delinquency.js";
import { unearnedEstimate } from "../pmi/ported/refund.js";
import { midpoint, scheduledDateForPct, thresholdCents } from "../pmi/ported/schedule.js";
import { isCurrent } from "../pmi/ported/termination.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const lines = (text: string, imports: boolean) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("import ") === imports)
    .join("\n");
/** Each import line with its module path removed: what it imports, and how. */
const importHeads = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("import "))
    .map((l) => l.replace(/ from "[^"]+";$/, ""));
/**
 * The four rewrites a port may carry (PORTED_FROM): the kernel's paths become the package's, a
 * sibling's .ts its .js, the boarding files sit beside the PMI ones, and the transfers type is ours.
 */
const rewritten = (imports: string) =>
  imports
    .replace(/"\.\.\/\.\.\/kernel\/(calendar|money)\/[a-z-]+\.ts"/g, '"@hm/kernel/$1"')
    .replace(/"\.\/([a-z-]+)\.ts"/g, '"./$1.js"')
    .replace(/"\.\.\/boarding\/([a-z-]+)\.ts"/g, '"./$1.js"')
    .replace(/"\.\.\/transfers\/ops-1-7\.ts"/g, '"../lossmit-stub.js"');
const PORTS = [
  ["pmi", "schedule"],
  ["pmi", "termination"],
  ["pmi", "cancellation"],
  ["pmi", "refund"],
  ["boarding", "delinquency"],
  ["boarding", "types"],
] as const;

const service = (file: string) =>
  readFileSync(here(`../../../../apps/servicing/src/${file}`), "utf8").split("\n");
/** A run of service lines, found by what the first holds, with the lines the grader cites them by. */
const serviceLines = (file: string, first: string, n: number) => {
  const all = service(file);
  const start = all.findIndex((l) => l.includes(first));
  if (start < 0) return `${file}: no line holding ${first}`;
  return [`${file}:${start + 1}-${start + n}`, ...all.slice(start, start + n)].join("\n");
};

const solveAll = async (tasks: readonly PmiTask[]) => {
  const misses: string[] = [];
  let turns = 0;
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(pmiTermination, task, new PmiReferencePolicy());
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

const SPEC = pmiSpecTasks();
const d = (s: string) => plainDate(s);

describe("pmi-termination", () => {
  it("grades with the servicing app's engine: each port is its file but for the imports", () => {
    for (const [dir, file] of PORTS) {
      const original = readFileSync(
        here(`../../../../apps/servicing/src/domain/${dir}/${file}.ts`),
        "utf8",
      );
      const port = readFileSync(here(`../pmi/ported/${file}.ts`), "utf8");
      expect(lines(port, false), file).toBe(lines(original, false));
      expect(lines(port, true), file).toBe(rewritten(lines(original, true)));
      // The same names, imported the same way.
      expect(importHeads(port), file).toEqual(importHeads(original));
    }
    // The one file of our own the port needs, outside the ported directory, named in PORTED_FROM.
    expect(readFileSync(here("../pmi/ported/PORTED_FROM"), "utf8")).toMatch(/lossmit-stub\.ts/);
    expect(readFileSync(here("../pmi/lossmit-stub.ts"), "utf8")).toMatch(
      /export type InheritedLossmitFile = /,
    );
  });

  describe("gives §10's worked examples to the cent", () => {
    const [a, b, c, arm, flex, lpmi, io, two, t3, t3late, pre, fifteen] = SPEC.map(expectedPmi);
    const [
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      t2,
      t1,
      t4,
      t4d,
      t5,
      t5bpo,
      t6,
      t9,
      cv500,
      cv490,
      t12ok,
      t12late,
      monthly,
    ] = SPEC.map(expectedPmi);

    it("10.1's worked loan: original value $400,000.00, P&I $2,401.86, 78% at payment 135 on 2035-07-01", () => {
      expect(a!.position).toEqual({
        original_value_cents: "40000000",
        rule_78_applies: true,
        pi_cents: "240186",
        scheduled_78_payment_number: 135,
        scheduled_78_date: "2035-07-01",
        midpoint_termination_date: "2039-05-01",
        trigger_date: "2035-07-01",
      });
      // The 80% row and the 78% row's balance, as the spec states them.
      const v = scheduleVersions(SPEC[0]!)[0]!;
      expect(scheduledDateForPct(v, 40_000_000n, 80)).toEqual({
        due_date: "2034-08-01",
        n: 124,
        upb_after_cents: 31_950_009n,
      });
      expect(scheduledDateForPct(v, 40_000_000n, 78)!.upb_after_cents).toBe(31_191_325n);
    });

    it("10.2 scenario A: current, terminated 2035-07-01, the clocks and LAR 89 070135", () => {
      expect(a!.automatic).toEqual({
        current_on_trigger: true,
        not_current_installments: [],
        not_current_notice_due: null,
        cure_on: null,
      });
      expect(a!.termination).toMatchObject({
        effective_on: "2035-07-01",
        lar89_action_code: "53",
        lar89_action_date: "070135",
        notice_due: "2035-07-31",
        premium_stop_by: "2035-07-31",
        refund_due: "2035-08-15",
        insurer_notice_due: "2035-07-03",
      });
    });

    it("scenario B: not current, cured 07-20, effective 08-01; and 10.5's annual estimate, $1,411.73", () => {
      expect(b!.automatic).toEqual({
        current_on_trigger: false,
        not_current_installments: ["2035-06-01"],
        not_current_notice_due: "2035-07-31",
        cure_on: "2035-07-20",
      });
      expect(b!.termination).toMatchObject({
        effective_on: "2035-08-01",
        lar89_action_date: "080135",
        notice_due: "2035-08-31",
        refund_due: "2035-09-15",
        // $2,280.00 from the 2035-03-15 anniversary to 08-01: 139 days in force (10.5's arithmetic).
        unearned_premium_cents: "141173",
      });
    });

    it("scenario C: July paid 08-03, cured then, effective 2035-09-01", () => {
      expect(c!.automatic!.cure_on).toBe("2035-08-03");
      expect(c!.termination!.effective_on).toBe("2035-09-01");
    });

    it("the ARM: P&I $2,596.45 after the reset at 61 to 7.50%, the 78% date moved to 2035-09-01", () => {
      expect(arm!.position).toMatchObject({
        pi_cents: "259645",
        scheduled_78_payment_number: 137,
        scheduled_78_date: "2035-09-01",
        trigger_date: "2035-09-01",
      });
      const [note, reset] = scheduleVersions(SPEC[3]!);
      expect(note!.pi_cents).toBe(215_760n);
      expect(scheduledDateForPct(note!, 40_000_000n, 78)).toMatchObject({
        n: 123,
        due_date: "2034-07-01",
      });
      expect(note!.rows.find((x) => x.n === 60)!.upb_after_cents).toBe(35_135_017n);
      expect(reset!.rows.length).toBe(300);
    });

    it("the Flex Modification: P&I $1,873.46, 78% at payment 218 on 2047-03-01, midpoint 2049-02-01", () => {
      expect(flex!.position).toMatchObject({
        pi_cents: "187346",
        scheduled_78_payment_number: 218,
        scheduled_78_date: "2047-03-01",
        midpoint_termination_date: "2049-02-01",
        trigger_date: "2047-03-01",
      });
    });

    it("lender-paid: the options notice by 2035-07-31, and nothing cancelled", () => {
      expect(lpmi).toMatchObject({
        request: null,
        automatic: null,
        termination: null,
        lpmi_options_notice_due: "2035-07-31",
      });
    });

    it("10.3 interest-only 10/20: P&I $2,833.18, 78% at 192 after the midpoint, terminated 2039-05-01", () => {
      expect(io!.position).toMatchObject({
        pi_cents: "283318",
        scheduled_78_payment_number: 192,
        scheduled_78_date: "2040-04-01",
        midpoint_termination_date: "2039-05-01",
        trigger_date: "2039-05-01",
      });
      expect(io!.termination).toMatchObject({
        notice_due: "2039-05-31",
        refund_due: "2039-06-15",
        lar89_action_code: "53",
        lar89_action_date: "050139",
      });
    });

    it("10.3-T2 and T3: the two-unit loan at its midpoint, and the March installment both ways", () => {
      expect(two!.position).toMatchObject({
        rule_78_applies: false,
        midpoint_termination_date: "2036-04-01",
        trigger_date: "2036-04-01",
      });
      expect(two!.termination).toMatchObject({
        effective_on: "2036-04-01",
        lar89_action_date: "040136",
        notice_due: "2036-05-01",
        refund_due: "2036-05-16",
      });
      expect(t3!.automatic!.current_on_trigger).toBe(true);
      expect(t3late!.automatic).toEqual({
        current_on_trigger: false,
        not_current_installments: ["2036-03-01"],
        not_current_notice_due: "2036-05-01",
        cure_on: "2036-04-09",
      });
      expect(t3late!.termination!.effective_on).toBe("2036-05-01");
    });

    it("10.3 pre-1999 and T6's 15-year loan", () => {
      expect(pre!.position).toMatchObject({
        rule_78_applies: false,
        midpoint_termination_date: "2014-01-01",
        trigger_date: "2014-01-01",
      });
      expect(midpoint(d("1999-01-01"), 360)).toEqual({
        amortization_start: "1998-12-01",
        midpoint_date: "2013-12-01",
        midpoint_termination_date: "2014-01-01",
      });
      expect(fifteen!.position).toMatchObject({
        scheduled_78_payment_number: 48,
        scheduled_78_date: "2028-04-01",
        midpoint_termination_date: "2031-11-01",
        trigger_date: "2028-04-01",
      });
    });

    it("10.1-T2 and T1: 8388 basis points denied; 7998 granted, effective 2029-07-10", () => {
      expect(t2!.request).toMatchObject({
        evaluation_upb_cents: "33554868",
        ltv_bps: 8388,
        threshold_bps: 8000,
        result: "ineligible",
        reasons: ["LTV_ABOVE_THRESHOLD"],
        decision_due: "2027-08-09",
      });
      expect(t2!.termination).toBeNull();
      expect(t1!.request).toMatchObject({ ltv_bps: 7998, result: "eligible", reasons: [] });
      expect(t1!.termination).toMatchObject({
        effective_on: "2029-07-10",
        lar89_action_code: "51",
        lar89_action_date: "071029",
        premium_stop_by: "2029-08-09",
        notice_due: "2029-08-09",
        refund_due: "2029-08-24",
      });
    });

    it("10.1-T4: 35 days late in window B, and excused as disaster-attributable", () => {
      expect(t4!.request).toMatchObject({
        late30_12m: 1,
        result: "ineligible",
        reasons: ["PAYMENT_HISTORY_30_12M"],
      });
      expect(t4d!.request).toMatchObject({ late30_12m: 0, result: "eligible" });
    });

    it("10.1-T5: the AVM below the original value, then the borrower's BPO at $412,000", () => {
      expect(t5!.request).toMatchObject({
        result: "value_check_needed",
        reasons: ["VALUE_DECLINED_OR_UNKNOWN"],
      });
      expect(t5bpo!.request!.result).toBe("eligible");
      // Evidence is satisfied by the delivered valuation in v1, so the grant runs from 07-30.
      expect(t5bpo!.termination!.effective_on).toBe("2029-07-30");
    });

    it("10.1-T6 and T9: a two-unit 72% denied on the 70% line; a curtailment after the request", () => {
      expect(t6!.request).toMatchObject({
        threshold_bps: 7000,
        ltv_bps: 7200,
        result: "ineligible",
      });
      expect(t9!.request).toMatchObject({ ltv_bps: 7990, result: "eligible" });
      expect(t9!.termination).toMatchObject({
        effective_on: "2029-07-15",
        premium_stop_by: "2029-08-09",
        notice_due: "2029-08-14",
        refund_due: "2029-08-29",
        lar89_action_date: "071529",
      });
    });

    it("10.1 current value: $500,000 is 74.10% and granted; $490,000 is 75.61% (the spec prints 75.62) and denied", () => {
      expect(seasoningMonths(d("2024-03-15"), d("2026-08-20"))).toBe(29);
      expect(cv500!.request).toMatchObject({
        threshold_bps: 7500,
        ltv_bps: 7410,
        result: "eligible",
      });
      expect(cv500!.termination).toMatchObject({
        effective_on: "2026-09-03",
        lar89_action_code: "52",
      });
      expect(cv490!.request).toMatchObject({
        ltv_bps: 7561,
        result: "ineligible",
        reasons: ["LTV_ABOVE_THRESHOLD_CURRENT"],
        decision_due: "2026-10-03",
      });
    });

    it("10.1-T12: valid until 2027-01-01, refused on 01-02; 10.5's monthly $190 effective the 13th is $114.00", () => {
      expect(t12ok!.request!.result).toBe("eligible");
      expect(t12late!.request).toEqual({
        evaluation_upb_cents: null,
        threshold_bps: null,
        ltv_bps: null,
        fnma_current: null,
        late30_12m: null,
        late60_24m: null,
        result: "refused",
        reasons: ["VALUATION_EXPIRED"],
        decision_due: "2026-10-03",
      });
      expect(monthly!.termination!.unearned_premium_cents).toBe("11400");
    });

    it("are all in scope and solved by the rulebook", () => {
      expect(SPEC.filter((t) => !pmiInScope(t)).map((t) => t.id)).toEqual([]);
      expect(SPEC.filter((t) => !pmiFairToGrade(t)).map((t) => t.id)).toEqual([]);
    });
  });

  it("restates what the engine does where the map was loose: the windows and the trigger's sweep", () => {
    const ledger = (paid: Record<string, string | null>, first = "2023-08-01", n = 30) => {
      const inst = Array.from({ length: n }, (_, i) => ({
        due_date: addMonths(d(first), i),
        amount_cents: 100_000n,
      }));
      const pays = inst
        .filter((i) => paid[i.due_date] !== null)
        .map((i) => ({ received_on: d(paid[i.due_date] ?? i.due_date), amount_cents: 100_000n }));
      return applyFifo(inst, pays).installments;
    };
    // late60_24m counts a 65-day late in window B too, not only in window A.
    const inB = paymentHistory(
      ledger({
        "2025-01-01": "2025-03-07",
        "2025-02-01": "2025-03-07",
        "2025-03-01": "2025-03-07",
      }),
      d("2025-08-01"),
    );
    expect([inB.late30_12m, inB.late60_24m, inB.reason]).toEqual([2, 1, "PAYMENT_HISTORY_30_12M"]);
    // Both windows shrink to the loan's age: at 13 months a 75-day late 14 months back is outside.
    const young = ledger(
      { "2024-06-01": "2024-08-15", "2024-07-01": "2024-08-15", "2024-08-01": "2024-08-15" },
      "2024-06-01",
      15,
    );
    expect(paymentHistory(young, d("2025-08-01"), new Set(), 13).reason).toBeNull();
    expect(paymentHistory(young, d("2025-08-01")).reason).toBe("PAYMENT_HISTORY_60_24M");
    // The sweep runs at every trigger whatever the 78% rule: a two-unit loan terminates at its midpoint.
    expect(expectedPmi(SPEC[7]!).termination!.effective_on).toBe("2036-04-01");
  });

  it("holds the conventions it restates to the service's own lines", () => {
    // A re-vendor that changes any of these fails here: revisit the grader, the rulebook and their citations.
    expect(serviceLines("app/tools/section10.ts", "function cancellationRequest(", 9))
      .toMatchInlineSnapshot(`
        "app/tools/section10.ts:48-56
        function cancellationRequest(i: ToolInput): CancellationRequest {
          need(i, "received_on", "decision_on", "original_value_cents", "evaluation_upb_cents", "consummation");
          return {
            received_on: date(i, "received_on"), decision_on: date(i, "decision_on"), evidence_satisfied_on: optDate(i, "evidence_satisfied_on"),
            path: (str(i, "path") || "original_value") as "original_value" | "current_value", property_class: (str(i, "property_class") || "1u_principal_or_second") as PropertyClass, hpa_covered: i.hpa_covered !== false,
            original_value_cents: cents(i.original_value_cents), valuation_cents: optCents(i.valuation_cents), valuation_delivered_on: optDate(i, "valuation_delivered_on"),
            evaluation_upb_cents: cents(i.evaluation_upb_cents), threshold_reached_on: optDate(i, "threshold_reached_on"), installments: Array.isArray(i.installments) ? (i.installments as AppliedInstallment[]) : [],
            avm_cents: optCents(i.avm_cents), consummation: date(i, "consummation"), improvements_accepted: flag(i, "improvements_accepted"),
          };"
      `);
    expect(
      serviceLines(
        "app/tools/section10.ts",
        'const receivedOn = optDate(i, "received_on"); const stopFrom',
        1,
      ),
    ).toMatchInlineSnapshot(`
      "app/tools/section10.ts:169-169
                const receivedOn = optDate(i, "received_on"); const stopFrom = receivedOn ? premiumStopAnchor(receivedOn, optDate(i, "evidence_satisfied_on")) : effective;"
    `);
    expect(
      serviceLines(
        "app/tools/section10.ts",
        "const v = i.prior_version !== undefined && i.change_n",
        2,
      ),
    ).toMatchInlineSnapshot(`
      "app/tools/section10.ts:235-236
            const v = i.prior_version !== undefined && i.change_n !== undefined ? armResetVersion(scheduleFrom(i.prior_version as ToolInput), num(i, "change_n"), ratePercent(str(i, "new_rate_pct")), num(i, "remaining_term")) : scheduleFrom(i);
            const d78 = scheduledDateForPct(v, ov, 78), d80 = scheduledDateForPct(v, ov, 80); const mp = midpoint(v.rows[0]!.due_date, v.rows.length);"
    `);
    expect(serviceLines("app/tools/section10.ts", 'if (str(i, "premium_plan") === "lpmi")', 4))
      .toMatchInlineSnapshot(`
        "app/tools/section10.ts:246-249
              if (str(i, "premium_plan") === "lpmi") {
                // 12 U.S.C. 4905(c)(2): LPMI never cancels — the BPMI-equivalent date reached → options notice within 30 days; no refund, no LAR 89.
                ctx.events.append({ type: "mi.lpmi_equivalent_termination_date.reached", loanId, actor: ctx.actor, payload: { equivalent_termination_on: scheduled, notice: "NTC_HPA_4905C2_LPMI_OPTIONS", due: lpmiOptionsNoticeDue(scheduled) } });
                return { lpmi: true, cancellation: false, notice: "NTC_HPA_4905C2_LPMI_OPTIONS", due: lpmiOptionsNoticeDue(scheduled), lar89: null, refund: null };"
      `);
    // The sweep's own reading of the rule (not the schedule rebuild's at :237): the grader passes true.
    expect(serviceLines("app/tools/section10.ts", ": i.applies !== false;", 1))
      .toMatchInlineSnapshot(`
      "app/tools/section10.ts:251-251
            const applies = i.applicability ? rule78Applies(i.applicability as { consummation: PlainDate; units: number; occupancy_at_origination: "principal" | "second_home" | "investment" }) : i.applies !== false;"
    `);
    expect(serviceLines("app/tools/section10.ts", "const refundPlan = (i: ToolInput)", 1))
      .toMatchInlineSnapshot(`
        "app/tools/section10.ts:279-279
        const refundPlan = (i: ToolInput): RefundPlan => { need(i, "plan", "premium_cents"); const k = str(i, "plan"); if (k === "monthly") return { kind: "monthly", premium_cents: cents(i.premium_cents), coverage_month_start: date(i, "coverage_month_start") }; if (k === "annual") return { kind: "annual", premium_cents: cents(i.premium_cents), anniversary_start: date(i, "anniversary_start") }; if (k === "single") return { kind: "single", premium_cents: cents(i.premium_cents), refund_pct: str(i, "refund_pct") || "0" }; throw new RangeError(\`plan \${k} is not monthly/annual/single\`); };"
      `);
    expect(serviceLines("domain/pmi/ops.ts", "export function sweepTermination(", 2))
      .toMatchInlineSnapshot(`
        "domain/pmi/ops.ts:87-88
        export function sweepTermination(i: { loan_id: string; installments: readonly AppliedInstallment[]; scheduled_date: PlainDate; applies?: boolean; kind?: "automatic_78" | "automatic_midpoint"; cal?: Calendar }): { result: AutoResult; actions: TerminationActions | null; not_current_notice: NotCurrentNotice | null } {
          const result = automaticTermination(i.installments, i.scheduled_date, i.applies ?? true, i.cal ?? servicer);"
      `);
  });

  it("fails an answer one cent off on exactly that field, and charges for what is missing or extra", () => {
    const want = expectedPmi(SPEC[1]!);
    const wrong = (answer: unknown) =>
      gradePmiAgainst(want, answer as PmiAnswer)
        .fields.filter((x) => !x.ok)
        .map((x) => x.field);
    expect(
      wrong({ ...want, termination: { ...want.termination!, unearned_premium_cents: "141174" } }),
    ).toEqual(["termination.unearned_premium_cents"]);
    expect(wrong({ ...want, position: { ...want.position, pi_cents: "240187" } })).toEqual([
      "position.pi_cents",
    ]);
    expect(
      wrong({ ...want, position: { ...want.position, original_value_cents: "40000001" } }),
    ).toEqual(["position.original_value_cents"]);
    // A cure a day late is one field; the effective date it moves is another.
    expect(wrong({ ...want, automatic: { ...want.automatic!, cure_on: "2035-07-21" } })).toEqual([
      "automatic.cure_on",
    ]);
    // A section the date does not call for, answered, costs every field it holds.
    const hedge = expectedPmi(SPEC[13]!).request;
    expect(wrong({ ...want, request: hedge })).toEqual([
      "request.evaluation_upb_cents",
      "request.threshold_bps",
      "request.ltv_bps",
      "request.fnma_current",
      "request.history",
      "request.result",
      "request.reasons",
      "request.decision_due",
    ]);
    // A section left out misses every field in it.
    expect(wrong({ ...want, termination: null })).toHaveLength(8);
    // On a request, one wrong late count is one field.
    const t1 = expectedPmi(SPEC[13]!);
    expect(
      gradePmiAgainst(t1, { ...t1, request: { ...t1.request!, late60_24m: 1 } })
        .fields.filter((x) => !x.ok)
        .map((x) => x.field),
    ).toEqual(["request.history"]);
  });

  it("reads a submission strictly, as the schema says, and bounces what does not fit", () => {
    const want = expectedPmi(SPEC[1]!);
    const ok = (x: unknown) => parsePmiSubmission(x).ok;
    expect(ok(want)).toBe(true);
    expect(ok(JSON.parse(JSON.stringify(want)))).toBe(true);
    // Missing and extra keys, at the top and inside.
    const { lpmi_options_notice_due: _l, ...noLpmi } = want;
    expect(ok(noLpmi)).toBe(false);
    expect(ok({ ...want, note: "hi" })).toBe(false);
    expect(ok({ ...want, position: { ...want.position, ltv: 1 } })).toBe(false);
    const { cure_on: _c, ...noCure } = want.automatic!;
    expect(ok({ ...want, automatic: noCure })).toBe(false);
    // Types and forms.
    expect(ok({ ...want, position: { ...want.position, pi_cents: 240186 } })).toBe(false);
    expect(ok({ ...want, position: { ...want.position, pi_cents: "2401.86" } })).toBe(false);
    expect(
      ok({ ...want, position: { ...want.position, scheduled_78_payment_number: "135" } }),
    ).toBe(false);
    expect(ok({ ...want, position: { ...want.position, trigger_date: "07/01/2035" } })).toBe(false);
    expect(ok({ ...want, position: { ...want.position, rule_78_applies: "true" } })).toBe(false);
    expect(ok({ ...want, termination: { ...want.termination!, lar89_action_code: "54" } })).toBe(
      false,
    );
    expect(
      ok({ ...want, termination: { ...want.termination!, lar89_action_date: "2035-08-01" } }),
    ).toBe(false);
    // Duplicates.
    expect(
      ok({
        ...want,
        automatic: { ...want.automatic!, not_current_installments: ["2035-06-01", "2035-06-01"] },
      }),
    ).toBe(false);
    const t2 = expectedPmi(SPEC[12]!);
    expect(ok(t2)).toBe(true);
    expect(
      ok({
        ...t2,
        request: { ...t2.request!, reasons: ["LTV_ABOVE_THRESHOLD", "LTV_ABOVE_THRESHOLD"] },
      }),
    ).toBe(false);
    expect(ok({ ...t2, request: { ...t2.request!, reasons: ["LTV_TOO_HIGH"] } })).toBe(false);
    expect(ok({ ...t2, request: { ...t2.request!, result: "denied" } })).toBe(false);
    expect(ok({ ...t2, request: { ...t2.request!, late30_12m: -1 } })).toBe(false);
    expect(ok({ ...t2, request: { ...t2.request!, ltv_bps: 83.88 } })).toBe(false);
    // The reasons are a set: their order is the engine's, and is not graded.
    const many = expectedPmi(
      generatePmiSuite("train", 1, 120).find(
        (t) => (expectedPmi(t).request?.reasons.length ?? 0) >= 2,
      )!,
    );
    const shuffled = parsePmiSubmission({
      ...many,
      request: { ...many.request!, reasons: [...many.request!.reasons].reverse() },
    });
    expect(shuffled.ok && gradePmiAgainst(many, shuffled.answer).pass).toBe(true);
    // The sections must agree: no answer says two things at once.
    const t1 = expectedPmi(SPEC[13]!);
    expect(ok(t1)).toBe(true);
    const noTermination = { ...t1, termination: null };
    expect(ok({ ...t1, automatic: want.automatic })).toBe(false);
    expect(ok({ ...t1, request: { ...t1.request!, reasons: ["NOT_CURRENT"] } })).toBe(false);
    expect(ok({ ...t1, request: { ...t1.request!, result: "ineligible" } })).toBe(false);
    expect(
      ok({ ...t1, request: { ...t1.request!, result: "ineligible", reasons: ["NOT_CURRENT"] } }),
    ).toBe(false);
    expect(
      ok({
        ...noTermination,
        request: { ...t1.request!, result: "ineligible", reasons: ["NOT_CURRENT"] },
      }),
    ).toBe(true);
    expect(ok(noTermination)).toBe(false);
    expect(ok({ ...t1, termination: { ...t1.termination!, lar89_action_code: "53" } })).toBe(false);
    expect(ok({ ...t1, lpmi_options_notice_due: "2035-07-31" })).toBe(false);
    expect(ok({ ...t2, request: { ...t2.request!, result: "value_check_needed" } })).toBe(false);
    expect(
      ok({ ...t2, request: { ...t2.request!, result: "refused", reasons: ["VALUATION_EXPIRED"] } }),
    ).toBe(false);
    // A sweep: never cured with a termination; current with findings; not current without them.
    expect(ok({ ...want, automatic: { ...want.automatic!, cure_on: null } })).toBe(false);
    expect(
      ok({ ...want, automatic: { ...want.automatic!, cure_on: null }, termination: null }),
    ).toBe(true);
    expect(ok({ ...want, automatic: { ...want.automatic!, current_on_trigger: true } })).toBe(
      false,
    );
    expect(ok({ ...want, automatic: { ...want.automatic!, not_current_installments: [] } })).toBe(
      false,
    );
    expect(ok({ ...want, termination: { ...want.termination!, lar89_action_code: "51" } })).toBe(
      false,
    );
  });

  it("costs the same to claim a grant, a cure or a sweep that is not there as to miss one", () => {
    const wrongCount = (want: PmiAnswer, answer: PmiAnswer) => {
      const parsed = parsePmiSubmission(JSON.parse(JSON.stringify(answer)));
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      return gradePmiAgainst(want, parsed.ok ? parsed.answer : null).fields.filter((f) => !f.ok)
        .length;
    };
    const junk = (on: string, code: "51" | "52" | "53") => ({
      effective_on: on,
      lar89_action_code: code,
      lar89_action_date: "010100",
      notice_due: on,
      premium_stop_by: on,
      refund_due: on,
      insurer_notice_due: on,
      escrow_interim_analysis_due: on,
      unearned_premium_cents: "1",
    });
    const costs = new Map<string, Set<number>>();
    const note = (k: string, n: number) => costs.set(k, (costs.get(k) ?? new Set()).add(n));
    for (const t of generatePmiSuite("train", 5, 240)) {
      const w = expectedPmi(t);
      const r = w.request;
      if (r && r.result === "eligible")
        note(
          "deny a grant",
          wrongCount(w, {
            ...w,
            request: { ...r, result: "ineligible", reasons: ["NOT_CURRENT"] },
            termination: null,
          }),
        );
      if (r && r.result === "ineligible")
        note(
          "grant a denial",
          wrongCount(w, {
            ...w,
            request: { ...r, result: "eligible", reasons: [] },
            termination: junk(t.as_of, "51"),
          }),
        );
      const s = w.automatic;
      if (s && !s.current_on_trigger && s.cure_on !== null)
        note(
          "miss a cure",
          wrongCount(w, { ...w, automatic: { ...s, cure_on: null }, termination: null }),
        );
      if (s && !s.current_on_trigger && s.cure_on === null)
        note(
          "invent a cure",
          wrongCount(w, {
            ...w,
            automatic: { ...s, cure_on: t.as_of },
            termination: junk(t.as_of, "53"),
          }),
        );
      if (s && s.current_on_trigger)
        note("skip a sweep", wrongCount(w, { ...w, automatic: null, termination: null }));
      if (!r && !s && t.mi.plan !== "lender_paid")
        note(
          "sweep too early",
          wrongCount(w, {
            ...w,
            automatic: {
              current_on_trigger: true,
              not_current_installments: [],
              not_current_notice_due: null,
              cure_on: null,
            },
            termination: junk(t.as_of, "53"),
          }),
        );
    }
    const only = (k: string) => [...(costs.get(k) ?? [])];
    expect(only("deny a grant")).toEqual([10]);
    expect(only("grant a denial")).toEqual([10]);
    expect(only("miss a cure")).toEqual([9]);
    expect(only("invent a cure")).toEqual([9]);
    expect(only("skip a sweep")).toEqual([10]);
    expect(only("sweep too early")).toEqual([10]);
  });

  it("gives an answer that answers nothing little credit", () => {
    const tasks = generatePmiSuite("heldout", 1, 200);
    const scores = tasks.map((t) => {
      const want = expectedPmi(t);
      const nothing: PmiAnswer = {
        position: {
          original_value_cents: "0",
          rule_78_applies: false,
          pi_cents: "0",
          scheduled_78_payment_number: null,
          scheduled_78_date: null,
          midpoint_termination_date: t.as_of,
          trigger_date: t.as_of,
        },
        request: null,
        automatic: null,
        termination: null,
        lpmi_options_notice_due: null,
      };
      return gradePmiAgainst(want, nothing).score;
    });
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    // About 0.16, the empty answer docs/environments.md states. The floor it reads scores against is the
    // schedule-free policy's, about 0.47 (the held-out test below runs that policy).
    expect(mean).toBeGreaterThan(0.12);
    expect(mean).toBeLessThan(0.2);
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    const r = await solveAll([
      ...SPEC,
      ...generatePmiSuite("heldout", PMI_HELDOUT_SUITE.seed, PMI_HELDOUT_SUITE.n),
    ]);
    expect(r.misses).toEqual([]);
    // Inside the episode's 80 turns even for a model that makes one tool call a turn: the
    // reference's call count, submission included, is that model's turn count.
    expect(r.calls).toBeLessThan(70);
    expect(r.turns).toBeLessThan(40);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    const r = await solveAll(generatePmiSuite("train", 11, 300));
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(70);
  }, 120_000);

  it("is fair to grade on every first draw, and stays out of the engine's regions of doubt", () => {
    const draws = Array.from({ length: 600 }, (_, i) => drawPmiTask("train", 3, i));
    expect(draws.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    for (const { task } of draws) expect(pmiInScope(task)).toBe(true);
  });

  it("holds the rulebook to the engine on candidates nothing filtered", () => {
    // The guard and the fairness filter would hide a disagreement; the candidates they would see show none.
    const unfair: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      const id = pmiTaskId("train", 99, i);
      const task = drawPmiCandidate(rngFor(id), id, "train", 99, i);
      if (!pmiInScope(task) || !pmiFairToGrade(task)) unfair.push(id);
    }
    expect(unfair).toEqual([]);
  }, 120_000);

  describe("keeps out each place the engine departs from its spec, each reproduced", () => {
    const [A] = SPEC;
    const T1 = SPEC[13]!;
    const with_ = (t: PmiTask, o: Partial<PmiTask>): PmiTask => ({ ...t, ...o });
    const loan = (t: PmiTask, o: Partial<PmiTask["loan"]>) =>
      with_(t, { loan: { ...t.loan, ...o } });
    const req = (t: PmiTask, o: Partial<NonNullable<PmiTask["request"]>>) =>
      with_(t, { request: { ...t.request!, ...o } });

    it("admits the spec's own cases", () => {
      expect(SPEC.every(pmiInScope)).toBe(true);
    });

    it("an odd term's midpoint terminates a month late", () => {
      // The true midpoint of 181 months from 2024-04-01 is 2031-10-16; the engine rounds twice.
      expect(midpoint(d("2024-05-01"), 181).midpoint_termination_date).toBe("2031-12-01");
      expect(pmiInScope(loan(A!, { amortizing_term_months: 359 }))).toBe(false);
    });

    it("the current test misses an installment due after the 1st", () => {
      const inst = [
        { due_date: d("2035-05-15"), amount_cents: 100n },
        { due_date: d("2035-06-15"), amount_cents: 100n },
      ];
      const applied = applyFifo(inst, [
        { received_on: d("2035-05-15"), amount_cents: 100n },
      ]).installments;
      expect(isCurrent(applied, d("2035-07-15"))).toBe(true);
      expect(fnmaDelinquencyStatus(applied, d("2035-06-30"))).toBe("30");
      const fifteenth = with_(A!, {
        ledger: {
          ...A!.ledger,
          installments: A!.ledger.installments.map((i) => ({
            ...i,
            due_date: addDays(i.due_date, 14),
          })),
        },
      });
      expect(pmiInScope(fifteenth)).toBe(false);
    });

    it("a New York purchase takes the appraisal, and its 78% date eleven months early; New York is never drawn", () => {
      const ny = loan(A!, { state: "NY" });
      expect(
        originalValue({
          sales_price_cents: 40_000_000n,
          appraised_value_cents: 41_000_000n,
          is_refinance: false,
          state: "NY",
        }),
      ).toBe(41_000_000n);
      expect(analyzePmi(ny).scheduled_78).toMatchObject({ n: 124, due_date: "2034-08-01" });
      expect(pmiInScope(ny)).toBe(false);
      // New York's own 75% stop (10.2's overlay) is not ported either, so no New York loan is in scope,
      // a refinance or a purchase whose appraisal is the lesser figure included.
      expect(
        pmiInScope(loan(A!, { state: "NY", is_refinance: true, sales_price_cents: null })),
      ).toBe(false);
      expect(pmiInScope(loan(A!, { state: "NY", sales_price_cents: 42_000_000n }))).toBe(false);
    });

    it("a rate change after the 78% row, or inside an interest-only period, re-versions wrongly", () => {
      // Swept on 2035-12-10, after the change has taken effect, so only the 78%-row clause can refuse it.
      const late = with_(A!, {
        as_of: d("2035-12-10"),
        ledger: specLedgerWith(A!.ledger, "2035-12-10", {}),
        rate_changes: [{ payment_number: 140, new_rate_pct: "7.000" }],
      });
      // The engine reads the reset row itself as the 78% row; the note's own is 135.
      expect(analyzePmi(late).scheduled_78).toMatchObject({ n: 140, due_date: "2035-12-01" });
      expect(analyzePmi(A!).scheduled_78).toMatchObject({ n: 135 });
      expect(pmiInScope(late)).toBe(false);
      const ioArm = with_(SPEC[6]!, {
        rate_changes: [{ payment_number: 61, new_rate_pct: "7.500" }],
      });
      const reset = scheduleVersions(ioArm)[1]!;
      // 10.2 R2 holds the balance until amortization begins; the reset amortizes at once.
      expect(reset.rows[0]!.principal_cents).toBe(43_317n);
      expect(reset.pi_cents).toBe(280_817n);
      expect(pmiInScope(ioArm)).toBe(false);
      // A modification after the note's own trigger.
      expect(
        pmiInScope(
          with_(SPEC[4]!, {
            modification: { ...SPEC[4]!.modification!, first_modified_due: d("2035-08-01") },
          }),
        ),
      ).toBe(false);
    });

    it("the service measures the midpoint from a rate change, thirty months late", () => {
      const [, reset] = scheduleVersions(SPEC[3]!);
      expect(midpoint(reset!.rows[0]!.due_date, reset!.rows.length).midpoint_termination_date).toBe(
        "2041-11-01",
      );
      // The grader measures from the note's first due and full term, as 10.3 R1 says.
      expect(expectedPmi(SPEC[3]!).position.midpoint_termination_date).toBe("2039-05-01");
    });

    it("a request after the scheduled 80% date is tested on the actual balance alone", () => {
      // Scheduled balance after 2034-09-01 is $318,828.86 (79.70%); a $15,000 deferral makes it 83.45%.
      const v = scheduleVersions(A!)[0]!;
      expect(v.rows.find((x) => x.due_date === "2034-09-01")!.upb_after_cents).toBe(31_882_886n);
      const late = with_(T1, {
        as_of: d("2034-09-15"),
        ledger: specLedgerWith({ ...T1.ledger, from: d("2032-08-01") }, "2034-09-15", {}),
        request: {
          ...T1.request!,
          received_on: d("2034-09-10"),
          balance: {
            upb_on_receipt_cents: 31_882_886n,
            postings: [],
            deferred_principal_cents: 1_500_000n,
            forborne_principal_cents: 0n,
          },
        },
      });
      expect(expectedPmi(late).request).toMatchObject({
        ltv_bps: 8345,
        result: "ineligible",
        reasons: ["LTV_ABOVE_THRESHOLD"],
      });
      expect(pmiInScope(late)).toBe(false);
      // Asked on the current-value path with a $410,000 BPO, it is denied on that path's table, where the
      // original-value path the spec evaluates first grants on the schedule alone.
      const current = with_(late, {
        as_of: d("2034-09-20"),
        ledger: specLedgerWith(late.ledger, "2034-09-20", {}),
        request: {
          ...late.request!,
          path: "current_value",
          avm_cents: null,
          valuation: { value_cents: 41_000_000n, delivered_on: d("2034-09-15") },
          evidence_satisfied_on: d("2034-09-15"),
        },
      });
      expect(expectedPmi(current).request).toMatchObject({
        ltv_bps: 8142,
        result: "ineligible",
        reasons: ["LTV_ABOVE_THRESHOLD_CURRENT"],
      });
      expect(pmiInScope(current)).toBe(false);
    });

    it("a current-value request is judged on its own path alone, where the spec evaluates the original value first", () => {
      // 10.1-T1's balance, 79.98% of the original value, asked on the current-value path with a $455,000
      // BPO: the engine grants under code 52, where the original-value path grants under 51 (10.1 R1).
      const t = req(T1, {
        path: "current_value",
        avm_cents: null,
        valuation: { value_cents: 45_500_000n, delivered_on: d("2029-07-12") },
        evidence_satisfied_on: d("2029-07-12"),
      });
      expect(expectedPmi(t).termination).toMatchObject({ lar89_action_code: "52" });
      expect(expectedPmi(T1).termination).toMatchObject({ lar89_action_code: "51" });
      expect(pmiInScope(t)).toBe(false);
      // Above the original-value line the current-value path is the borrower's only one, and in scope.
      expect(pmiInScope(SPEC[20]!)).toBe(true);
    });

    it("a current-value request under 24 months asks for a valuation that cannot help", () => {
      const young = req(SPEC[20]!, {
        received_on: d("2025-02-20"),
        valuation: null,
        evidence_satisfied_on: null,
      });
      const t = with_(young, {
        as_of: d("2025-02-25"),
        ledger: specLedgerWith(young.ledger, "2025-02-25", {}),
      });
      expect(seasoningMonths(t.loan.consummation, d("2025-02-20"))).toBe(11);
      expect(expectedPmi(t).request).toMatchObject({
        result: "value_check_needed",
        reasons: ["VALUATION_REQUIRED"],
        threshold_bps: null,
      });
      expect(pmiInScope(t)).toBe(false);
    });

    it("a borrower-paid valuation below the original value loops back to a value check", () => {
      const t = req(SPEC[17]!, {
        valuation: { value_cents: 39_800_000n, delivered_on: d("2029-07-30") },
      });
      expect(expectedPmi(t).request).toMatchObject({
        result: "value_check_needed",
        reasons: ["VALUE_DECLINED_OR_UNKNOWN"],
      });
      expect(pmiInScope(t)).toBe(false);
    });

    it("a two- to four-unit investment property is never offered the $750 appraisal (not graded)", () => {
      const check = valueCheck(null, 40_000_000n, 1);
      expect(check.status === "value_check_needed" && check.options.map((o) => o.type)).toEqual([
        "bpo",
        "restricted_appraisal",
      ]);
    });

    it("the HPA's current test at the decision is computed and discarded", () => {
      const t = with_(T1, {
        as_of: d("2029-08-15"),
        ledger: {
          ...T1.ledger,
          receipts: T1.ledger.receipts.filter((r) => r.received_on < "2029-07-01"),
        },
      });
      expect(analyzePmi(t).request!.current).toEqual({ fnma: true, hpa: false });
      expect(expectedPmi(t).request!.result).toBe("eligible");
      expect(pmiInScope(t)).toBe(false);
    });

    it("an evidence date before the valuation's delivery runs the clock from the fee", () => {
      const fee = req(SPEC[21]!, { evidence_satisfied_on: d("2026-08-24") });
      expect(expectedPmi(fee).request!.decision_due).toBe("2026-09-23");
      expect(expectedPmi(SPEC[21]!).request!.decision_due).toBe("2026-10-03");
      expect(pmiInScope(fee)).toBe(false);
    });

    it("keeps the late counts SMDU is sent equal to the ones the engine decides on", () => {
      // The threshold reached by a posting on 08-05, after the request on 07-10: a late installment due
      // 2028-08-01 is in the request's twelve months and not in the posting's.
      const t = with_(SPEC[19]!, {
        as_of: d("2029-08-10"),
        ledger: specLedgerWith(SPEC[19]!.ledger, "2029-08-10", {
          "2028-08-01": "2028-09-05",
          "2028-09-01": "2028-09-05",
        }),
        request: {
          ...SPEC[19]!.request!,
          balance: {
            ...SPEC[19]!.request!.balance,
            postings: [{ posted_on: d("2029-08-05"), upb_after_cents: 31_960_000n }],
          },
        },
      });
      const a = analyzePmi(t);
      expect(a.request!.threshold_reached_on).toBe("2029-08-05");
      expect(a.request!.decision.history.late30_12m).toBe(0);
      const age = seasoningMonths(t.loan.consummation, d("2029-07-10"));
      expect(paymentHistory(a.installments, d("2029-07-10"), new Set(), age).late30_12m).toBe(1);
      expect(pmiInScope(t)).toBe(false);
    });

    it("keeps receipts to the evaluation date, a request before the trigger, and none on lender-paid MI", () => {
      const ahead = with_(A!, {
        ledger: {
          ...A!.ledger,
          receipts: [
            ...A!.ledger.receipts,
            { received_on: d("2035-07-02"), amount_cents: 240_186n },
          ],
        },
      });
      expect(pmiInScope(ahead)).toBe(false);
      expect(pmiInScope(with_(T1, { as_of: d("2035-07-01") }))).toBe(false);
      expect(pmiInScope(with_(T1, { mi: { ...T1.mi, plan: "lender_paid" } }))).toBe(false);
    });
  });

  it("holds every rare outcome in the held-out suite, and gives the trigger away in neither the date nor the ledger", () => {
    const tasks = generatePmiSuite("heldout", PMI_HELDOUT_SUITE.seed, PMI_HELDOUT_SUITE.n);
    const runs = tasks.map((t) => ({ t, w: expectedPmi(t) }));
    // The rare arms are taken in turn by index, so the suite every score is measured on has each.
    expect(runs.filter(({ w }) => w.request?.result === "refused").length).toBeGreaterThan(0);
    expect(
      runs.filter(({ w }) => w.request?.reasons.includes("VALUATION_REQUIRED")).length,
    ).toBeGreaterThan(0);
    expect(
      runs.filter(
        ({ w }) => w.automatic && !w.automatic.current_on_trigger && w.automatic.cure_on === null,
      ).length,
    ).toBeGreaterThan(0);

    const firstOf = (x: string) => `${x.slice(0, 7)}-01`;
    const months = (x: string) => Number(x.slice(0, 4)) * 12 + Number(x.slice(5, 7));
    const sweeps = runs.filter(({ t }) => !t.request);
    const ran = sweeps.filter(({ t, w }) => t.as_of >= w.position.trigger_date);
    // The evaluation date falls up to thirteen months from the trigger, so its month is the trigger's
    // about as often as chance has it; and no count of months back from the trigger to the ledger's
    // first installment holds more than one sweep in eight.
    expect(
      ran.filter(({ t, w }) => w.position.trigger_date === firstOf(t.as_of)).length / ran.length,
    ).toBeLessThan(0.15);
    const gaps = new Map<number, number>();
    for (const { t, w } of sweeps) {
      const g = months(w.position.trigger_date) - months(t.ledger.from);
      gaps.set(g, (gaps.get(g) ?? 0) + 1);
    }
    expect(Math.max(...gaps.values()) / sweeps.length).toBeLessThan(0.125);

    // A policy that takes the trigger for the 1st of the evaluation date's month and works every clock
    // from it, searching no schedule, scores no better than the same policy taking the midpoint for the
    // trigger: the date tells it nothing.
    const tool = (name: string, input: unknown, key: string) =>
      String((JSON.parse(executePmiTool(name, input)) as Record<string, unknown>)[key]);
    const scheduleFree = (t: PmiTask, fromDate: boolean): PmiAnswer => {
      const l = t.loan;
      const m = t.modification;
      const ov = l.is_refinance
        ? l.appraised_value_cents
        : l.sales_price_cents! < l.appraised_value_cents
          ? l.sales_price_cents!
          : l.appraised_value_cents;
      const rule78 =
        l.consummation >= "1999-07-29" &&
        l.units === 1 &&
        l.occupancy_at_origination !== "investment";
      const firstDue = m ? m.first_modified_due : l.first_payment_due;
      const term = m ? m.term_months : l.io_months + l.amortizing_term_months;
      const mid = tool("date_add", { date: firstDue, months: term / 2, days: 0 }, "date");
      const pi = tool(
        "level_payment",
        m
          ? {
              principal_cents: String(m.ib_upb_cents),
              annual_rate_pct: m.rate_pct,
              term_months: term,
            }
          : {
              principal_cents: String(l.original_principal_cents),
              annual_rate_pct: l.note_rate_pct,
              term_months: l.amortizing_term_months,
            },
        "payment_cents",
      );
      const T = fromDate ? firstOf(t.as_of) : mid;
      const via78 = rule78 && T < mid;
      const position = {
        original_value_cents: String(ov),
        rule_78_applies: rule78,
        pi_cents: pi,
        scheduled_78_payment_number: via78 ? months(T) - months(firstDue) + 1 : null,
        scheduled_78_date: via78 ? T : null,
        midpoint_termination_date: mid,
        trigger_date: T,
      };
      const none = {
        request: null,
        automatic: null,
        termination: null,
        lpmi_options_notice_due: null,
      };
      if (t.mi.plan === "lender_paid")
        return {
          position,
          ...none,
          lpmi_options_notice_due: t.as_of >= T ? addDays(d(T), 30) : null,
        };
      if (t.as_of < T) return { position, ...none };
      const E = d(T);
      const plan = refundPlanAt(t, E)!;
      return {
        position,
        request: null,
        automatic: {
          current_on_trigger: true,
          not_current_installments: [],
          not_current_notice_due: null,
          cure_on: null,
        },
        termination: {
          effective_on: E,
          lar89_action_code: "53",
          lar89_action_date: `${E.slice(5, 7)}${E.slice(8, 10)}${E.slice(2, 4)}`,
          notice_due: addDays(E, 30),
          premium_stop_by: addDays(E, 30),
          refund_due: addDays(E, 45),
          insurer_notice_due: addBusinessDays(E, 2, servicer),
          escrow_interim_analysis_due: addBusinessDays(E, 10, servicer),
          unearned_premium_cents: String(unearnedEstimate(plan, E)),
        },
        lpmi_options_notice_due: null,
      };
    };
    const mean = (fromDate: boolean) =>
      sweeps.reduce((a, { t, w }) => a + gradePmiAgainst(w, scheduleFree(t, fromDate)).score, 0) /
      sweeps.length;
    expect(mean(true)).toBeLessThan(mean(false) + 0.02);
    expect(
      sweeps.filter(({ t, w }) => gradePmiAgainst(w, scheduleFree(t, true)).pass).length /
        sweeps.length,
    ).toBeLessThan(0.05);
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump PMI_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generatePmiSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"cdc54ff3d77dd2b13a77ebd9cf0fb1f15b3db3aa9aad80fec07195b99091447d"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out task into training", () => {
    expect(toJsonLine(generatePmiTask("train", 7, 17))).toBe(
      toJsonLine(generatePmiSuite("train", 7, 30)[17]),
    );
    const fp = (t: PmiTask) => toJsonLine(pmiPayload(t));
    const held = new Set(generatePmiSuite("heldout", 1, 200).map(fp));
    expect(generatePmiSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  }, 60_000);

  describe("each edge and configuration that decides an answer turns up", () => {
    const runs = generatePmiSuite("train", 1, 1200).map((t, i) => ({
      t,
      a: expectedPmi(t),
      an: analyzePmi(t),
      edge: pmiEdgeOf(i),
    }));
    type Run = (typeof runs)[number];
    const count = (f: (x: Run) => boolean) => runs.filter(f).length;
    const rowAt = (x: Run, n: number) => x.an.version.rows.find((r) => r.n === n);
    const t78 = (x: Run) => thresholdCents(x.an.original_value_cents, 78);
    const forborne = (x: Run) => x.an.version.forborne_principal_cents;
    const satisfied = (x: Run, due: PlainDate) =>
      x.an.installments.find((i) => i.due_date === due)?.satisfied_on ?? null;
    const requests = runs.filter((x) => x.t.request);
    const countRequests = (f: (x: Run) => boolean) => requests.filter(f).length;

    it("cycles through every edge, a hundred tasks each", () => {
      expect(new Set(runs.map((x) => x.edge))).toEqual(new Set(PMI_EDGES));
    });

    it("draws the 78% threshold on a row to the cent, a cent either side, and half a cent over a row", () => {
      const at78 = (x: Run, n: number) =>
        x.an.scheduled_78 && rowAt(x, n)
          ? rowAt(x, n)!.upb_after_cents + forborne(x) - t78(x)
          : null;
      expect(
        count((x) => x.an.scheduled_78 !== null && at78(x, x.an.scheduled_78.n) === 0n),
      ).toBeGreaterThan(60);
      expect(
        count((x) => x.an.scheduled_78 !== null && at78(x, x.an.scheduled_78.n - 1) === 1n),
      ).toBeGreaterThan(15);
      expect(
        count((x) => x.an.scheduled_78 !== null && at78(x, x.an.scheduled_78.n) === -1n),
      ).toBeGreaterThan(8);
      // Half a cent: the row's balance is the threshold rounded half up, and (odd) one more than it rounded
      // half to even or down, so only rounding half up finds that row.
      expect(
        count(
          (x) =>
            x.an.scheduled_78 !== null &&
            (x.an.original_value_cents * 78n) % 100n === 50n &&
            at78(x, x.an.scheduled_78.n) === 0n &&
            t78(x) % 2n === 1n,
        ),
      ).toBeGreaterThan(30);
    });

    it("draws the 78% date a payment either side of the midpoint, and the sweep the day before", () => {
      const p = (x: Run) => x.a.position;
      expect(
        count(
          (x) =>
            p(x).rule_78_applies &&
            p(x).scheduled_78_date !== null &&
            addMonths(d(p(x).scheduled_78_date!), 1) === p(x).midpoint_termination_date,
        ),
      ).toBeGreaterThan(12);
      expect(
        count(
          (x) =>
            p(x).rule_78_applies &&
            p(x).scheduled_78_date !== null &&
            addMonths(d(p(x).midpoint_termination_date), 1) === p(x).scheduled_78_date,
        ),
      ).toBeGreaterThan(8);
      expect(
        count(
          (x) =>
            x.t.loan.io_months > 0 &&
            p(x).rule_78_applies &&
            p(x).trigger_date === p(x).midpoint_termination_date,
        ),
      ).toBeGreaterThan(20);
      expect(
        count((x) => !x.t.request && x.t.mi.plan !== "lender_paid" && x.a.automatic === null),
      ).toBeGreaterThan(20);
    });

    it("draws the 78% rule's reach on each side of each line", () => {
      expect(
        count((x) => x.t.loan.consummation === "1999-07-28" && !x.a.position.rule_78_applies),
      ).toBeGreaterThan(10);
      expect(
        count((x) => x.t.loan.consummation === "1999-07-29" && x.a.position.rule_78_applies),
      ).toBeGreaterThan(8);
      expect(count((x) => x.t.loan.consummation < "1999-07-28")).toBeGreaterThan(6);
      expect(
        count(
          (x) =>
            x.t.loan.occupancy_at_origination === "second_home" && x.a.position.rule_78_applies,
        ),
      ).toBeGreaterThan(30);
      expect(
        count(
          (x) =>
            x.t.loan.occupancy_at_origination === "investment" && !x.a.position.rule_78_applies,
        ),
      ).toBeGreaterThan(30);
      expect(count((x) => x.t.loan.units > 1 && !x.a.position.rule_78_applies)).toBeGreaterThan(40);
    });

    it("draws the original value each way: a refinance, the price lower, equal or higher; never New York", () => {
      const l = (x: Run) => x.t.loan;
      expect(count((x) => l(x).is_refinance)).toBeGreaterThan(150);
      expect(
        count((x) => !l(x).is_refinance && l(x).sales_price_cents! < l(x).appraised_value_cents),
      ).toBeGreaterThan(150);
      expect(
        count((x) => !l(x).is_refinance && l(x).sales_price_cents === l(x).appraised_value_cents),
      ).toBeGreaterThan(80);
      expect(
        count((x) => !l(x).is_refinance && l(x).sales_price_cents! > l(x).appraised_value_cents),
      ).toBeGreaterThan(150);
      expect(count((x) => l(x).state === "NY")).toBe(0);
    });

    it("draws rate changes up and down that move the 78% date, and modifications either side of their midpoint", () => {
      expect(count((x) => x.t.rate_changes.length === 2)).toBeGreaterThan(15);
      const moved = (x: Run) =>
        x.t.rate_changes.length > 0 &&
        scheduledDateForPct(x.an.versions[0]!, x.an.original_value_cents, 78)!.n !==
          x.an.scheduled_78!.n;
      expect(
        count(
          (x) =>
            moved(x) && Number(x.t.rate_changes[0]!.new_rate_pct) > Number(x.t.loan.note_rate_pct),
        ),
      ).toBeGreaterThan(30);
      expect(
        count(
          (x) =>
            moved(x) && Number(x.t.rate_changes[0]!.new_rate_pct) < Number(x.t.loan.note_rate_pct),
        ),
      ).toBeGreaterThan(15);
      expect(count((x) => (x.t.modification?.forborne_principal_cents ?? 0n) > 0n)).toBeGreaterThan(
        60,
      );
      expect(
        count(
          (x) =>
            x.t.modification !== null &&
            x.a.position.trigger_date === x.a.position.scheduled_78_date,
        ),
      ).toBeGreaterThan(50);
      expect(
        count(
          (x) =>
            x.t.modification !== null &&
            x.a.position.trigger_date !== x.a.position.scheduled_78_date,
        ),
      ).toBeGreaterThan(15);
    });

    it("draws the month before the trigger paid on its last day and on the trigger, February in a leap year among them", () => {
      const T = (x: Run) => d(x.a.position.trigger_date);
      const sweeps = (f: (x: Run) => boolean) => count((x) => x.a.automatic !== null && f(x));
      expect(
        sweeps(
          (x) =>
            satisfied(x, addMonths(T(x), -1)) === addDays(T(x), -1) &&
            x.a.automatic!.current_on_trigger,
        ),
      ).toBeGreaterThan(40);
      expect(
        sweeps(
          (x) => satisfied(x, addMonths(T(x), -1)) === T(x) && !x.a.automatic!.current_on_trigger,
        ),
      ).toBeGreaterThan(40);
      const leap = (x: Run) =>
        x.a.position.trigger_date.endsWith("-03-01") &&
        isLeapYear(Number(x.a.position.trigger_date.slice(0, 4)));
      expect(sweeps((x) => leap(x) && x.a.automatic!.current_on_trigger)).toBeGreaterThan(20);
      expect(sweeps((x) => leap(x) && !x.a.automatic!.current_on_trigger)).toBeGreaterThan(4);
    });

    it("draws cures on the trigger, on a month's last day and on a 1st; none by the evaluation date; partial and double receipts", () => {
      const cure = (x: Run) => x.a.automatic?.cure_on ?? null;
      expect(
        count((x) => cure(x) !== null && cure(x) === x.a.position.trigger_date),
      ).toBeGreaterThan(30);
      expect(count((x) => cure(x) !== null && cure(x) === endOfMonth(d(cure(x)!)))).toBeGreaterThan(
        12,
      );
      expect(
        count(
          (x) =>
            cure(x) !== null && cure(x)!.endsWith("-01") && cure(x) !== x.a.position.trigger_date,
        ),
      ).toBeGreaterThan(8);
      expect(
        count(
          (x) => x.a.automatic !== null && !x.a.automatic.current_on_trigger && cure(x) === null,
        ),
      ).toBeGreaterThan(12);
      expect(
        count((x) => (x.a.automatic?.not_current_installments.length ?? 0) >= 2),
      ).toBeGreaterThan(25);
      // Two steps: an arrear caught up on or after the trigger, before the receipt that cures.
      expect(
        count(
          (x) =>
            cure(x) !== null &&
            x.an.installments.some(
              (i) =>
                x.a.automatic!.not_current_installments.includes(i.due_date) &&
                i.satisfied_on !== null &&
                i.satisfied_on >= x.a.position.trigger_date &&
                i.satisfied_on < cure(x)!,
            ),
        ),
      ).toBeGreaterThan(45);
      // An older arrear caught up on the test month's last day itself: on time for the test, and not
      // listed, while the installment after it is.
      expect(
        count((x) => {
          const s = x.a.automatic;
          if (!s || s.current_on_trigger) return false;
          const testEnd = addDays(d(x.a.position.trigger_date), -1);
          return x.an.installments.some(
            (i) =>
              i.due_date < addMonths(d(x.a.position.trigger_date), -1) &&
              i.satisfied_on === testEnd,
          );
        }),
      ).toBeGreaterThan(10);
      const A = (x: Run) => x.t.ledger.installments[0]!.amount_cents;
      expect(count((x) => x.t.ledger.receipts.some((r) => r.amount_cents < A(x)))).toBeGreaterThan(
        60,
      );
      expect(
        count((x) => x.t.ledger.receipts.some((r) => r.amount_cents >= 2n * A(x))),
      ).toBeGreaterThan(60);
    });

    it("draws each refund plan where it decides the figure", () => {
      const e = (x: Run) => d(x.a.termination!.effective_on);
      const annual = (f: (x: Run) => boolean) =>
        count((x) => x.t.mi.plan === "annual" && x.a.termination !== null && f(x));
      expect(
        annual((x) => x.a.termination!.unearned_premium_cents === String(x.t.mi.premium_cents)),
      ).toBeGreaterThan(12);
      expect(
        annual((x) => daysBetween(anniversaryOnOrBefore(x.t.mi.coverage_start, e(x)), e(x)) === 1),
      ).toBeGreaterThan(10);
      expect(annual((x) => x.a.termination!.unearned_premium_cents === "0")).toBeGreaterThan(12);
      const months = (x: Run) => seasoningMonths(x.t.mi.coverage_start, e(x));
      const single = (f: (x: Run) => boolean) =>
        count((x) => x.t.mi.plan === "single" && x.a.termination !== null && f(x));
      expect(
        single((x) => x.t.mi.refund_schedule!.some((r) => r.months_in_force_from === months(x))),
      ).toBeGreaterThan(20);
      expect(
        single((x) =>
          x.t.mi.refund_schedule!.some((r) => r.months_in_force_from === months(x) + 1),
        ),
      ).toBeGreaterThan(20);
      expect(
        count(
          (x) =>
            x.t.mi.plan === "monthly" &&
            x.a.termination !== null &&
            !x.a.termination.effective_on.endsWith("-01"),
        ),
      ).toBeGreaterThan(20);
      expect(count((x) => x.a.lpmi_options_notice_due !== null)).toBeGreaterThan(50);
      expect(
        count((x) => x.t.mi.plan === "lender_paid" && x.a.lpmi_options_notice_due === null),
      ).toBeGreaterThan(4);
    });

    it("draws effective dates whose business-day clocks step over a federal holiday", () => {
      const weekdays = { ...servicer, isBusinessDay: (x: PlainDate) => !isWeekend(x) };
      expect(
        count((x) => {
          const t = x.a.termination;
          return (
            t !== null &&
            (t.insurer_notice_due !== addBusinessDays(d(t.effective_on), 2, weekdays) ||
              t.escrow_interim_analysis_due !== addBusinessDays(d(t.effective_on), 10, weekdays))
          );
        }),
      ).toBeGreaterThan(300);
    });

    it("draws only loans that could exist: within what the property may borrow, certified at closing, forbearance within the Flex Modification's cap", () => {
      const ltv = (x: Run) =>
        Number((x.t.loan.original_principal_cents * 10_000n) / x.an.original_value_cents);
      const occupancy = (x: Run) => x.t.loan.occupancy_at_origination;
      expect(count((x) => ltv(x) <= 8000 || ltv(x) > 9650)).toBe(0);
      expect(
        count(
          (x) =>
            occupancy(x) === "investment" &&
            (ltv(x) > 8500 || x.t.loan.units > 1 || x.t.loan.is_refinance),
        ),
      ).toBe(0);
      expect(count((x) => occupancy(x) === "second_home" && ltv(x) > 9000)).toBe(0);
      expect(count((x) => occupancy(x) === "investment")).toBeGreaterThan(35);
      expect(count((x) => occupancy(x) === "second_home")).toBeGreaterThan(60);
      expect(
        count(
          (x) =>
            x.t.mi.coverage_start < x.t.loan.consummation ||
            x.t.mi.coverage_start >= x.t.loan.first_payment_due,
        ),
      ).toBe(0);
      expect(
        count((x) => {
          const m = x.t.modification;
          return (
            m !== null &&
            m.forborne_principal_cents * 10n > (m.ib_upb_cents + m.forborne_principal_cents) * 3n
          );
        }),
      ).toBe(0);
    });

    it("draws every request result and reason", () => {
      expect(new Set(requests.map((x) => x.a.request!.result))).toEqual(
        new Set(["eligible", "ineligible", "value_check_needed", "refused"]),
      );
      expect(new Set(requests.flatMap((x) => x.a.request!.reasons))).toEqual(
        new Set(REQUEST_REASONS),
      );
    });

    it("draws the LTV on its line in floored basis points, a point either side, at the line's top and bottom", () => {
      const r = (x: Run) => x.a.request!;
      const value = (x: Run) =>
        x.t.request!.path === "original_value"
          ? x.an.original_value_cents
          : x.t.request!.valuation!.value_cents;
      const onLine = (x: Run) => r(x).ltv_bps !== null && r(x).ltv_bps === r(x).threshold_bps;
      expect(countRequests(onLine)).toBeGreaterThan(25);
      expect(
        countRequests(
          (x) =>
            r(x).ltv_bps !== null &&
            r(x).threshold_bps !== null &&
            r(x).ltv_bps === r(x).threshold_bps! - 1,
        ),
      ).toBeGreaterThan(12);
      expect(
        countRequests(
          (x) =>
            r(x).ltv_bps !== null &&
            r(x).threshold_bps !== null &&
            r(x).ltv_bps === r(x).threshold_bps! + 1,
        ),
      ).toBeGreaterThan(15);
      // 80.00% exactly as the smallest balance that floors to it, and the largest.
      const E = (x: Run) => x.an.request!.evaluation_upb_cents;
      expect(
        countRequests(
          (x) => onLine(x) && (E(x) - 1n) * 10_000n < BigInt(r(x).threshold_bps!) * value(x),
        ),
      ).toBeGreaterThan(6);
      expect(
        countRequests(
          (x) => onLine(x) && (E(x) + 1n) * 10_000n >= BigInt(r(x).threshold_bps! + 1) * value(x),
        ),
      ).toBeGreaterThan(5);
      expect(countRequests((x) => r(x).threshold_bps === 7000)).toBeGreaterThan(25);
      expect(countRequests((x) => r(x).threshold_bps === 7500)).toBeGreaterThan(4);
      expect(
        countRequests((x) => x.t.request!.path === "current_value" && r(x).threshold_bps === 8000),
      ).toBeGreaterThan(12);
      expect(countRequests((x) => x.t.request!.improvements_accepted)).toBeGreaterThan(8);
    });

    it("draws deferred and forborne principal in the balance, and the threshold reached after the request", () => {
      const b = (x: Run) => x.t.request!.balance;
      expect(countRequests((x) => b(x).deferred_principal_cents > 0n)).toBeGreaterThan(25);
      expect(countRequests((x) => b(x).forborne_principal_cents > 0n)).toBeGreaterThan(4);
      expect(
        countRequests(
          (x) =>
            x.an.request!.threshold_reached_on !== null &&
            x.an.request!.threshold_reached_on > x.t.request!.received_on,
        ),
      ).toBeGreaterThan(15);
    });

    it("draws each history window failing on its own, at 29 and 30 days, 59 and 60, and disaster exclusions that decide", () => {
      const r = (x: Run) => x.a.request!;
      expect(
        countRequests(
          (x) => r(x).reasons.includes("PAYMENT_HISTORY_30_12M") && r(x).late60_24m === 0,
        ),
      ).toBeGreaterThan(20);
      expect(
        countRequests(
          (x) => r(x).reasons.includes("PAYMENT_HISTORY_60_24M") && r(x).late30_12m === 0,
        ),
      ).toBeGreaterThan(15);
      const late = (x: Run, days: number) =>
        x.an.installments.some(
          (i) =>
            i.satisfied_on !== null &&
            i.due_date < x.t.request!.received_on &&
            daysBetween(i.due_date, i.satisfied_on) === days,
        );
      for (const [days, at] of [
        [29, 10],
        [30, 18],
        [59, 5],
        [60, 8],
      ] as const)
        expect(
          countRequests((x) => late(x, days)),
          `${days} days`,
        ).toBeGreaterThan(at);
      // February counts its own days: 30 days after 02-01 is 03-02 in a leap year.
      expect(
        countRequests((x) =>
          x.an.installments.some(
            (i) =>
              i.due_date.endsWith("-02-01") &&
              isLeapYear(Number(i.due_date.slice(0, 4))) &&
              i.satisfied_on === `${i.due_date.slice(0, 4)}-03-02`,
          ),
        ),
      ).toBeGreaterThan(0);
      const decides = (x: Run) => {
        const a = x.an.request!;
        if (x.t.request!.disaster_excluded.length === 0) return false;
        const D =
          a.threshold_reached_on && a.threshold_reached_on > x.t.request!.received_on
            ? a.threshold_reached_on
            : x.t.request!.received_on;
        return (
          paymentHistory(
            x.an.installments,
            D,
            new Set(),
            seasoningMonths(x.t.loan.consummation, x.t.request!.received_on),
          ).ok !== a.decision.history.ok
        );
      };
      expect(countRequests(decides)).toBeGreaterThan(4);
      expect(countRequests((x) => r(x).reasons.includes("NOT_CURRENT"))).toBeGreaterThan(10);
      // A 60-day late on a loan under 24 months old. (The windows shortened to the loan's age reach back
      // before its first installment, so the age clause is restated for fidelity and decides nothing.)
      expect(
        countRequests(
          (x) =>
            seasoningMonths(x.t.loan.consummation, x.t.request!.received_on) < 24 &&
            r(x).late60_24m! > 0,
        ),
      ).toBeGreaterThan(4);
      const D = (x: Run) => {
        const reached = x.an.request!.threshold_reached_on;
        return reached && reached > x.t.request!.received_on ? reached : x.t.request!.received_on;
      };
      const daysLate = (i: { due_date: PlainDate; satisfied_on: PlainDate | null }) =>
        i.satisfied_on === null ? null : daysBetween(i.due_date, i.satisfied_on);
      // The month before the request paid on its own last day: current to the day.
      expect(
        countRequests((x) => {
          const precedingEnd = addDays(d(`${x.t.request!.received_on.slice(0, 7)}-01`), -1);
          return satisfied(x, d(`${precedingEnd.slice(0, 7)}-01`)) === precedingEnd;
        }),
      ).toBeGreaterThan(5);
      // An installment due on D itself, 30 days late: outside both windows, which end before D.
      expect(
        countRequests((x) =>
          x.an.installments.some((i) => i.due_date === D(x) && (daysLate(i) ?? 0) >= 30),
        ),
      ).toBeGreaterThan(4);
      // One due under 30 days before D and satisfied after it, 30 days late: counted to its satisfaction.
      expect(
        countRequests((x) =>
          x.an.installments.some(
            (i) =>
              i.due_date < D(x) &&
              i.satisfied_on !== null &&
              i.satisfied_on > D(x) &&
              daysBetween(i.due_date, D(x)) < 30 &&
              (daysLate(i) ?? 0) >= 30,
          ),
        ),
      ).toBeGreaterThan(6);
    });

    it("draws the value checks: an AVM at the original value, none, a borrower's BPO, the 120th day and the 121st", () => {
      const r = (x: Run) => x.t.request!;
      expect(
        countRequests(
          (x) =>
            r(x).path === "original_value" &&
            r(x).avm_cents === x.an.original_value_cents &&
            x.a.request!.result === "eligible",
        ),
      ).toBeGreaterThan(3);
      expect(
        countRequests((x) => r(x).path === "original_value" && r(x).avm_cents === null),
      ).toBeGreaterThan(5);
      expect(
        countRequests(
          (x) =>
            r(x).path === "original_value" &&
            r(x).valuation !== null &&
            x.a.request!.result === "eligible",
        ),
      ).toBeGreaterThan(3);
      const daysSince = (x: Run) =>
        r(x).valuation ? daysBetween(r(x).valuation!.delivered_on, x.t.as_of) : 0;
      expect(
        countRequests((x) => daysSince(x) === 120 && x.a.request!.result !== "refused"),
      ).toBeGreaterThan(2);
      expect(
        countRequests((x) => daysSince(x) === 121 && x.a.request!.result === "refused"),
      ).toBeGreaterThan(2);
      for (const age of [23, 24, 59, 60])
        expect(
          countRequests(
            (x) =>
              r(x).path === "current_value" &&
              seasoningMonths(x.t.loan.consummation, r(x).received_on) === age,
          ),
          `${age} months`,
        ).toBeGreaterThan(2);
    });
  });
});

/** A spec ledger carried to a new date, with some installments paid on other days. */
function specLedgerWith(
  base: PmiTask["ledger"],
  through: string,
  paid: Record<string, string>,
): PmiTask["ledger"] {
  const amount = base.installments[0]!.amount_cents;
  const installments: { due_date: PlainDate; amount_cents: bigint }[] = [];
  for (let due = base.from; due <= through; due = addMonths(due, 1))
    installments.push({ due_date: due, amount_cents: amount });
  const receipts = installments
    .map((i) => ({ received_on: plainDate(paid[i.due_date] ?? i.due_date), amount_cents: amount }))
    .filter((r) => r.received_on <= through)
    .sort((a, b) => (a.received_on < b.received_on ? -1 : a.received_on > b.received_on ? 1 : 0));
  return { from: base.from, installments, receipts };
}
