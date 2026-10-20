/**
 * The audit, on real records from the reference policy: a clean pass raises
 * no flag, each flag rises on the record that earns it, and a held-out
 * transcript is never printed.
 */

import { describe, expect, it } from "vitest";
import { auditEpisode, summarize, transcriptOf, type AuditRecord } from "../audit.js";
import { runEpisode } from "../episode.js";
import { ReferencePolicy, refiReview, specTasks, type RefiTask } from "../refi/index.js";

async function recordOf(task: RefiTask, split = task.split): Promise<AuditRecord> {
  const result = await runEpisode(refiReview, task, new ReferencePolicy());
  return {
    task: { id: task.id, split, index: task.index, rendered: refiReview.render(task) },
    policy: { id: "reference" },
    result: result as unknown as AuditRecord["result"],
  };
}

const [workedExample, , , , , noQuote] = specTasks();
if (!workedExample || !noQuote) throw new Error("no spec tasks");

describe("the audit", () => {
  it("raises nothing on a clean pass", async () => {
    const row = auditEpisode(await recordOf(workedExample));
    expect(row).toMatchObject({
      verdict: "candidate",
      pass: true,
      mental: [],
      passWithout: [],
      toolErrors: 0,
      missed: [],
      cost: null,
    });
  });

  it("flags a submitted figure no tool returned: arithmetic done in the model's head", async () => {
    const r = await recordOf(workedExample);
    const answer = r.result.answer as { offer: Record<string, unknown> };
    const doctored: AuditRecord = {
      ...r,
      result: {
        ...r.result,
        answer: { ...answer, offer: { ...answer.offer, npv_cents: "2429279" } },
      },
    };
    expect(auditEpisode(doctored).mental).toEqual(["npv_cents"]);
  });

  it("flags a pass that never called a tool a full review needs, but not one that needed none", async () => {
    const r = await recordOf(workedExample);
    const without: AuditRecord = {
      ...r,
      result: {
        ...r.result,
        transcript: r.result.transcript.map((e) =>
          e.kind === "turn"
            ? { ...e, calls: e.calls.filter((c) => c.name !== "balance_after") }
            : e,
        ),
      },
    };
    expect(auditEpisode(without).passWithout).toEqual(["balance_after"]);
    // With no quote the review skips the benefit, and needs none of them.
    expect(auditEpisode(await recordOf(noQuote)).passWithout).toEqual([]);
  });

  it("totals the rows", async () => {
    const rows = await Promise.all(specTasks().map(async (t) => auditEpisode(await recordOf(t))));
    const s = summarize(rows);
    expect(s).toMatchObject({
      episodes: rows.length,
      passed: rows.length,
      cost: null,
      missedFields: {},
    });
    expect(s.byVerdict["candidate"]).toEqual({ n: 2, passed: 2 });
  });

  it("prints a training transcript, and refuses a held-out one", async () => {
    expect(transcriptOf(await recordOf(workedExample))).toMatch(/submit_review/);
    expect(() =>
      transcriptOf({
        ...({} as AuditRecord),
        task: { id: "x", split: "heldout", index: 0, rendered: "" },
      }),
    ).toThrow(/not for reading/);
  });
});
