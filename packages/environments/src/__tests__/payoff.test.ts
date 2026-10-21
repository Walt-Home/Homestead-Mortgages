/**
 * payoff-statement: the grader is the servicing app's payoff engine and no
 * other (each port is its file byte for byte but the imports), and the
 * conventions it restates are held to the ops layer's own lines; it gives the
 * spec's worked examples (§16.1 A and B, §16.2's remittance types, §7.6's
 * Texas statement and the clocks) to the cent; every generated payoff can be
 * worked from the rulebook and the tools, on unfiltered draws too; the guard
 * keeps out each place the engine departs from its spec; and each edge turns
 * up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  addBusinessDays,
  addDays,
  dayOfWeek,
  daysBetween,
  isFederalHoliday,
  servicer,
  type PlainDate,
} from "@hm/kernel/calendar";
import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { solveNow } from "../refi/reference.js";
import { rngFor } from "../rng.js";
import {
  PAYOFF_EDGES,
  PAYOFF_FIELDS,
  PAYOFF_HELDOUT_SUITE,
  PayoffReferencePolicy,
  analyzePayoff,
  drawPayoffCandidate,
  drawPayoffTask,
  executePayoffTool,
  expectedPayoff,
  fannieBusinessDay,
  generatePayoffSuite,
  generatePayoffTask,
  gradePayoffAgainst,
  parsePayoffSubmission,
  payoffEdgeOf,
  payoffInScope,
  payoffPayload,
  payoffSpecTasks,
  payoffStatement,
  payoffSteps,
  payoffTaskId,
  type PayoffAnswer,
  type PayoffTask,
} from "../payoff/index.js";
import { interest, quote } from "../payoff/ported/quote.js";
import { payoffInterest } from "../payoff/ported/remittance.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const imports = (text: string) => text.split("\n").filter((l) => l.startsWith("import "));
const withoutImports = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith("import "))
    .join("\n");
/** Each import line with its module path removed: what it imports, and how. */
const importHeads = (text: string) => imports(text).map((l) => l.replace(/ from "[^"]+";$/, ""));
/** The one rewrite a port may carry: the kernel's paths become the package's, a sibling's .ts its .js. */
const rewritten = (lines: readonly string[]) =>
  lines.map((l) =>
    l
      .replace(/"\.\.\/\.\.\/kernel\/(money|calendar)\/[a-z-]+\.ts"/g, '"@hm/kernel/$1"')
      .replace(/"\.\.\/investor\/remittance\.ts"/g, '"./remittance.js"')
      .replace(/"\.\/([a-z-]+)\.ts"/g, '"./$1.js"'),
  );

const servicing = (file: string) =>
  readFileSync(here(`../../../../apps/servicing/src/${file}`), "utf8").split("\n");
/** A run of source lines, found by how the first begins, with the lines the grader cites them by. */
const sourceLines = (file: string, first: string, n: number) => {
  const lines = servicing(file);
  const start = lines.findIndex((l) => l.trimStart().startsWith(first));
  if (start < 0) return `${file}: no line beginning ${first}`;
  return [`${file}:${start + 1}-${start + n}`, ...lines.slice(start, start + n)].join("\n");
};

/** The fields where the rulebook, followed through the tools, lands somewhere other than the engine. */
const byRulesMisses = (task: PayoffTask): string[] => {
  let raw: unknown;
  try {
    raw = solveNow(payoffSteps, JSON.parse(JSON.stringify(payoffPayload(task))), executePayoffTool);
  } catch (e) {
    return [`${task.id} threw ${e instanceof Error ? e.message : String(e)}`];
  }
  const parsed = parsePayoffSubmission(raw);
  if (!parsed.ok) return [`${task.id} ${parsed.error}`];
  return gradePayoffAgainst(expectedPayoff(task), parsed.answer)
    .fields.filter((f) => !f.ok)
    .map((f) => `${task.id} ${f.field} ${f.expected}/${f.got}`);
};

const solveAll = async (tasks: readonly PayoffTask[]) => {
  const misses: string[] = [];
  let turns = 0;
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(payoffStatement, task, new PayoffReferencePolicy());
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

const SPEC = payoffSpecTasks();
const spec = (i: number) => SPEC[i]!;
const D = (s: string) => s as PlainDate;

describe("payoff-statement", () => {
  it("grades with the servicing app's payoff engine: each port is its file but for the imports", () => {
    const files = [
      ["domain/payoff/quote.ts", "quote"],
      ["domain/payoff/remit.ts", "remit"],
      ["domain/investor/remittance.ts", "remittance"],
      ["domain/investor/types.ts", "types"],
    ] as const;
    for (const [source, port] of files) {
      const original = readFileSync(here(`../../../../apps/servicing/src/${source}`), "utf8");
      const ported = readFileSync(here(`../payoff/ported/${port}.ts`), "utf8");
      expect(withoutImports(ported), port).toBe(withoutImports(original));
      expect(imports(ported), port).toEqual(rewritten(imports(original)));
      // The same names, imported the same way, from the kernel the servicing app's copy is.
      expect(importHeads(ported), port).toEqual(importHeads(original));
      for (const l of imports(ported))
        expect(l, port).toMatch(/ from "(@hm\/kernel\/(money|calendar)|\.\/[a-z]+\.js)";$/);
    }
    const from = readFileSync(here("../payoff/ported/PORTED_FROM"), "utf8");
    const vendored = readFileSync(here("../../../../apps/servicing/VENDORED_FROM"), "utf8");
    const commit = /Commit\s+([0-9a-f]{40})/.exec(vendored)![1]!;
    expect(from).toContain(commit);
  });

  describe("gives the spec's worked examples to the cent", () => {
    it("§16.1 example A: $1,345.02, $619.08, per diem $44.22, $250,390.82, federal due 09/23, no Ohio deadline", () => {
      const a = expectedPayoff(spec(0));
      expect(a).toMatchObject({
        federal_due: "2026-09-23",
        state_due: null,
        governing: "federal",
        governing_due: "2026-09-23",
        valid_until: "2026-10-15",
        months_full: 1,
        days_partial: 14,
        interest_full_cents: "134502",
        interest_partial_cents: "61908",
        per_diem_cents: "4422",
        nib_line_cents: "0",
        total_cents: "25039082",
        alt_applies: false,
        alt_if_posts_total_cents: null,
      });
    });

    it("§16.1 A's funds: early on 10/09 is $353.76 and $265.32 over; late on 10/20 is $840.17 and $221.09 short", () => {
      const early = analyzePayoff(spec(0));
      expect(early.exact.interest.partial_cents).toBe(35_376n);
      expect(expectedPayoff(spec(0))).toMatchObject({
        payoff_date: "2026-10-09",
        variance_cents: "26532",
        disposition: "paid_in_full_overage_refund_10bd",
      });
      const late = analyzePayoff(spec(1));
      expect(late.exact.interest.partial_cents).toBe(84_017n);
      // 16.1-T2 prints $221.10, the per-diem instruction's 5 × $44.22; the exact Δ is $221.09 (16.2
      // rule 2), and that is what the engine and the rulebook reconcile against. Ohio relies on
      // nothing, so it is demanded (16.2-T4).
      expect(expectedPayoff(spec(1))).toMatchObject({
        variance_cents: "-22109",
        disposition: "short_payoff_demand_1bd",
      });
    });

    it("§16.1 example B: $468.49, per diem $24.66, NIB $12,000.00, $192,468.49; Fannie Mae's principal $192,000.00", () => {
      expect(expectedPayoff(spec(2))).toMatchObject({
        months_full: 0,
        days_partial: 19,
        interest_partial_cents: "46849",
        per_diem_cents: "2466",
        nib_line_cents: "1200000",
        total_cents: "19246849",
        fnma_principal_cents: "19200000",
      });
    });

    it("§16.2's A/A example: $1,039.06 + $512.41 collected, $201,051.47 at $0 variance, Fannie Mae $1,489.42, fee $62.05, $200,989.42", () => {
      const a = expectedPayoff(spec(3));
      expect(a).toMatchObject({
        interest_full_cents: "103906",
        interest_partial_cents: "51241",
        total_cents: "20105147",
        payoff_date: "2026-10-16",
        exact_total_cents: "20105147",
        variance_cents: "0",
        disposition: "paid_in_full",
        fnma_interest_cents: "148942",
        servicing_fee_cents: "6205",
        ss_interest_gap_cents: null,
        fnma_total_cents: "20098942",
        // 16.2-T6: twenty federal business days, Veterans Day excluded.
        escrow_refund_by: "2026-11-16",
      });
      expect(analyzePayoff(spec(3)).share.collected_interest_cents).toBe(155_147n);
    });

    it("§16.2's variants and §5.2 rule 6: S/A $498.75, S/S $997.50 with a $505.58 gap, nothing on an MBS payoff processed BD1 and reported BD2", () => {
      expect(expectedPayoff(spec(4))).toMatchObject({
        fnma_interest_cents: "49875",
        servicing_fee_cents: null,
        ss_interest_gap_cents: null,
      });
      expect(expectedPayoff(spec(5))).toMatchObject({
        fnma_interest_cents: "99750",
        ss_interest_gap_cents: "50558",
        fnma_total_cents: "20049750",
      });
      // Mon 11/02/2026 is November's first Fannie Mae business day; reported Tue 11/03, the second.
      expect(fannieBusinessDay(D("2026-11-02"), 1)).toBe("2026-11-02");
      expect(fannieBusinessDay(D("2026-11-02"), 2)).toBe("2026-11-03");
      expect(expectedPayoff(spec(6))).toMatchObject({
        payoff_date: "2026-11-02",
        fnma_interest_cents: "0",
        ss_interest_gap_cents: "0",
        fnma_total_cents: "19950000",
      });
      // Reported on BD3 it is owed after all; and a portfolio loan always owes the month.
      const bd3 = { ...spec(6), investor: { ...spec(6).investor, reported_on: D("2026-11-04") } };
      expect(expectedPayoff(bd3).fnma_interest_cents).toBe("99750");
      const portfolio = { ...spec(6), investor: { ...spec(6).investor, mbs_pool: false } };
      expect(expectedPayoff(portfolio).fnma_interest_cents).toBe("99750");
      expect([bd3, portfolio].flatMap(byRulesMisses)).toEqual([]);
    });

    it("§7.6's Texas statement: federal due Thu 10/22 (Texas ties), 19 days $1,231.32, per diem $64.81, $372,280.18; Florida's 10/23 loses to 10/22", () => {
      expect(expectedPayoff(spec(7))).toMatchObject({
        federal_due: "2026-10-22",
        state_due: "2026-10-22",
        governing: "federal",
        months_full: 0,
        days_partial: 19,
        interest_partial_cents: "123132",
        per_diem_cents: "6481",
        total_cents: "37228018",
      });
      expect(expectedPayoff(spec(8))).toMatchObject({
        federal_due: "2026-10-22",
        state_due: "2026-10-23",
        governing: "federal",
        governing_due: "2026-10-22",
      });
    });

    it("16.1-T7 (Massachusetts, Mon 09/14): 5 business days, Mon 09/21, governs the federal 09/23; good at least to 10/14", () => {
      expect(expectedPayoff(spec(9))).toMatchObject({
        federal_due: "2026-09-23",
        state_due: "2026-09-21",
        governing: "state",
        governing_due: "2026-09-21",
        valid_until: "2026-10-14",
        // 16.1-T3: LPI 09/01 and a payoff on 10/01 is one full month and no partial days.
        months_full: 1,
        days_partial: 0,
      });
    });

    it("16.1-T11 (Connecticut, a payoff date five business days ahead): the seven-day floor, and federal governs", () => {
      expect(expectedPayoff(spec(10))).toMatchObject({
        federal_due: "2026-09-23",
        state_due: "2026-09-23",
        governing: "federal",
      });
    });

    it("16.2-T4 and T5: $30.00 short is kept as tolerance; a Florida figure relied on within the good-through is absorbed", () => {
      expect(expectedPayoff(spec(11))).toMatchObject({
        variance_cents: "-3000",
        disposition: "paid_in_full_tolerance_expense",
      });
      expect(expectedPayoff(spec(12))).toMatchObject({
        variance_cents: "-22110",
        disposition: "reliance_absorbed",
      });
    });

    it("16.1-T3: due Sun 11/01, funds Mon 11/02 are deemed received 11/01, and Tue 11/03 are not", () => {
      expect(expectedPayoff(spec(13))).toMatchObject({
        payoff_date: "2026-11-01",
        exact_total_cents: "24977174",
        variance_cents: "4422",
      });
      const tuesday = { ...spec(13), funds: { ...spec(13).funds, received_on: D("2026-11-03") } };
      expect(expectedPayoff(tuesday).payoff_date).toBe("2026-11-03");
      expect(byRulesMisses(tuesday)).toEqual([]);
    });

    it("16.1-T4: daily simple interest has no 360-day block: example A is 44 days, $1,945.67", () => {
      expect(expectedPayoff(spec(14))).toMatchObject({
        months_full: 0,
        days_partial: 44,
        interest_full_cents: "0",
        interest_partial_cents: "194567",
      });
    });

    it("every spec task is in scope, and the rulebook lands on each", () => {
      expect(SPEC).toHaveLength(15);
      expect(SPEC.every(payoffInScope)).toBe(true);
      expect(SPEC.flatMap(byRulesMisses)).toEqual([]);
    });
  });

  it("restates the conventions the engine takes from its caller, as the ops layer has them", () => {
    // A re-vendor that changes any of these fails here: revisit the grader, the rulebook and their citations.
    expect(sourceLines("domain/investor/period.ts", "export function fannieBusinessDay(", 1))
      .toMatchInlineSnapshot(`
      "domain/investor/period.ts:20-20
      export function fannieBusinessDay(d: PlainDate, n: number): PlainDate { return addBusinessDays(firstOfMonth(d), n, fannieEt) === firstOfMonth(d) ? firstOfMonth(d) : (fannieEt.isBusinessDay(firstOfMonth(d)) ? addBusinessDays(firstOfMonth(d), n - 1, fannieEt) : addBusinessDays(firstOfMonth(d), n, fannieEt)); }"
    `);
    expect(sourceLines("domain/payoff/ops-16-2.ts", "export function ssBd1Bd2Exception(", 5))
      .toMatchInlineSnapshot(`
      "domain/payoff/ops-16-2.ts:157-161
      export function ssBd1Bd2Exception(i: { type: RemittanceType; mbs_pool: boolean; processed_on: PlainDate; reported_on?: PlainDate | null }): boolean {
        if (i.type !== "SS" || !i.mbs_pool) return false;
        const bd1 = fannieBusinessDay(i.processed_on, 1), bd2 = fannieBusinessDay(i.processed_on, 2);
        return i.processed_on === bd1 && (i.reported_on ?? i.processed_on) <= bd2;
      }"
    `);
    expect(sourceLines("domain/payoff/ops-16-2.ts", "const exception = ssBd1Bd2Exception(", 1))
      .toMatchInlineSnapshot(`
      "domain/payoff/ops-16-2.ts:171-171
        const exception = ssBd1Bd2Exception({ type: f.type, mbs_pool: f.mbs_pool === true, processed_on: f.processed_on ?? f.payoff_on, reported_on: f.reported_on ?? null });"
    `);
    expect(sourceLines("domain/payoff/ops-16-2.ts", "export function payoffDate(", 5))
      .toMatchInlineSnapshot(`
      "domain/payoff/ops-16-2.ts:44-48
      export function payoffDate(i: { received_on: PlainDate; remittance_type: RemittanceType; paid_by: "borrower" | "closing_agent" | "estate" | "other"; settlement_date?: PlainDate | null; due_on?: PlainDate | null }): { payoff_date: PlainDate; basis: "credited_as_of" | "closing_agent_settlement_date" | "f109_non_business_day" } {
        if (i.remittance_type === "SS" && i.paid_by === "closing_agent" && i.settlement_date) return { payoff_date: i.settlement_date, basis: "closing_agent_settlement_date" };
        if (i.due_on) { const d = deemedPayoffDate(i.received_on, i.due_on); if (d !== i.received_on) return { payoff_date: d, basis: "f109_non_business_day" }; }
        return { payoff_date: i.received_on, basis: "credited_as_of" };
      }"
    `);
    expect(sourceLines("domain/payoff/ops-16-2.ts", "export function exactFigure(", 1))
      .toMatchInlineSnapshot(`
      "domain/payoff/ops-16-2.ts:373-373
      export function exactFigure(c: Components, payoffOn: PlainDate): ReturnType<typeof quote> { return quote({ ...c, good_through: payoffOn }); }"
    `);
    expect(
      sourceLines(
        "app/tools/section16-2.ts",
        "const d = disposeVariance({ amount_cents: amount,",
        1,
      ),
    ).toContain(
      'reliance_state: flag(i, "reliance_state"), within_good_through: flag(i, "within_good_through")',
    );
    // The restatement agrees with the source's own day count on every month of the range.
    for (let m = D("2026-01-15"); m <= "2028-12-15"; m = addDays(m, 30)) {
      const bd1 = fannieBusinessDay(m, 1);
      expect(servicer.isBusinessDay(bd1)).toBe(true);
      expect(fannieBusinessDay(m, 2)).toBe(addBusinessDays(bd1, 1, servicer));
    }
  });

  it("fails an answer one cent off on exactly that field, and grades the figures that seldom move with the one that decides them", () => {
    const want = expectedPayoff(spec(3));
    const wrong = (answer: Partial<PayoffAnswer>) =>
      gradePayoffAgainst(want, { ...want, ...answer })
        .fields.filter((f) => !f.ok)
        .map((f) => f.field);
    expect(wrong({ interest_partial_cents: "51242" })).toEqual(["interest"]);
    expect(wrong({ per_diem_cents: "3417" })).toEqual(["per_diem"]);
    expect(wrong({ total_cents: "20105148" })).toEqual(["total"]);
    expect(wrong({ exact_total_cents: "20105148" })).toEqual(["reconciliation"]);
    expect(wrong({ servicing_fee_cents: "6204" })).toEqual(["fnma_interest"]);
    expect(wrong({ fnma_total_cents: "20098943" })).toEqual(["fnma_principal_and_total"]);
    expect(wrong({ valid_until: "2026-10-17" })).toEqual(["state_rules"]);
    expect(wrong({ governing: "state" })).toEqual(["state_rules"]);
    expect(wrong({ escrow_refund_by: "2026-11-17" })).toEqual(["escrow_refund_by"]);
    expect(wrong({ disposition: "paid_in_full_tolerance_expense" })).toEqual(["disposition"]);
    expect(Object.keys(PAYOFF_FIELDS)).toHaveLength(12);
    // A field per group, and every answer key in exactly one group.
    const keys = Object.values(PAYOFF_FIELDS).flat();
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(Object.keys(want)));
  });

  it("reads a submission strictly, as the schema says, and bounces what does not fit", () => {
    const want = expectedPayoff(spec(5));
    const ok = (x: unknown) => parsePayoffSubmission(x).ok;
    expect(ok(want)).toBe(true);
    // Every key is required, null only where the schema allows it, and nothing it does not name.
    const { state_due: _s, ...missing } = want;
    expect(ok(missing)).toBe(false);
    expect(ok({ ...want, total_cents: null })).toBe(false);
    expect(ok({ ...want, state_due: null })).toBe(true);
    expect(ok({ ...want, note: "checked twice" })).toBe(false);
    expect(ok({ ...want, nib_line_cents: "0", nib_line: "0" })).toBe(false);
    // Cents are strings of digits, not numbers or dollars.
    expect(ok({ ...want, total_cents: 20105147 })).toBe(false);
    expect(ok({ ...want, total_cents: "201051.47" })).toBe(false);
    expect(ok({ ...want, variance_cents: "+0" })).toBe(false);
    // Dates are real dates.
    expect(ok({ ...want, federal_due: "2026-10-32" })).toBe(false);
    expect(ok({ ...want, federal_due: "10/13/2026" })).toBe(false);
    // Whole numbers, booleans and the enums as listed.
    expect(ok({ ...want, months_full: 1.5 })).toBe(false);
    expect(ok({ ...want, days_partial: "15" })).toBe(false);
    expect(ok({ ...want, alt_applies: "false" })).toBe(false);
    expect(ok({ ...want, governing: "State" })).toBe(false);
    expect(ok({ ...want, disposition: "paid" })).toBe(false);
    expect(ok([want])).toBe(false);
    expect(ok(null)).toBe(false);
  });

  it("gives an answer that copies the request and the funds back little credit", () => {
    // Every date the request's or the funds' own, every figure the balance or zero, nothing
    // computed: 0.105 on the held-out suite. It is right on the alternative figure when there is
    // none to print, and on the reconciliation and disposition when the funds were exact; only a
    // payoff on the loan's own due date, owing nothing else, gets as much as half.
    const tasks = generatePayoffSuite("heldout", 1, 200);
    const scores = tasks.map((t) => {
      const nothing: PayoffAnswer = {
        federal_due: t.request.received_on,
        state_due: null,
        governing: "federal",
        governing_due: t.request.received_on,
        valid_until: t.request.good_through,
        months_full: 0,
        days_partial: 0,
        interest_full_cents: "0",
        interest_partial_cents: "0",
        per_diem_cents: "0",
        nib_line_cents: "0",
        total_cents: String(t.loan.upb_cents),
        alt_applies: false,
        alt_if_posts_total_cents: null,
        payoff_date: t.funds.received_on,
        exact_total_cents: String(t.funds.amount_cents),
        variance_cents: "0",
        disposition: "paid_in_full",
        escrow_refund_by: t.funds.received_on,
        fnma_principal_cents: String(t.loan.upb_cents),
        fnma_interest_cents: "0",
        servicing_fee_cents: null,
        ss_interest_gap_cents: null,
        fnma_total_cents: String(t.loan.upb_cents),
      };
      return gradePayoffAgainst(expectedPayoff(t), nothing).score;
    });
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    expect(mean).toBeLessThan(0.15);
    expect(scores.filter((s) => s > 3 / 12).length).toBeLessThan(10);
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    const r = await solveAll([
      ...SPEC,
      ...generatePayoffSuite("heldout", PAYOFF_HELDOUT_SUITE.seed, PAYOFF_HELDOUT_SUITE.n),
    ]);
    expect(r.misses).toEqual([]);
    // Inside the episode's 80 turns even for a model that makes one tool call a turn: the
    // reference's call count, submission included, is that model's turn count.
    expect(r.calls).toBeLessThan(70);
    expect(r.turns).toBeLessThan(12);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    const r = await solveAll(generatePayoffSuite("train", 11, 300));
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(70);
  }, 120_000);

  it("is fair to grade on every first draw", () => {
    const draws = Array.from({ length: 600 }, (_, i) => drawPayoffTask("train", 3, i));
    expect(draws.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
  });

  it("agrees with the engine on unfiltered draws: the rulebook, not the guard, makes the suites fair", () => {
    // Candidates exactly as the generator draws them, before its guard has kept or redrawn any.
    const candidates = Array.from({ length: 2_000 }, (_, i) => {
      const id = payoffTaskId("train", 5, i);
      return drawPayoffCandidate(rngFor(id), id, "train", 5, i);
    });
    expect(candidates.flatMap(byRulesMisses)).toEqual([]);
    // The guard is a guard, not a filter: the generator aims around every region it keeps out.
    expect(candidates.filter((t) => !payoffInScope(t)).map((t) => t.id)).toEqual([]);
  }, 120_000);

  describe("keeps out each place the engine departs from its own spec", () => {
    const [A] = SPEC;
    const base = A!;
    const out = (t: PayoffTask) => payoffInScope(t);

    it("D1: two full months, where the engine rounds each month and the spec rounds the block once", () => {
      // Example A paid through July: the engine's two months are 2 × $1,345.02; once, $2,690.03.
      const twoMonths = { ...base, loan: { ...base.loan, lpi_due: D("2026-08-01") } };
      const q = quote({
        upb_cents: base.loan.upb_cents,
        rate_pct: "6.500",
        lpi_due: D("2026-08-01"),
        good_through: D("2026-10-15"),
      });
      expect(q.interest.months_full).toBe(2);
      expect(q.interest.full_cents).toBe(269_004n);
      expect((24_831_055n * 65n * 2n + 6_000n) / 12_000n).toBe(269_003n);
      expect(out(twoMonths)).toBe(false);
      // And Fannie Mae's A/A walk rounds per month the same way: two months at the payoff is out too.
      const latePayoff = {
        ...base,
        loan: { ...base.loan, lpi_due: D("2026-09-01") },
        funds: { ...base.funds, received_on: D("2026-11-02") },
      };
      expect(
        interest(base.loan.upb_cents, "6.250", D("2026-09-01"), D("2026-11-02")).months_full,
      ).toBe(2);
      expect(out(latePayoff)).toBe(false);
    });

    it("D2: a due day other than the 1st, where the clamped month walk drifts", () => {
      // LPI 01/31 to 03/31 is two months and three days in the engine; two months exactly by the spec.
      expect(interest(20_000_000n, "6.000", D("2026-01-31"), D("2026-03-31"))).toMatchObject({
        months_full: 2,
        days_partial: 3,
      });
      const fifteenth = {
        ...base,
        loan: { ...base.loan, lpi_due: D("2026-09-15") },
        funds: { ...base.funds, installment_due_on: D("2026-10-15") },
      };
      expect(out(fifteenth)).toBe(false);
    });

    it("D3: an alternative figure for an installment that is not the next one skips the arrears", () => {
      const skipping = {
        ...base,
        next_installment: { due_on: D("2026-11-01"), principal_cents: 19_910n, autodraft: false },
      };
      expect(out(skipping)).toBe(false);
      const next = {
        ...base,
        next_installment: { due_on: D("2026-10-01"), principal_cents: 29_872n, autodraft: false },
      };
      expect(out(next)).toBe(true);
      // The verifier's figure for example A with its 10/01 installment: $248,746.33 if it posts.
      expect(expectedPayoff(next)).toMatchObject({
        alt_applies: true,
        alt_if_posts_total_cents: "24874633",
      });
    });

    it("the share's collected interest is the 30/360 figure: a daily-simple payoff past its last paid month", () => {
      const dsi = {
        ...spec(3),
        loan: { ...spec(3).loan, accrual_method: "daily_simple_365" as const },
      };
      const a = analyzePayoff(dsi);
      // 45 actual days on the statement and at the payoff; the share collects a month and 15 days.
      expect(a.exact.interest.total_cents).toBe(153_724n);
      expect(a.share.collected_interest_cents).toBe(155_147n);
      expect(a.share.servicing_fee_cents).toBe(6_205n);
      expect(out(dsi)).toBe(false);
      // Paid off in its last paid installment's month, the two agree, and it is graded.
      expect(out(spec(14))).toBe(true);
    });

    it("D6: an S/A half month the engine rounds twice", () => {
      // $200,001.20 at 6.000 %: the month is $1,000.006 → $1,000.01, halved $500.005 → $500.01;
      // once, ÷ 24, $500.003 → $500.00.
      expect(payoffInterest("SA", 20_000_120n, "6.000", D("2026-09-01"), D("2026-10-16"))).toBe(
        50_001n,
      );
      const drawn = { ...spec(4), loan: { ...spec(4).loan, upb_cents: 20_000_120n } };
      // Paid to the cent, so the double rounding is the only thing out of place.
      const twice = {
        ...drawn,
        funds: { ...drawn.funds, amount_cents: BigInt(expectedPayoff(drawn).exact_total_cents) },
      };
      expect(expectedPayoff(twice)).toMatchObject({
        variance_cents: "0",
        fnma_interest_cents: "50001",
      });
      expect(out(twice)).toBe(false);
      // A cent more balance and the two roundings agree again: $500.01 either way.
      const once = {
        ...twice,
        loan: { ...twice.loan, upb_cents: 20_000_200n },
        funds: {
          ...twice.funds,
          amount_cents: BigInt(
            expectedPayoff({ ...twice, loan: { ...twice.loan, upb_cents: 20_000_200n } })
              .exact_total_cents,
          ),
        },
      };
      expect(expectedPayoff(once).fnma_interest_cents).toBe("50001");
      expect(out(once)).toBe(true);
    });

    it("D9: $0.01 to $1.00 over, which the engine keeps and the ops layer refunds", () => {
      const over = (cents: bigint) => ({
        ...spec(3),
        funds: { ...spec(3).funds, amount_cents: 20_105_147n + cents },
      });
      expect(out(over(50n))).toBe(false);
      expect(out(over(100n))).toBe(false);
      expect(out(over(101n))).toBe(true);
      expect(out(over(-1n))).toBe(true);
    });

    it("a loan paid ahead of its payoff, which the engine accrues as negative interest", () => {
      const ahead = {
        ...base,
        loan: { ...base.loan, lpi_due: D("2026-10-01") },
        funds: { ...base.funds, received_on: D("2026-09-30"), installment_due_on: D("2026-11-01") },
      };
      expect(analyzePayoff(ahead).exact.interest.partial_cents).toBeLessThan(0n);
      expect(out(ahead)).toBe(false);
    });

    it("an S/S MBS payoff deemed received on a non-business due date, and a payoff deemed back across the good-through", () => {
      // Sunday 11/01 due, Monday 11/02 funds: deemed 11/01, which is not BD1; processed on 11/02, it is.
      const deemedMbs = {
        ...spec(6),
        loan: { ...spec(6).loan, lpi_due: D("2026-10-01") },
        funds: { ...spec(6).funds, installment_due_on: D("2026-11-01") },
      };
      expect(analyzePayoff(deemedMbs).payoff_on).toBe("2026-11-01");
      expect(out(deemedMbs)).toBe(false);
      // Good through Sunday 11/01, funds Monday 11/02 deemed 11/01: within good-through or not.
      const across = {
        ...spec(13),
        request: { ...spec(13).request, good_through: D("2026-11-01") },
      };
      expect(out(across)).toBe(false);
    });

    it("the request, the statement and the funds out of order", () => {
      const beforeStatement = { ...base, funds: { ...base.funds, received_on: D("2026-09-14") } };
      expect(out(beforeStatement)).toBe(false);
      const saturday = { ...base, funds: { ...base.funds, received_on: D("2026-10-10") } };
      expect(out(saturday)).toBe(false);
      const reportedEarly = {
        ...base,
        investor: { ...base.investor, reported_on: D("2026-10-08") },
      };
      expect(out(reportedEarly)).toBe(false);
    });
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump PAYOFF_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generatePayoffSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"ad05821be0f03b8c5d217cb99fb1465148c82c3a1eb8545e58e522b9f61e76d4"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out payoff into training", () => {
    expect(toJsonLine(generatePayoffTask("train", 7, 17))).toBe(
      toJsonLine(generatePayoffSuite("train", 7, 30)[17]),
    );
    const fp = (t: PayoffTask) => toJsonLine(payoffPayload(t));
    const held = new Set(generatePayoffSuite("heldout", 1, 200).map(fp));
    expect(generatePayoffSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  });

  describe("each edge turns up", () => {
    const runs = generatePayoffSuite("train", 1, 1300).map((t, i) => ({
      t,
      a: expectedPayoff(t),
      x: analyzePayoff(t),
      edge: payoffEdgeOf(i),
    }));
    type Run = (typeof runs)[number];
    const count = (f: (r: Run) => boolean) => runs.filter(f).length;
    const dsi = (r: Run) => r.t.loan.accrual_method === "daily_simple_365";
    const early = (r: Run) => daysBetween(r.x.payoff_on, r.t.request.good_through);

    it("cycles through every edge, a hundred payoffs each", () => {
      expect(new Set(runs.map((r) => r.edge))).toEqual(new Set(PAYOFF_EDGES));
    });

    it("draws every disposition, governing deadline and remittance type", () => {
      const tally = (f: (r: Run) => string) => new Set(runs.map(f));
      expect(tally((r) => r.a.disposition)).toEqual(
        new Set([
          "paid_in_full",
          "paid_in_full_tolerance_expense",
          "paid_in_full_overage_refund_10bd",
          "short_payoff_demand_1bd",
          "reliance_absorbed",
        ]),
      );
      expect(tally((r) => r.a.governing)).toEqual(new Set(["federal", "state"]));
      expect(tally((r) => r.t.investor.remittance_type)).toEqual(new Set(["AA", "SA", "SS"]));
      expect(tally((r) => r.t.request.state)).toEqual(
        new Set(["CA", "FL", "NY", "NC", "MA", "TX", "CT", "OH", "PA", "GA", "AZ"]),
      );
      expect(count((r) => r.a.disposition === "reliance_absorbed")).toBeGreaterThan(15);
    });

    it("draws a good-through on the 1st and on the last day of a month, and late funds across the month end", () => {
      expect(
        count(
          (r) =>
            r.t.request.good_through.endsWith("-01") &&
            r.a.months_full === 1 &&
            r.a.days_partial === 0,
        ),
      ).toBeGreaterThan(60);
      // A good-through on the last paid installment's own due date: no interest at all.
      expect(count((r) => r.t.request.good_through === r.t.loan.lpi_due)).toBeGreaterThan(20);
      expect(
        count(
          (r) => addDays(r.t.request.good_through, 1).endsWith("-01") && r.a.days_partial >= 27,
        ),
      ).toBeGreaterThan(80);
      expect(
        count(
          (r) =>
            r.x.payoff_on > r.t.request.good_through &&
            r.x.payoff_on.slice(0, 7) !== r.t.request.good_through.slice(0, 7),
        ),
      ).toBeGreaterThan(50);
    });

    it("draws daily simple interest across a month end and across February 29, and a monthly partial in a leap February", () => {
      expect(
        count(
          (r) => dsi(r) && r.t.request.good_through.slice(0, 7) !== r.t.loan.lpi_due.slice(0, 7),
        ),
      ).toBeGreaterThan(60);
      expect(
        count(
          (r) =>
            dsi(r) && r.t.loan.lpi_due <= "2028-02-29" && r.t.request.good_through > "2028-02-29",
        ),
      ).toBeGreaterThan(15);
      expect(
        count(
          (r) => !dsi(r) && r.t.request.good_through.startsWith("2028-02") && r.a.days_partial > 0,
        ),
      ).toBeGreaterThan(20);
      // The trap: the per diem times the days is not the partial interest, which is rounded once.
      expect(
        count(
          (r) =>
            BigInt(r.a.per_diem_cents) * BigInt(r.a.days_partial) !==
            BigInt(r.a.interest_partial_cents),
        ),
      ).toBeGreaterThan(600);
    });

    it("draws deferred and forborne principal, every fee and advance, and both credits, in and out", () => {
      const l = (r: Run) => r.t.loan;
      for (const k of [
        "nib_deferred_cents",
        "nib_forborne_cents",
        "late_charges_cents",
        "fees_cents",
        "corporate_advances_cents",
        "escrow_advance_cents",
        "recording_fee_cents",
        "mi_premium_cents",
        "buydown_credit_cents",
        "suspense_credit_cents",
      ] as const) {
        expect(
          count((r) => l(r)[k] > 0n),
          k,
        ).toBeGreaterThan(50);
        expect(
          count((r) => l(r)[k] === 0n),
          k,
        ).toBeGreaterThan(300);
      }
      // NIB rides in Fannie Mae's principal, never in its interest.
      expect(
        count(
          (r) =>
            r.a.nib_line_cents !== "0" && r.a.fnma_principal_cents !== String(r.t.loan.upb_cents),
        ),
      ).toBeGreaterThan(100);
    });

    it("draws funds a day early and a day late, a day's interest either side of the $50.00 tolerance, and more", () => {
      expect(
        count((r) => early(r) === 1 && r.a.disposition === "paid_in_full_overage_refund_10bd"),
      ).toBeGreaterThan(50);
      expect(count((r) => early(r) > 1)).toBeGreaterThan(200);
      expect(
        count((r) => early(r) === -1 && r.a.disposition === "paid_in_full_tolerance_expense"),
      ).toBeGreaterThan(20);
      expect(
        count((r) => early(r) === -1 && r.a.disposition === "short_payoff_demand_1bd"),
      ).toBeGreaterThan(20);
      expect(count((r) => early(r) < -1)).toBeGreaterThan(150);
    });

    it("draws the variance on each threshold: exact, a cent and $50.00 short kept, $50.01 short demanded, $1.01 over refunded", () => {
      for (const [v, d, n] of [
        ["0", "paid_in_full", 100],
        ["-1", "paid_in_full_tolerance_expense", 3],
        ["-5000", "paid_in_full_tolerance_expense", 3],
        ["101", "paid_in_full_overage_refund_10bd", 3],
      ] as const)
        expect(
          count((r) => r.a.variance_cents === v && r.a.disposition === d),
          v,
        ).toBeGreaterThan(n);
      expect(count((r) => r.a.variance_cents === "-5001")).toBeGreaterThan(8);
      // Reliance needs both: a reliance state and a payoff within the good-through.
      expect(
        count(
          (r) =>
            ["FL", "TX", "CA"].includes(r.t.request.state) &&
            r.x.payoff_on > r.t.request.good_through &&
            r.a.disposition === "short_payoff_demand_1bd",
        ),
      ).toBeGreaterThan(40);
      expect(
        count(
          (r) =>
            !["FL", "TX", "CA"].includes(r.t.request.state) &&
            r.x.payoff_on <= r.t.request.good_through &&
            r.a.disposition === "short_payoff_demand_1bd",
        ),
      ).toBeGreaterThan(10);
    });

    it("draws funds deemed received on a non-business due date, and funds a business day too late for it", () => {
      expect(count((r) => r.x.payoff_on !== r.t.funds.received_on)).toBeGreaterThan(40);
      expect(
        count(
          (r) =>
            !servicer.isBusinessDay(r.t.funds.installment_due_on) &&
            r.t.funds.received_on === addBusinessDays(r.t.funds.installment_due_on, 2, servicer),
        ),
      ).toBeGreaterThan(30);
    });

    it("draws the seven-business-day clock across a holiday, ties, a state that governs, and Saturday deadlines", () => {
      const holidayIn = (r: Run) => {
        for (let d = addDays(r.t.request.received_on, 1); d <= r.a.federal_due; d = addDays(d, 1))
          if (isFederalHoliday(d) && dayOfWeek(d) % 6 !== 0) return true;
        return false;
      };
      expect(count(holidayIn)).toBeGreaterThan(200);
      expect(count((r) => !servicer.isBusinessDay(r.t.request.received_on))).toBeGreaterThan(200);
      // Ten calendar days against seven business days: Florida and North Carolina both ways.
      for (const st of ["FL", "NC"]) {
        expect(count((r) => r.t.request.state === st && r.a.governing === "state")).toBeGreaterThan(
          15,
        );
        expect(
          count((r) => r.t.request.state === st && r.a.state_due === r.a.federal_due),
        ).toBeGreaterThan(8);
        expect(
          count(
            (r) =>
              r.t.request.state === st &&
              r.a.state_due !== null &&
              dayOfWeek(r.a.state_due as PlainDate) % 6 === 0,
          ),
        ).toBeGreaterThan(8);
      }
      expect(count((r) => r.t.request.state === "MA" && r.a.governing === "state")).toBeGreaterThan(
        50,
      );
      expect(
        count((r) => r.t.request.state === "TX" && r.a.state_due === r.a.federal_due),
      ).toBeGreaterThan(50);
      // Connecticut: the requested date when it clears the floor, the floor when it does not.
      expect(
        count((r) => r.t.request.state === "CT" && r.a.state_due === r.t.request.good_through),
      ).toBeGreaterThan(30);
      expect(
        count(
          (r) =>
            r.t.request.state === "CT" &&
            r.a.state_due === r.a.federal_due &&
            r.t.request.good_through < r.a.federal_due,
        ),
      ).toBeGreaterThan(8);
      // Massachusetts: good for at least thirty days from the statement.
      expect(
        count((r) => r.t.request.state === "MA" && r.a.valid_until !== r.t.request.good_through),
      ).toBeGreaterThan(50);
    });

    it("draws the next installment inside the window, on the statement date, on the good-through, and after it", () => {
      const n = (r: Run) => r.t.next_installment;
      expect(count((r) => r.a.alt_applies)).toBeGreaterThan(200);
      expect(
        count((r) => !r.a.alt_applies && n(r)?.due_on === r.t.request.issued_on),
      ).toBeGreaterThan(10);
      expect(
        count((r) => r.a.alt_applies && n(r)?.due_on === r.t.request.good_through),
      ).toBeGreaterThan(50);
      expect(
        count((r) => n(r) !== null && !r.a.alt_applies && n(r)!.due_on > r.t.request.good_through),
      ).toBeGreaterThan(100);
      expect(count((r) => r.a.alt_applies && n(r)!.autodraft)).toBeGreaterThan(50);
      expect(count((r) => n(r) === null)).toBeGreaterThan(200);
    });

    it("draws the S/S exception, and an MBS payoff on BD1 reported on BD3, and a portfolio one", () => {
      const ss = (r: Run) => r.t.investor.remittance_type === "SS";
      expect(count((r) => ss(r) && r.a.fnma_interest_cents === "0")).toBeGreaterThan(12);
      expect(
        count(
          (r) =>
            ss(r) &&
            r.t.investor.mbs_pool &&
            r.x.payoff_on === fannieBusinessDay(r.x.payoff_on, 1) &&
            r.a.fnma_interest_cents !== "0",
        ),
      ).toBeGreaterThan(6);
      expect(
        count(
          (r) =>
            ss(r) &&
            !r.t.investor.mbs_pool &&
            r.x.payoff_on === fannieBusinessDay(r.x.payoff_on, 1),
        ),
      ).toBeGreaterThan(5);
      // Paid off on the 1st: the gap is the whole month.
      expect(
        count(
          (r) =>
            ss(r) &&
            r.a.fnma_interest_cents !== "0" &&
            r.a.ss_interest_gap_cents === r.a.fnma_interest_cents,
        ),
      ).toBeGreaterThan(20);
      expect(count((r) => r.t.investor.remittance_type === "SA")).toBeGreaterThan(200);
      expect(count((r) => r.a.servicing_fee_cents !== null)).toBeGreaterThan(300);
    });
  });
});
