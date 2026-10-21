/**
 * escrow-history: a ledger written from an account reads back as that
 * account, so the grader concludes what escrow-analysis would; every task
 * can be solved from Step 0, the rulebook and the tools; and each of the
 * ledger's traps turns up.
 */

import { describe, expect, it } from "vitest";
import { addMonths } from "@hm/kernel/calendar";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { ESCROW_RULEBOOK } from "../escrow/rulebook.js";
import { expectedEscrow, projectedActual } from "../escrow/grader.js";
import {
  HISTORY_HELDOUT_SUITE,
  HISTORY_RULEBOOK,
  HistoryReferencePolicy,
  drawHistoryTask,
  escrowHistory,
  generateHistorySuite,
  generateHistoryTask,
  historyPayload,
  readHistory,
  type EscrowHistoryTask,
} from "../escrow-history/index.js";

const solveAll = async (tasks: readonly EscrowHistoryTask[]) => {
  const misses: string[] = [];
  for (const task of tasks) {
    const r = await runEpisode(escrowHistory, task, new HistoryReferencePolicy());
    if (!r.grade.pass) {
      const wrong = r.grade.fields
        .filter((f) => !f.ok)
        .map((f) => `${f.field} ${f.expected}/${f.got}`);
      misses.push(`${task.id} ${r.outcome} ${r.error ?? ""} ${wrong.join("; ")}`);
    }
  }
  return misses;
};

describe("escrow-history", () => {
  it("reads every ledger back as the account it was written from", () => {
    const drift: string[] = [];
    for (let i = 0; i < 1500; i++) {
      const { task, account } = drawHistoryTask("train", 1, i);
      const read = readHistory(task);
      if (projectedActual(read) !== projectedActual(account))
        drift.push(`${task.id}: projected balance`);
      for (const [a, b] of read.lines.map((l, k) => [l, account.lines[k]!] as const)) {
        if (a.prior_year_annual_cents !== b.prior_year_annual_cents)
          drift.push(`${task.id}: ${a.line_type} total`);
        if ([...a.prior_disbursed_on].sort().join() !== [...b.prior_disbursed_on].sort().join())
          drift.push(`${task.id}: ${a.line_type} dates`);
      }
      if (toJsonLine(expectedEscrow(read)) !== toJsonLine(expectedEscrow(account)))
        drift.push(`${task.id}: answer`);
    }
    expect(drift).toEqual([]);
  });

  it("is escrow-analysis's rulebook with Step 0 in front and nothing else changed", () => {
    expect(HISTORY_RULEBOOK).toContain("## Step 0. Reading the ledger");
    expect(HISTORY_RULEBOOK.replace(/## Step 0\.[\s\S]*?\n## Step 1\./, "## Step 1.")).toBe(
      ESCROW_RULEBOOK,
    );
  });

  it("can be solved from Step 0, the rulebook and the tools: the reference passes the held-out suite", async () => {
    expect(
      await solveAll(
        generateHistorySuite("heldout", HISTORY_HELDOUT_SUITE.seed, HISTORY_HELDOUT_SUITE.n),
      ),
    ).toEqual([]);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    expect(await solveAll(generateHistorySuite("train", 11, 300))).toEqual([]);
  }, 120_000);

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump HISTORY_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generateHistorySuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"1d61db7549802cd8e93b5bd1f20590b8cb18773f87753b8f5753546e8876bd2b"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out ledger into training", () => {
    expect(toJsonLine(generateHistoryTask("train", 7, 17))).toBe(
      toJsonLine(generateHistorySuite("train", 7, 30)[17]),
    );
    const fp = (t: EscrowHistoryTask) => toJsonLine(historyPayload(t));
    const held = new Set(generateHistorySuite("heldout", 1, 200).map(fp));
    expect(generateHistorySuite("train", 1, 1000).filter((t) => held.has(fp(t)))).toEqual([]);
  });

  describe("every trap of the ledger turns up", () => {
    const tasks = generateHistorySuite("train", 1, 1000);
    const count = (pred: (t: EscrowHistoryTask) => boolean) => tasks.filter(pred).length;
    const lastYear = (t: EscrowHistoryTask) => addMonths(t.year_start, -12);

    it("draws a line's payment from the year before last, which is not last year", () => {
      expect(
        count((t) => t.ledger.posted.some((p) => p.line_type !== null && p.on < lastYear(t))),
      ).toBeGreaterThan(900);
    });

    it("draws last year's payments still to come, scheduled after the run date", () => {
      expect(
        count((t) => t.ledger.scheduled.some((p) => p.line_type !== null && p.on < t.year_start)),
      ).toBeGreaterThan(500);
    });

    it("draws one-offs with no line, and postings that belong to the new year", () => {
      expect(
        count((t) =>
          [...t.ledger.posted, ...t.ledger.scheduled].some(
            (p) => p.type === "disbursement" && p.line_type === null,
          ),
        ),
      ).toBeGreaterThan(300);
      expect(count((t) => t.ledger.scheduled.some((p) => p.on >= t.year_start))).toBeGreaterThan(
        200,
      );
    });
  });
});
