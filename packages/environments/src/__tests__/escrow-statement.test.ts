/**
 * The annual escrow statement's explanation: the lines are the servicing
 * app's statement engine and no other (the port is its file byte for byte
 * but the imports), the pairing around it restates the servicing app's own
 * statement assembly, and the two together give §3.3's worked example and
 * 3.3-T9 exactly as the servicing app's spec and its own tests state them.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addMonths, type PlainDate } from "@hm/kernel/calendar";
import type { Cents } from "@hm/kernel/money";
import {
  escrowSpecTasks,
  expectedEscrow,
  statementExplanation,
  statementHistory,
  statementScopeIssues,
  type StatementAnalysis,
  type StatementDisbursement,
  type StatementLedger,
} from "../escrow/index.js";
import { project, type ProjectedItem } from "../escrow/ported/analysis.js";
import { lowPointExplanation } from "../escrow/ported/statement.js";
import { statementReading } from "../escrow/statement.js";
import {
  analysisDecision,
  defaultCalibration,
  demoLoan,
  escrowYears,
  generate,
  noStatementWhy,
  statementYearOf,
  type LifeBook,
  type LoanLife,
} from "../life/index.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const imports = (text: string) => text.split("\n").filter((l) => l.startsWith("import "));
const withoutImports = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith("import "))
    .join("\n");
/** Each import line with its module path removed: what it imports, and how. */
const importHeads = (text: string) => imports(text).map((l) => l.replace(/ from "[^"]+";$/, ""));
/** The one rewrite the port may carry: the kernel's paths become the package's. */
const rewritten = (lines: readonly string[]) =>
  lines.map((l) =>
    l.replace(/"\.\.\/\.\.\/kernel\/(money|calendar)\/[a-z-]+\.ts"/g, '"@hm/kernel/$1"'),
  );

const servicing = (file: string) =>
  readFileSync(here(`../../../../apps/servicing/${file}`), "utf8");
/** A run of source lines, found by how the first begins, with the lines they are cited by. */
const sourceLines = (file: string, first: string, n: number) => {
  const lines = servicing(`src/${file}`).split("\n");
  const start = lines.findIndex((l) => l.trimStart().startsWith(first));
  if (start < 0) return `${file}: no line beginning ${first}`;
  return [`${file}:${start + 1}-${start + n}`, ...lines.slice(start, start + n)].join("\n");
};
/** The lines a servicing app spec test asserts, read out of that test: `assert.deepEqual(<name>, [...])` inside the named test. */
const assertedLines = (testName: string, name: string): string[] => {
  const text = servicing("src/domain/escrow/3-3.spec.test.ts");
  const body = text.slice(text.indexOf(`test("${testName}`));
  const m = new RegExp(`assert\\.deepEqual\\(${name}, (\\[[^\\]]*\\])\\);`).exec(body);
  if (!m) throw new Error(`no assert.deepEqual(${name}, [...]) in "${testName}"`);
  return JSON.parse(m[1]!) as string[];
};

const D = (s: string) => s as PlainDate;
const $ = (dollars: string): Cents => BigInt(dollars.replace(".", ""));

/**
 * §3.3's worked example, its year 2026-07-01 to 2027-06-30. Last year's
 * projection is the servicing app's own `E` (3-3.spec.test.ts:10): county tax
 * $500.00 in July and $700.00 in December, school tax $360.00 in September,
 * with the default two-month cushion.
 */
const E: ProjectedItem[] = [
  { line_type: "school_tax", amount_cents: $("360.00"), disburse_on: D("2026-09-15") },
  { line_type: "county_tax", amount_cents: $("500.00"), disburse_on: D("2026-07-15") },
  { line_type: "county_tax", amount_cents: $("700.00"), disburse_on: D("2026-12-15") },
];
const PRIOR: StatementAnalysis = {
  year_start: D("2026-07-01"),
  projection: project(E, D("2026-07-01")),
};
/** The names the servicing app's test gives the lines (its HISTORY, 3-3.spec.test.ts:58). */
const LABELS = {
  county_tax: "County tax",
  school_tax: "School tax",
  supplemental_tax: "supplemental tax",
};
/** Twelve deposits of $130.00, one on each due date. */
const DEPOSITS = Array.from({ length: 12 }, (_, k) => ({
  on: addMonths(D("2026-07-01"), k),
  amount_cents: $("130.00"),
}));
const ledger = (
  disbursements: StatementDisbursement[],
  opening = $("1040.00"),
): StatementLedger => ({
  opening_balance_cents: opening,
  deposits: DEPOSITS,
  disbursements,
});
const bill = (on: string, line_type: string, amount: string): StatementDisbursement => ({
  on: D(on),
  line_type,
  amount_cents: $(amount),
});
/** The history: start $1,040.00; bills Jul $520 (proj. $500), Sep $360, Dec $760 (proj. $700), Mar $260 supplemental (not projected). */
const WORKED = ledger([
  bill("2026-07-15", "county_tax", "520.00"),
  bill("2026-09-15", "school_tax", "360.00"),
  bill("2026-12-15", "county_tax", "760.00"),
  bill("2027-03-15", "supplemental_tax", "260.00"),
]);
/** The year exactly as projected. */
const AS_PROJECTED = ledger(
  E.map((i) => ({ on: i.disburse_on, line_type: i.line_type, amount_cents: i.amount_cents })),
);

describe("the annual escrow statement's explanation", () => {
  it("is the servicing app's statement engine: the port is its file but for the imports", () => {
    const original = servicing("src/domain/escrow/statement.ts");
    const port = readFileSync(here("../escrow/ported/statement.ts"), "utf8");
    expect(withoutImports(port)).toBe(withoutImports(original));
    expect(imports(port)).toEqual(rewritten(imports(original)));
    // The same names, imported the same way, from the kernel the servicing app's copy is.
    expect(importHeads(port)).toEqual(importHeads(original));
    for (const l of imports(port)) expect(l).toMatch(/ from "@hm\/kernel\/(money|calendar)";$/);
    const from = readFileSync(here("../escrow/ported/PORTED_FROM"), "utf8");
    const vendored = servicing("VENDORED_FROM");
    const commit = /Commit\s+([0-9a-f]{40})/.exec(vendored)![1]!;
    expect(from).toContain(commit);
    expect(from).toContain("apps/servicing/src/domain/escrow/statement.ts");
  });

  it("reads the history the way the servicing app's statement assembly does", () => {
    // The month-end balance: the opening balance, plus each month's deposits, less its disbursements.
    expect(sourceLines("domain/escrow/ops.ts", "export function buildHistory(", 4)).toBe(
      [
        "domain/escrow/ops.ts:109-112",
        "export function buildHistory(openingBalanceCents: Cents, rows: readonly { month: PlainDate; deposits_cents: Cents; disbursements: readonly { line: string; amount_cents: Cents; projected_cents: Cents | null }[] }[]): StatementHistoryRow[] {",
        "  let bal = openingBalanceCents;",
        "  return rows.map((r) => { bal += r.deposits_cents - r.disbursements.reduce((s, d) => s + d.amount_cents, 0n); return { month: r.month, deposits_cents: r.deposits_cents, disbursements: r.disbursements, balance_cents: bal }; });",
        "}",
      ].join("\n"),
    );
    // The low balance: the lowest month-end balance, the opening balance not among them.
    expect(
      sourceLines("domain/escrow/ops.ts", "ending_balance_cents: history.length ?", 1),
    ).toContain(
      "low_balance_cents: history.length ? history.reduce((m, r) => (r.balance_cents < m ? r.balance_cents : m), history[0]!.balance_cents) : null,",
    );
    // The projected low: the worked example reads December's target, the projection's lowest, its cushion.
    expect(PRIOR.projection.targets[5]).toBe($("260.00"));
    expect(statementHistory(PRIOR, WORKED).projected_low_cents).toBe($("260.00"));
    expect(project(E, D("2026-07-01")).cushion_cents).toBe($("260.00"));
    // Last year's target at the start is the year's opening balance.
    expect(project(E, D("2026-07-01")).target_at_start_cents).toBe($("1040.00"));
  });

  it("starts from the servicing app's own example: its last-year projection and its line names", () => {
    const source = servicing("src/domain/escrow/3-3.spec.test.ts").split("\n");
    const dollars = (c: Cents) => `${c / 100n}${c % 100n === 0n ? "" : `.${c % 100n}`}`;
    expect(source).toContain(
      `const E = [${E.map((i) => `{ line_type: "${i.line_type}", amount_cents: cents("${dollars(i.amount_cents)}"), disburse_on: D("${i.disburse_on}") }`).join(", ")}];`,
    );
    const history = source.find((l) => l.startsWith("const HISTORY = "))!;
    for (const label of Object.values(LABELS)) expect(history).toContain(`line: "${label}"`);
  });

  it("gives §3.3's worked example: the four lines of item (viii) the spec prints and its test asserts", () => {
    const lines = statementExplanation(PRIOR, WORKED, LABELS);
    expect(lines).toEqual(assertedLines("3.3 worked example", "viii"));
    expect(lines).toEqual([
      "County tax paid 07/2026 was $520.00 vs $500.00 projected",
      "County tax paid 12/2026 was $760.00 vs $700.00 projected",
      "a supplemental tax bill of $260.00 was paid 03/2027 (not projected)",
      "low balance $180.00 vs $260.00 projected",
    ]);
    // The spec's prose prints the same four, joined, with the second label in lower case.
    const spec = servicing(
      "spec/sections/03-escrow-administration/3-3-annual-escrow-account-statement.md",
    );
    const printed = /item \(viii\) prints: "([^"]+)\."/.exec(spec)![1]!.split("; ");
    expect(printed.map((l) => l.toLowerCase())).toEqual(lines.map((l) => l.toLowerCase()));
  });

  it("gives the worked example's history: $1,560.00 in, $1,900.00 out, $180.00 in December, $700.00 at the end", () => {
    const h = statementHistory(PRIOR, WORKED, LABELS);
    const total = (k: "deposits_cents" | "disbursements_cents") =>
      h.months.reduce((s, m) => s + m[k], 0n);
    expect(total("deposits_cents")).toBe($("1560.00"));
    expect(total("disbursements_cents")).toBe($("1900.00"));
    expect(h.months.map((m) => m.balance_cents)).toEqual(
      ["650", "780", "550", "680", "810", "180", "310", "440", "310", "440", "570", "700"].map(
        (x) => $(`${x}.00`),
      ),
    );
    expect(h.actual_low_cents).toBe($("180.00"));
    expect(h.ending_balance_cents).toBe($("700.00"));
    // The September school tax was as projected: a history line, and nothing to explain.
    expect(h.lines.find((l) => l.line_type === "School tax")).toEqual({
      month: "2026-09-01",
      line_type: "School tax",
      projected_cents: $("360.00"),
      actual_cents: $("360.00"),
    });
  });

  it("explains the payment §3.2's worked example sets: its year begins at the $700.00 this one ends at", () => {
    // §3.3's statement goes out with §3.2's analysis (its 2027-05-18 approval): May's balance is the
    // analysis's ledger balance, and the year's end its projected actual.
    const [task] = escrowSpecTasks();
    const h = statementHistory(PRIOR, WORKED, LABELS);
    expect(h.months[10]!.balance_cents).toBe(task!.ledger.balance_cents);
    const analysis = expectedEscrow(task!);
    expect(analysis.projected_actual_cents).toBe(h.ending_balance_cents.toString());
    // The shortage the statement explains, "$33.89 per month for 12 months beginning 07/01/2027", and
    // the payment it explains, $172.22 against last year's $130.00.
    expect(analysis).toMatchObject({
      decision: "shortage",
      shortage_cents: "40668",
      repayment_months: 12,
      installment_cents: "3389",
      effective_on: "2027-07-01",
      new_payment_cents: "17222",
    });
    expect(PRIOR.projection.items.length).toBe(3);
    expect(project(E, D("2026-07-01")).base_payment_cents).toBe($("130.00"));
  });

  it("gives 3.3-T9: December's county-tax variance and the low-balance difference", () => {
    const t9 = assertedLines("3.3-T9", "ex");
    expect(t9).toEqual([
      "County tax paid 12/2026 was $760.00 vs $700.00 projected",
      "low balance $180.00 vs $260.00 projected",
    ]);
    // T9's test takes its low from the worked example's year, where July's bill was over too.
    const worked = statementExplanation(PRIOR, WORKED, LABELS);
    for (const l of t9) expect(worked).toContain(l);
    // In a year where December's bill alone moved, the low is $200.00.
    const decemberOnly = ledger([
      bill("2026-07-15", "county_tax", "500.00"),
      bill("2026-09-15", "school_tax", "360.00"),
      bill("2026-12-15", "county_tax", "760.00"),
    ]);
    expect(statementExplanation(PRIOR, decemberOnly, LABELS)).toEqual([
      t9[0],
      "low balance $200.00 vs $260.00 projected",
    ]);
  });

  it("writes nothing when the year went as projected", () => {
    const h = statementHistory(PRIOR, AS_PROJECTED, LABELS);
    expect(h.months.map((m) => m.balance_cents)).toEqual(PRIOR.projection.targets);
    expect(statementExplanation(PRIOR, AS_PROJECTED, LABELS)).toEqual([]);
  });

  it("shows a bill that moved where it left and where it arrived, and a low that rose", () => {
    // December's county tax paid in January: the low is January's $390.00, a month's deposit above
    // the $260.00 December would have reached.
    const late = ledger([
      bill("2026-07-15", "county_tax", "500.00"),
      bill("2026-09-15", "school_tax", "360.00"),
      bill("2027-01-10", "county_tax", "700.00"),
    ]);
    expect(statementExplanation(PRIOR, late, LABELS)).toEqual([
      "County tax paid 12/2026 was $0.00 vs $700.00 projected",
      "a County tax bill of $700.00 was paid 01/2027 (not projected)",
      "low balance $390.00 vs $260.00 projected",
    ]);
  });

  it("sums a month's bills by line, keeps the order they posted, and prints a line type with no label as it is", () => {
    // July's two county payments make the $500.00 projected. A hazard premium nobody projected, met by
    // a larger opening balance, leaves every month-end where the projection put it.
    const split = ledger(
      [
        bill("2026-07-20", "county_tax", "300.00"),
        bill("2026-07-25", "county_tax", "200.00"),
        bill("2026-07-15", "hazard", "1710.50"),
        bill("2026-09-15", "school_tax", "360.00"),
        bill("2026-12-15", "county_tax", "700.00"),
      ],
      $("2750.50"),
    );
    const h = statementHistory(PRIOR, split, LABELS);
    expect(h.lines.filter((l) => l.month === "2026-07-01").map((l) => l.line_type)).toEqual([
      "hazard",
      "County tax",
    ]);
    expect(h.months.map((m) => m.balance_cents)).toEqual(PRIOR.projection.targets);
    // The engine prints every figure without a thousands separator.
    expect(statementExplanation(PRIOR, split, LABELS)).toEqual([
      "a hazard bill of $1710.50 was paid 07/2026 (not projected)",
    ]);
  });

  it("refuses a posting outside the computation year, a negative one, and a year not begun on the 1st", () => {
    const outside = ledger([bill("2027-07-15", "county_tax", "520.00")]);
    expect(() => statementHistory(PRIOR, outside)).toThrow(
      "a county_tax disbursement on 2027-07-15 is outside the computation year 2026-07-01 to 2027-06-30",
    );
    expect(() => statementHistory(PRIOR, ledger([bill("2026-07-15", "refund", "-5.00")]))).toThrow(
      "a refund disbursement on 2026-07-15 is negative",
    );
    expect(() => statementHistory({ ...PRIOR, year_start: D("2026-07-15") }, AS_PROJECTED)).toThrow(
      "a computation year starts on the first of a month, not 2026-07-15",
    );
    // The history is twelve month-ends; a biweekly projection's 26 targets are not its low.
    const biweekly = { ...PRIOR, projection: project(E, D("2026-07-01"), {}, { biweekly: true }) };
    expect(() => statementHistory(biweekly, AS_PROJECTED)).toThrow(
      "a monthly projection has twelve targets, not 26",
    );
  });

  it("takes the projected low as the lowest target, which sits above the cushion when the trial balance never reaches zero", () => {
    // One bill of $1,000.06 in June: the $83.34 payment rounds up, so the trial balance ends at 2 cents
    // and never falls to zero. The cushion is $166.67; the lowest target, June's, is $166.69.
    const june = project(
      [{ line_type: "hazard", amount_cents: $("1000.06"), disburse_on: D("2027-06-15") }],
      D("2026-07-01"),
    );
    expect(june.cushion_cents).toBe($("166.67"));
    const h = statementHistory(
      { year_start: D("2026-07-01"), projection: june },
      {
        opening_balance_cents: june.target_at_start_cents,
        deposits: Array.from({ length: 12 }, (_, k) => ({
          on: addMonths(D("2026-07-01"), k),
          amount_cents: june.base_payment_cents,
        })),
        disbursements: [bill("2027-06-15", "hazard", "1000.06")],
      },
    );
    expect(h.projected_low_cents).toBe($("166.69"));
    expect(h.months.map((m) => m.balance_cents)).toEqual(june.targets);
  });

  it("keeps escrow-4 out: an account overdrawn during the year is a scope issue, not a garbled line", () => {
    // A supplemental bill of $365.50 in December takes the account to −$105.50 at December's end.
    const overdrawn = ledger([
      ...AS_PROJECTED.disbursements,
      bill("2026-12-20", "supplemental_tax", "365.50"),
    ]);
    const h = statementHistory(PRIOR, overdrawn, LABELS);
    expect(h.actual_low_cents).toBe(-$("105.50"));
    expect(statementScopeIssues(h)).toEqual([
      "escrow-4: the low balance is negative (-10550 cents), which the engine cannot print",
    ]);
    expect(() => statementExplanation(PRIOR, overdrawn, LABELS)).toThrow(/^escrow-4: /);
    // What the engine itself writes: the sign inside the cents, and no sign at all under a dollar.
    expect(lowPointExplanation(h.lines, h.actual_low_cents, h.projected_low_cents)).toEqual([
      "a supplemental tax bill of $365.50 was paid 12/2026 (not projected)",
      "low balance $-105.-50 vs $260.00 projected",
    ]);
    expect(lowPointExplanation([], -50n, $("260.00"))).toEqual([
      "low balance $0.-50 vs $260.00 projected",
    ]);
    expect(statementScopeIssues(statementHistory(PRIOR, WORKED))).toEqual([]);
  });
  it("explains every whole computation year of a generated book, the overdrawn ones filtered", () => {
    // A 300-loan decade on the typed defaults. Each analysis row carries its projection's bills and targets, so a
    // year's history is held to the projection that set its payment, as the statement holds it.
    const book = generate(1, { loans: 300 }, { calibration: defaultCalibration() }).clean;
    const TEMPLATES = [
      /^a [a-z_ ]+ bill of \$\d+\.\d{2} was paid \d{2}\/\d{4} \(not projected\)$/,
      /^[a-z_ ]+ paid \d{2}\/\d{4} was \$\d+\.\d{2} vs \$\d+\.\d{2} projected$/,
      /^low balance \$\d+\.\d{2} vs \$\d+\.\d{2} projected$/,
    ];
    const seen = { years: 0, overdrawn: 0, quiet: 0, moved: 0, unprojected: 0, low: 0 };
    for (const loan of book.loans)
      for (const y of escrowYears(loan)) {
        seen.years++;
        const h = statementHistory(y.analysis, y.ledger);
        // The ledger is the history's: every month-end balance is the generator's own.
        expect(h.months.map((m) => m.balance_cents)).toEqual(y.month_end_balances);
        expect(y.analysis.projection.targets.length).toBe(12);
        if (statementScopeIssues(h).length > 0) {
          seen.overdrawn++;
          expect(h.actual_low_cents < 0n).toBe(true);
          expect(() => statementExplanation(y.analysis, y.ledger)).toThrow(/^escrow-4: /);
          continue;
        }
        const lines = statementExplanation(y.analysis, y.ledger);
        for (const l of lines)
          expect(
            TEMPLATES.some((t) => t.test(l)),
            l,
          ).toBe(true);
        if (lines.length === 0) seen.quiet++;
        if (lines.some((l) => TEMPLATES[1]!.test(l))) seen.moved++;
        if (lines.some((l) => TEMPLATES[0]!.test(l))) seen.unprojected++;
        if (lines.some((l) => TEMPLATES[2]!.test(l))) seen.low++;
      }
    expect(seen.years).toBeGreaterThan(1_000);
    // Every kind of line turns up.
    for (const k of ["moved", "unprojected", "low"] as const) expect(seen[k], k).toBeGreaterThan(0);
    expect(seen.overdrawn).toBeGreaterThan(0);
    expect(seen.overdrawn).toBeLessThan(seen.years / 20);
  });

  it("reads the year an analysis's statement explains: the history through its run date, then what it counted on, ending at its projected actual", () => {
    // Books of every kind the generator writes: a 300-loan decade, loans transferred in with vendor and system
    // errors made on their bills and payments (the clean book and its twins), and the demo loan's four.
    const cal = defaultCalibration();
    const errors = generate(
      "statement-years",
      {
        loans: 120,
        events: Array.from({ length: 40 }, (_, i) => ({
          kind: "transfer_in" as const,
          loan: 3 * i,
          month: 8 + (i % 30),
        })),
      },
      {
        calibration: cal,
        defects: [
          { id: "V-01", rate: 0.05 },
          { id: "V-02", rate: 1 },
          { id: "D-28", rate: 0.01 },
        ],
      },
    );
    const demo = demoLoan(cal);
    const books: LifeBook[] = [
      generate(1, { loans: 300 }, { calibration: cal }).clean,
      errors.clean,
      errors.defective!,
    ];
    const loans: LoanLife[] = [
      ...books.flatMap((b) => b.loans),
      demo.clean,
      demo.twins["D-42"],
      demo.twins["D-03"],
      demo.twins.defective,
    ];
    const why = new Map<string, number>();
    const seen = { analyses: 0, years: 0, whole: 0, assumed: 0, refused: 0, lines: 0 };
    for (const loan of loans) {
      const whole = new Map(escrowYears(loan).map((y) => [y.analysis.year_start, y]));
      for (const a of loan.analyses) {
        seen.analyses++;
        // The row's decision is the escrow port's, decided again from its figures.
        expect(analysisDecision(a).kind).toBe(a.decision);
        const y = statementYearOf(loan, a);
        const reason = noStatementWhy(loan, a);
        expect(y === null, `${loan.loan_id} ${a.as_of}`).toBe(reason !== null);
        if (!y) {
          const k = reason!.replace(/\(.*\)|\d{4}-\d{2}/g, "…");
          why.set(k, (why.get(k) ?? 0) + 1);
          continue;
        }
        seen.years++;
        expect(y.analysis.year_start).toBe(addMonths(a.year_start, -12));
        expect(y.row.year_start).toBe(y.analysis.year_start);
        const h = statementHistory(y.analysis, y.ledger);
        expect(h.ending_balance_cents, `${loan.loan_id} ${a.as_of}`).toBe(a.projected_actual);
        // After the run date, only what the analysis counted on, inside the year.
        for (const p of [...y.assumed.deposits, ...y.assumed.disbursements]) {
          expect(p.on > y.through).toBe(true);
          expect(p.on < a.year_start).toBe(true);
        }
        seen.assumed += y.assumed.deposits.length + y.assumed.disbursements.length;
        // Through the run date the postings are the history's: escrowYears' own, where it holds the year whole.
        const ey = whole.get(y.analysis.year_start);
        if (ey) {
          seen.whole++;
          const upTo = <T extends { on: PlainDate }>(xs: readonly T[]) =>
            xs.filter((p) => p.on <= y.through);
          expect(y.ledger.opening_balance_cents).toBe(ey.ledger.opening_balance_cents);
          expect(upTo(y.ledger.deposits)).toEqual(upTo(ey.ledger.deposits));
          expect(upTo(y.ledger.disbursements)).toEqual(upTo(ey.ledger.disbursements));
          const before = h.months.filter((m) => addMonths(m.month, 1) <= y.through);
          expect(before.map((m) => m.balance_cents)).toEqual(
            ey.month_end_balances.slice(0, before.length),
          );
        }
        // Item (viii) is the engine's: whole, or without the low line it cannot print.
        const r = statementReading(y.analysis, y.ledger);
        seen.lines += r.engine.length;
        if (r.refused.length) {
          seen.refused++;
          expect(r.low).toBeNull();
          expect(r.engine).toEqual(lowPointExplanation(h.lines, 0n, 0n));
          expect(() => statementExplanation(y.analysis, y.ledger)).toThrow(/^escrow-4: /);
        } else expect(r.engine).toEqual(statementExplanation(y.analysis, y.ledger));
        expect([...r.bills.map((b) => b.text), ...(r.low ? [r.low.text] : [])]).toEqual(r.engine);
      }
    }
    expect(seen.years).toBeGreaterThan(2_000);
    expect(seen.whole).toBeGreaterThan(seen.years * 0.9);
    expect(seen.assumed).toBeGreaterThan(seen.years);
    expect(seen.refused).toBeGreaterThan(0);
    // Why an analysis has no statement year: the first one, a borrower more than 30 days behind, a year on two
    // servicers' books or with a transfer in it, a history that ends before an installment the analysis counted on.
    expect([...why.keys()].sort()).toEqual(
      [
        "a transfer inside the year",
        "exempt …: no annual statement goes out",
        "the analysis is another servicer's than the year's",
        "the history ends before an installment the analysis counted on",
        "the year is on two servicers' books",
        "the year's payment was set by no analysis the history holds: nothing to hold it to",
      ].filter((k) => why.has(k)),
    );
    expect(why.get("the year is on two servicers' books") ?? 0).toBeGreaterThan(0);
    expect(
      why.get("the year's payment was set by no analysis the history holds: nothing to hold it to"),
    ).toBeGreaterThan(0);
    expect(why.get("exempt …: no annual statement goes out") ?? 0).toBeGreaterThan(0);
  });
});
