/**
 * The first demo's page (`npm run env:demo`): the build runs and writes one
 * self-contained page; the page's script parses and renders every view
 * against a stub DOM; the page's data is exactly what `demoPageData`
 * computes from the code on disk; and every figure a moment grades, and every
 * figure of what the defects cost, is what the engine gives, worked out here
 * again from the environments and the ports without the page's own code.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lateChargeAmount } from "../payments/ported/latecharges.js";
import { toJsonLine } from "../record.js";
import {
  DEMO_DEFECTS,
  DEMO_SCENARIO,
  DEMO_SEED,
  TAPE_HEADERS,
  defaultCalibration,
  demoLoan,
  generate,
  loadCalibration,
  writeTape,
  type CalibrationFile,
  type LifeMoment,
  type LifeResult,
  type LoanLife,
} from "../life/index.js";
import { boardingSpecTasks, expectedTriage, gradeTriage } from "../boarding/index.js";
import { catchupTaskAt, expectedCatchup, gradeCatchup } from "../catchup/index.js";
import { expectedEscrowReview, gradeReview, reviewTaskAt } from "../escrow-review/index.js";
import { demoPageData, type DemoPageData, type PagePosed } from "../demo/page-data.js";
import { bookPanel, type AcceptanceFile } from "../demo/book-panel.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

interface PageCheck {
  extractDemo(html: string): { json: string; data: DemoPageData; script: string };
  checkSyntax(script: string): void;
  smokeDemoPage(html: string): { views: number; pressed: number; years: number };
}

let dir = "";
let html = "";
let page: DemoPageData;
let check: PageCheck;
let built = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "demo-page-test-"));
  const out = join(dir, "demo.html");
  const r = spawnSync(process.execPath, [here("../../scripts/build-demo.mjs"), "--out", out], {
    encoding: "utf8",
  });
  built = `${r.stdout}\n${r.stderr}`;
  if (r.status !== 0) throw new Error(`build-demo.mjs failed:\n${built}`);
  html = readFileSync(out, "utf8");
  check = (await import(here("../../playground/demo/check-page.mjs"))) as PageCheck;
  page = check.extractDemo(html).data;
}, 120_000);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The demo scenario run again, here, with every moment it hands an engine. */
function demoRun(): {
  res: LifeResult;
  moments: { clean: Map<string, LifeMoment>; twin: Map<string, LifeMoment> };
} {
  const moments = { clean: new Map<string, LifeMoment>(), twin: new Map<string, LifeMoment>() };
  const res = generate(DEMO_SEED, DEMO_SCENARIO, {
    calibration: defaultCalibration(),
    defects: DEMO_DEFECTS.map((id) => ({ id, loans: [0] })),
    observe: (_i, h, m) =>
      moments[h].set(m.kind === "receipt" ? m.receipt_id : `analysis-${m.year}`, m),
  });
  return { res, moments };
}

const posed = (id: string, twin: "clean" | "defective"): PagePosed => {
  const p = page.moments.find((m) => m.id === id)!.twins[twin];
  if (!p.posed) throw new Error(`${id} is not posed on the ${twin} twin`);
  return p;
};

