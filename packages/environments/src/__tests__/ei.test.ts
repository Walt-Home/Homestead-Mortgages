/**
 * ei-clocks: the grader is the servicing app's windows engine and no other
 * (the port is its file byte for byte but the imports), folded as §11.1's
 * and §11.2's state machines run it, and the rules it restates beside the
 * engine are held to the servicing app's own lines and to the spec's timer
 * registry; the rulebook a model is told is pinned, and its rules are held
 * to the grader's in order; it gives the spec's own cases, and the spec's
 * reading where the runtime departs from it (ei-1, ei-2, ei-3); every
 * generated loan can be read from the rulebook and the tools; the guard
 * keeps out each place the engine, the runtime or the spec is in doubt; and
 * each edge and outcome turns up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addDays, plainDate } from "@hm/kernel/calendar";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { solveNow } from "../refi/reference.js";
import { rngFor } from "../rng.js";
import {
  ASSIGN_DAYS,
  CADENCE_OPENS_DAY,
  EI_EDGES,
  EI_FINGERPRINT,
  EI_HELDOUT_SUITE,
  EI_RULEBOOK,
  EI_SPEC_CASES,
  BK_STATUSES,
  CONTINUITY_STATUSES,
  CYCLE_OUTCOMES,
  EiReferencePolicy,
  LIVE_STATUSES,
  NOTICE_STATUSES,
  OUTBOUND_EVERY_DAYS,
  OUTBOUND_START_DAYS,
  REGF_CAP,
  REGF_DAYS,
  REPEAT_STATUSES,
  drawEiCandidate,
  drawEiTask,
  eiArmOf,
  eiClocks,
  eiEdgeOf,
  eiInScope,
  eiPayload,
  eiScopeIssues,
  eiSpecTasks,
  eiSteps,
  eiTaskId,
  eiVerdictOf,
  executeEiTool,
  expectedEi,
  generateEiSuite,
  generateEiTask,
  gradeEiAgainst,
  parseEiSubmission,
  regfOf,
  type Contact,
  type EiAnswer,
  type EiTask,
} from "../ei/index.js";
import {
  BK_NOTICE_DAYS,
  CYCLE_DAYS,
  FDCPA_CYCLE_DAYS,
  LIVE_DAYS,
  NOTICE_DAYS,
  applyBankruptcyPetition,
  applyContact,
  applyFdcpaCease,
  cycleEndReview,
  installmentPaid,
  noticeCycle,
  openWindow,
} from "../ei/ported/windows.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const imports = (text: string) => text.split("\n").filter((l) => l.startsWith("import "));
const withoutImports = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith("import "))
    .join("\n");
/** Each import line with its module path removed: what it imports, and how. */
const importHeads = (text: string) => imports(text).map((l) => l.replace(/ from "[^"]+";$/, ""));
/** The one rewrite the port may carry: the kernel's calendar paths become the package's. */
const rewritten = (lines: readonly string[]) =>
  lines.map((l) =>
    l.replace(/"\.\.\/\.\.\/kernel\/calendar\/[a-z-]+\.ts"/g, '"@hm/kernel/calendar"'),
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
/** The line a citation names holds this text. */
const lineHas = (path: string, line: number, text: string) =>
  expect(servicing(path)[line - 1], `${path}:${line}`).toContain(text);

/** The fields where the rulebook, followed through the tools, lands somewhere other than the grader. */
const byRulesMisses = (task: EiTask): string[] => {
  let raw: unknown;
  try {
    raw = solveNow(eiSteps, JSON.parse(JSON.stringify(eiPayload(task))), executeEiTool);
  } catch (e) {
    return [`${task.id} threw ${e instanceof Error ? e.message : String(e)}`];
  }
  const parsed = parseEiSubmission(raw);
  if (!parsed.ok) return [`${task.id} ${parsed.error}`];
  return gradeEiAgainst(expectedEi(task), parsed.answer)
    .fields.filter((f) => !f.ok)
    .map((f) => `${task.id} ${f.field} ${f.expected}/${f.got}`);
};

const solveAll = async (tasks: readonly EiTask[]) => {
  const misses: string[] = [];
  let turns = 0;
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(eiClocks, task, new EiReferencePolicy());
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

const SPEC = eiSpecTasks();
const specTask = (prefix: string): EiTask => {
  const k = EI_SPEC_CASES.findIndex((c) => c.name.startsWith(prefix));
  if (k < 0) throw new Error(`no spec case ${prefix}`);
  return SPEC[k]!;
};
const D = plainDate;
const windowOf = (a: EiAnswer, due: string) => {
  const w = a.windows.find((x) => x.due_date === due);
  if (!w) throw new Error(`no window ${due}`);
  return w;
};
const unpaid = (...dues: string[]) => dues.map((x) => ({ due_date: D(x), credited_as_of: null }));
const ai = (on: string, outcome: Contact["outcome"] = "no_answer"): Contact => ({
  on: D(on),
  direction: "outbound",
  channel: "ai_voice",
  person: "borrower",
  outcome,
  callback_requested: false,
});
const inbound = (on: string): Contact => ({
  on: D(on),
  direction: "inbound",
  channel: "phone",
  person: "borrower",
  outcome: "conversation",
  callback_requested: false,
});
/** A loan by hand, as the spec's own cases are written. */
const loan = (over: Partial<EiTask>): EiTask => ({
  id: "ei-clocks/test",
  split: "spec",
  suite_seed: 0,
  index: 0,
  as_of: D("2026-12-05"),
  loan: { principal_residence: true, debt_collector: false },
  installments: [],
  contacts: [],
  notices: [],
  assignments: [],
  bankruptcy: null,
  fdcpa_cease_on: null,
  ...over,
});

describe("ei-clocks", () => {
  it("grades with the servicing app's windows engine: the port is its file but for the imports", () => {
    const original = servicing("domain/early-intervention/windows.ts").join("\n");
    const port = readFileSync(here("../ei/ported/windows.ts"), "utf8");
    expect(withoutImports(port)).toBe(withoutImports(original));
    expect(imports(port)).toEqual(rewritten(imports(original)));
    // The same names, imported the same way; and no sibling, so nothing else came along.
    expect(importHeads(port)).toEqual(importHeads(original));
    expect(imports(port)).toHaveLength(3);
    expect(imports(port).every((l) => l.includes('"@hm/kernel/calendar"'))).toBe(true);
  });

  it("holds the rules it restates beside the engine to the servicing app's own lines", () => {
    // A re-vendor that changes any of these fails here: revisit the grader, the rulebook and their citations.
    expect(
      serviceLines("domain/servicing-requests/continuity.ts", "export function assignmentDue(", 1),
    ).toMatchInlineSnapshot(`
      "continuity.ts:4-4
      export function assignmentDue(dueDateUnpaid: PlainDate, principalResidence: boolean): PlainDate | "not_required" { return principalResidence ? addDays(dueDateUnpaid, 45) : "not_required"; }"
    `);
    expect(
      serviceLines("domain/servicing-requests/ops.ts", "export function assignmentTrigger(", 5),
    ).toMatchInlineSnapshot(`
      "ops.ts:178-182
      export function assignmentTrigger(dueUnpaid: PlainDate, principalResidence: boolean, eiNoticeOn: PlainDate | null): { assign_by: PlainDate | "not_required"; basis: "day_45" | "ei_notice" | "not_required" } {
        const d = assignmentDue(dueUnpaid, principalResidence);
        if (d === "not_required") return { assign_by: d, basis: "not_required" };
        return eiNoticeOn && eiNoticeOn < d ? { assign_by: eiNoticeOn, basis: "ei_notice" } : { assign_by: d, basis: "day_45" };
      }"
    `);
    expect(serviceLines("domain/early-intervention/plan.ts", "export const FIRST_ATTEMPT_DAY", 2))
      .toMatchInlineSnapshot(`
      "plan.ts:16-17
      export const FIRST_ATTEMPT_DAY = 17;   // 11.1 rule 5 / 11.1-Q2 (policy; partner may set 16–25)
      export const CYCLE_DAYS = 7;           // D2-2-02 "continue every 7 days""
    `);
    expect(serviceLines("domain/early-intervention/plan.ts", "const shift = ", 1))
      .toMatchInlineSnapshot(`
      "plan.ts:64-64
      const shift = (d: PlainDate, cal: Calendar): PlainDate => { let x = d; while (!cal.isBusinessDay(x)) x = addDays(x, 1); return x; };"
    `);
    expect(serviceLines("domain/early-intervention/plan.ts", "p.attempts.push(row);", 1))
      .toMatchInlineSnapshot(`
      "plan.ts:95-95
        p.attempts.push(row); p.last_attempt_on = a.on; p.cycle_due_at = shift(addDays(a.on, CYCLE_DAYS), cal);"
    `);
    expect(
      serviceLines("domain/early-intervention/plan.ts", "export function delinquencyResolved(", 5),
    ).toMatchInlineSnapshot(`
      "plan.ts:151-155
      export function delinquencyResolved(p: ContactPlan, on: PlainDate, o: { cured?: boolean } = {}): PlanEvent[] {
        const events = p.status === "active" ? cease(p, "resolved", on) : [];
        if (o.cured) events.push(...close(p, "cured", on));
        return events;
      }"
    `);
    expect(serviceLines("domain/early-intervention/plan.ts", "export function applyPetition(", 3))
      .toMatchInlineSnapshot(`
      "plan.ts:179-181
      export function applyPetition(p: ContactPlan, on: PlainDate): PlanEvent[] { return suspend(p, "bankruptcy", on); }
      /** 11.4 rule 6 / 11.4-T7: written cease → \`suspended{cease_request}\`. */
      export function applyWrittenCease(p: ContactPlan, on: PlainDate): PlanEvent[] { return suspend(p, "cease_request", on); }"
    `);
    expect(serviceLines("domain/early-intervention/ops.ts", "const counts = ", 5))
      .toMatchInlineSnapshot(`
      "ops.ts:222-226
      const counts = (a: CallAttempt) => a.outcome !== "busy_or_failed" && !a.consent_callback;
      /** 11.1 rule 9 — counted calls to a person in the trailing 7 days as of \`at_ms\` (inclusive). */
      export function countedCalls(attempts: readonly CallAttempt[], person: string, atMs: number): number {
        return attempts.filter((a) => a.person === person && counts(a) && a.at_ms <= atMs && a.at_ms > atMs - 7 * DAY).length;
      }"
    `);
    expect(serviceLines("domain/early-intervention/ops.ts", "export function regfDialCheck(", 2))
      .toMatchInlineSnapshot(`
      "ops.ts:230-231
      export function regfDialCheck(attempts: readonly CallAttempt[], person: string, atMs: number, o: { callback_consent_at_ms?: number | null; cap?: number; cap_code?: string } = {}): { allowed: boolean; count_after: number; cap: number; refused_by: "REGF_1006_14_CALL_CAP_7IN7" | string | null; regf_exclusion: "consent_within_7d" | null } {
        const cap = o.cap ?? 7; const code = o.cap_code ?? "REGF_1006_14_CALL_CAP_7IN7";"
    `);
    expect(serviceLines("app/evaluator-kit.ts", "export const within = ", 1))
      .toMatchInlineSnapshot(`
      "evaluator-kit.ts:24-24
      export const within = (f: Facts, k: string, days: number, now: string): number => arr<string>(f, k).filter((t) => Date.parse(now) - Date.parse(t) < days * 86_400_000 && Date.parse(t) <= Date.parse(now)).length;"
    `);
    // The lines too long to hold whole are held by what the grader reads in them.
    lineHas(
      "app/tools/section11.ts",
      328,
      'regf_counted: direction === "outbound" && /voice/.test(str(i, "mode")) && outcome !== "busy_or_failed"',
    );
    lineHas(
      "app/evaluators.ts",
      256,
      '"11.1.callCap7in7": (f) => atMost(within(f, "counted_call_attempts_at", 7, s(f, "now")) + 1, 7',
    );
    lineHas(
      "kernel/timers/engine.ts",
      172,
      'inst.status = inst.status === "breached" ? "satisfied_late" : "satisfied";',
    );
    lineHas("domain/early-intervention/ops.ts", 76, "const w = openWindow(dueDate,");
    lineHas(
      "domain/early-intervention/ops.ts",
      79,
      'if (regxDays === 1 && o.first_delinquency !== false) events.push({ type: "loan.delinquency.started"',
    );
    lineHas(
      "domain/early-intervention/ops.ts",
      81,
      'anchor_on: dueDate, basis: "first_delinquency_in_case"',
    );
    lineHas("domain/early-intervention/plan.ts", 70, "export function openPlanIfDue(");
    lineHas("domain/early-intervention/plan.ts", 191, 'a.mode !== "letter"');
    lineHas("domain/early-intervention/plan.ts", 193, "end >= startDue");
    lineHas(
      "domain/early-intervention/plan.ts",
      98,
      'if (a.live_contact) events.push({ type: "contact.live.established"',
    );
    lineHas("domain/early-intervention/plan.ts", 105, 'basis: "borrower_initiated"');
    lineHas(
      "domain/early-intervention/windows.ts",
      71,
      'if (o.bankruptcy === "active") { applyBankruptcyPetition([w]',
    );
    lineHas(
      "domain/early-intervention/windows.ts",
      74,
      "o.active_cycle.cycle_end_at >= w.notice_due_at",
    );
    lineHas("domain/early-intervention/windows.ts", 126, 'o.fdcpa_cease ? "exempt_bk_cease"');
    // The constants the grader keeps are the lines' own.
    expect([
      ASSIGN_DAYS,
      CADENCE_OPENS_DAY,
      OUTBOUND_START_DAYS,
      OUTBOUND_EVERY_DAYS,
      REGF_CAP,
      REGF_DAYS,
    ]).toEqual([45, 17, 36, 7, 7, 7]);
  });

  it("holds every clock it grades to the spec's timer registry", () => {
    type Row = {
      code: string;
      process: string;
      trigger: string;
      anchor: string;
      offset: string;
      satisfied: string;
    };
    const rows = JSON.parse(
      readFileSync(here("../../../../apps/servicing/spec/registry/timers.json"), "utf8"),
    ) as Row[];
    const row = (code: string, process: string) => {
      const r = rows.find((x) => x.code === code && x.process === process);
      if (!r) throw new Error(`no ${code} in ${process}`);
      return r;
    };
    const plus = (offset: string) => Number(/\+(\d+)/.exec(offset)?.[1]);
    const live = row("REGX_1024_39A_LIVE_CONTACT_36", "11.1");
    expect([live.anchor, plus(live.offset)]).toEqual(["`due_date`", LIVE_DAYS]);
    expect(live.satisfied).toContain(
      "cancelled by installment paid ≤ due, bankruptcy, FDCPA cease, discharge",
    );
    const notice = row("REGX_1024_39B_WRITTEN_NOTICE_45", "11.2");
    expect([notice.anchor, plus(notice.offset)]).toEqual(["`due_date`", NOTICE_DAYS]);
    expect(notice.satisfied).toContain(
      "`satisfied_by_prior_180` when an active cycle exists; cancelled by installment paid ≤ due",
    );
    const repeat = row("REGX_1024_39B_NOTICE_180_REPEAT", "11.2");
    expect([repeat.anchor, plus(repeat.offset)]).toEqual(["`provided_at`", CYCLE_DAYS]);
    expect(repeat.offset).toContain(
      "≥ 45` → due at +180; **else** due 45 days after the earliest due date for which the borrower remains delinquent",
    );
    const fdcpa = row("REGX_1024_39D_FDCPA_NOTICE_190", "11.2");
    expect(fdcpa.offset).toContain(
      `due +${FDCPA_CYCLE_DAYS}; else due at the later of (45 days after the due date for which the borrower remains delinquent) and +${FDCPA_CYCLE_DAYS}`,
    );
    // The registry tests the delinquency at +180; the engine reviews the fdcpa cycle at its end, +190.
    expect(fdcpa.offset.startsWith("at +180: if ≥45 days delinquent")).toBe(true);
    const bk = row("REGX_1024_39C_BK_MODIFIED_NOTICE_45", "11.2");
    expect([bk.anchor, plus(bk.offset)]).toEqual([
      "petition date (or delinquency start)",
      BK_NOTICE_DAYS,
    ]);
    const assign = row("REGX_1024_40A1_CONTACT_ASSIGN_45", "4.3");
    expect(assign.offset).toContain("day 45 = day-1 date + 44 `calendar_days`");
    expect(1 + 44).toBe(ASSIGN_DAYS);
    const start = row("FNMA_D2202_OUTBOUND_START_36", "11.1");
    expect(start.offset).toBe(
      `day 36 = due_date + ${OUTBOUND_START_DAYS}, next open day if closed (A4-2.1-04)`,
    );
    const every = row("FNMA_D2202_OUTBOUND_EVERY_7", "11.1");
    expect(every.offset).toBe(`+${OUTBOUND_EVERY_DAYS} \`calendar_days\` (shift to next open day)`);
    expect(every.satisfied).toContain("cancelled by plan `ceased/suspended/closed`");
    const cap = row("REGF_1006_14_CALL_CAP_7IN7", "11.1");
    expect([cap.anchor, cap.offset]).toEqual([
      `trailing ${REGF_DAYS} days per person per debt`,
      `max ${REGF_CAP} counted calls`,
    ]);
    // And the grader's deadlines are those offsets from their anchors, on the spec's own loan.
    const a = expectedEi(specTask("11.2 rule 5"));
    for (const w of a.windows) {
      expect(w.live_due).toBe(addDays(D(w.due_date), LIVE_DAYS));
      expect(w.notice_due).toBe(addDays(D(w.due_date), NOTICE_DAYS));
    }
    expect(a.bk_notice?.due).toBe(addDays(D("2027-01-20"), BK_NOTICE_DAYS));
    expect(a.cycles[0]?.cycle_end).toBe(addDays(D("2026-12-14"), CYCLE_DAYS));
  });

  it("pins what a model is told, and states each rule the way the grader applies it", () => {
    // Any edit to the rulebook or the tools changes what every model is told: bump
    // EI_ENVIRONMENT_VERSION with this pin.
    expect(EI_FINGERPRINT.environment).toMatchInlineSnapshot(`
      {
        "name": "ei-clocks",
        "rulebook_sha256": "5b83f12afc2b923a88b541658bbd673c4c18932ba3a357fb979979c64d2c35c2",
        "tools_sha256": "df152b6424884c1cd68b358adedbb7fc94777986ff3cda2e8a1f4b9b49c65aa8",
        "version": "1.0.0",
      }
    `);
    // The sentences the reference follows and the grader computes, in the rulebook's order.
    const stated = [
      "A deadline passes at the end of its own day: on the deadline day the duty is still due, and it is missed only on a later day.",
      "An installment is unpaid on day t when its credited_as_of is null or after t.",
      "A live contact is a contact whose outcome is conversation, outbound or inbound, with either borrower.",
      "No day carries two of these: an installment credited, a live contact, a notice, the petition, the discharge, the cease.",
      "regx_days_delinquent: take E, the earliest due date on or before as_of of an installment unpaid on as_of; it is days_between(E, as_of).",
      "A window opens for each installment whose due date D is before as_of and which was unpaid on D + 1 (credited_as_of null or after D). It opens on D + 1, before anything else that day.",
      "the live-contact leg, due live_due = D + 36;",
      "the written-notice leg, due notice_due = D + 45.",
      "Neither deadline ever moves off a weekend or holiday.",
      "When loan.principal_residence is false, both legs are not_applicable, and never change.",
      "a discharge before: both legs exempt_discharge;",
      "else a petition before: the live leg is exempt_bk; the notice leg is exempt_bk_cease when a cease was received before the petition, and bk_modified_required otherwise;",
      "the notice leg is satisfied_by_prior_180 when the most recent notice provided before D + 1 has a cycle_end (Step 3) on or after notice_due, and open otherwise.",
      "Each day, first: every leg still open whose deadline is before today becomes breached.",
      "Installment D credited on day t: its own window's live leg, if still open, becomes cancelled_paid, and its notice leg, if still open, cancelled_paid.",
      "A live contact on day t: every live leg still open becomes satisfied_live. A window that opens after the contact is not touched by it.",
      "The petition on day t: every live leg still open becomes exempt_bk; every notice leg still open becomes exempt_bk_cease when a cease was received before, and bk_modified_required otherwise.",
      "A cease on day t: every live leg still open becomes exempt_fdcpa_cease. Notice legs do not change.",
      "(a) the notice for every notice leg that is breached (it becomes sent, and notice_late is true) or bk_modified_required (sent, notice_late false);",
      "(b) the notice for the oldest window whose notice leg is still open (sent, notice_late false);",
      "(c) and every other notice leg still open becomes satisfied_by_prior_180: it is inside the cycle this notice starts.",
      "live_late is true when the live leg is breached and a live contact came after its live_due: the duty was met late.",
      "Each notice starts a cycle: cycle_end = provided_on + 180, or provided_on + 190 when its variant is fdcpa.",
      "superseded when the next notice was provided before this one's cycle_end;",
      "else running when as_of is before cycle_end;",
      "days 45 or more: repeat_required, next_required_by = cycle_end.",
      "days under 45, with an E: not_required, next_required_by = E + 45 (for an fdcpa notice, the later of E + 45 and cycle_end), repeat null.",
      "exempt, with due null, when a cease was received before the petition;",
      "else, when the borrower was delinquent on petition_on (an installment due before petition_on was unpaid on petition_on): due = petition_on + 45;",
      "else due = D + 45 for the first window that opened after petition_on (and before any discharge): the first due date missed during the case.",
      "A delinquency starts on D + 1 for a window D when no installment older than D was unpaid on D",
      "It ends on the first later day t, on or before as_of, on which no installment due before t is unpaid on t; ended_on = t.",
      "Otherwise: when the first notice provided during the delinquency (on or after day_1, and before ended_on) came before D + 45, assign_by is that notice's provided_on and basis ei_notice; otherwise assign_by = D + 45 and basis day_45.",
      "status: not_due when the delinquency ended on or before assign_by.",
      "The cadence opens on D + 17. A petition, or a cease, suspends it for good",
      "Otherwise start_due = next_business_day(D + 36).",
      "after each attempt, X becomes next_business_day(attempt + 7).",
      "when the delinquency closed, X is missed too when close is after X, and next_due is null. When it runs on, X is missed when as_of is after X, and next_due is X.",
      "A counted call is an outbound ai_voice or human_voice contact whose outcome is not busy_or_failed and that was not callback_requested.",
      "counted_last_7: for each person, the counted calls dated after as_of − 7 (the seven days ending on as_of).",
      "over_cap: every counted call that is more than the 7th counted call to its person in the seven days ending on its own day",
    ];
    expect(stated.filter((rule) => !EI_RULEBOOK.includes(rule))).toEqual([]);
    const at = stated.map((rule) => EI_RULEBOOK.indexOf(rule));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  describe("gives the spec's own cases", () => {
    it("11.1 rule 3, T1 and T2: day 36 is 2026-12-07, day 45 2026-12-16; paid 12-10 cancels the notice and not the live leg; 10 days on 12-11", () => {
      const a = expectedEi(specTask("11.1 rule 3 / 11.1-T1"));
      expect(windowOf(a, "2026-11-01")).toMatchObject({
        live_due: "2026-12-07",
        live: "breached",
        notice_due: "2026-12-16",
        notice: "cancelled_paid",
      });
      expect(windowOf(a, "2026-12-01")).toMatchObject({
        live_due: "2027-01-06",
        notice_due: "2027-01-15",
      });
      expect(a.regx_days_delinquent).toBe(10);
      const early = expectedEi(specTask("11.1 rule 3: the same"));
      expect(windowOf(early, "2026-11-01")).toMatchObject({
        live: "cancelled_paid",
        notice: "cancelled_paid",
      });
    });

    it("11.1-T3: rolling 30 cancels every window, and no D2-2-02 deadline is missed", () => {
      const a = expectedEi(specTask("11.1-T3"));
      expect(a.windows).toHaveLength(4);
      for (const w of a.windows)
        expect([w.live, w.notice]).toEqual(["cancelled_paid", "cancelled_paid"]);
      // Each delinquency ends on the next due date, day 28 to 31, before day 36 and day 45.
      expect(a.episodes.map((e) => [e.day_1, e.ended_on])).toEqual([
        ["2027-01-02", "2027-02-01"],
        ["2027-02-02", "2027-03-01"],
        ["2027-03-02", "2027-04-01"],
        ["2027-04-02", "2027-05-01"],
      ]);
      for (const e of a.episodes) {
        expect(e.outbound?.missed).toEqual([]);
        expect(e.continuity.status).toBe("not_due");
      }
      expect(eiVerdictOf(a)).toBe("clear");
    });

    it("11.1-T4: the 2027-02-05 contact satisfies the Jan 1 and Feb 1 windows; Mar 1 open through 04-06, breached on 04-07", () => {
      const a = expectedEi(specTask("11.1-T4: a live"));
      expect(["2027-01-01", "2027-02-01", "2027-03-01"].map((d) => windowOf(a, d).live)).toEqual([
        "satisfied_live",
        "satisfied_live",
        "open",
      ]);
      expect(windowOf(a, "2027-03-01").live_due).toBe("2027-04-06");
      const b = expectedEi(specTask("11.1-T4: and"));
      expect(windowOf(b, "2027-03-01")).toMatchObject({ live: "breached", live_late: false });
    });

    it("11.2-T2: paid 2026-12-10 cancels the notice leg; paid 12-17, the notice must already have gone by 12-16", () => {
      expect(windowOf(expectedEi(SPEC[0]!), "2026-11-01").notice).toBe("cancelled_paid");
      const missed = expectedEi(specTask("11.2-T2: paid 2026-12-17 with no"));
      expect(windowOf(missed, "2026-11-01")).toMatchObject({
        notice: "breached",
        live: "breached",
      });
      const sent = expectedEi(specTask("11.2-T2: paid 2026-12-17 with the"));
      expect(windowOf(sent, "2026-11-01")).toMatchObject({ notice: "sent", notice_late: false });
    });

    it("11.2-T3: the 12-14 notice covers the Dec 1 window, satisfied_by_prior_180, its cycle to 2027-06-12", () => {
      const a = expectedEi(specTask("11.2-T3"));
      expect(windowOf(a, "2026-11-01").notice).toBe("sent");
      expect(windowOf(a, "2026-12-01")).toMatchObject({
        notice: "satisfied_by_prior_180",
        notice_due: "2027-01-15",
      });
      expect(a.cycles).toEqual([
        {
          provided_on: "2026-12-14",
          cycle_end: "2027-06-12",
          outcome: "running",
          next_required_by: null,
          repeat: null,
        },
      ]);
    });

    it("11.2 rule 3 and T4: 45 days or more on 2027-06-12, the repeat due that day; June 1 earliest unpaid, due 2027-07-16", () => {
      const at45 = expectedEi(specTask("11.2-T4: 45 days"));
      expect(at45.cycles[0]).toMatchObject({
        outcome: "repeat_required",
        next_required_by: "2027-06-12",
        repeat: "open",
      });
      // Rule 4: every window whose day 45 falls inside the cycle is covered; May 1's (06-15) is not.
      expect(at45.windows.map((w) => w.notice)).toEqual([
        "sent",
        ...Array(5).fill("satisfied_by_prior_180"),
        "open",
        "open",
      ]);
      const moved = expectedEi(specTask("11.2-T4: June 1"));
      expect(moved.cycles[0]).toMatchObject({
        outcome: "not_required",
        next_required_by: "2027-07-16",
        repeat: null,
      });
      expect(windowOf(moved, "2027-06-01")).toMatchObject({
        notice: "open",
        notice_due: "2027-07-16",
      });
    });

    it("11.2-T5: the fdcpa variant's cycle runs 190 days, the repeat due 2027-06-22", () => {
      const a = expectedEi(specTask("11.2-T5"));
      expect(a.cycles[0]).toMatchObject({
        cycle_end: "2027-06-22",
        outcome: "repeat_required",
        next_required_by: "2027-06-22",
      });
      // The cease ends the live-contact duty (§1024.39(d)(1)), the notice survives.
      expect(a.windows.every((w) => w.live === "exempt_fdcpa_cease")).toBe(true);
    });

    it("11.2 rule 5 and T6: the petition 2027-01-20 while delinquent, the bankruptcy notice due 2027-03-06, then one notice for every leg waiting", () => {
      const a = expectedEi(specTask("11.2 rule 5"));
      expect(a.bk_notice).toEqual({ due: "2027-03-06", status: "open" });
      expect(windowOf(a, "2027-01-01").live).toBe("exempt_bk");
      expect(["2027-02-01", "2027-03-01"].map((d) => windowOf(a, d).notice)).toEqual([
        "bk_modified_required",
        "bk_modified_required",
      ]);
      const sent = expectedEi(specTask("11.2-T6: the bankruptcy notice provided"));
      expect(sent.bk_notice).toEqual({ due: "2027-03-06", status: "sent" });
      expect(["2027-02-01", "2027-03-01"].map((d) => windowOf(sent, d))).toMatchObject([
        { notice: "sent", notice_late: false },
        { notice: "sent", notice_late: false },
      ]);
      // The bankruptcy notice starts a cycle of its own (rule 5: "the Mar 6 notice's 180-day cycle").
      expect(sent.cycles.map((c) => c.outcome)).toEqual(["superseded", "running"]);
    });

    it("11.1-T8 and 11.2-T7: after a Chapter 7 discharge, a new window is exempt on both legs", () => {
      const a = expectedEi(specTask("11.1-T8"));
      expect(windowOf(a, "2027-04-01")).toMatchObject({
        live: "exempt_bk",
        notice: "bk_modified_required",
      });
      expect(windowOf(a, "2027-05-01")).toMatchObject({
        live: "exempt_discharge",
        notice: "exempt_discharge",
      });
    });

    it("11.1-T15: the deadline after Thursday 2026-11-19 is Friday 11-27, Thanksgiving closed", () => {
      const a = expectedEi(specTask("11.1-T15"));
      expect(a.episodes[0]?.outbound).toEqual({
        start_due: "2026-11-06",
        missed: [],
        next_due: "2026-11-27",
      });
    });

    it("4.3-T1 and T2: assigned by day 45, 2026-10-16, or by the notice when it comes first", () => {
      expect(expectedEi(specTask("4.3-T1")).episodes[0]?.continuity).toEqual({
        assign_by: "2026-10-09",
        basis: "ei_notice",
        status: "met",
      });
      expect(expectedEi(specTask("4.3-T2")).episodes[0]?.continuity).toEqual({
        assign_by: "2026-10-16",
        basis: "day_45",
        status: "met",
      });
    });

    it("11.1 rule 10 and T13: B's counts run 1, 2, 2, 2, 3, 4 and C's 1; the 12-15 callback is not counted", () => {
      const t = specTask("11.1 rule 10");
      // The count after each call, read as the cap reads it on that call's day.
      const running = [
        "2026-12-07",
        "2026-12-08",
        "2026-12-09",
        "2026-12-09",
        "2026-12-10",
        "2026-12-11",
      ].map((day, k) => {
        const upTo = { ...t, as_of: D(day), contacts: t.contacts.slice(0, k + 1) };
        return regfOf(upTo)!.counted_last_7;
      });
      expect(running.map((c) => c.borrower)).toEqual([1, 2, 2, 2, 3, 4]);
      expect(running[3]!.co_borrower).toBe(1);
      expect(regfOf(t)).toEqual({ counted_last_7: { borrower: 2, co_borrower: 1 }, over_cap: [] });
      expect(
        regfOf({ ...t, contacts: t.contacts.map((c) => ({ ...c, callback_requested: false })) })!
          .counted_last_7.borrower,
      ).toBe(3);
    });

    it("11.1-T22 and 11.2-T13: an investment property has no Reg X window, and the D2-2-02 cadence runs", () => {
      const a = expectedEi(specTask("11.1-T22"));
      expect(
        a.windows.every((w) => w.live === "not_applicable" && w.notice === "not_applicable"),
      ).toBe(true);
      expect(a.episodes[0]?.continuity.status).toBe("not_required");
      expect(a.episodes[0]?.outbound?.start_due).toBe("2026-10-07");
    });

    it("and every spec case is in scope, fair to grade, and solved through the tools", () => {
      for (const t of SPEC) {
        expect(eiScopeIssues(t), t.id).toEqual([]);
        expect(byRulesMisses(t), t.id).toEqual([]);
      }
      expect(new Set(EI_SPEC_CASES.map((c) => c.name)).size).toBe(EI_SPEC_CASES.length);
    });
  });

  describe("grades the spec's reading where the servicing app's runtime departs from it", () => {
    // 35.5's AZ tape, next due 2026-10-01, as docs/servicing-engine-defects.md reproduces each.
    const az = (over: Partial<EiTask>) =>
      loan({ installments: unpaid("2026-10-01", "2026-11-01"), as_of: D("2026-11-20"), ...over });

    it("ei-1: the installment paid on day 14 cancels both clocks, which the hosted runtime leaves armed to breach", () => {
      const a = expectedEi(
        az({
          installments: [
            { due_date: D("2026-10-01"), credited_as_of: D("2026-10-15") },
            ...unpaid("2026-11-01"),
          ],
        }),
      );
      expect(windowOf(a, "2026-10-01")).toMatchObject({
        live: "cancelled_paid",
        notice: "cancelled_paid",
      });
    });

    it("ei-2: a late payment leaves a breached leg breached, and one contact satisfies only the windows containing its day", () => {
      // Loan A pays 10-01 on 11-22, day 52, after both deadlines: breached and breached, not cancelled_paid.
      const a = expectedEi(
        az({
          as_of: D("2026-11-25"),
          installments: [
            { due_date: D("2026-10-01"), credited_as_of: D("2026-11-22") },
            ...unpaid("2026-11-01"),
          ],
        }),
      );
      expect(windowOf(a, "2026-10-01")).toMatchObject({ live: "breached", notice: "breached" });
      // Loan B logs one inbound live call on 11-24: window 10-01 was due 11-06 and stays breached (met late);
      // 11-01 is satisfied; 12-01, which opens after the call, owes its own.
      const b = expectedEi(
        az({
          as_of: D("2026-12-05"),
          installments: unpaid("2026-10-01", "2026-11-01", "2026-12-01"),
          contacts: [inbound("2026-11-24")],
        }),
      );
      expect(windowOf(b, "2026-10-01")).toMatchObject({ live: "breached", live_late: true });
      expect(windowOf(b, "2026-11-01").live).toBe("satisfied_live");
      expect(windowOf(b, "2026-12-01").live).toBe("open");
      // The engine's own applyContact has the date test the runtime's projection lacks.
      const ws = [openWindow(D("2026-10-01"), { principal_residence: true })];
      expect(applyContact(ws, D("2026-11-24"), "live")).toEqual([]);
    });

    it("ei-3: a window that opens inside a notice's cycle is covered, where the hosted counter opens it to breach", () => {
      const a = expectedEi(
        az({
          as_of: D("2026-12-20"),
          installments: unpaid("2026-10-01", "2026-11-01", "2026-12-01"),
          notices: [{ provided_on: D("2026-10-30"), variant: "standard" }],
        }),
      );
      expect(a.windows.map((w) => w.notice)).toEqual([
        "sent",
        "satisfied_by_prior_180",
        "satisfied_by_prior_180",
      ]);
      expect(openWindow(D("2026-11-01"), { principal_residence: true }).notice).toBe("open");
      expect(
        openWindow(D("2026-11-01"), {
          principal_residence: true,
          active_cycle: noticeCycle(D("2026-10-30"), "standard", "cycle-B"),
        }).notice,
      ).toBe("satisfied_by_prior_180");
    });
  });

  it("fails an answer one day off on exactly that field, and charges for what is answered that is not there", () => {
    const t = specTask("11.2-T3");
    const want = expectedEi(t);
    expect(gradeEiAgainst(want, want).pass).toBe(true);
    const off = (a: EiAnswer): EiAnswer => ({
      ...a,
      windows: a.windows.map((w, k) =>
        k === 1 ? { ...w, live_due: addDays(D(w.live_due), 1) } : w,
      ),
    });
    const g = gradeEiAgainst(want, off(want));
    expect(g.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual(["window 2026-12-01 live"]);
    // A window that is not there costs the list and a field of its own; so does a cycle or a delinquency.
    const extra = gradeEiAgainst(want, {
      ...want,
      windows: [...want.windows, { ...want.windows[1]!, due_date: "2027-01-01" }],
      cycles: [...want.cycles, { ...want.cycles[0]!, provided_on: "2026-12-20" }],
      episodes: [...want.episodes, { ...want.episodes[0]!, day_1: "2026-12-02" }],
    });
    expect(extra.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual([
      "windows",
      "window 2027-01-01",
      "cycle 2026-12-20",
      "episodes",
      "episode 2026-12-02",
    ]);
    // A section the loan does not have is not a field; answering one is.
    expect(want.regf).toBeNull();
    const regf = gradeEiAgainst(want, {
      ...want,
      regf: { counted_last_7: { borrower: 0, co_borrower: 0 }, over_cap: [] },
    });
    expect(regf.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual(["regf"]);
    expect(gradeEiAgainst(want, null).pass).toBe(false);
  });

  it("reads a submission strictly, as the schema says, and bounces what does not fit", () => {
    const want = expectedEi(specTask("11.2-T3"));
    const json = JSON.parse(JSON.stringify(want)) as Record<string, unknown>;
    expect(parseEiSubmission(json)).toEqual({ ok: true, answer: want });
    type Node = Record<string | number, unknown>;
    /** The object at a path inside the submission, to change one thing in it. */
    const dig = (j: unknown, ...path: readonly (string | number)[]): Node =>
      path.reduce<unknown>((o, k) => (o as Node)[k], j) as Node;
    const bounce = (mutate: (j: Node) => void, says: RegExp) => {
      const j = JSON.parse(JSON.stringify(want)) as Node;
      mutate(j);
      const p = parseEiSubmission(j);
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.error).toMatch(says);
    };
    bounce(
      (j) => (dig(j, "windows", 1).live_late = true),
      /live_late is true only on a breached live leg/,
    );
    bounce((j) => (dig(j, "windows", 1).notice_late = true), /notice_late is true only/);
    bounce((j) => (dig(j, "cycles", 0).repeat = "open"), /repeat is given when, and only when/);
    bounce((j) => (dig(j, "cycles", 0).next_required_by = "2027-06-12"), /never reviewed/);
    bounce((j) => (j.bk_notice = { due: null, status: "sent" }), /bk_notice.due is null exactly/);
    bounce(
      (j) => (dig(j, "episodes", 0, "continuity").basis = null),
      /continuity has assign_by and basis/,
    );
    bounce((j) => (j.windows as unknown[]).push(dig(j, "windows", 0)), /windows lists one twice/);
    bounce((j) => (dig(j, "windows", 0).live = "satisfied_good_faith"), /live must be one of/);
    bounce((j) => (j.extra = 1), /which the schema does not name/);
    bounce((j) => delete j.regf, /needs regf/);
    bounce(
      (j) => (dig(j, "episodes", 0, "outbound").missed = ["2026-12-01", "2026-12-01"]),
      /missed lists one twice/,
    );
    // Order carries nothing: a list is put in its order, not graded on it.
    const shuffled = JSON.parse(JSON.stringify(want)) as Node;
    (shuffled.windows as unknown[]).reverse();
    expect(parseEiSubmission(shuffled)).toEqual({ ok: true, answer: want });
  });

  describe("scores an answer that works out nothing for what it did", () => {
    const suite = generateEiSuite(
      EI_HELDOUT_SUITE.split,
      EI_HELDOUT_SUITE.seed,
      EI_HELDOUT_SUITE.n,
    );
    const scored = (answer: (t: EiTask, want: EiAnswer) => EiAnswer) => {
      let passed = 0;
      let sum = 0;
      for (const t of suite) {
        const want = expectedEi(t);
        const g = gradeEiAgainst(want, answer(t, want));
        if (g.pass) passed++;
        sum += g.score;
      }
      return { passed, mean: sum / suite.length };
    };
    it("an answer that answers nothing scores about a hundredth and never passes", () => {
      const s = scored(() => ({
        regx_days_delinquent: 0,
        windows: [],
        cycles: [],
        bk_notice: null,
        episodes: [],
        regf: null,
      }));
      expect(s.passed).toBe(0);
      expect(s.mean).toBeLessThan(0.05);
    });
    it("every deadline right and every status read off the date alone: about 0.58, passing under a tenth", () => {
      // The deadlines are date arithmetic, and so are the delinquencies, the cycles and the counts,
      // here taken from the grader; the statuses are what the events decide. This is the floor the
      // mean field score is read against. Its passes are loans where nothing happened in time.
      const s = scored((t, want) => ({
        ...want,
        windows: want.windows.map((w) => {
          const by = (due: string) => (t.as_of > due ? "breached" : "open") as "breached" | "open";
          return {
            ...w,
            live: t.loan.principal_residence ? by(w.live_due) : "not_applicable",
            live_late: false,
            notice: t.loan.principal_residence ? by(w.notice_due) : "not_applicable",
            notice_late: false,
          };
        }),
        episodes: want.episodes.map((e) => ({
          ...e,
          continuity: e.continuity.assign_by
            ? { ...e.continuity, status: t.as_of > e.continuity.assign_by ? "breached" : "open" }
            : e.continuity,
          outbound: e.outbound ? { ...e.outbound, missed: [] } : null,
        })),
        regf: want.regf ? { ...want.regf, over_cap: [] } : null,
      }));
      expect(s.passed).toBeLessThan(EI_HELDOUT_SUITE.n * 0.1);
      expect(s.mean).toBeGreaterThan(0.5);
      expect(s.mean).toBeLessThan(0.65);
    });
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    // The generator keeps a draw only once the reference solves it, so a pass on a suite it built
    // would prove nothing by itself if anything had been redrawn. Every held-out loan is its
    // index's first draw.
    const drawn = Array.from({ length: EI_HELDOUT_SUITE.n }, (_, i) =>
      drawEiTask(EI_HELDOUT_SUITE.split, EI_HELDOUT_SUITE.seed, i),
    );
    expect(drawn.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    const r = await solveAll([...SPEC, ...drawn.map((x) => x.task)]);
    expect(r.misses).toEqual([]);
    // Inside the episode's 80 turns even for a model that makes one tool call a turn: the
    // reference's call count, submission included, is that model's turn count.
    expect(r.calls).toBeLessThan(60);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    const r = await solveAll(generateEiSuite("train", 11, 300));
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(60);
  }, 120_000);

  it("is fair to grade on every first draw, and in scope", () => {
    const draws = Array.from({ length: 600 }, (_, i) => drawEiTask("train", 3, i));
    expect(draws.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    for (const { task } of draws) expect(eiInScope(task)).toBe(true);
  });

  it("holds the reference, the rulebook as code, to the grader on candidates nothing filtered", () => {
    const unfair: string[] = [];
    for (let i = 0; i < 2_000; i++) {
      const id = eiTaskId("train", 99, i);
      const task = drawEiCandidate(rngFor(id), id, "train", 99, i);
      const issues = eiScopeIssues(task);
      if (issues.length) unfair.push(`${id} out of scope: ${issues.join("; ")}`);
      else unfair.push(...byRulesMisses(task));
    }
    expect(unfair).toEqual([]);
  }, 120_000);

  describe("keeps out each place the engine, the runtime or the spec is in doubt, and reproduces each", () => {
    const base = loan({
      as_of: D("2026-12-20"),
      installments: unpaid("2026-10-01", "2026-11-01", "2026-12-01"),
      contacts: [
        ai("2026-10-18"),
        ai("2026-10-24"),
        ai("2026-10-30", "conversation"),
        ai("2026-11-05"),
      ],
    });
    const flags = (t: EiTask, says: RegExp) =>
      expect(
        eiScopeIssues(t).some((x) => says.test(x)),
        eiScopeIssues(t).join("; ") || "in scope",
      ).toBe(true);

    it("the base loan is in scope, and fair", () => {
      expect(eiScopeIssues(base)).toEqual([]);
      expect(byRulesMisses(base)).toEqual([]);
    });

    it("a credit the day after its due date: the counter opens a delinquency the day's end never shows", () => {
      const t = {
        ...base,
        installments: [
          { due_date: D("2026-10-01"), credited_as_of: D("2026-10-02") },
          ...unpaid("2026-11-01", "2026-12-01"),
        ],
      };
      flags(t, /credited the day after it fell due/);
      expect(expectedEi(t).windows[0]).toMatchObject({
        due_date: "2026-10-01",
        live: "cancelled_paid",
      });
      expect(expectedEi(t).episodes[0]?.day_1).toBe("2026-11-02");
    });

    it("two events on one day, whose order the answer would turn on", () => {
      // Credited and called on day 20: cancelled_paid one way, satisfied_live the other.
      const one = [openWindow(D("2026-10-01"), { principal_residence: true })];
      installmentPaid(one[0]!, D("2026-10-21"));
      applyContact(one, D("2026-10-21"), "live");
      const other = [openWindow(D("2026-10-01"), { principal_residence: true })];
      applyContact(other, D("2026-10-21"), "live");
      installmentPaid(other[0]!, D("2026-10-21"));
      expect([one[0]!.live, other[0]!.live]).toEqual(["cancelled_paid", "satisfied_live"]);
      flags(
        {
          ...base,
          installments: [
            { due_date: D("2026-10-01"), credited_as_of: D("2026-10-30") },
            ...unpaid("2026-11-01", "2026-12-01"),
          ],
        },
        /carries credit and live/,
      );
    });

    it("a cease after the petition: the engine leaves the leg waiting on the bankruptcy notice, where (c)(1)(ii) exempts it", () => {
      const ws = [openWindow(D("2026-11-01"), { principal_residence: true })];
      applyBankruptcyPetition(ws, { options_available: true });
      applyFdcpaCease(ws, { options_available: true });
      expect(ws[0]!.notice).toBe("bk_modified_required");
      flags(
        {
          ...base,
          loan: { principal_residence: true, debt_collector: true },
          contacts: [ai("2026-10-18")],
          bankruptcy: { petition_on: D("2026-10-20"), discharged_on: null },
          fdcpa_cease_on: D("2026-10-25"),
        },
        /cease on or after the petition/,
      );
    });

    it("a window in the case after its one notice: the engine opens it waiting on the notice again", () => {
      expect(
        openWindow(D("2026-12-01"), { principal_residence: true, bankruptcy: "active" }).notice,
      ).toBe("bk_modified_required");
      flags(
        {
          ...base,
          contacts: [ai("2026-10-18")],
          bankruptcy: { petition_on: D("2026-10-20"), discharged_on: null },
          notices: [{ provided_on: D("2026-11-20"), variant: "bk" }],
        },
        /a window opens in the case after its notice/,
      );
    });

    it("a window inside a cycle after a cure: 11.2's state machine closes the cycle, §1024.39(b)(1) does not", () => {
      flags(
        loan({
          as_of: D("2027-01-20"),
          installments: [
            { due_date: D("2026-10-01"), credited_as_of: D("2026-11-28") },
            { due_date: D("2026-11-01"), credited_as_of: D("2026-11-28") },
            ...unpaid("2026-12-01", "2027-01-01"),
          ],
          notices: [{ provided_on: D("2026-11-10"), variant: "standard" }],
        }),
        /inside the 2026-11-10 cycle after a cure/,
      );
    });

    it("an fdcpa cycle that day 180 and day 190 review differently: §1024.39(d)(3)(iii) tests at 180, cycleEndReview at its end", () => {
      const c = noticeCycle(D("2026-12-14"), "fdcpa", "c");
      expect(
        cycleEndReview(c, {
          today: D("2027-06-12"),
          regx_days_delinquent: 60,
          earliest_unpaid_due: D("2027-04-01"),
        }).reviewed,
      ).toBe(false);
      // Caught up on day 185 to within 45 days: repeat_required on day 180, not on day 190.
      const dues = [
        "2026-11-01",
        "2026-12-01",
        "2027-01-01",
        "2027-02-01",
        "2027-03-01",
        "2027-04-01",
        "2027-05-01",
        "2027-06-01",
      ];
      flags(
        loan({
          as_of: D("2027-06-25"),
          loan: { principal_residence: true, debt_collector: true },
          installments: dues.map((d) => ({
            due_date: D(d),
            credited_as_of: d < "2027-06-01" ? D("2027-06-17") : null,
          })),
          contacts: [ai("2026-11-18")],
          notices: [{ provided_on: D("2026-12-14"), variant: "fdcpa" }],
          fdcpa_cease_on: D("2026-11-25"),
        }),
        /day 180 and day 190 review differently/,
      );
    });

    it("a cycle reviewed after a petition, a cease inside a standard cycle, a credit on a review day", () => {
      const long = (over: Partial<EiTask>) =>
        loan({
          as_of: D("2027-06-20"),
          installments: unpaid(
            "2026-11-01",
            "2026-12-01",
            "2027-01-01",
            "2027-02-01",
            "2027-03-01",
            "2027-04-01",
            "2027-05-01",
            "2027-06-01",
          ),
          notices: [{ provided_on: D("2026-12-14"), variant: "standard" }],
          ...over,
        });
      expect(eiScopeIssues(long({}))).toEqual([]);
      flags(
        long({ bankruptcy: { petition_on: D("2027-05-20"), discharged_on: null } }),
        /a cycle reviewed after a petition/,
      );
      flags(
        long({
          loan: { principal_residence: true, debt_collector: true },
          fdcpa_cease_on: D("2027-01-20"),
        }),
        /a cease inside a running standard cycle/,
      );
      flags(
        long({
          installments: [
            { due_date: D("2026-11-01"), credited_as_of: D("2027-06-12") },
            ...unpaid(
              "2026-12-01",
              "2027-01-01",
              "2027-02-01",
              "2027-03-01",
              "2027-04-01",
              "2027-05-01",
              "2027-06-01",
            ),
          ],
        }),
        /credited on a review day/,
      );
    });

    it("a delinquency closed on its start deadline with no attempt, where the timer row and fnmaCadenceBreaches's end >= startDue part", () => {
      flags(
        loan({
          as_of: D("2026-11-20"),
          installments: [
            { due_date: D("2026-10-01"), credited_as_of: D("2026-11-06") },
            { due_date: D("2026-11-01"), credited_as_of: D("2026-11-06") },
          ],
        }),
        /closed on its start deadline/,
      );
    });

    it("a counted call in the seven days after a conversation, on a debt collector's loan (Reg F's cooling-off, not graded)", () => {
      flags(
        {
          ...base,
          loan: { principal_residence: true, debt_collector: true },
          contacts: [ai("2026-10-18"), ai("2026-10-24", "conversation"), ai("2026-10-27")],
        },
        /inside 2026-10-24's seven days/,
      );
    });

    it("anything after the petition or the cease, an attempt outside a cadence, a credit in the case, a variant out of place", () => {
      const bk = { petition_on: D("2026-10-20"), discharged_on: null };
      flags({ ...base, bankruptcy: bk }, /a contact after the petition or the cease/);
      flags({ ...base, contacts: [ai("2026-10-10")] }, /outside a cadence/);
      flags(
        {
          ...base,
          contacts: [ai("2026-10-18")],
          bankruptcy: bk,
          installments: [
            { due_date: D("2026-10-01"), credited_as_of: D("2026-10-25") },
            ...unpaid("2026-11-01", "2026-12-01"),
          ],
        },
        /a credit on or after the petition/,
      );
      flags(
        { ...base, notices: [{ provided_on: D("2026-11-10"), variant: "fdcpa" }] },
        /notice is fdcpa, not standard/,
      );
      flags(
        {
          ...base,
          contacts: [ai("2026-10-18")],
          bankruptcy: { petition_on: D("2026-10-20"), discharged_on: D("2026-11-20") },
        },
        /a discharge before the bankruptcy notice was due/,
      );
    });
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump EI_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generateEiSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"5088ab989517cdae6fd0229a4f3f1617f53be344cc2ad0e787bac4221823fde7"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out loan into training", () => {
    expect(toJsonLine(generateEiTask("train", 7, 17))).toBe(
      toJsonLine(generateEiSuite("train", 7, 30)[17]),
    );
    const fp = (t: EiTask) => toJsonLine(eiPayload(t));
    const held = new Set(generateEiSuite("heldout", 1, 200).map(fp));
    expect(generateEiSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  });

  describe("each edge and outcome turns up", () => {
    const runs = generateEiSuite("train", 1, 1400).map((t, i) => ({
      t,
      a: expectedEi(t),
      edge: eiEdgeOf(i),
      i,
    }));
    type Run = (typeof runs)[number];
    const of = (edge: string) => runs.filter((x) => x.edge === edge);
    const arm = (x: Run, arms: number) => eiArmOf(x.i, arms);
    const first = (x: Run) => x.a.windows[0]!;
    const held = generateEiSuite("heldout", 1, 200).map(expectedEi);

    it("cycles through every edge, a hundred loans each, and every verdict above 12%, here and held out", () => {
      expect(new Set(runs.map((x) => x.edge))).toEqual(new Set(EI_EDGES));
      for (const v of ["breached", "owed", "clear"]) {
        expect(runs.filter((x) => eiVerdictOf(x.a) === v).length / runs.length, v).toBeGreaterThan(
          0.12,
        );
        expect(held.filter((a) => eiVerdictOf(a) === v).length / held.length, v).toBeGreaterThan(
          0.12,
        );
      }
    });

    it("turns up every status the grader can give, in training and held out", () => {
      for (const set of [runs.map((x) => x.a), held]) {
        const ws = set.flatMap((a) => a.windows);
        for (const s of LIVE_STATUSES)
          expect(ws.filter((w) => w.live === s).length, s).toBeGreaterThan(0);
        for (const s of NOTICE_STATUSES)
          expect(ws.filter((w) => w.notice === s).length, s).toBeGreaterThan(0);
        expect(ws.some((w) => w.live_late)).toBe(true);
        expect(ws.some((w) => w.notice_late)).toBe(true);
        const cs = set.flatMap((a) => a.cycles);
        for (const o of CYCLE_OUTCOMES)
          expect(
            cs.some((c) => c.outcome === o),
            o,
          ).toBe(true);
        for (const r of REPEAT_STATUSES)
          expect(
            cs.some((c) => c.repeat === r),
            r,
          ).toBe(true);
        // A case drawn before its first missed due date is a sixth of one edge's arm: training has it.
        for (const s of BK_STATUSES.filter((x) => x !== "not_yet_required"))
          expect(
            set.some((a) => a.bk_notice?.status === s),
            s,
          ).toBe(true);
        const es = set.flatMap((a) => a.episodes);
        for (const s of CONTINUITY_STATUSES)
          expect(
            es.some((e) => e.continuity.status === s),
            s,
          ).toBe(true);
        expect(es.some((e) => e.continuity.basis === "ei_notice")).toBe(true);
        expect(es.some((e) => (e.outbound?.missed.length ?? 0) > 0)).toBe(true);
        expect(es.some((e) => e.outbound !== null && e.outbound.missed.length === 0)).toBe(true);
        expect(set.some((a) => (a.regf?.over_cap.length ?? 0) > 0)).toBe(true);
      }
      // A case current at the petition owes its notice from the first due date missed in it.
      expect(
        runs.some(
          (x) =>
            x.t.bankruptcy !== null &&
            x.a.bk_notice?.due != null &&
            x.a.bk_notice.due !== addDays(x.t.bankruptcy.petition_on, 45),
        ),
      ).toBe(true);
      expect(runs.some((x) => x.a.bk_notice?.status === "not_yet_required")).toBe(true);
    });

    it("live_36 and overlap: a contact on day 36 meets, on day 37 is late, on the next due date meets only the older window", () => {
      for (const x of of("live_36")) {
        const w = first(x);
        const k = arm(x, 4);
        if (k === 0 || k === 2) expect(w.live, x.t.id).toBe("satisfied_live");
        if (k === 1) expect([w.live, w.live_late], x.t.id).toEqual(["breached", true]);
        if (k === 3) expect(w.live, x.t.id).toBe("breached");
      }
      for (const x of of("overlap")) {
        const [w0, w1] = x.a.windows;
        const k = arm(x, 3);
        if (k === 0)
          expect([w0!.live, w1!.live === "satisfied_live"], x.t.id).toEqual([
            "satisfied_live",
            false,
          ]);
        if (k === 1)
          expect([w0!.live, w1!.live], x.t.id).toEqual(["satisfied_live", "satisfied_live"]);
        if (k === 2)
          expect([w0!.live, w0!.live_late, w1!.live], x.t.id).toEqual([
            "breached",
            true,
            "satisfied_live",
          ]);
      }
    });

    it("paid_36, paid_45 and notice_45: a day either side of each deadline", () => {
      for (const x of of("paid_36")) {
        const k = arm(x, 3);
        if (k !== 1) expect(first(x).live, x.t.id).toBe("cancelled_paid");
        else expect(first(x).live, x.t.id).toBe("breached");
        expect(first(x).notice, x.t.id).toBe("cancelled_paid");
      }
      for (const x of of("paid_45"))
        expect(first(x).notice, x.t.id).toBe(arm(x, 2) === 0 ? "cancelled_paid" : "breached");
      for (const x of of("notice_45")) {
        const k = arm(x, 4);
        const w = first(x);
        if (k === 0) expect([w.notice, w.notice_late], x.t.id).toEqual(["sent", false]);
        if (k === 1) expect([w.notice, w.notice_late], x.t.id).toEqual(["sent", true]);
        if (k === 2) expect(w.notice, x.t.id).toBe("sent");
        if (k === 2 && x.a.windows[1])
          expect(x.a.windows[1].notice, x.t.id).toBe("satisfied_by_prior_180");
        if (k === 3) expect(w.notice, x.t.id).toBe("breached");
      }
    });

    it("cycle_cover and cycle_review: day 45 on the cycle's end or past it; each review's outcome", () => {
      for (const x of of("cycle_cover")) {
        const end = x.a.cycles[0]!.cycle_end;
        const on = x.a.windows.find((w) => w.notice_due === end);
        const past = x.a.windows.find((w) => w.notice_due === addDays(D(end), 1));
        if (arm(x, 2) === 0) expect(on?.notice, x.t.id).toBe("satisfied_by_prior_180");
        else expect(past?.notice, x.t.id).toBe("open");
      }
      for (const x of of("cycle_review")) {
        const c = x.a.cycles[0]!;
        const want = [
          ["repeat_required", "sent"],
          ["repeat_required", "late"],
          ["repeat_required", null],
          ["not_required", "next"],
          ["not_required", "none"],
        ][arm(x, 5)]!;
        expect(c.outcome, x.t.id).toBe(want[0]);
        if (want[1] === "next") expect(c.next_required_by, x.t.id).not.toBeNull();
        else if (want[1] === "none") expect(c.next_required_by, x.t.id).toBeNull();
        else if (want[1] === null) expect(["open", "breached"], x.t.id).toContain(c.repeat);
        else expect(c.repeat, x.t.id).toBe(want[1]);
      }
    });

    it("bankruptcy and cease: the case's notice on time, late, missing, owed from the first due date missed, exempt; the cease's legs", () => {
      for (const x of of("bankruptcy")) {
        const k = arm(x, 6);
        const s = x.a.bk_notice?.status;
        if (k === 0 || k === 5) expect(s, x.t.id).toBe("sent");
        if (k === 1) expect(s, x.t.id).toBe("late");
        if (k === 2) expect(["open", "breached"], x.t.id).toContain(s);
        if (k === 4) expect(s, x.t.id).toBe("exempt");
      }
      expect(
        of("bankruptcy").some((x) => x.a.windows.some((w) => w.live === "exempt_discharge")),
      ).toBe(true);
      for (const x of of("cease").filter((y) => arm(y, 3) === 1))
        expect(
          x.a.windows.every((w) => w.live === "exempt_fdcpa_cease"),
          x.t.id,
        ).toBe(true);
      expect(
        of("cease").some((x) =>
          x.a.cycles.some((c) => c.cycle_end === addDays(D(c.provided_on), 190)),
        ),
      ).toBe(true);
    });

    it("rolling, investment and continuity", () => {
      // Every window whose installment has been paid was cancelled by it; the newest may still be running.
      for (const x of of("rolling"))
        for (const w of x.a.windows) {
          const paid = x.t.installments.find((i) => i.due_date === w.due_date)?.credited_as_of;
          if (x.t.loan.principal_residence && paid)
            expect([w.live, w.notice], x.t.id).toEqual(["cancelled_paid", "cancelled_paid"]);
        }
      for (const x of of("investment")) {
        expect(
          x.a.windows.every((w) => w.live === "not_applicable"),
          x.t.id,
        ).toBe(true);
        expect(
          x.a.episodes.every((e) => e.continuity.status === "not_required"),
          x.t.id,
        ).toBe(true);
      }
      for (const x of of("continuity")) {
        const c = x.a.episodes[0]!.continuity;
        const want = [
          ["day_45", "met"],
          ["day_45", "late"],
          ["day_45", "breached"],
          ["ei_notice", "met"],
          ["ei_notice", "late"],
          ["day_45", "not_due"],
          ["day_45", "breached"],
        ][arm(x, 7)]!;
        expect([c.basis, c.status], x.t.id).toEqual(want);
      }
    });

    it("outbound and regf: a deadline met or missed by a day, and the cap at seven, eight and nine", () => {
      for (const x of of("outbound")) {
        const missed = x.a.episodes[0]!.outbound!.missed.length;
        expect(missed, x.t.id).toBe(arm(x, 6) % 2);
      }
      for (const x of of("regf")) {
        const over = x.a.regf!.over_cap.filter((c) => c.person === "borrower").length;
        expect(over, x.t.id).toBe([0, 1, 2, 0][arm(x, 4)]);
      }
      expect(of("regf").some((x) => x.a.regf!.counted_last_7.borrower === 7)).toBe(true);
    });
  });
});
