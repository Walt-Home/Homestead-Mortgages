/**
 * payoff-statement: the grader is the servicing app's payoff engine and no
 * other (each port is its file byte for byte but the imports), and the
 * conventions it restates are held to the ops layer's own lines; it gives the
 * spec's worked examples (§16.1 A and B, §16.2's remittance types, §7.6's
 * Texas statement and the clocks) to the cent; every generated payoff can be
 * worked from the rulebook and the tools, on unfiltered draws too; the guard
 * keeps out each place the engine departs from its spec; each edge turns up
 * in its own payoffs; and the held-out suite itself holds every case a rule
 * turns on.
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
import { auditEpisode, type AuditRecord } from "../audit.js";
import { scoreSide, type EpisodeLine } from "../compare.js";
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
  type PayoffEdge,
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
    // Cents are integer cents: a string of digits, or a whole number as the task prints them and
    // every other environment takes them; never dollars, a sign, a fraction or past 2^53.
    const read = (x: unknown) => {
      const p = parsePayoffSubmission(x);
      return p.ok ? p.answer : p.error;
    };
    expect(read({ ...want, total_cents: 20105147 })).toEqual(want);
    expect(read({ ...want, total_cents: " 20105147 ", payoff_date: "2026-10-16 " })).toEqual(want);
    expect(ok({ ...want, total_cents: 20105147.5 })).toBe(false);
    expect(ok({ ...want, total_cents: 2 ** 60 })).toBe(false);
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

  describe("scores an answer that computes no money for what it did", () => {
    // Every date the request's or the funds' own, every figure the balance or zero, nothing
    // computed. It is right on the alternative figure when there is none to print, and on the
    // reconciliation and disposition when the funds were exact; only a payoff on the loan's own
    // due date, owing nothing else, gets as much as half.
    const copied = (t: PayoffTask): PayoffAnswer => ({
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
    });
    // The same with the commonest disposition and day count, and the nulls each type takes.
    const constant = (t: PayoffTask): PayoffAnswer => ({
      ...copied(t),
      months_full: 1,
      days_partial: 0,
      disposition: "paid_in_full_overage_refund_10bd",
      servicing_fee_cents: t.investor.remittance_type === "AA" ? "0" : null,
      ss_interest_gap_cents: t.investor.remittance_type === "SS" ? "0" : null,
    });
    // Every date and count right (each a call or two to the date tools), the per diem from its
    // own tool, whether the alternative applies read off the dates, and the disposition guessed
    // from the funds' day against the good-through: no interest, no total, no share.
    const datesOnly = (t: PayoffTask): PayoffAnswer => {
      const w = expectedPayoff(t);
      const [funds, gt] = [t.funds.received_on, t.request.good_through];
      return {
        ...constant(t),
        federal_due: w.federal_due,
        state_due: w.state_due,
        governing: w.governing,
        governing_due: w.governing_due,
        valid_until: w.valid_until,
        months_full: w.months_full,
        days_partial: w.days_partial,
        per_diem_cents: w.per_diem_cents,
        alt_applies: w.alt_applies,
        payoff_date: w.payoff_date,
        escrow_refund_by: w.escrow_refund_by,
        disposition:
          funds < gt
            ? "paid_in_full_overage_refund_10bd"
            : funds === gt
              ? "paid_in_full"
              : "short_payoff_demand_1bd",
      };
    };
    const held = generatePayoffSuite("heldout", 1, 200);
    const scored = (f: (t: PayoffTask) => PayoffAnswer) => {
      const grades = held.map((t) => gradePayoffAgainst(expectedPayoff(t), f(t)));
      return {
        mean: grades.reduce((a, g) => a + g.score, 0) / grades.length,
        passed: grades.filter((g) => g.pass).length,
      };
    };

    it("copied back, or the best constant: about a tenth", () => {
      // 0.086 and 0.118 on the held-out suite.
      expect(scored(copied)).toMatchObject({ passed: 0 });
      expect(scored(copied).mean).toBeLessThan(0.12);
      expect(scored(constant).mean).toBeLessThan(0.14);
    });

    it("every date right and no money: about half the fields, and never a pass", () => {
      // 0.549 on the held-out suite: the deadlines, the day count, the per diem and the escrow
      // refund's day are five fields of twelve, and none of them is money. The mean field score is
      // read against this, never in place of the pass.
      const s = scored(datesOnly);
      expect(s.passed).toBe(0);
      expect(s.mean).toBeGreaterThan(0.5);
      expect(s.mean).toBeLessThan(0.6);
    });
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    // The generator keeps a draw only once the reference solves it, so a pass on a suite it built
    // would prove nothing by itself if anything had been redrawn. Every held-out payoff is its
    // index's first draw: nothing there was put back for disagreeing.
    const drawn = Array.from({ length: PAYOFF_HELDOUT_SUITE.n }, (_, i) =>
      drawPayoffTask(PAYOFF_HELDOUT_SUITE.split, PAYOFF_HELDOUT_SUITE.seed, i),
    );
    expect(drawn.filter((x) => x.attempts > 1).map((x) => x.task.id)).toEqual([]);
    const r = await solveAll([...SPEC, ...drawn.map((x) => x.task)]);
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
      // A statement before the request it answers, one good through a day before it was issued,
      // and one issued on a Saturday.
      const answeredEarly = { ...base, request: { ...base.request, received_on: D("2026-09-16") } };
      expect(out(answeredEarly)).toBe(false);
      const goodBeforeIssue = {
        ...base,
        request: { ...base.request, issued_on: D("2026-10-16"), good_through: D("2026-10-15") },
        funds: { ...base.funds, received_on: D("2026-10-16") },
        investor: { ...base.investor, reported_on: D("2026-10-16") },
      };
      expect(out(goodBeforeIssue)).toBe(false);
      const saturdayStatement = {
        ...base,
        request: { ...base.request, issued_on: D("2026-09-19") },
      };
      expect(out(saturdayStatement)).toBe(false);
      // Nothing wired, or less than nothing.
      for (const amount_cents of [0n, -100n])
        expect(out({ ...base, funds: { ...base.funds, amount_cents } })).toBe(false);
    });

    it("a statement good through a day the loan is not yet paid to, and a due date other than the next", () => {
      // Paid through October and good through October 30: the statement accrues back from
      // November 1.
      const pastGoodThrough = {
        ...base,
        request: { ...base.request, good_through: D("2026-10-30") },
        loan: { ...base.loan, lpi_due: D("2026-11-01") },
        funds: { ...base.funds, received_on: D("2026-11-02"), installment_due_on: D("2026-12-01") },
        investor: { ...base.investor, reported_on: D("2026-11-02") },
      };
      expect(analyzePayoff(pastGoodThrough).statement.interest.days_partial).toBeLessThan(0);
      expect(out(pastGoodThrough)).toBe(false);
      // The non-business-day rule tests the next unpaid installment. Tested on the one already paid
      // (Sunday 11/01), it deems Monday's funds received on that Sunday and drops a day's $44.22.
      const paid = { ...spec(13), loan: { ...spec(13).loan, lpi_due: D("2026-11-01") } };
      expect(analyzePayoff(paid).payoff_on).toBe("2026-11-01");
      expect(analyzePayoff(paid).exact.interest.total_cents).toBe(0n);
      expect(out(paid)).toBe(false);
      const next = { ...paid, funds: { ...paid.funds, installment_due_on: D("2026-12-01") } };
      expect(analyzePayoff(next).exact.interest.partial_cents).toBe(4_422n);
      expect(out(next)).toBe(true);
    });
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump PAYOFF_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generatePayoffSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"21742e9a1a02c896b415b42a0b7074a9a06137c2819a947e7d54a0f032007f96"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out payoff into training", () => {
    expect(toJsonLine(generatePayoffTask("train", 7, 17))).toBe(
      toJsonLine(generatePayoffSuite("train", 7, 30)[17]),
    );
    const fp = (t: PayoffTask) => toJsonLine(payoffPayload(t));
    const held = new Set(generatePayoffSuite("heldout", 1, 200).map(fp));
    expect(generatePayoffSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  });

  describe("each edge turns up, in its own hundred", () => {
    const runs = generatePayoffSuite("train", 1, 1300).map((t, i) => ({
      t,
      a: expectedPayoff(t),
      x: analyzePayoff(t),
      edge: payoffEdgeOf(i),
    }));
    type Run = (typeof runs)[number];
    // An edge's aim is counted in its own payoffs, so taking the aim away takes its count to
    // nothing however many the other edges draw by chance. A property no edge owns is counted in
    // the whole suite.
    const count = (f: (r: Run) => boolean, edge?: PayoffEdge) =>
      runs.filter((r) => (edge === undefined || r.edge === edge) && f(r)).length;
    const dsi = (r: Run) => r.t.loan.accrual_method === "daily_simple_365";
    const early = (r: Run) => daysBetween(r.x.payoff_on, r.t.request.good_through);
    const short = (r: Run) => r.x.reconciled.variance_cents < -5000n;
    const relies = (r: Run) => ["FL", "TX", "CA"].includes(r.t.request.state);
    const firstOfPayoffMonth = (r: Run) => D(`${r.x.payoff_on.slice(0, 8)}01`);
    const onBd1 = (r: Run) => r.x.payoff_on === fannieBusinessDay(r.x.payoff_on, 1);

    it("cycles through every edge, a hundred payoffs each", () => {
      for (const edge of PAYOFF_EDGES)
        expect(runs.filter((r) => r.edge === edge)).toHaveLength(100);
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
      expect(count((r) => r.t.investor.remittance_type === "SA")).toBeGreaterThan(200);
      expect(count((r) => r.a.servicing_fee_cents !== null)).toBeGreaterThan(300);
    });

    it("draws a good-through on the 1st and on the last day of a month, and late funds across the month end", () => {
      expect(
        count(
          (r) =>
            r.t.request.good_through.endsWith("-01") &&
            r.a.months_full === 1 &&
            r.a.days_partial === 0,
          "first_of_month",
        ),
      ).toBeGreaterThan(50);
      // A good-through on the last paid installment's own due date: no interest at all.
      expect(
        count((r) => r.t.request.good_through === r.t.loan.lpi_due, "first_of_month"),
      ).toBeGreaterThan(12);
      expect(
        count(
          (r) => addDays(r.t.request.good_through, 1).endsWith("-01") && r.a.days_partial >= 27,
          "end_of_month",
        ),
      ).toBeGreaterThan(80);
      expect(
        count(
          (r) =>
            r.x.payoff_on > r.t.request.good_through &&
            r.x.payoff_on.slice(0, 7) !== r.t.request.good_through.slice(0, 7),
          "end_of_month",
        ),
      ).toBeGreaterThan(20);
    });

    it("draws daily simple interest across a month end and across February 29, and a monthly partial in a leap February", () => {
      expect(
        count(
          (r) => dsi(r) && r.t.request.good_through.slice(0, 7) !== r.t.loan.lpi_due.slice(0, 7),
          "daily_simple",
        ),
      ).toBeGreaterThan(50);
      expect(
        count(
          (r) =>
            dsi(r) && r.t.loan.lpi_due <= "2028-02-29" && r.t.request.good_through > "2028-02-29",
          "leap_day",
        ),
      ).toBeGreaterThan(15);
      expect(
        count(
          (r) => !dsi(r) && r.t.request.good_through.startsWith("2028-02") && r.a.days_partial > 0,
          "leap_day",
        ),
      ).toBeGreaterThan(12);
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
          count((r) => l(r)[k] > 0n, "nib_and_fees"),
          k,
        ).toBeGreaterThan(30);
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
          "nib_and_fees",
        ),
      ).toBeGreaterThan(60);
    });

    it("draws funds a day early and a day late, a day's interest either side of the $50.00 tolerance, and more", () => {
      expect(
        count(
          (r) => early(r) === 1 && r.a.disposition === "paid_in_full_overage_refund_10bd",
          "early_funds",
        ),
      ).toBeGreaterThan(35);
      expect(count((r) => early(r) > 1, "early_funds")).toBeGreaterThan(25);
      expect(
        count(
          (r) => early(r) === -1 && r.a.disposition === "paid_in_full_tolerance_expense",
          "late_funds",
        ),
      ).toBeGreaterThan(8);
      expect(
        count(
          (r) => early(r) === -1 && r.a.disposition === "short_payoff_demand_1bd",
          "late_funds",
        ),
      ).toBeGreaterThan(20);
      expect(count((r) => early(r) < -1, "late_funds")).toBeGreaterThan(25);
    });

    it("draws the variance on each threshold in turn: exact, a cent and $50.00 short kept, $50.01 short demanded, $1.01 over refunded", () => {
      for (const [v, ds] of [
        ["0", ["paid_in_full"]],
        ["-1", ["paid_in_full_tolerance_expense"]],
        ["-5000", ["paid_in_full_tolerance_expense"]],
        // Demanded, unless Florida, Texas or California relies on it.
        ["-5001", ["short_payoff_demand_1bd", "reliance_absorbed"]],
        ["101", ["paid_in_full_overage_refund_10bd"]],
      ] as const) {
        const on = (r: Run) => r.a.variance_cents === v;
        expect(count(on, "tolerance"), v).toBe(20);
        expect(
          count((r) => on(r) && !(ds as readonly string[]).includes(r.a.disposition)),
          v,
        ).toBe(0);
      }
      expect(
        count(
          (r) => r.a.variance_cents === "-5001" && r.a.disposition === "short_payoff_demand_1bd",
        ),
      ).toBeGreaterThan(10);
      // And the figures between, from every other edge.
      const v = (r: Run) => r.x.reconciled.variance_cents;
      expect(count((r) => v(r) < -1n && v(r) > -5000n)).toBeGreaterThan(30);
      expect(count((r) => v(r) > 101n)).toBeGreaterThan(200);
    });

    it("draws each side of reliance in turn: the state, the good-through day, and after it", () => {
      const reliance = (f: (r: Run) => boolean) => count((r) => short(r) && f(r), "reliance");
      const within = (r: Run) => r.x.payoff_on <= r.t.request.good_through;
      const absorbed = (r: Run) => r.a.disposition === "reliance_absorbed";
      const demanded = (r: Run) => r.a.disposition === "short_payoff_demand_1bd";
      expect(
        reliance(
          (r) =>
            ["FL", "TX"].includes(r.t.request.state) &&
            r.x.payoff_on < r.t.request.good_through &&
            absorbed(r),
        ),
      ).toBeGreaterThanOrEqual(20);
      expect(
        reliance((r) => r.t.request.state === "CA" && within(r) && absorbed(r)),
      ).toBeGreaterThanOrEqual(20);
      expect(
        reliance((r) => relies(r) && r.x.payoff_on === r.t.request.good_through && absorbed(r)),
      ).toBeGreaterThanOrEqual(20);
      expect(reliance((r) => !relies(r) && within(r) && demanded(r))).toBeGreaterThanOrEqual(20);
      expect(reliance((r) => relies(r) && !within(r) && demanded(r))).toBeGreaterThanOrEqual(20);
    });

    it("draws funds deemed received on a non-business due date, funds a business day too late for it, and a due date the rule does not reach", () => {
      const due = (r: Run) => r.t.funds.installment_due_on;
      const fundsOn = (r: Run) => r.t.funds.received_on;
      expect(count((r) => r.x.payoff_on !== fundsOn(r), "deemed_date")).toBeGreaterThanOrEqual(50);
      expect(
        count(
          (r) =>
            !servicer.isBusinessDay(due(r)) && fundsOn(r) === addBusinessDays(due(r), 2, servicer),
          "deemed_date",
        ),
      ).toBeGreaterThanOrEqual(25);
      expect(
        count(
          (r) =>
            servicer.isBusinessDay(due(r)) && fundsOn(r) === addBusinessDays(due(r), 1, servicer),
          "deemed_date",
        ),
      ).toBeGreaterThanOrEqual(25);
    });

    it("draws the seven-business-day clock across a holiday, ties, a state that governs, and Saturday deadlines", () => {
      const holidayIn = (r: Run) => {
        for (let d = addDays(r.t.request.received_on, 1); d <= r.a.federal_due; d = addDays(d, 1))
          if (isFederalHoliday(d) && dayOfWeek(d) % 6 !== 0) return true;
        return false;
      };
      expect(count(holidayIn, "deadline_holiday")).toBeGreaterThan(70);
      expect(
        count((r) => !servicer.isBusinessDay(r.t.request.received_on), "deadline_holiday"),
      ).toBeGreaterThan(25);
      // A request that arrives on the weekend before a Monday holiday, the clock's longest start.
      const weekendBeforeHoliday = (r: Run) => {
        const d = r.t.request.received_on;
        return (
          dayOfWeek(d) % 6 === 0 &&
          [1, 2].some((k) => isFederalHoliday(addDays(d, k)) && dayOfWeek(addDays(d, k)) === 1)
        );
      };
      expect(count(weekendBeforeHoliday, "deadline_holiday")).toBeGreaterThan(12);
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
          "deadline_holiday",
        ),
      ).toBeGreaterThanOrEqual(20);
      // Massachusetts: good for at least thirty days from the statement, and the good-through
      // when that is later.
      expect(
        count((r) => r.t.request.state === "MA" && r.a.valid_until !== r.t.request.good_through),
      ).toBeGreaterThan(50);
      expect(
        count(
          (r) =>
            r.t.request.state === "MA" &&
            r.a.valid_until === r.t.request.good_through &&
            r.t.request.good_through > addDays(r.t.request.issued_on, 30),
          "deadline_holiday",
        ),
      ).toBe(20);
    });

    it("draws the next installment inside the window, on the statement date, on the good-through, and after it", () => {
      const n = (r: Run) => r.t.next_installment;
      const alternative = (f: (r: Run) => boolean) => count(f, "alternative");
      expect(
        alternative((r) => r.a.alt_applies && n(r)!.due_on < r.t.request.good_through),
      ).toBeGreaterThan(30);
      expect(
        alternative((r) => !r.a.alt_applies && n(r)?.due_on === r.t.request.issued_on),
      ).toBeGreaterThan(12);
      expect(
        alternative((r) => r.a.alt_applies && n(r)?.due_on === r.t.request.good_through),
      ).toBeGreaterThan(4);
      expect(
        alternative(
          (r) => n(r) !== null && !r.a.alt_applies && n(r)!.due_on > r.t.request.good_through,
        ),
      ).toBeGreaterThan(6);
      expect(count((r) => r.a.alt_applies && n(r)!.autodraft)).toBeGreaterThan(50);
    });

    it("carries the next installment whenever it falls due after the statement date and by the good-through (16.1 rule 7)", () => {
      const inWindow = (t: PayoffTask) =>
        t.funds.installment_due_on > t.request.issued_on &&
        t.funds.installment_due_on <= t.request.good_through;
      expect(runs.filter((r) => inWindow(r.t) && !r.t.next_installment).map((r) => r.t.id)).toEqual(
        [],
      );
      expect(count((r) => inWindow(r.t))).toBeGreaterThan(400);
      // Outside it the statement may carry it or not, and prints one figure either way.
      expect(count((r) => !inWindow(r.t) && r.t.next_installment === null)).toBeGreaterThan(100);
      // The spec's worked examples print one figure and carry no installment, where the spec's
      // own figures do: example A's October installment is inside its window.
      expect(SPEC.filter((t) => inWindow(t) && !t.next_installment).map((t) => t.index)).toEqual([
        0, 1, 9, 12, 13, 14,
      ]);
    });

    it("draws each S/S payoff on the month's first business day in turn: the MBS exception both kinds of 1st, a report on the third, and a portfolio loan", () => {
      const ss = (r: Run) => r.t.investor.remittance_type === "SS";
      const mbs = (r: Run) => ss(r) && r.t.investor.mbs_pool;
      const owes = (r: Run) => r.a.fnma_interest_cents !== "0";
      const firstIsBd = (r: Run) => servicer.isBusinessDay(firstOfPayoffMonth(r));
      expect(
        count((r) => mbs(r) && onBd1(r) && !owes(r) && firstIsBd(r), "remittance"),
      ).toBeGreaterThanOrEqual(20);
      expect(
        count((r) => mbs(r) && onBd1(r) && !owes(r) && !firstIsBd(r), "remittance"),
      ).toBeGreaterThanOrEqual(40);
      expect(
        count(
          (r) =>
            mbs(r) &&
            onBd1(r) &&
            owes(r) &&
            r.t.investor.reported_on > fannieBusinessDay(r.x.payoff_on, 2),
          "remittance",
        ),
      ).toBeGreaterThanOrEqual(20);
      expect(
        count(
          (r) =>
            ss(r) &&
            !r.t.investor.mbs_pool &&
            onBd1(r) &&
            owes(r) &&
            r.t.investor.reported_on <= fannieBusinessDay(r.x.payoff_on, 2),
          "remittance",
        ),
      ).toBeGreaterThanOrEqual(20);
      // Paid off on the 1st: the gap is the whole month.
      expect(
        count(
          (r) => ss(r) && owes(r) && r.a.ss_interest_gap_cents === r.a.fnma_interest_cents,
          "remittance",
        ),
      ).toBeGreaterThan(8);
      // And MBS loans beyond the edge, each paid off on whatever day its funds arrived.
      expect(count((r) => r.edge !== "remittance" && mbs(r))).toBeGreaterThan(100);
    });

    it("draws Fannie Mae's rate stack: a servicing fee from 0.25 % to 0.50 %, and on an MBS loan a guaranty fee besides", () => {
      // Note rate less pass-through rate, in thousandths of a percent.
      const strip = (r: Run) =>
        Math.round(Number(r.t.loan.rate_pct) * 1000) -
        Math.round(Number(r.t.investor.ptr_pct) * 1000);
      const outside = runs.filter((r) => {
        const s = strip(r);
        return r.t.investor.mbs_pool ? s < 500 || s > 1000 : s < 250 || s > 500;
      });
      expect(outside.map((r) => r.t.id)).toEqual([]);
      expect(count((r) => !r.t.investor.mbs_pool && strip(r) === 250)).toBeGreaterThan(500);
      expect(new Set(runs.map(strip)).size).toBeGreaterThan(8);
    });
  });

  it("puts every rule that turns on one case into the held-out suite itself, a handful of each", () => {
    // Each line is the held-out payoffs on which a wrong reading of one rule answers differently
    // from the engine. A suite without them scores the wrong reading as it scores the right one.
    const held = generatePayoffSuite("heldout", 1, 200).map((t) => ({
      t,
      x: analyzePayoff(t),
      a: expectedPayoff(t),
    }));
    type H = (typeof held)[number];
    const v = (h: H) => h.x.reconciled.variance_cents;
    const within = (h: H) => h.x.payoff_on <= h.t.request.good_through;
    const relies = (h: H) => ["FL", "TX", "CA"].includes(h.t.request.state);
    const mbsBd1 = (h: H, pool: boolean) =>
      h.t.investor.remittance_type === "SS" &&
      h.t.investor.mbs_pool === pool &&
      h.x.payoff_on === fannieBusinessDay(h.x.payoff_on, 1);
    const firstIsBd = (h: H) => servicer.isBusinessDay(D(`${h.x.payoff_on.slice(0, 8)}01`));
    const bd2 = (h: H) => fannieBusinessDay(h.x.payoff_on, 2);
    const due = (h: H) => h.t.funds.installment_due_on;
    const cases: Record<string, (h: H) => boolean> = {
      "reliance in every state": (h) => v(h) < -5000n && within(h) && !relies(h),
      "reliance without California": (h) =>
        v(h) < -5000n && within(h) && h.t.request.state === "CA",
      "reliance only before the good-through": (h) =>
        v(h) < -5000n && relies(h) && h.x.payoff_on === h.t.request.good_through,
      "a cent short as paid in full": (h) => v(h) === -1n,
      "$50.00 short demanded": (h) => v(h) === -5000n,
      "$50.01 short kept": (h) => v(h) === -5001n,
      "$1.01 over kept": (h) => v(h) === 101n,
      "BD1 as the 1st when the 1st is not a business day": (h) =>
        mbsBd1(h, true) && !firstIsBd(h) && h.t.investor.reported_on <= bd2(h),
      "BD2 as the business day after the 1st": (h) =>
        mbsBd1(h, true) && !firstIsBd(h) && h.t.investor.reported_on === bd2(h),
      "the MBS exception for a portfolio loan": (h) =>
        mbsBd1(h, false) && h.t.investor.reported_on <= bd2(h),
      "the non-business-day rule on a business day": (h) =>
        servicer.isBusinessDay(due(h)) &&
        h.t.funds.received_on === addBusinessDays(due(h), 1, servicer),
      "Connecticut's requested date below its floor": (h) =>
        h.t.request.state === "CT" && h.t.request.good_through < h.a.federal_due,
      "Massachusetts' thirty days over a later good-through": (h) =>
        h.t.request.state === "MA" && h.t.request.good_through > addDays(h.t.request.issued_on, 30),
    };
    const thin = Object.entries(cases)
      .map(([name, f]) => [name, held.filter(f).length] as const)
      .filter(([, n]) => n < 3);
    expect(thin).toEqual([]);
  });

  it("names a payoff's disposition as its verdict, to the audit and to the comparison", async () => {
    const task = spec(1);
    const result = await runEpisode(payoffStatement, task, new PayoffReferencePolicy());
    const record: AuditRecord = {
      task: {
        id: task.id,
        split: task.split,
        index: task.index,
        rendered: payoffStatement.render(task),
      },
      policy: { id: "reference" },
      result: result as unknown as AuditRecord["result"],
    };
    expect(auditEpisode(record).verdict).toBe("short_payoff_demand_1bd");
    const line = {
      task: { id: task.id },
      policy: { id: "reference" },
      result,
    } as unknown as EpisodeLine;
    expect(scoreSide([line]).byTask.get(task.id)?.verdict).toBe("short_payoff_demand_1bd");
  });
});
