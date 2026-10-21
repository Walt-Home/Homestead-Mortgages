/**
 * escrow-analysis: the grader is the servicing app's engine and no other
 * (the port is its file byte for byte but the imports), it gives the spec's
 * worked example to the cent, every generated task can be solved from the
 * rulebook and the tools, and each decision and trap turns up often enough
 * to be measured.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import {
  ESCROW_HELDOUT_SUITE,
  EscrowReferencePolicy,
  analyze,
  escrowAnalysis,
  escrowPayload,
  escrowSpecTasks,
  expectedEscrow,
  generateEscrowSuite,
  generateEscrowTask,
  gradeEscrowAgainst,
  parseEscrowSubmission,
  type EscrowTask,
} from "../escrow/index.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const withoutImports = (text: string) =>
  text
    .split("\n")
    .filter((l) => !l.startsWith("import "))
    .join("\n");

const solveAll = async (tasks: readonly EscrowTask[]) => {
  const misses: string[] = [];
  for (const task of tasks) {
    const r = await runEpisode(escrowAnalysis, task, new EscrowReferencePolicy());
    if (!r.grade.pass) {
      const wrong = r.grade.fields
        .filter((f) => !f.ok)
        .map((f) => `${f.field} ${f.expected}/${f.got}`);
      misses.push(`${task.id} ${r.outcome} ${r.error ?? ""} ${wrong.join("; ")}`);
    }
  }
  return misses;
};

describe("escrow-analysis", () => {
  it("grades with the servicing app's engine: the port is its file but for the imports", () => {
    const original = readFileSync(
      here("../../../../apps/servicing/src/domain/escrow/analysis.ts"),
      "utf8",
    );
    const port = readFileSync(here("../escrow/ported/analysis.ts"), "utf8");
    expect(withoutImports(port)).toBe(withoutImports(original));
    expect(
      port
        .split("\n")
        .filter((l) => l.startsWith("import "))
        .join("\n"),
    ).toMatch(/^(import .* from "@hm\/kernel\/(money|calendar)";\n?){3}$/);
  });

  it("gives §3.2's worked example and its variants to the cent", () => {
    const [shortage, refund, credit, deficiency] = escrowSpecTasks().map(expectedEscrow);
    expect(shortage).toMatchObject({
      annual_cents: "166000",
      base_payment_cents: "13833",
      required_start_cents: "83002",
      cushion_cents: "27666",
      target_at_start_cents: "110668",
      projected_actual_cents: "70000",
      decision: "shortage",
      shortage_cents: "40668",
      repayment_months: 12,
      installment_cents: "3389",
      final_installment_cents: "3389",
      lump_sum_option_offered: false,
      new_payment_cents: "17222",
      effective_on: "2027-07-01",
    });
    expect(refund).toMatchObject({
      decision: "refund",
      surplus_cents: "14332",
      refund_due_on: "2027-06-15",
      new_payment_cents: "13833",
    });
    expect(credit).toMatchObject({
      decision: "credit",
      surplus_cents: "2668",
      credit_monthly_cents: "222",
      first_month_extra_credit_cents: "4",
      new_payment_cents: "13611",
      first_month_payment_cents: "13607",
    });
    expect(deficiency).toMatchObject({
      decision: "shortage",
      deficiency_cents: "15000",
      deficiency_installment_cents: "1250",
      shortage_cents: "110668",
      installment_cents: "9222",
      final_installment_cents: "9226",
      new_payment_cents: "24305",
      final_month_payment_cents: "24309",
    });
  });

  it("fails an answer one cent off on exactly that field", () => {
    const [task] = escrowSpecTasks();
    const want = expectedEscrow(task!);
    const g = gradeEscrowAgainst(want, { ...want, installment_cents: "3390" });
    expect(g.pass).toBe(false);
    expect(g.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual(["installment_cents"]);
    expect(
      gradeEscrowAgainst(want, { ...want, anomalies: [...want.anomalies].reverse() }).pass,
    ).toBe(true);
  });

  it("reads a submission strictly", () => {
    const want = expectedEscrow(escrowSpecTasks()[0]!);
    expect(parseEscrowSubmission(want).ok).toBe(true);
    expect(parseEscrowSubmission({ ...want, decision: "approve" }).ok).toBe(false);
    expect(parseEscrowSubmission({ ...want, base_payment_cents: "138.33" }).ok).toBe(false);
    expect(parseEscrowSubmission({ ...want, effective_on: null }).ok).toBe(false);
  });

  it("can be solved from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    expect(
      await solveAll([
        ...escrowSpecTasks(),
        ...generateEscrowSuite("heldout", ESCROW_HELDOUT_SUITE.seed, ESCROW_HELDOUT_SUITE.n),
      ]),
    ).toEqual([]);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    expect(await solveAll(generateEscrowSuite("train", 11, 300))).toEqual([]);
  }, 120_000);

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump ESCROW_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generateEscrowSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"a45f624fcf2b823f22221d2ba880c2a62fb48682398d41f4b6a3aee3e5952960"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out account into training", () => {
    expect(toJsonLine(generateEscrowTask("train", 7, 17))).toBe(
      toJsonLine(generateEscrowSuite("train", 7, 30)[17]),
    );
    const fp = (t: EscrowTask) => toJsonLine(escrowPayload(t));
    const held = new Set(generateEscrowSuite("heldout", 1, 200).map(fp));
    expect(generateEscrowSuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  });

  describe("every decision and trap turns up", () => {
    const tasks = generateEscrowSuite("train", 1, 2000);
    const runs = tasks.map((t) => ({ t, a: expectedEscrow(t), e: analyze(t) }));
    const count = (pred: (x: (typeof runs)[number]) => boolean) => runs.filter(pred).length;

    it("draws every decision, a deficiency, the lump-sum option and a workout spread", () => {
      expect(new Set(runs.map((x) => x.a.decision))).toEqual(
        new Set(["balanced", "refund", "credit", "retain", "shortage"]),
      );
      expect(
        count(({ a }) => a.decision === "shortage" && a.deficiency_cents !== "0"),
      ).toBeGreaterThan(100);
      expect(count(({ a }) => a.lump_sum_option_offered === true)).toBeGreaterThan(50);
      expect(count(({ a }) => a.repayment_months === 60)).toBeGreaterThan(10);
    });

    it("draws the decision's edges: fifty dollars exactly and a cent under, one month exactly and a cent under, 30 and 31 days late", () => {
      expect(
        count(({ a }) => a.decision === "refund" && a.surplus_cents === "5000"),
      ).toBeGreaterThan(30);
      expect(
        count(({ a }) => a.decision === "credit" && a.surplus_cents === "4999"),
      ).toBeGreaterThan(30);
      expect(count(({ a }) => a.shortage_cents === a.base_payment_cents)).toBeGreaterThan(30);
      expect(count(({ t }) => t.regx_days_delinquent === 30)).toBeGreaterThan(50);
      expect(
        count(({ t, a }) => t.regx_days_delinquent === 31 && a.decision === "retain"),
      ).toBeGreaterThan(10);
    });

    it("draws every anomaly, a pushed effective date, and postings outside the window", () => {
      const flagged = new Set(
        runs.flatMap(({ a }) => a.anomalies.map((x) => x.replace(/^[a-z_]+:/, ""))),
      );
      for (const code of [
        "estimate_basis_prior_year_gt_2y",
        "pmi_without_termination",
        "payment_change_gt_25pct",
        "payment_change_gt_150",
        "surplus_gt_2500",
      ])
        expect(flagged, code).toContain(code);
      expect(count(({ t, a }) => a.effective_on !== t.year_start)).toBeGreaterThan(100);
      expect(
        count(({ t }) =>
          [...t.ledger.deposits, ...t.ledger.disbursements].some(
            (x) => x.on <= t.as_of || x.on >= t.year_start,
          ),
        ),
      ).toBeGreaterThan(300);
    });

    it("draws the line traps: CPI on taxes and not insurance, a discount date, an MI line ending mid-year", () => {
      expect(
        count(({ t }) =>
          t.lines.some((l) => l.line_type === "hazard" && l.estimate_basis === "prior_year_cpi"),
        ),
      ).toBeGreaterThan(200);
      expect(
        count(({ t }) => t.lines.some((l) => (l.known_bills ?? []).some((b) => b.discount))),
      ).toBeGreaterThan(100);
      expect(
        count(({ t }) =>
          t.lines.some(
            (l) =>
              l.line_type === "mi_borrower_paid" &&
              !!l.terminates_on &&
              l.terminates_on < t.year_start.replace(/^(\d{4})/, (y) => String(Number(y) + 1)),
          ),
        ),
      ).toBeGreaterThan(50);
    });
  });
});
