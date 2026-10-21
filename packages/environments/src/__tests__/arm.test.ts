/**
 * arm-adjustment: the grader is the servicing app's two ARM engines and no
 * other (each port is its file byte for byte but the imports), and the
 * conventions it restates are held to the service's own lines; it gives
 * §7.2's worked example and test cases, and §7.3's, to the cent; engine A and
 * engine B agree on every generated change; the rulebook followed through the
 * tools lands where the engine does on every generated change and on
 * unfiltered draws the generator's guard never saw; the guard keeps out each
 * place the engine departs from its spec; and each edge and configuration
 * that decides an answer turns up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addDays, daysBetween, plainDate, servicer, type PlainDate } from "@hm/kernel/calendar";
import { describe, expect, it } from "vitest";
import { auditEpisode, type AuditRecord } from "../audit.js";
import { noticeOf } from "../compare.js";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { solveNow } from "../refi/reference.js";
import { rngFor } from "../rng.js";
import {
  ARM_EDGES,
  ARM_FINGERPRINT,
  ARM_HELDOUT_SUITE,
  ARM_RULEBOOK,
  ArmReferencePolicy,
  BOUNDS,
  NOTICE_KINDS,
  TEMPLATES,
  analyzeArm,
  armAdjustment,
  armEdgeOf,
  armFairToGrade,
  armInScope,
  armPayload,
  armSpecTasks,
  armSteps,
  armTaskId,
  drawArmCandidate,
  drawArmTask,
  executeArmTool,
  expectedArm,
  generateArmSuite,
  generateArmTask,
  gradeArmAgainst,
  parseArmSubmission,
  type ArmAnalysis,
  type ArmAnswer,
  type ArmTask,
} from "../arm/index.js";
import { computeArmAdjustment, newPayment, newRate, scheduledUpbAfter } from "../arm/ported/arm.js";
import { verifyArmAdjustment } from "../arm/ported/arm-verify.js";

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
/** The one rewrite a port may carry: the kernel's paths become the package's, a sibling's .ts its .js. */
const rewritten = (imports: string) =>
  imports
    .replace(/"\.\.\/\.\.\/kernel\/(calendar|money|fsm|events)\/[a-z-]+\.ts"/g, '"@hm/kernel/$1"')
    .replace(/"\.\/([a-z-]+)\.ts"/g, '"./$1.js"');

const notices = (file: string) =>
  readFileSync(here(`../../../../apps/servicing/src/domain/notices/${file}`), "utf8").split("\n");
/** A run of service lines, found by how the first begins, with the lines the grader cites them by. */
const serviceLines = (file: string, first: string, n: number) => {
  const all = notices(file);
  const start = all.findIndex((l) => l.trimStart().startsWith(first));
  if (start < 0) return `${file}: no line beginning ${first}`;
  return [`${file}:${start + 1}-${start + n}`, ...all.slice(start, start + n)].join("\n");
};

/** The fields where the rulebook, followed through the tools, lands somewhere other than the engine. */
const byRulesMisses = (task: ArmTask): string[] => {
  let raw: unknown;
  try {
    raw = solveNow(armSteps, JSON.parse(JSON.stringify(armPayload(task))), executeArmTool);
  } catch (e) {
    return [`${task.id} threw ${e instanceof Error ? e.message : String(e)}`];
  }
  const parsed = parseArmSubmission(raw);
  if (!parsed.ok) return [`${task.id} ${parsed.error}`];
  return gradeArmAgainst(expectedArm(task), parsed.answer)
    .fields.filter((f) => !f.ok)
    .map((f) => `${task.id} ${f.field} ${f.expected}/${f.got}`);
};