describe("the demo page", () => {
  it("is one self-contained page, titled, with nothing loaded from elsewhere", () => {
    expect(built).toMatch(/demo\.html: [\d.]+ KB/);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toMatch(/<head>[\s\S]*<title>Synthetic Loan Histories<\/title>[\s\S]*<\/head>/);
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|@import|url\(\s*["']?https?:/i);
    expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest/);
    expect(Buffer.byteLength(html)).toBeLessThan(16 * 1024 * 1024);
  });

  it("has a script that parses and renders every view against a stub DOM", () => {
    const { script } = check.extractDemo(html);
    check.checkSyntax(script);
    const months = page.twins.clean.months.length + page.twins.defective.months.length;
    const smoke = check.smokeDemoPage(html);
    // Each history's years, each month in them, and the premium shown and hidden.
    expect(smoke.views).toBe(2 * smoke.years + months + 2);
    expect(smoke.years).toBe(10);
    expect(smoke.pressed).toBeGreaterThan(20);
  });

  it("holds exactly what demoPageData computes from the code on disk", () => {
    const pkg = here("../..");
    const calibrationFile = JSON.parse(
      readFileSync(join(pkg, "src/life/calibration.json"), "utf8"),
    ) as CalibrationFile;
    const acceptance = JSON.parse(
      readFileSync(join(pkg, "src/life/calibration-acceptance.json"), "utf8"),
    ) as AcceptanceFile;
    expect(JSON.stringify(page)).toBe(
      JSON.stringify(demoPageData({ calibrationFile, acceptance })),
    );
  });

  it("shows the demo loan demoLoan() draws, month by month, in both histories", () => {
    const demo = demoLoan(defaultCalibration());
    const lives: Record<"clean" | "defective", LoanLife> = {
      clean: demo.clean,
      defective: demo.twins.defective,
    };
    expect(page.loan.id).toBe(demo.clean.loan_id);
    expect(page.twins.defective.label_count).toBe(demo.labels.defective.length);
    for (const twin of ["clean", "defective"] as const) {
      const life = lives[twin];
      const shown = page.twins[twin].months;
      expect(shown.map((m) => m.month)).toEqual(life.months.map((m) => m.month));
      shown.forEach((m, k) => {
        const e = life.months[k]!;
        expect([
          m.upb,
          m.escrow_balance,
          m.suspense,
          m.late_charges_due,
          m.pi,
          m.escrow_payment,
        ]).toEqual(
          [e.upb, e.escrow_balance, e.suspense, e.late_charges_due, e.pi, e.escrow_payment].map(
            Number,
          ),
        );
        expect([m.mba, m.status, m.next_due]).toEqual([e.mba_status, e.status, e.next_due]);
      });
      expect(page.twins[twin].boarded.escrowed).toBe(life.boarded.terms.escrowed);
    }
    // The two defects, where they enter.
    expect(page.twins.defective.boarded).toEqual({
      on: "2027-12-16",
      escrowed: false,
      cap_cents: null,
    });
    expect(page.twins.clean.boarded).toEqual({
      on: "2027-12-16",
      escrowed: true,
      cap_cents: 5_000,
    });
  });

  it("writes the tape the tape writer writes, and nothing before the transfer", () => {
    const { res } = demoRun();
    expect(page.tape_headers).toEqual([...TAPE_HEADERS]);
    for (const [twin, book] of [
      ["clean", res.clean],
      ["defective", res.defective!],
    ] as const) {
      for (const m of page.twins[twin].months) {
        const written = writeTape(book, m.month);
        if (m.servicer === "prior") {
          expect(m.tape, `${twin} ${m.month}`).toBeNull();
          expect(written.rows).toEqual([]);
        } else expect(m.tape, `${twin} ${m.month}`).toEqual(written.rows[0]);
      }
    }
    // The year-4 payment rises on the tape with no reason given.
    const ti = TAPE_HEADERS.indexOf("Current T&I Payment Amt");
    const feb = page.twins.clean.months.find((m) => m.month === "2030-02")!;
    expect(feb.tape![ti]).toBe("1377.04");
    expect(feb.hidden.some((h) => h.startsWith("Why the T&I payment changed"))).toBe(true);
  });

  it("grades boarding triage as the environment's own spec cases grade it", () => {
    const spec = boardingSpecTasks();
    for (const [twin, task] of [
      ["clean", spec[0]!],
      ["defective", spec[3]!],
    ] as const) {
      const p = posed("triage", twin);
      const engine = gradeTriage(task, expectedTriage(task));
      expect(p.graded.map((g) => [g.field, g.expected])).toEqual(
        engine.fields.map((f) => [f.field, f.expected]),
      );
      expect(p.pass).toBe(true);
      expect(p.graded.every((g) => g.ok)).toBe(true);
      // The reference finds exactly the planted cells, in its own order.
      const byField = (xs: readonly { field: string }[]) =>
        [...xs].sort((a, b) => (a.field < b.field ? -1 : 1));
      expect(byField((p.answer_raw as { findings: { field: string }[] }).findings)).toEqual(
        byField(expectedTriage(task).findings),
      );
    }
    // The defective package: D-42's Yes corrected to Y, D-03's blank cap queried at the statements' $50.00.
    expect(
      posed("triage", "defective")
        .graded.filter((g) => / (says|truth|handling)$/.test(g.field))
        .map((g) => g.expected),
    ).toEqual(['"Yes"', '"Y"', "correct", '""', '"50.00"', "query"]);
  });

  it("grades the catch-up as catchup-posting's engine posts it", () => {
    const { res, moments } = demoRun();
    const lives = { clean: res.clean.loans[0]!, defective: res.defective!.loans[0]! };
    for (const twin of ["clean", "defective"] as const) {
      const life = lives[twin];
      const row = life.receipts.find((r) => r.on === "2028-04-05")!;
      const m = moments[twin === "clean" ? "clean" : "twin"].get(row.id)!;
      if (m.kind !== "receipt") throw new Error("not a receipt");
      const task = catchupTaskAt(
        { id: "t", split: "spec", suite_seed: 0, index: 0 },
        life,
        m,
        row.installments[0]!.rate_pct,
      );
      const engine = gradeCatchup(task, expectedCatchup(task));
      const p = posed("catchup", twin);
      expect(p.graded.map((g) => [g.field, g.expected])).toEqual(
        engine.fields.map((f) => [f.field, f.expected]),
      );
      expect(p.pass).toBe(true);
    }
    // The figures, from cashiering's own late-charge function.
    const pi = 227_544n;
    const capped = lateChargeAmount(pi, "5", 5_000n);
    const uncapped = lateChargeAmount(pi, "5", null);
    const field = (twin: "clean" | "defective", f: string) =>
      posed("catchup", twin).graded.find((g) => g.field === f)!.expected;
    expect(field("defective", "late_charge_paid_cents")).toBe(String(capped));
    expect(field("defective", "to_suspense_cents")).toBe(String(uncapped - capped));
    expect(field("clean", "to_suspense_cents")).toBe("0");
    expect(posed("catchup", "defective").arm).toBe("breached");
    expect(posed("catchup", "clean").arm).toBe("within_capped");
  });

  it("grades the flagged analysis as escrow-review's engine reviews it, and poses none on the twin", () => {
    const { res, moments } = demoRun();
    const life = res.clean.loans[0]!;
    const flagged = life.analyses.find((a) => a.anomalies.length > 0 && a.servicer === "us")!;
    const m = moments.clean.get(`analysis-${flagged.year}`)!;
    if (m.kind !== "analysis") throw new Error("not an analysis");
    const task = reviewTaskAt({ id: "t", split: "spec", suite_seed: 0, index: 0 }, life, m);
    const want = expectedEscrowReview(task);
    const engine = gradeReview(task, want);
    const p = posed("escrow", "clean");
    expect(p.graded.map((g) => [g.field, g.expected])).toEqual(
      engine.fields.map((f) => [f.field, f.expected]),
    );
    // The history decided the same: the shortage, the new payment, its date.
    expect([want.shortage_cents, want.new_payment_cents, want.effective_on]).toEqual([
      String(flagged.shortage),
      String(flagged.new_payment),
      flagged.effective,
    ]);
    expect(want.flag_stands).toBe(true);
    expect(page.moments.find((x) => x.id === "escrow")!.twins.defective.posed).toBe(false);
    expect(res.defective!.loans[0]!.analyses.filter((a) => a.servicer === "us")).toEqual([]);
  });

  it("prices the missed defects with the engines' own figures", () => {
    const { res } = demoRun();
    const clean = res.clean.loans[0]!;
    const twin = res.defective!.loans[0]!;
    const note = twin.draw.late_charge;
    // D-03: each charge against what the note allows.
    for (const r of page.harm.d03.rows) {
      const fee = twin.fees.find((f) => f.due === r.installment_due)!;
      const pi = twin.installments.find((i) => i.due === fee.due)!.pi;
      const allowed = lateChargeAmount(pi, note.pct, note.cap_cents);
      expect([r.charged, r.allowed, r.collected]).toEqual(
        [fee.amount, allowed, fee.collected].map(Number),
      );
      expect(r.refund).toBe(Number(fee.collected - allowed));
    }
    expect(page.harm.d03.refund_total).toBe(6_377);
    // D-31: every bill the clean history's escrow paid after boarding and the twin's never did.
    const paid = clean.disbursements.filter((d) => d.kind === "bill" && d.servicer === "us");
    expect(twin.disbursements.filter((d) => d.kind === "bill" && d.servicer === "us")).toEqual([]);
    expect(page.harm.d31.bills).toBe(paid.length);
    expect(page.harm.d31.total).toBe(Number(paid.reduce((s, d) => s + d.amount, 0n)));
    expect(page.harm.d31.tax_total).toBe(
      Number(paid.filter((d) => d.line.startsWith("tax")).reduce((s, d) => s + d.amount, 0n)),
    );
    expect(page.harm.d31.payoff_refund).toEqual({
      clean: Number(clean.payoff!.escrow_refund),
      defective: Number(twin.payoff!.escrow_refund),
    });
    // No engine prices a tax penalty, and the page says so rather than inventing one.
    expect(page.harm.d31.penalty).toBeNull();
    expect(page.harm.d31.penalty_note).toMatch(/Not computed/);
  });

  it("reads the book against every acceptance test, and labels what is not a verdict", () => {
    const acceptance = JSON.parse(
      readFileSync(here("../life/calibration-acceptance.json"), "utf8"),
    ) as AcceptanceFile;
    expect(page.book.rows.map((r) => r.id)).toEqual(acceptance.tests.map((t) => t.id));
    expect(page.book.loans).toBe(1_000);
    expect(page.book.passed + page.book.failed + page.book.unmeasured).toBe(
      acceptance.tests.length,
    );
    for (const r of page.book.rows) {
      expect(r.parts.length, r.id).toBeGreaterThan(0);
      // A row with no verdict, or a part without one, says why.
      if (r.pass === null || r.parts.some((p) => p.pass === null))
        expect(r.note.length, r.id).toBeGreaterThan(20);
    }
    // Tests the generator cannot meet yet are said to fail or to be no verdict, never passed.
    const by = (id: string) => page.book.rows.find((r) => r.id === id)!;
    expect(by("returned-payments").pass).toBe(false);
    expect(by("loan-age-distribution").pass).toBeNull();
    expect(by("call-note-length").pass).toBeNull();
    expect(toJsonLine(by("payment-within-grace").parts[0])).toContain("50.8%");
  });

  it("reads every tolerance from the acceptance file, the ones it states only in words too", () => {
    const pkg = here("../..");
    const file = JSON.parse(
      readFileSync(join(pkg, "src/life/calibration.json"), "utf8"),
    ) as CalibrationFile;
    const acceptance = JSON.parse(
      readFileSync(join(pkg, "src/life/calibration-acceptance.json"), "utf8"),
    ) as AcceptanceFile;
    const calibration = loadCalibration({ file });
    const panel = (a: AcceptanceFile) =>
      bookPanel({ calibration, file, acceptance: a, loans: 40, seed: "demo-page-test" });
    const reword = (id: string, from: string, to: string): AcceptanceFile => ({
      ...acceptance,
      tests: acceptance.tests.map((t) =>
        t.id === id
          ? { ...t, tolerance: { ...t.tolerance, unit: t.tolerance.unit.replace(from, to) } }
          : t,
      ),
    });
    const part = (b: ReturnType<typeof panel>, id: string, label: string) =>
      b.rows.find((r) => r.id === id)!.parts.find((p) => p.label === label)!;
    const moved = panel(reword("delinquency-stock", "0.01 on the total", "0.02 on the total"));
    expect(part(moved, "delinquency-stock", "total").tolerance).toBe("±2.0 pts");
    const cure = panel(reword("quarterly-transitions", "0.08 absolute", "0.05 absolute"));
    expect(part(cure, "quarterly-transitions", "30 to 60 days → current").tolerance).toBe(
      "±5.0 pts",
    );
    const status = panel(
      reword("contacts-per-loan-year-by-status", "25% relative", "40% relative"),
    );
    expect(
      part(status, "contacts-per-loan-year-by-status", "current (design choice)").tolerance,
    ).toBe("±40%");
    // Words the page cannot read stop the build rather than fall back to a typed figure.
    expect(() =>
      panel(reword("delinquency-stock", "0.01 on the total", "a point on the total")),
    ).toThrow(/delinquency-stock/);
  });
});
