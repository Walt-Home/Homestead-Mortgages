/**
 * escrow-review: escrow-analysis's rulebook through Step 9 word for word,
 * graded by its composition of the servicing app's escrow engine with the
 * app's own anomaly triggers and bill comparison; every analysis drawn from
 * a history concludes what that history did; the spec's worked example and
 * its variants are reviewed as the spec reads them; every task can be
 * reviewed from the rulebook and the tools; and each arm and outcome turns
 * up.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addMonths } from "@hm/kernel/calendar";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { rngFor } from "../rng.js";
import { ESCROW_RULEBOOK } from "../escrow/rulebook.js";
import { expectedEscrow } from "../escrow/grader.js";
import { escrowSpecTasks } from "../escrow/generator.js";
import { defaultCalibration, generate, type LifeMoment } from "../life/index.js";
import {
  ANALYSIS_STEPS,
  REVIEW_ARMS,
  REVIEW_HELDOUT_SUITE,
  REVIEW_RULEBOOK,
  REVIEW_SPEC_CASES,
  REVIEW_TOOLS,
  ReviewReferencePolicy,
  agreesWithHistory,
  analysisOf,
  billVariance,
  drawReviewCandidate,
  drawReviewTask,
  escrowReview,
  expectedEscrowReview,
  generateReviewSuite,
  generateReviewTask,
  gradeReviewAgainst,
  parseReviewSubmission,
  reviewArmOf,
  reviewFairToGrade,
  reviewPayload,
  reviewSpecTasks,
  reviewTaskAt,
  reviewTaskId,
  reviewVerdict,
  type EscrowReviewAnswer,
  type EscrowReviewTask,
} from "../escrow-review/index.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const solveAll = async (tasks: readonly EscrowReviewTask[]) => {
  const misses: string[] = [];
  let calls = 0;
  for (const task of tasks) {
    const r = await runEpisode(escrowReview, task, new ReviewReferencePolicy());
    calls = Math.max(calls, r.tool_calls);
    if (!r.grade.pass) {
      const wrong = r.grade.fields
        .filter((f) => !f.ok)
        .map((f) => `${f.field} ${f.expected}/${f.got}`);
      misses.push(`${task.id} ${r.outcome} ${r.error ?? ""} ${wrong.join("; ")}`);
    }
  }
  return { misses, calls };
};

let heldout: EscrowReviewTask[] | null = null;
const heldoutSuite = () =>
  (heldout ??= generateReviewSuite("heldout", REVIEW_HELDOUT_SUITE.seed, REVIEW_HELDOUT_SUITE.n));
let train: EscrowReviewTask[] | null = null;
const trainSuite = () => (train ??= generateReviewSuite("train", 11, 300));

describe("escrow-review", () => {
  it("keeps escrow-analysis's rulebook through Step 9 word for word, and adds the review after it", () => {
    expect(ANALYSIS_STEPS.startsWith("Conventions:")).toBe(true);
    expect(ANALYSIS_STEPS.trimEnd().endsWith("The result is effective_on.")).toBe(true);
    expect(REVIEW_RULEBOOK).toContain(ANALYSIS_STEPS);
    expect(ESCROW_RULEBOOK).toContain(ANALYSIS_STEPS);
    for (const code of [
      "payment_change_gt_25pct",
      "payment_change_gt_150",
      "surplus_gt_2500",
      "bill_variance_gt_20pct",
      "flag_stands",
    ])
      expect(REVIEW_RULEBOOK).toContain(code);
    expect(REVIEW_TOOLS.map((t) => t.name)).toEqual([
      "date_add",
      "days_between",
      "end_of_month",
      "whole_months_between",
      "calculate",
      "submit_review",
    ]);
  });

  it("grades with escrow-analysis's run of the engine, and the app's own triggers and bill comparison", () => {
    // The analysis is escrow-analysis's to the cent.
    for (const task of trainSuite().slice(0, 100)) {
      const a = expectedEscrowReview(task);
      const e = expectedEscrow(analysisOf(task));
      for (const f of [
        "annual_cents",
        "base_payment_cents",
        "target_at_start_cents",
        "projected_actual_cents",
        "decision",
        "surplus_cents",
        "shortage_cents",
        "deficiency_cents",
        "repayment_months",
        "new_payment_cents",
        "effective_on",
      ] as const)
        expect(a[f], `${task.id} ${f}`).toEqual(e[f]);
      // The triggers are the analysis's, with the bill comparison besides.
      expect(e.anomalies.every((x) => a.anomalies.includes(x))).toBe(true);
      expect(a.anomalies.filter((x) => !e.anomalies.includes(x))).toEqual(
        a.anomalies.includes("bill_variance_gt_20pct") ? ["bill_variance_gt_20pct"] : [],
      );
      expect(a.flag_stands).toBe(a.anomalies.length > 0);
    }
    // The comparison is the app's own (section03.ts:144) and the triggers its engine's (analysis.ts:101-107).
    const tools = readFileSync(
      here("../../../../apps/servicing/src/app/tools/section03.ts"),
      "utf8",
    );
    const line = tools.split("\n")[143]!;
    expect(line).toContain("compareBillToPriorYear");
    expect(line).toContain("Number(((cur - prior) * 10_000n) / prior) / 100");
    expect(line).toContain("Math.abs(varPct) > 20");
    const engine = readFileSync(
      here("../../../../apps/servicing/src/domain/escrow/analysis.ts"),
      "utf8",
    ).split("\n");
    expect(engine[100]).toMatch(/^export function anomalies\(/);
    expect(engine[104]).toContain('out.push("bill_variance_gt_20pct")');
    // 21 % is flagged, 20 % and 20.009 % are not; a fall counts as a rise does.
    const line0 = {
      line_type: "hazard",
      frequency: "annual" as const,
      estimate_basis: "known_bill" as const,
      prior_year_annual_cents: 100_000n,
      prior_disbursed_on: [],
    };
    const bill = (amount: bigint) => ({
      ...line0,
      known_bills: [{ amount_cents: amount, due_on: "2030-01-01" as never }],
    });
    expect(billVariance(bill(121_000n))).toBe(2100);
    expect(billVariance(bill(120_009n))).toBe(2000);
    expect(billVariance(bill(79_000n))).toBe(-2100);
    expect(billVariance({ ...line0, prior_year_annual_cents: 0n })).toBe(null);
  }, 300_000);

  it("concludes what the history did, for every analysis a decade runs", () => {
    // Every annual analysis in forty decades, read off as a task: the grader's run is the history's.
    let analyses = 0;
    for (let s = 0; s < 40; s++) {
      const moments: Extract<LifeMoment, { kind: "analysis" }>[] = [];
      const res = generate(
        s,
        {
          loans: 1,
          random: { payoff: false },
          pins: { 0: { escrowed: true } },
          events:
            s % 2 === 0
              ? [{ kind: "tax_reassessment", loan: 0, month: 30 + s, pct: 40 - 2 * s }]
              : [],
        },
        {
          calibration: defaultCalibration(),
          observe: (_l, _h, m) => {
            if (m.kind === "analysis") moments.push(m);
          },
        },
      );
      const life = res.clean.loans[0]!;
      expect(moments.length).toBe(life.analyses.length);
      for (const row of life.analyses) {
        const m = moments.find((x) => x.year === row.year)!;
        const coords = {
          id: reviewTaskId("train", 0, s),
          split: "train" as const,
          suite_seed: 0,
          index: s,
        };
        expect(agreesWithHistory(reviewTaskAt(coords, life, m), row), `${s} ${row.year}`).toBe(
          true,
        );
        analyses++;
      }
    }
    // Ten a decade: the tenth runs inside the window, for the year that begins just after it.
    expect(analyses).toBe(400);
  }, 300_000);

  describe("reviews the spec's worked example and its variants as the spec reads them", () => {
    const tasks = reviewSpecTasks();
    const [example, refund, credit, deficiency] = tasks.map(expectedEscrowReview);

    it("§3.2: shortage $406.68 over 12 months, payment $172.22 from 2027-07-01, held: a 32 % change", () => {
      expect(example).toMatchObject({
        annual_cents: "166000",
        base_payment_cents: "13833",
        target_at_start_cents: "110668",
        projected_actual_cents: "70000",
        decision: "shortage",
        shortage_cents: "40668",
        deficiency_cents: "0",
        repayment_months: 12,
        new_payment_cents: "17222",
        effective_on: "2027-07-01",
        anomalies: ["payment_change_gt_25pct"],
        flag_stands: true,
      });
    });

    it("the variants: a refund of $143.32 and a credit of $26.68, not held; a deficiency, held", () => {
      expect(refund).toMatchObject({
        decision: "refund",
        surplus_cents: "14332",
        new_payment_cents: "13833",
        flag_stands: false,
      });
      expect(credit).toMatchObject({
        decision: "credit",
        surplus_cents: "2668",
        new_payment_cents: "13611",
        flag_stands: false,
      });
      expect(deficiency).toMatchObject({
        decision: "shortage",
        shortage_cents: "110668",
        deficiency_cents: "15000",
        new_payment_cents: "24305",
        anomalies: ["payment_change_gt_25pct"],
        flag_stands: true,
      });
      expect(tasks.map(reviewVerdict)).toEqual([
        "flag stands, shortage",
        "no flag, refund",
        "no flag, credit",
        "flag stands, shortage",
      ]);
      expect(REVIEW_SPEC_CASES.length).toBe(escrowSpecTasks().length);
    });
  });

  it("fails an answer one cent off on exactly that field", () => {
    const want = expectedEscrowReview(reviewSpecTasks()[0]!);
    const wrong = (answer: unknown) =>
      gradeReviewAgainst(want, answer as EscrowReviewAnswer)
        .fields.filter((x) => !x.ok)
        .map((x) => x.field);
    expect(wrong(want)).toEqual([]);
    expect(wrong({ ...want, new_payment_cents: "17223" })).toEqual(["new_payment_cents"]);
    expect(wrong({ ...want, flag_stands: false })).toEqual(["flag_stands"]);
    expect(wrong({ ...want, anomalies: [...want.anomalies, "payment_change_gt_150"] })).toEqual([
      "anomalies",
    ]);
    // The anomalies are a set: their order is not graded.
    expect(wrong({ ...want, anomalies: [...want.anomalies].reverse() })).toEqual([]);
    expect(gradeReviewAgainst(want, null).pass).toBe(false);
  });

  it("reads a submission strictly, as the schema says, and bounces what does not fit", () => {
    const want = expectedEscrowReview(reviewSpecTasks()[0]!);
    const ok = (x: unknown) => parseReviewSubmission(x).ok;
    expect(ok(want)).toBe(true);
    expect(ok({ ...want, flag_stands: undefined })).toBe(false);
    expect(ok({ ...want, flag_stands: "yes" })).toBe(false);
    expect(ok({ ...want, decision: "deficit" })).toBe(false);
    expect(ok({ ...want, new_payment_cents: "172.22" })).toBe(false);
    expect(ok({ ...want, repayment_months: 12.5 })).toBe(false);
    expect(ok({ ...want, anomalies: "payment_change_gt_25pct" })).toBe(false);
    expect(ok({ ...want, effective_on: "July 2027" })).toBe(false);
  });

  it("can be reviewed from the rulebook and the tools: the reference passes the held-out suite and the spec", async () => {
    const r = await solveAll([...reviewSpecTasks(), ...heldoutSuite()]);
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(80);
  }, 300_000);

  it("can be reviewed on a training suite from another seed", async () => {
    const r = await solveAll(trainSuite());
    expect(r.misses).toEqual([]);
    expect(r.calls).toBeLessThan(80);
  }, 300_000);

  it("holds the rulebook to the engine on candidates nothing filtered", () => {
    const unfair: string[] = [];
    let drawn = 0;
    for (let i = 0; i < 600; i++) {
      const id = reviewTaskId("train", 99, i);
      const d = drawReviewCandidate(rngFor(id), id, "train", 99, i);
      if (!d) continue;
      drawn++;
      if (!reviewFairToGrade(d.task)) unfair.push(id);
    }
    expect(unfair).toEqual([]);
    expect(drawn).toBeGreaterThan(400);
  }, 300_000);

  it("carries the account's history up to the run date", () => {
    for (const t of trainSuite()) {
      for (const a of t.history.analyses) expect(a.as_of < t.as_of).toBe(true);
      expect(t.history.analyses.length).toBeLessThanOrEqual(2);
      const since = addMonths(t.as_of, -24);
      for (const x of t.history.disbursements) expect(x.on > since && x.on <= t.as_of).toBe(true);
      for (const m of t.history.month_ends) expect(m.month < t.as_of.slice(0, 7)).toBe(true);
      expect(reviewPayload(t)).toEqual(JSON.parse(JSON.stringify(reviewPayload(t))));
    }
    expect(trainSuite().filter((t) => t.history.analyses.length === 2).length).toBeGreaterThan(150);
  }, 300_000);

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump REVIEW_ENVIRONMENT_VERSION, then the pin.
    expect(sha256(heldoutSuite().map(toJsonLine).join(""))).toMatchInlineSnapshot(
      `"310870f7e369538b4ad9728073ea8be9ee5b57efa646d0fc79c7526d6263ba2f"`,
    );
  }, 300_000);

  it("rebuilds a task from its coordinates, and never draws a held-out task into training", () => {
    expect(toJsonLine(generateReviewTask("train", 11, 17))).toBe(toJsonLine(trainSuite()[17]));
    const fp = (t: EscrowReviewTask) => toJsonLine(reviewPayload(t));
    const held = new Set(heldoutSuite().map(fp));
    expect(trainSuite().filter((t) => held.has(fp(t)))).toEqual([]);
    expect(drawReviewTask("heldout", 1, 0).task.id).toBe(reviewTaskId("heldout", 1, 0));
  }, 300_000);

  describe("each arm and outcome turns up", () => {
    const runs = () =>
      trainSuite().map((t, i) => ({ t, a: expectedEscrowReview(t), arm: reviewArmOf(i) }));
    const share = (f: (x: ReturnType<typeof runs>[number]) => boolean) =>
      runs().filter(f).length / runs().length;

    it("cycles through every arm, fifty analyses each in three hundred", () => {
      expect(new Set(runs().map((x) => x.arm))).toEqual(new Set(REVIEW_ARMS));
    }, 300_000);

    it("draws every outcome at more than 12 %", () => {
      const above = (f: (x: ReturnType<typeof runs>[number]) => boolean) =>
        expect(share(f)).toBeGreaterThan(0.12);
      above((x) => x.a.flag_stands && x.a.decision === "shortage");
      above((x) => x.a.flag_stands && x.a.decision !== "shortage");
      above((x) => !x.a.flag_stands && x.a.decision === "shortage");
      above((x) => !x.a.flag_stands && x.a.decision !== "shortage");
      for (const d of ["shortage", "refund", "credit"]) above((x) => x.a.decision === d);
    }, 300_000);

    it("raises every trigger a history can, and spreads every shortage over twelve months", () => {
      const raised = new Set(runs().flatMap((x) => x.a.anomalies));
      for (const code of [
        "payment_change_gt_25pct",
        "payment_change_gt_150",
        "surplus_gt_2500",
        "bill_variance_gt_20pct",
      ])
        expect(raised).toContain(code);
      for (const x of runs())
        if (x.a.decision === "shortage") expect(x.a.repayment_months).toBe(12);
    }, 300_000);
  });
});