const solveAll = async (tasks: readonly ArmTask[]) => {
  const misses: string[] = [];
  let turns = 0;
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(armAdjustment, task, new ArmReferencePolicy());
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

const SPEC = armSpecTasks();
const [WORKED] = SPEC as [ArmTask];
/** The worked example with some of it changed. */
const workedWith = (loan: Partial<ArmTask["loan"]>, rest: Partial<ArmTask> = {}): ArmTask => ({
  ...WORKED,
  ...rest,
  loan: { ...WORKED.loan, ...loan },
});
const d = plainDate;

describe("arm-adjustment", () => {
  it("grades with the servicing app's ARM engines: each port is its file but for the imports", () => {
    for (const file of ["arm", "arm-verify"]) {
      const original = notices(`${file}.ts`).join("\n");
      const port = readFileSync(here(`../arm/ported/${file}.ts`), "utf8");
      expect(lines(port, false), file).toBe(lines(original, false));
      expect(lines(port, true), file).toBe(rewritten(lines(original, true)));
      // The same names, imported the same way.
      expect(importHeads(port), file).toEqual(importHeads(original));
    }
    expect(importHeads(readFileSync(here("../arm/ported/arm.ts"), "utf8"))).toHaveLength(5);
  });

  it("holds the conventions it restates to the service's own lines", () => {
    // A re-vendor that changes any of these fails here: revisit the grader, the rulebook and their citations.
    expect(serviceLines("ops-7-2.ts", "const monthsBetween = ", 7)).toMatchInlineSnapshot(`
      "ops-7-2.ts:80-86
      const monthsBetween = (a: PlainDate, b: PlainDate): number => { const pa = parts(a), pb = parts(b); return (pb.y - pa.y) * 12 + (pb.m - pa.m); };
      /** The first scheduled due date (day \`dueDay\`, clipped to the month) strictly after \`d\`: the payment "effective in the month following" (F-1-01). */
      export function nextDueAfter(d: PlainDate, dueDay: number): PlainDate {
        const p = parts(d); const cand = ymd(p.y, p.m, Math.min(dueDay, daysInMonth(p.y, p.m)));
        if (cand > d) return cand;
        const n = parts(addMonths(ymd(p.y, p.m, 1), 1)); return ymd(n.y, n.m, Math.min(dueDay, daysInMonth(n.y, n.m)));
      }"
    `);
    expect(serviceLines("ops-7-2.ts", "first_payment_due, maturity_date: raw.maturity_date", 1))
      .toMatchInlineSnapshot(`
      "ops-7-2.ts:158-158
          first_payment_due, maturity_date: raw.maturity_date === undefined ? addMonths(first_payment_due, term_months - 1) : date(raw.maturity_date, "maturity_date"), term_months,"
    `);
    expect(serviceLines("ops-7-2.ts", "export function noticeKindFor(", 7)).toMatchInlineSnapshot(`
      "ops-7-2.ts:188-194
      export function noticeKindFor(terms: Pick<ArmTerms, "term_months" | "consummation_date" | "initial_disclosure_estimate" | "adjustment_period_months" | "lookback_days">, initial: boolean, changeDate: PlainDate, firstNewPaymentDue: PlainDate): NoticeKind {
        if (terms.term_months <= 12) return "fnma_only";
        if (initial && daysBetween(terms.consummation_date, firstNewPaymentDue) <= 210 && !terms.initial_disclosure_estimate) return "fnma_only";
        if (initial && daysBetween(terms.consummation_date, changeDate) <= 60 && terms.initial_disclosure_estimate) return "c_first_25";
        if (terms.adjustment_period_months <= 2 || (terms.consummation_date < "2015-01-10" && terms.lookback_days < 45)) return "c_25_120";
        return "c_60_120";
      }"
    `);
    expect(serviceLines("ops-7-2.ts", "const rows: ArmScheduleRow[] = []; const dueDay", 6))
      .toMatchInlineSnapshot(`
      "ops-7-2.ts:197-202
        const rows: ArmScheduleRow[] = []; const dueDay = parts(terms.first_payment_due).d;
        for (let d = terms.first_change_date, i = 0; d < terms.maturity_date && i < 720; d = addMonths(terms.first_change_date, (i + 1) * terms.adjustment_period_months), i++) {
          const fnpd = nextDueAfter(d, dueDay); const kind = noticeKindFor(terms, i === 0, d, fnpd);
          rows.push({ loan_id: terms.loan_id, change_date: d, index_date: indexDateOf(d, terms.lookback_days), first_new_payment_due: fnpd,
            notice_window_open: kind === "c_60_120" || kind === "c_25_120" ? addDays(fnpd, -120) : null,
            notice_due_by: kind === "c_60_120" ? addDays(fnpd, -60) : kind === "fnma_only" ? addDays(d, -25) : addDays(fnpd, -25),"
    `);
    expect(serviceLines("ops-7-2.ts", "export function expectedUpbAt(", 9)).toMatchInlineSnapshot(`
      "ops-7-2.ts:314-322
      export function expectedUpbAt(terms: ArmTerms, changeDate: PlainDate): Cents {
        const b = terms.schedule_basis; const months = monthsBetween(b.from_due_date, changeDate) + 1;
        if (months < 0) throw new RangeError(\`schedule basis \${b.from_due_date} is after the change date \${changeDate}\`);
        if (terms.interest_only_until !== null && changeDate <= terms.interest_only_until) return b.upb_cents;
        return scheduledUpbAfter(b.upb_cents, b.rate_pct, b.pi_cents, months);
      }
      /** Rule 3: months from \`first_new_payment_due\` to maturity inclusive. */
      export const remainingTermAt = (terms: ArmTerms, firstNewPaymentDue: PlainDate): number => monthsBetween(firstNewPaymentDue, terms.maturity_date) + 1;
      const roundingOf = (t: ArmTerms): "half_down" | "half_up" => (t.rounding_rule === "nearest_eighth_half_up" ? "half_up" : "half_down");"
    `);
    expect(
      serviceLines("ops-7-2.ts", "const first_change = changeDate === terms.first_change_date;", 6),
    ).toMatchInlineSnapshot(`
      "ops-7-2.ts:334-339
        const first_change = changeDate === terms.first_change_date;
        const expected_upb_cents = expectedUpbAt(terms, changeDate); const remaining_term_months = remainingTermAt(terms, row.first_new_payment_due);
        const interest_only = terms.interest_only_until !== null && row.first_new_payment_due <= terms.interest_only_until;
        const engine_input: ArmAdjustmentInput = { index_pct: sel.value, margin_pct: terms.margin_pct, prior_rate_pct: terms.current_rate_pct, initial_note_rate_pct: terms.initial_note_rate_pct, initial_cap_pct: terms.initial_cap_pct, periodic_cap_pct: terms.periodic_cap_pct, lifetime_cap_pct: terms.lifetime_cap_pct, first_change, rounding: roundingOf(terms), expected_upb_cents, remaining_term_months, interest_only };
        const a = computeArmAdjustment(engine_input); const r = newRate(engine_input);
        const unrounded = Decimal.parse(a.unrounded_pct); const rounded = roundToEighth(unrounded, roundingOf(terms)).rate.toFixed(3);"
    `);
    expect(
      serviceLines("ops-7-2.ts", "const rate_changed = adj.new_rate_pct !== adj.prior_rate_pct", 5),
    ).toMatchInlineSnapshot(`
      "ops-7-2.ts:436-440
        const rate_changed = adj.new_rate_pct !== adj.prior_rate_pct, payment_changed = adj.new_pi_cents !== adj.prior_pi_cents;
        const fd = fdcpaCeaseArmNotice({ fdcpa_cease_on_file: terms.fdcpa_cease_on_file, debt_collector: terms.fdcpa_debt_collector });
        const sel = armNoticeSelection({ rate_changed, payment_changed, change_date: changeDate });
        const regz = sel.regz_c_notice && row.notice_kind !== "fnma_only" && fd.regz_c_notice;
        const template: string | null = regz ? TEMPLATES.regz_c : sel.regz_c_notice || sel.fnma_notice ? TEMPLATES.fnma_change : null;"
    `);
    expect(serviceLines("ops-7-2.ts", "const w = windowFor(deps, loanId, row);", 7))
      .toMatchInlineSnapshot(`
      "ops-7-2.ts:445-451
        const w = windowFor(deps, loanId, row);
        let breach: ArmNoticeResult["breach"] = null; let late = false;
        if (regz) {
          const check = sendCheck(sendOn, { not_before: gated(row.notice_kind) ? w.not_before : sendOn, deadline: row.notice_kind === "c_60_120" ? w.deadline : addDays(adj.first_new_payment_due, -25) }, { gate: TIMERS.not_before, deadline: deadlineTimer(row.notice_kind) });
          if (!check.allowed) throw new RangeError(\`\${check.blocked_by}: send blocked before \${w.not_before} (§1026.20(c)(2): no more than 120 days before the first payment at the adjusted level)\`);
          breach = check.breach; late = breach !== null;
        } else if (sel.send_by !== null && sendOn > sel.send_by) late = true;"
    `);
    expect(serviceLines("ops-7-2.ts", "const gated = (k: NoticeKind)", 5)).toMatchInlineSnapshot(`
      "ops-7-2.ts:399-403
      const gated = (k: NoticeKind): boolean => k === "c_60_120" || k === "c_25_120";
      /** The row's (c) window: [−120, −60] (or −25) around \`first_new_payment_due\`; sendable from the index date. */
      export function windowFor(deps: OpsDeps, loanId: string, row: ArmScheduleRow): ReturnType<typeof noticeWindow> {
        return noticeWindow(row.first_new_payment_due, row.change_date, loadTerms(deps, loanId).lookback_days, row.notice_kind !== "c_60_120");
      }"
    `);
    expect(
      serviceLines(
        "ops-7-2.ts",
        "expected_upb_cents: adj.expected_upb_cents, remaining_term_months",
        1,
      ),
    ).toMatchInlineSnapshot(`
      "ops-7-2.ts:461-461
              expected_upb_cents: adj.expected_upb_cents, remaining_term_months: adj.remaining_term_months, escrow_cents: adj.escrow_cents, total_payment_cents: figures.total_payment_cents, current_total_cents: figures.current_total_cents, next_change_date: addMonths(changeDate, terms.adjustment_period_months),"
    `);
    expect(serviceLines("ops.ts", "export function armNoticeSelection(", 5)).toMatchInlineSnapshot(`
      "ops.ts:139-143
      export function armNoticeSelection(f: { rate_changed: boolean; payment_changed: boolean; change_date: PlainDate; courtesy_no_change_notice?: boolean }): { regz_c_notice: boolean; fnma_notice: "NTC_FNMA_C2_1_02_RATE_CHANGE" | null; send_by: PlainDate | null } {
        if (f.rate_changed && f.payment_changed) return { regz_c_notice: true, fnma_notice: null, send_by: null };
        if (f.rate_changed || f.payment_changed) return { regz_c_notice: false, fnma_notice: "NTC_FNMA_C2_1_02_RATE_CHANGE", send_by: addDays(f.change_date, -25) };
        return { regz_c_notice: false, fnma_notice: f.courtesy_no_change_notice ? "NTC_FNMA_C2_1_02_RATE_CHANGE" : null, send_by: f.courtesy_no_change_notice ? addDays(f.change_date, -25) : null };
      }"
    `);
    expect(serviceLines("ops.ts", "export function fdcpaCeaseArmNotice(", 4))
      .toMatchInlineSnapshot(`
      "ops.ts:159-162
      export function fdcpaCeaseArmNotice(f: { fdcpa_cease_on_file: boolean; debt_collector: boolean }): { regz_c_notice: boolean; fnma_notice: "NTC_FNMA_C2_1_02_RATE_CHANGE" | null; marked_as: "required_by_contract_information" | null; decision_cite: string | null } {
        if (f.fdcpa_cease_on_file && f.debt_collector) return { regz_c_notice: false, fnma_notice: "NTC_FNMA_C2_1_02_RATE_CHANGE", marked_as: "required_by_contract_information", decision_cite: "12 CFR 1026.20(c)(1)(ii)(C)" };
        return { regz_c_notice: true, fnma_notice: null, marked_as: null, decision_cite: null };
      }"
    `);
    expect(serviceLines("ops-7-3.ts", "const w = initialNoticeWindow(row.first_new_payment_due", 1))
      .toMatchInlineSnapshot(`
      "ops-7-3.ts:144-144
        const w = initialNoticeWindow(row.first_new_payment_due, terms.consummation_date, terms.term_months);"
    `);
  });

  describe("gives §7.2's and §7.3's worked examples and test cases to the cent", () => {
    const [worked, noSept17, capped, halfDown, halfUp, late, early, second, legacy, fdcpa] =
      SPEC.map(expectedArm);

    it("the worked example: 6.39883 is 6.375 %, $371,048.86 over 300 months is $2,476.44, mailed by Oct 2", () => {
      expect(worked).toEqual({
        index_date: "2026-09-17",
        index_effective_date: "2026-09-17",
        index_value: "3.64883",
        unrounded_pct: "6.39883",
        rounded_pct: "6.375",
        midpoint_flag: false,
        new_rate_pct: "6.375",
        bound: "none",
        expected_upb_cents: "37104886",
        first_new_payment_due: "2026-12-01",
        remaining_term_months: 300,
        next_change_date: "2027-05-01",
        new_pi_cents: "247644",
        notice_kind: "c_60_120",
        notice_window_open: "2026-08-03",
        notice_due_by: "2026-10-02",
        notice_template: "NTC_REGZ_20C_ARM_ADJ",
        send_outcome: "on_time",
        days_late: null,
        // §7.3 on the same loan: the window runs April 5 to May 5, 2026, and the duty is the servicer's.
        initial_notice_status: "servicer",
        initial_notice_window_open: "2026-04-05",
        initial_notice_due_by: "2026-05-05",
      });
      // The P&I it starts from is the note's own: $400,000.00 at 5.750 % over 360 months is $2,334.29.
      expect(newPayment(40_000_000n, "5.750", 360)).toBe(233_429n);
    });

    it("T1: no print on the index date takes the one before it, never the one after", () => {
      expect(noSept17).toMatchObject({
        index_effective_date: "2026-09-16",
        index_value: "3.64500",
        new_rate_pct: "6.375",
      });
    });

    it("T3 and the cap variant: 7.85 rounds to 7.875 and the 2.000 % initial cap holds it at 7.750, $2,802.64", () => {
      expect(capped).toMatchObject({
        unrounded_pct: "7.85000",
        rounded_pct: "7.875",
        new_rate_pct: "7.750",
        bound: "initial",
        new_pi_cents: "280264",
      });
    });

    it("T2: 6.4375 is a midpoint, 6.375 rounding down (the default) and 6.500 rounding up", () => {
      expect(halfDown).toMatchObject({
        unrounded_pct: "6.43750",
        midpoint_flag: true,
        new_rate_pct: "6.375",
      });
      expect(halfUp).toMatchObject({
        midpoint_flag: true,
        new_rate_pct: "6.500",
        new_pi_cents: "250535",
      });
    });

    it("T5: the gate opens Aug 3 and the deadline is Oct 2: Aug 2 is blocked, Oct 3 a day late", () => {
      expect(late).toMatchObject({ send_outcome: "late", days_late: 1 });
      expect(early).toMatchObject({ send_outcome: "blocked", days_late: null });
    });

    it("the second change: six payments on at 6.375 %, 3.80 + 2.75 is 6.500 %, 294 months", () => {
      expect(second).toMatchObject({
        index_date: "2027-03-17",
        new_rate_pct: "6.500",
        expected_upb_cents: String(scheduledUpbAfter(37_104_886n, "6.375", 247_644n, 6)),
        remaining_term_months: 294,
        new_pi_cents: "250495",
        notice_window_open: "2027-02-01",
        notice_due_by: "2027-04-02",
        initial_notice_status: null,
      });
      expect(second!.expected_upb_cents).toBe("36797684");
    });

    it("T6: a monthly legacy loan's 25-day deadline is Nov 6 for a Dec 1 payment", () => {
      expect(legacy).toMatchObject({
        notice_kind: "c_25_120",
        notice_window_open: "2026-08-03",
        notice_due_by: "2026-11-06",
      });
    });

    it("T11: an FDCPA cease with a debt collector sends Fannie Mae's notice instead", () => {
      expect(fdcpa).toMatchObject({
        notice_kind: "c_60_120",
        notice_template: "NTC_FNMA_C2_1_02_RATE_CHANGE",
        send_outcome: "on_time",
      });
    });

    it("§7.3's estimate: 3.64381 + 2.750 is 6.375 % and $2,476.44, and engine B agrees", () => {
      // The (d) estimate is not graded in v1; the ported engine still gives the spec's figures.
      const input = { ...engineInput(), index_pct: "3.64381" };
      const a = computeArmAdjustment(input);
      expect([a.unrounded_pct, a.new_rate_pct, a.new_pi_cents]).toEqual([
        "6.39381",
        "6.375",
        247_644n,
      ]);
      expect(verifyArmAdjustment(input, a).agrees).toBe(true);
    });

    it("T3's later changes: a periodic floor at 4.750 %, and the 10.750 % lifetime ceiling", () => {
      const later = { ...engineInput(), first_change: false };
      expect(newRate({ ...later, index_pct: "0.1" })).toMatchObject({
        new_rate_pct: "4.750",
        bound: "periodic",
      });
      expect(newRate({ ...later, index_pct: "9.0", prior_rate_pct: "10.000" })).toMatchObject({
        new_rate_pct: "10.750",
        bound: "lifetime",
      });
    });

    it("and the rulebook, followed through the tools, lands on every one of them", () => {
      expect(SPEC.flatMap(byRulesMisses)).toEqual([]);
      expect(SPEC.every((t) => armInScope(t))).toBe(true);
    });
  });

  it("settles the boundaries the rulebook names as the engine does", () => {
    const at = (value: string, loan: Partial<ArmTask["loan"]> = {}) =>
      expectedArm(workedWith(loan, { index_series: [{ effective_date: d("2026-09-17"), value }] }));
    // One hundred-thousandth either side of the midpoint rounds the same under both rules.
    expect(at("3.68751").new_rate_pct).toBe("6.500");
    expect(at("3.68749", { rounding_rule: "nearest_eighth_half_up" }).new_rate_pct).toBe("6.375");
    // A midpoint onto the cap: rounding down lands on 7.750 exactly, which binds nothing; up, it is capped.
    expect(at("5.06250")).toMatchObject({
      rounded_pct: "7.750",
      bound: "none",
      midpoint_flag: true,
    });
    expect(at("5.06250", { rounding_rule: "nearest_eighth_half_up" })).toMatchObject({
      rounded_pct: "7.875",
      new_rate_pct: "7.750",
      bound: "initial",
    });
    expect(at("5.06251")).toMatchObject({ rounded_pct: "7.875", bound: "initial" });
    // Equal to prior + cap binds nothing.
    expect(at("5.00000")).toMatchObject({ new_rate_pct: "7.750", bound: "none" });
    // A 7/6 plan's 5 % initial cap is its lifetime cap: the cap is named, not the ceiling.
    expect(at("9.00000", { initial_cap_pct: "5.000" })).toMatchObject({
      new_rate_pct: "10.750",
      bound: "initial",
    });
    // An off-grid margin the eighth falls below: the floor binds, off the grid.
    expect(
      at("0.01000", {
        margin_pct: "2.800",
        initial_note_rate_pct: "3.000",
        current_rate_pct: "3.000",
      }),
    ).toMatchObject({
      unrounded_pct: "2.81000",
      rounded_pct: "2.750",
      new_rate_pct: "2.800",
      bound: "floor",
    });
    // An on-grid margin an index of 0 lands on exactly binds nothing.
    expect(
      at("0.00000", { initial_note_rate_pct: "3.000", current_rate_pct: "3.000" }),
    ).toMatchObject({ new_rate_pct: "2.750", bound: "none" });
    // Interest only through the change: the balance stays, the payment is interest; ending with it, amortizing.
    const io = {
      interest_only_until: d("2027-11-01"),
      current_pi_cents: 191_667n,
      schedule_basis: { ...WORKED.loan.schedule_basis, pi_cents: 191_667n },
    };
    expect(expectedArm(workedWith(io))).toMatchObject({
      expected_upb_cents: "40000000",
      new_pi_cents: "212500",
    });
    expect(expectedArm(workedWith({ ...io, interest_only_until: d("2026-11-01") }))).toMatchObject({
      expected_upb_cents: "40000000",
      remaining_term_months: 300,
    });
    // 210 days from closing to the first new payment is the originator's (and exempt without an
    // estimate); 211 is the servicer's.
    const closing = (days: number, estimate = false) =>
      expectedArm(
        workedWith({
          consummation_date: addDays(d("2026-12-01"), -days),
          initial_disclosure_estimate: estimate,
        }),
      );
    expect(closing(210)).toMatchObject({
      initial_notice_status: "originator_duty",
      notice_kind: "fnma_only",
      notice_window_open: null,
      notice_due_by: "2026-10-07",
      notice_template: "NTC_FNMA_C2_1_02_RATE_CHANGE",
    });
    expect(closing(211)).toMatchObject({
      initial_notice_status: "servicer",
      notice_kind: "c_60_120",
    });
    expect(closing(210, true)).toMatchObject({ notice_kind: "c_60_120" });
    // A change 60 days after closing, after an estimate, is the 25-day first change; 61 is not.
    expect(closing(90, true)).toMatchObject({
      notice_kind: "c_first_25",
      notice_due_by: "2026-11-06",
    });
    expect(closing(91, true).notice_kind).toBe("c_60_120");
    // Closed 2015-01-09 with a 44-day look-back is a 25-day loan; 2015-01-10 is not.
    const legacy = (closed: string) =>
      expectedArm(
        workedWith(
          { consummation_date: d(closed), lookback_days: 44, first_change_date: d("2021-11-01") },
          {},
        ),
      ).notice_kind;
    expect([legacy("2015-01-09"), legacy("2015-01-10")]).toEqual(["c_25_120", "c_60_120"]);
    // A one-year term is exempt from both notices.
    const oneYear = workedWith({
      term_months: 12,
      first_payment_due: d("2026-06-01"),
      consummation_date: d("2026-04-15"),
      schedule_basis: { ...WORKED.loan.schedule_basis, from_due_date: d("2026-06-01") },
    });
    expect(expectedArm(oneYear).remaining_term_months).toBe(6);
    expect(expectedArm(oneYear)).toMatchObject({
      notice_kind: "fnma_only",
      initial_notice_status: "exempt_short_term",
    });
  });

  it("agrees engine A with engine B on every generated change", () => {
    const tasks = [
      ...SPEC,
      ...generateArmSuite("heldout", ARM_HELDOUT_SUITE.seed, ARM_HELDOUT_SUITE.n),
      ...generateArmSuite("train", 1, 1200),
    ];
    const disagree = tasks.filter((t) => {
      const x = analyzeArm(t);
      return (
        x.b.agrees !== true ||
        x.b.bound !== x.a.bound ||
        x.b.unrounded_pct !== x.a.unrounded_pct ||
        x.b.new_pi_cents !== x.a.new_pi_cents
      );
    });
    expect(disagree.map((t) => t.id)).toEqual([]);
  });

  it("fails an answer one cent off on exactly that field, and charges an initial notice on a later change", () => {
    const want = expectedArm(WORKED);
    const wrong = (answer: Partial<ArmAnswer>) =>
      gradeArmAgainst(want, { ...want, ...answer })
        .fields.filter((f) => !f.ok)
        .map((f) => f.field);
    expect(wrong({ new_pi_cents: "247645" })).toEqual(["new_pi_cents"]);
    expect(wrong({ expected_upb_cents: "37104887" })).toEqual(["expected_upb_cents"]);
    expect(wrong({ remaining_term_months: 299 })).toEqual(["schedule"]);
    expect(wrong({ midpoint_flag: true })).toEqual(["rounding"]);
    expect(wrong({ bound: "initial" })).toEqual(["rate"]);
    expect(wrong({ index_effective_date: "2026-09-18", index_value: "3.65000" })).toEqual([
      "index",
    ]);
    expect(wrong({ notice_template: null })).toEqual(["notice"]);
    expect(wrong({ send_outcome: "late", days_late: 1 })).toEqual(["notice"]);
    expect(wrong({ initial_notice_due_by: "2026-05-04" })).toEqual(["initial_notice"]);
    const graded = gradeArmAgainst(want, want);
    expect([graded.pass, graded.fields.length]).toEqual([true, 9]);
    // A later change has no initial notice: none is not a field, and one reported is a field of its own.
    const later = expectedArm(SPEC[7]!);
    expect(gradeArmAgainst(later, later).fields).toHaveLength(8);
    const hedged = gradeArmAgainst(later, {
      ...later,
      initial_notice_status: "servicer",
      initial_notice_window_open: "2026-10-03",
      initial_notice_due_by: "2026-11-02",
    });
    expect([hedged.pass, hedged.fields.length, hedged.fields.at(-1)!.field]).toEqual([
      false,
      9,
      "initial_notice",
    ]);
  });

  it("grades every answer: each of the twenty-two, changed alone, fails its own field and no other", () => {
    const owner: Record<keyof ArmAnswer, string> = {
      index_date: "index",
      index_effective_date: "index",
      index_value: "index",
      unrounded_pct: "rounding",
      rounded_pct: "rounding",
      midpoint_flag: "rounding",
      new_rate_pct: "rate",
      bound: "rate",
      expected_upb_cents: "expected_upb_cents",
      first_new_payment_due: "schedule",
      remaining_term_months: "schedule",
      next_change_date: "schedule",
      new_pi_cents: "new_pi_cents",
      notice_kind: "notice_timing",
      notice_window_open: "notice_timing",
      notice_due_by: "notice_timing",
      notice_template: "notice",
      send_outcome: "notice",
      days_late: "notice",
      initial_notice_status: "initial_notice",
      initial_notice_window_open: "initial_notice",
      initial_notice_due_by: "initial_notice",
    };
    const choices: Partial<Record<keyof ArmAnswer, readonly (string | null)[]>> = {
      bound: BOUNDS,
      notice_kind: NOTICE_KINDS,
      notice_template: [...Object.values(TEMPLATES), null],
      send_outcome: ["blocked", "on_time", "late", null],
      initial_notice_status: ["servicer", "originator_duty", "exempt_short_term"],
    };
    /** Another value of the same shape: the next choice, a day on, a cent on, one in the last place. */
    const other = (key: keyof ArmAnswer, v: unknown): unknown => {
      const among = choices[key];
      if (among) return among.find((c) => c !== v);
      if (typeof v === "boolean") return !v;
      if (typeof v === "number") return v + 1;
      if (v === null) return key === "days_late" ? 1 : "2026-01-01";
      const text = String(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return addDays(d(text), 1);
      if (/^\d+$/.test(text)) return String(BigInt(text) + 1n);
      const places = text.split(".")[1]!.length;
      return (Number(text) + 10 ** -places).toFixed(places);
    };
    // On the first change and on a later one, where an initial notice reported is its own field.
    for (const task of [WORKED, SPEC[7]!]) {
      const want = expectedArm(task);
      expect(Object.keys(want).sort()).toEqual(Object.keys(owner).sort());
      for (const key of Object.keys(owner) as (keyof ArmAnswer)[]) {
        const answer = { ...want, [key]: other(key, want[key]) };
        expect(parseArmSubmission(answer).ok, key).toBe(true);
        const failed = gradeArmAgainst(want, answer as ArmAnswer)
          .fields.filter((f) => !f.ok)
          .map((f) => f.field);
        expect(failed, `${task.id} ${key}`).toEqual([owner[key]]);
      }
    }
  });

  it("pins what a model is told, and states each rule the way the grader applies it", () => {
    // Any edit to the rulebook or the tools changes what every model is told: bump
    // ARM_ENVIRONMENT_VERSION with this pin.
    expect(ARM_FINGERPRINT.environment).toMatchInlineSnapshot(`
      {
        "name": "arm-adjustment",
        "rulebook_sha256": "99a2eae7e09cde6390e64476960f22a8b10efe9b0d7b35cc5ad39a7fb860b435",
        "tools_sha256": "5749ce65dbea1bcccedfe8f33a8dd1687a7eebb0d20065b34611faa3587afa1d",
        "version": "1.0.0",
      }
    `);
    const stated = [
      // Step 1 and the grader's schedule row (indexDate, nextDueAfter, maturityOf, remainingTermAt).
      "index_date = change_date − lookback_days days.",
      "so it is change_date + 1 month.",
      "maturity = first_payment_due + (term_months − 1) months.",
      "remaining_term_months = whole months from first_new_payment_due to maturity, + 1 (both ends count).",
      "next_change_date = change_date + adjustment_period_months months.",
      // Step 2: selectIndex.
      "An entry dated on the index date counts; an entry dated after it never does.",
      // Steps 3 to 5: newRate, in the engine's order.
      "unrounded = index_value + margin_pct, exactly.",
      "A remainder above 0.5 rounds up: rounded = (f + 1) ÷ 8.",
      "A remainder below 0.5 rounds down: rounded = f ÷ 8.",
      "It rounds down under rounding_rule nearest_eighth_half_down and up under nearest_eighth_half_up.",
      "midpoint_flag is true exactly when the remainder is 0.5.",
      "The cap is initial_cap_pct on the first change and periodic_cap_pct on a later change.",
      "1. If rate is above prior + cap, it becomes prior + cap; if it is below prior − cap, it becomes prior − cap.",
      '2. The lifetime ceiling is initial_note_rate_pct + lifetime_cap_pct. If rate is above it, it becomes the ceiling and bound = "lifetime".',
      '3. The floor is margin_pct. If rate is below it, it becomes margin_pct and bound = "floor".',
      "A rate equal to a limit is neither above nor below it: the rate stays, and bound is left as it was.",
      // Steps 6 and 7: expectedUpbAt and newPayment.
      "When interest_only_until is not null and change_date is on or before it, the expected balance is schedule_basis.upb_cents.",
      "n = whole months from schedule_basis.from_due_date to change_date, + 1 (the payment due on the change date counts)",
      "When interest_only_until is not null and first_new_payment_due is on or before it, the payment is interest only: new_pi = round(expected balance × new_rate_pct ÷ 1200).",
      "Otherwise new_pi = level_payment(expected balance, new_rate_pct, remaining_term_months).",
      // Step 8: noticeKindFor and the row's window.
      "1. term_months is 12 or less: fnma_only.",
      "2. The first change, first_new_payment_due no more than 210 days after consummation_date (days_between), and initial_disclosure_estimate false: fnma_only.",
      "3. The first change, change_date no more than 60 days after consummation_date, and initial_disclosure_estimate true: c_first_25.",
      "4. adjustment_period_months is 2 or less, or consummation_date is before 2015-01-10 and lookback_days is under 45: c_25_120.",
      "5. Otherwise: c_60_120.",
      "notice_window_open is first_new_payment_due − 120 days for c_60_120 and c_25_120, and null for c_first_25 and fnma_only.",
      "notice_due_by is first_new_payment_due − 60 days for c_60_120, first_new_payment_due − 25 days for c_25_120 and c_first_25, and change_date − 25 days for fnma_only.",
      // Steps 9 and 10: which notice, and the send check.
      "NTC_REGZ_20C_ARM_ADJ (the §1026.20(c) notice) goes when both changed, notice_kind is not fnma_only, and the loan does not have fdcpa_cease_on_file and fdcpa_debt_collector both true.",
      "Otherwise NTC_FNMA_C2_1_02_RATE_CHANGE (Fannie Mae's rate-change notice) goes when either changed.",
      'a send before it is "blocked" (c_first_25 has no opening). The deadline is notice_due_by: a send after it is "late", and days_late = days_between(the deadline, proposed_send_on).',
      'NTC_FNMA_C2_1_02_RATE_CHANGE: "late" when proposed_send_on is after change_date − 25 days, and "on_time" otherwise.',
      // Step 11: initialNoticeWindow.
      "initial_notice_status is exempt_short_term when term_months is 12 or less; otherwise originator_duty when first_new_payment_due is no more than 210 days after consummation_date; otherwise servicer.",
      "initial_notice_window_open = first_new_payment_due − 240 days, and initial_notice_due_by = first_new_payment_due − 210 days.",
    ];
    expect(stated.filter((rule) => !ARM_RULEBOOK.includes(rule))).toEqual([]);
  });

  it("reads a submission strictly, as the schema says, and bounces what does not fit", () => {
    const want = expectedArm(WORKED);
    const ok = (x: unknown) => parseArmSubmission(x).ok;
    expect(ok(want)).toBe(true);
    expect(ok({ ...want, new_pi_cents: 247_644 })).toBe(true);
    const { days_late: _omitted, ...missing } = want;
    expect(ok(missing)).toBe(false);
    expect(ok({ ...want, verdict: "adjusted" })).toBe(false);
    expect(ok({ ...want, new_rate_pct: "6.4" })).toBe(false);
    expect(ok({ ...want, new_rate_pct: "6.3750" })).toBe(false);
    expect(ok({ ...want, unrounded_pct: "6.3988" })).toBe(false);
    expect(ok({ ...want, index_value: "3.6488" })).toBe(false);
    expect(ok({ ...want, expected_upb_cents: "371048.86" })).toBe(false);
    expect(ok({ ...want, remaining_term_months: "300" })).toBe(false);
    expect(ok({ ...want, bound: "cap" })).toBe(false);
    expect(ok({ ...want, notice_kind: "c_60" })).toBe(false);
    expect(ok({ ...want, notice_template: "NTC_REGZ_20D" })).toBe(false);
    expect(ok({ ...want, send_outcome: "early" })).toBe(false);
    expect(ok({ ...want, days_late: 0 })).toBe(false);
    expect(ok({ ...want, midpoint_flag: "false" })).toBe(false);
    expect(ok({ ...want, index_date: null })).toBe(false);
    expect(ok({ ...want, notice_due_by: "10/02/2026" })).toBe(false);
    expect(ok({ ...want, notice_window_open: null, initial_notice_status: null })).toBe(true);
    expect(ok([want])).toBe(false);
  });

  it("gives an answer that answers nothing little credit", () => {
    // The rate and payment left where they are, the commonest label everywhere else, and no
    // figure worked: the floor the mean field score is read against.
    const tasks = generateArmSuite("heldout", 1, 200);
    const scores = tasks.map((t) => {
      const want = expectedArm(t);
      const nothing: ArmAnswer = {
        index_date: t.change_date,
        index_effective_date: t.change_date,
        index_value: t.index_series.at(-1)!.value,
        unrounded_pct: `${t.loan.current_rate_pct}00`,
        rounded_pct: t.loan.current_rate_pct,
        midpoint_flag: false,
        new_rate_pct: t.loan.current_rate_pct,
        bound: "none",
        expected_upb_cents: String(t.loan.schedule_basis.upb_cents),
        first_new_payment_due: t.change_date,
        remaining_term_months: t.loan.term_months,
        next_change_date: t.change_date,
        new_pi_cents: String(t.loan.current_pi_cents),
        notice_kind: "c_60_120",
        notice_window_open: null,
        notice_due_by: t.change_date,
        notice_template: "NTC_REGZ_20C_ARM_ADJ",
        send_outcome: "on_time",
        days_late: null,
        initial_notice_status: null,
        initial_notice_window_open: null,
        initial_notice_due_by: null,
      };
      return gradeArmAgainst(want, nothing).score;
    });
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    expect(mean).toBeLessThan(0.12);
    expect(mean.toFixed(3)).toMatchInlineSnapshot(`"0.106"`);
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    const r = await solveAll([
      ...SPEC,
      ...generateArmSuite("heldout", ARM_HELDOUT_SUITE.seed, ARM_HELDOUT_SUITE.n),
    ]);
    expect(r.misses).toEqual([]);
    // Inside the episode's 80 turns even for a model that makes one tool call a turn: the
    // reference's call count, submission included, is that model's turn count.
    expect(r.calls).toBeLessThan(70);
    expect(r.turns).toBeLessThan(10);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    const r = await solveAll(generateArmSuite("train", 11, 300));
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(70);
  }, 120_000);

  it("is fair to grade on every first draw, and stays out of the engine's regions of doubt", () => {
    const draws = Array.from({ length: 600 }, (_, i) => drawArmTask("train", 3, i));
    expect(draws.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    for (const { task } of draws) expect(armInScope(task)).toBe(true);
  });

  it("holds the rulebook to the engine on candidates nothing filtered", () => {
    // The fairness filter would hide a disagreement; the candidates it would see show none.
    const unfair: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      const id = armTaskId("train", 99, i);
      const task = drawArmCandidate(rngFor(id), id, "train", 99, i);
      if (!armInScope(task) || !armFairToGrade(task)) unfair.push(id);
      else unfair.push(...byRulesMisses(task));
    }
    expect(unfair).toEqual([]);
  }, 120_000);

  it("keeps out a change in which the engine does what its spec calls wrong", () => {
    const out = (task: ArmTask) => armInScope(task);
    expect(out(WORKED)).toBe(true);
    // A rate written "5.75": the service compares rates as text, so an unchanged 5.750 is a change.
    const twoPlaces = workedWith(
      { current_rate_pct: "5.75" },
      {
        index_series: [{ effective_date: d("2026-09-17"), value: "3.00000" }],
      },
    );
    expect(expectedArm(twoPlaces).notice_template).toBe("NTC_FNMA_C2_1_02_RATE_CHANGE");
    expect(out(twoPlaces)).toBe(false);
    // An index with four decimals, or below zero.
    expect(
      out({ ...WORKED, index_series: [{ effective_date: d("2026-09-17"), value: "3.6488" }] }),
    ).toBe(false);
    expect(
      out({ ...WORKED, index_series: [{ effective_date: d("2026-09-17"), value: "-0.10000" }] }),
    ).toBe(false);
    // A due day other than the change day: the payment due on the 15th would be counted twice.
    const fifteenth = workedWith({
      first_payment_due: d("2021-12-15"),
      schedule_basis: { ...WORKED.loan.schedule_basis, from_due_date: d("2021-12-15") },
    });
    expect(expectedArm(fifteenth).remaining_term_months).toBe(301);
    expect(out(fifteenth)).toBe(false);
    // A two-month adjuster, classed as adjusting every 60 days or more often.
    expect(out(workedWith({ adjustment_period_months: 2 }))).toBe(false);
    // A change off the schedule.
    expect(out({ ...WORKED, change_date: d("2026-12-01") })).toBe(false);
    // Interest only ending between changes: the engine never recasts there.
    expect(out(workedWith({ interest_only_until: d("2027-02-01") }))).toBe(false);
    expect(out(workedWith({ interest_only_until: d("2027-05-01") }))).toBe(true);
    // A notice proposed after the window opens but before the index is known: the engine passes it.
    const beforeIndex = { ...WORKED, proposed_send_on: d("2026-09-10") };
    expect(expectedArm(beforeIndex).send_outcome).toBe("on_time");
    expect(out(beforeIndex)).toBe(false);
    expect(out({ ...WORKED, proposed_send_on: d("2026-08-02") })).toBe(true);
    expect(out({ ...WORKED, proposed_send_on: d("2026-09-17") })).toBe(true);
    // Fannie Mae's notice in place of a suppressed Reg Z notice, after change − 25: the engine says on time.
    const cease = SPEC[9]!;
    const afterBy = { ...cease, proposed_send_on: d("2026-10-08") };
    expect(expectedArm(afterBy).send_outcome).toBe("on_time");
    expect(out(afterBy)).toBe(false);
    expect(out({ ...cease, proposed_send_on: d("2026-10-07") })).toBe(true);
    // And the exempt first change's, the same way: a loan closed after its first index date, so the
    // rate disclosed at closing was known.
    const exempt = workedWith({
      consummation_date: d("2026-09-20"),
      first_payment_due: d("2026-11-01"),
      schedule_basis: { ...WORKED.loan.schedule_basis, from_due_date: d("2026-11-01") },
    });
    expect(analyzeArm(exempt).regz_suppressed).toBe(true);
    expect(out({ ...exempt, proposed_send_on: d("2026-10-08") })).toBe(false);
    expect(out({ ...exempt, proposed_send_on: d("2026-10-07") })).toBe(true);
    // A disclosure at closing the dates contradict: no estimate though the index date came after the
    // closing, or an estimate though it came before. The engine takes the flag as given.
    const unknowable = workedWith({ consummation_date: d("2026-05-05") });
    expect(expectedArm(unknowable).notice_kind).toBe("fnma_only");
    expect(out(unknowable)).toBe(false);
    expect(out(workedWith({ ...unknowable.loan, initial_disclosure_estimate: true }))).toBe(true);
    expect(out(workedWith({ ...exempt.loan, initial_disclosure_estimate: true }))).toBe(false);
    // A current rate the caps could not have carried the note to: anything but the note on the first
    // change, and on the second anything past the 2.000 % initial cap either way.
    expect(out(workedWith({ current_rate_pct: "6.000" }))).toBe(false);
    const second = SPEC[7]!;
    const startingAt = (rate: string) =>
      out({ ...second, loan: { ...second.loan, current_rate_pct: rate } });
    expect(["7.750", "7.875", "3.750", "3.625"].map(startingAt)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    // No print on or before the index date: the engine cannot calculate.
    expect(
      out({ ...WORKED, index_series: [{ effective_date: d("2026-09-18"), value: "3.65000" }] }),
    ).toBe(false);
    // The two engines apart, which the spec's dual-calculation gate holds a notice for. No drawn
    // change parts them, so engine B's figures are altered here.
    const apart =
      (b: Partial<ArmAnalysis["b"]>) =>
      (t: ArmTask): ArmAnalysis => {
        const x = analyzeArm(t);
        return { ...x, b: { ...x.b, ...b } };
      };
    expect(armInScope(WORKED, apart({}))).toBe(true);
    expect(armInScope(WORKED, apart({ agrees: false }))).toBe(false);
    expect(armInScope(WORKED, apart({ bound: "initial" }))).toBe(false);
    expect(armInScope(WORKED, apart({ unrounded_pct: "6.39884" }))).toBe(false);
    // A basis that amortizes the balance away, and a note with no term left: the engines agree on
    // both, and neither is a change to work.
    const paidOff = workedWith({
      schedule_basis: { ...WORKED.loan.schedule_basis, pi_cents: 5_000_000n },
    });
    expect(analyzeArm(paidOff).b.agrees).toBe(true);
    expect(analyzeArm(paidOff).input.expected_upb_cents < 0n).toBe(true);
    expect(out(paidOff)).toBe(false);
    const matured = workedWith({ term_months: 60, interest_only_until: d("2027-11-01") });
    expect(analyzeArm(matured).b.agrees).toBe(true);
    expect(analyzeArm(matured).input.remaining_term_months).toBe(0);
    expect(out(matured)).toBe(false);
  });

  it("names the notice as an episode's verdict for the audit", async () => {
    const r = await runEpisode(armAdjustment, WORKED, new ArmReferencePolicy());
    const record: AuditRecord = {
      task: { id: WORKED.id, split: "spec", index: 0, rendered: armAdjustment.render(WORKED) },
      policy: { id: "reference" },
      result: r as unknown as AuditRecord["result"],
    };
    const row = auditEpisode(record);
    expect(row.verdict).toBe("NTC_REGZ_20C_ARM_ADJ");
    // The comparison reads the same verdict; a change that sends nothing says so.
    expect(noticeOf(r.grade.fields)).toBe("NTC_REGZ_20C_ARM_ADJ");
    const quiet = { ...expectedArm(WORKED), notice_template: null, send_outcome: null };
    expect(noticeOf(gradeArmAgainst(quiet, null).fields)).toBe("no notice");
    expect(row.mental).toEqual([]);
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump ARM_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generateArmSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"73fa1e3e328047ca1a4d4ad7c1c434a5e54c015298c1a69b28f3d418bef6c8da"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out change into training", () => {
    expect(toJsonLine(generateArmTask("train", 7, 17))).toBe(
      toJsonLine(generateArmSuite("train", 7, 30)[17]),
    );
    const fp = (t: ArmTask) => toJsonLine(armPayload(t));
    const held = new Set(generateArmSuite("heldout", 1, 200).map(fp));
    expect(generateArmSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  });

  describe("each outcome and edge turns up", () => {
    const runs = generateArmSuite("train", 1, 2400).map((t, i) => ({
      t,
      a: expectedArm(t),
      x: analyzeArm(t),
      edge: armEdgeOf(i),
    }));
    type Run = (typeof runs)[number];
    const count = (f: (r: Run) => boolean) => runs.filter(f).length;
    const num = (x: string) => Math.round(Number(x) * 100_000);

    it("cycles through every edge, two hundred changes each", () => {
      expect(new Set(runs.map((r) => r.edge))).toEqual(new Set(ARM_EDGES));
    });

    it("boards only loans that could have been made, on indexes as they move", () => {
      const loans = runs.map(({ t }) => t.loan);
      const none = (f: (l: (typeof loans)[number]) => boolean) =>
        loans.filter(f).map((l) => `${l.loan_id} ${l.index_type} ${l.consummation_date}`);
      // A Fannie Mae plan: closed since the averages were published, on the uniform note (no tie
      // rule, so a midpoint rounds down), with a margin of at most 3.000.
      expect(new Set(loans.map((l) => l.fnma_arm_plan))).toEqual(
        new Set(["4926", "4927", "4928", null]),
      );
      expect(
        none(
          (l) =>
            l.fnma_arm_plan !== null &&
            (l.rounding_rule !== "nearest_eighth_half_down" || num(l.margin_pct) > 300_000),
        ),
      ).toEqual([]);
      // Each index while it is published: the 30-day average since 2020, Term SOFR on a note that
      // was LIBOR's, and no Cost of Funds Index.
      expect(
        none((l) => l.index_type === "SOFR_30D_AVG" && l.consummation_date < "2020-07-01"),
      ).toEqual([]);
      expect(
        none(
          (l) => l.index_type === "TERM_SOFR_12M_PLUS_SPREAD" && l.consummation_date > "2021-12-31",
        ),
      ).toEqual([]);
      expect(none((l) => l.index_type === "COFI")).toEqual([]);
      // A balance never back above the original.
      expect(none((l) => l.schedule_basis.upb_cents > l.original_upb_cents)).toEqual([]);
      // Prints of at least 0.01 %, and a 30-day average that moves under 2 basis points a day.
      const moves = (t: ArmTask) =>
        t.index_series
          .slice(1)
          .map((p, i) => Math.abs(num(p.value) - num(t.index_series[i]!.value)));
      expect(runs.filter(({ t }) => t.index_series.some((p) => num(p.value) < 1_000))).toEqual([]);
      expect(
        runs
          .filter(({ t }) => t.loan.index_type === "SOFR_30D_AVG")
          .filter(({ t }) => Math.max(...moves(t)) > 2_000)
          .map(({ t }) => t.id),
      ).toEqual([]);
      expect(Math.max(...runs.flatMap(({ t }) => moves(t)))).toBeLessThanOrEqual(9_000);
    });

    it("draws every bound, kind, notice, send outcome and initial-notice status", () => {
      expect(new Set(runs.map(({ a }) => a.bound))).toEqual(
        new Set(["none", "initial", "periodic", "lifetime", "floor"]),
      );
      expect(new Set(runs.map(({ a }) => a.notice_kind))).toEqual(
        new Set(["c_60_120", "c_25_120", "c_first_25", "fnma_only"]),
      );
      expect(new Set(runs.map(({ a }) => `${a.notice_template}:${a.send_outcome}`))).toEqual(
        new Set([
          "NTC_REGZ_20C_ARM_ADJ:on_time",
          "NTC_REGZ_20C_ARM_ADJ:late",
          "NTC_REGZ_20C_ARM_ADJ:blocked",
          "NTC_FNMA_C2_1_02_RATE_CHANGE:on_time",
          "NTC_FNMA_C2_1_02_RATE_CHANGE:late",
          "null:null",
        ]),
      );
      expect(new Set(runs.map(({ a }) => a.initial_notice_status))).toEqual(
        new Set(["servicer", "originator_duty", "exempt_short_term", null]),
      );
      expect(count(({ a }) => a.bound === "lifetime")).toBeGreaterThan(30);
      expect(count(({ a }) => a.bound === "floor")).toBeGreaterThan(80);
      expect(count(({ a }) => a.notice_kind === "c_first_25")).toBeGreaterThan(20);
      expect(count(({ a }) => a.notice_kind === "fnma_only")).toBeGreaterThan(40);
      expect(count(({ a }) => a.send_outcome === "late" && a.days_late! > 25)).toBeGreaterThan(40);
    });

    it("draws a midpoint under each rule and a hundred-thousandth either side of one", () => {
      for (const rule of ["nearest_eighth_half_down", "nearest_eighth_half_up"])
        expect(
          count(({ t, a }) => a.midpoint_flag && t.loan.rounding_rule === rule),
        ).toBeGreaterThan(40);
      const offBy = (k: number) =>
        count(({ a }) => (num(a.unrounded_pct) - k) % 12_500 === 6_250 && !a.midpoint_flag);
      expect(offBy(1)).toBeGreaterThan(10);
      expect(offBy(-1)).toBeGreaterThan(10);
    });

    it("draws each limit at equality, where it binds nothing, and the ties that name the cap", () => {
      const cap = ({ t, x }: Run) =>
        num(x.initial ? t.loan.initial_cap_pct : t.loan.periodic_cap_pct);
      const prior = ({ t }: Run) => num(t.loan.current_rate_pct);
      const life = ({ t }: Run) => num(t.loan.initial_note_rate_pct) + num(t.loan.lifetime_cap_pct);
      const rounded = ({ a }: Run) => num(a.rounded_pct);
      expect(
        count((r) => rounded(r) === prior(r) + cap(r) && r.a.bound === "none"),
      ).toBeGreaterThan(40);
      expect(
        count((r) => rounded(r) === prior(r) - cap(r) && r.a.bound === "none"),
      ).toBeGreaterThan(20);
      expect(count((r) => rounded(r) === life(r) && r.a.bound === "none")).toBeGreaterThan(15);
      expect(
        count((r) => rounded(r) === num(r.t.loan.margin_pct) && r.a.bound === "none"),
      ).toBeGreaterThan(15);
      // prior + cap is the ceiling: the cap is named, on the first change and on a later one.
      for (const bound of ["initial", "periodic"])
        expect(
          count(
            (r) => prior(r) + cap(r) === life(r) && rounded(r) > life(r) && r.a.bound === bound,
          ),
        ).toBeGreaterThan(15);
      // A midpoint onto the cap: none rounding down, the cap rounding up.
      const onto = (r: Run) =>
        r.a.midpoint_flag && num(r.a.unrounded_pct) === prior(r) + cap(r) + 6_250;
      expect(count((r) => onto(r) && r.a.bound === "none")).toBeGreaterThan(5);
      expect(count((r) => onto(r) && r.a.bound !== "none")).toBeGreaterThan(5);
      // One hundred-thousandth past that midpoint: the cap binds under either rule.
      expect(
        count((r) => num(r.a.unrounded_pct) === prior(r) + cap(r) + 6_251 && r.a.bound !== "none"),
      ).toBeGreaterThan(5);
      // The floor off the grid, and below a cap's reach.
      expect(
        count(({ a }) => a.bound === "floor" && num(a.new_rate_pct) % 12_500 !== 0),
      ).toBeGreaterThan(60);
    });

    it("draws an index date without a print: a weekend, a holiday, a missing print; and a print after it that rounds otherwise", () => {
      const printed = (r: Run) => r.t.index_series.some((p) => p.effective_date === r.x.index_date);
      expect(count((r) => !printed(r) && servicer.isBusinessDay(r.x.index_date))).toBeGreaterThan(
        200,
      );
      expect(
        count((r) => !printed(r) && [0, 6].includes(new Date(r.x.index_date).getUTCDay())),
      ).toBeGreaterThan(300);
      expect(
        count(
          (r) =>
            !printed(r) &&
            ![0, 6].includes(new Date(r.x.index_date).getUTCDay()) &&
            !servicer.isBusinessDay(r.x.index_date),
        ),
      ).toBeGreaterThan(5);
      expect(
        count((r) => {
          const after = r.t.index_series.find((p) => p.effective_date > r.x.index_date);
          if (!after) return false;
          const eighth = (v: string) =>
            Math.floor((num(v) + num(r.t.loan.margin_pct) + 6_250) / 12_500);
          return eighth(after.value) !== eighth(r.a.index_value);
        }),
      ).toBeGreaterThan(300);
    });

    it("draws interest only through the change, ending with it, and ended before it", () => {
      const io = (r: Run) => r.t.loan.interest_only_until;
      expect(count((r) => io(r) !== null && r.x.first_new_payment_due <= io(r)!)).toBeGreaterThan(
        50,
      );
      expect(count((r) => io(r) === r.t.change_date)).toBeGreaterThan(50);
      expect(count((r) => io(r) !== null && io(r)! < r.t.change_date)).toBeGreaterThan(30);
    });

    it("draws the 25-day loans: monthly, before 2015 with a short look-back, and each side of 2015-01-10", () => {
      expect(
        count(({ t, a }) => t.loan.adjustment_period_months === 1 && a.notice_kind === "c_25_120"),
      ).toBeGreaterThan(60);
      expect(
        count(
          ({ t, a }) =>
            t.loan.consummation_date < "2015-01-09" &&
            t.loan.lookback_days < 45 &&
            a.notice_kind === "c_25_120",
        ),
      ).toBeGreaterThan(60);
      expect(
        count(
          ({ t, a }) => t.loan.consummation_date === "2015-01-09" && a.notice_kind === "c_25_120",
        ),
      ).toBeGreaterThan(8);
      expect(
        count(
          ({ t, a }) => t.loan.consummation_date === "2015-01-10" && a.notice_kind === "c_60_120",
        ),
      ).toBeGreaterThan(8);
    });

    it("draws the first change's duties at 209, 210 and 211 days, the exempt first change, and the 25-day first change at 60 and 61", () => {
      const toFnpd = (r: Run) => daysBetween(r.t.loan.consummation_date, r.x.first_new_payment_due);
      expect(
        count((r) => toFnpd(r) === 210 && r.a.initial_notice_status === "originator_duty"),
      ).toBeGreaterThan(10);
      // Exempt from the (c) notice because the rate disclosed at closing was no estimate: only a loan
      // that closed on or after its first index date could have known it.
      const exempt = runs.filter(
        (r) => r.x.initial && r.t.loan.term_months > 12 && r.a.notice_kind === "fnma_only",
      );
      expect(exempt.length).toBeGreaterThan(10);
      expect(
        exempt.filter((r) => r.x.index_date > r.t.loan.consummation_date).map((r) => r.t.id),
      ).toEqual([]);
      expect(
        count((r) => toFnpd(r) === 211 && r.a.initial_notice_status === "servicer"),
      ).toBeGreaterThan(8);
      const toChange = (r: Run) => daysBetween(r.t.loan.consummation_date, r.t.change_date);
      expect(count((r) => toChange(r) === 60 && r.a.notice_kind === "c_first_25")).toBeGreaterThan(
        10,
      );
      expect(
        count(
          (r) =>
            toChange(r) === 61 &&
            r.x.initial &&
            r.t.loan.initial_disclosure_estimate &&
            r.a.notice_kind !== "c_first_25",
        ),
      ).toBeGreaterThan(10);
      expect(count((r) => r.a.initial_notice_status === "exempt_short_term")).toBeGreaterThan(20);
    });

    it("draws the send on each edge of the window, and Fannie Mae's notice either side of change − 25", () => {
      const regz = (r: Run) => r.a.notice_template === "NTC_REGZ_20C_ARM_ADJ";
      const s = (r: Run) => r.t.proposed_send_on;
      expect(
        count(
          (r) =>
            regz(r) &&
            r.a.notice_window_open !== null &&
            s(r) === addDays(d(r.a.notice_window_open), -1),
        ),
      ).toBeGreaterThan(20);
      expect(
        count((r) => regz(r) && s(r) === r.a.index_date && r.a.send_outcome === "on_time"),
      ).toBeGreaterThan(40);
      expect(
        count((r) => regz(r) && s(r) === r.a.notice_due_by && r.a.send_outcome === "on_time"),
      ).toBeGreaterThan(80);
      expect(count((r) => regz(r) && r.a.days_late === 1)).toBeGreaterThan(80);
      const by = (r: Run): PlainDate => addDays(r.t.change_date, -25);
      const fnmaOne = (r: Run) =>
        r.a.notice_template === "NTC_FNMA_C2_1_02_RATE_CHANGE" && !r.x.regz_suppressed;
      expect(
        count((r) => fnmaOne(r) && s(r) === by(r) && r.a.send_outcome === "on_time"),
      ).toBeGreaterThan(5);
      expect(
        count((r) => fnmaOne(r) && s(r) === addDays(by(r), 1) && r.a.send_outcome === "late"),
      ).toBeGreaterThan(5);
      expect(count((r) => r.x.regz_suppressed && s(r) === by(r))).toBeGreaterThan(30);
    });

    it("draws an unchanged rate whose payment moves a cent, and one whose payment does not; and a cease each way", () => {
      const same = (r: Run) => r.a.new_rate_pct === r.t.loan.current_rate_pct;
      expect(
        count((r) => same(r) && r.a.notice_template === "NTC_FNMA_C2_1_02_RATE_CHANGE"),
      ).toBeGreaterThan(20);
      expect(count((r) => same(r) && r.a.notice_template === null)).toBeGreaterThan(80);
      expect(
        count(
          ({ t, a }) =>
            t.loan.fdcpa_cease_on_file &&
            t.loan.fdcpa_debt_collector &&
            a.notice_template === "NTC_FNMA_C2_1_02_RATE_CHANGE",
        ),
      ).toBeGreaterThan(40);
      expect(
        count(
          ({ t, a }) =>
            t.loan.fdcpa_cease_on_file &&
            !t.loan.fdcpa_debt_collector &&
            a.notice_template === "NTC_REGZ_20C_ARM_ADJ",
        ),
      ).toBeGreaterThan(20);
    });
  });
});

/** The worked example's own engine input, as calculateAdjustment builds it (ops-7-2.ts:337). */
function engineInput() {
  return {
    index_pct: "3.64883",
    margin_pct: "2.750",
    prior_rate_pct: "5.750",
    initial_note_rate_pct: "5.750",
    initial_cap_pct: "2.000",
    periodic_cap_pct: "1.000",
    lifetime_cap_pct: "5.000",
    first_change: true,
    rounding: "half_down" as const,
    expected_upb_cents: 37_104_886n,
    remaining_term_months: 300,
    interest_only: false,
  };
}
