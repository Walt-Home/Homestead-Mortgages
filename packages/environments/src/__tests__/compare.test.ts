/**
 * The comparison: the intervals and the test held to values worked by hand,
 * and the pairing rules — a transport error is not an answer, the newest
 * scored episode counts, and a task not scored on both sides is left out.
 */

import { describe, expect, it } from "vitest";
import { compare, costOf, mcnemarExact, scoreSide, wilson, type EpisodeLine } from "../compare.js";

const line = (
  id: string,
  pass: boolean,
  o: {
    outcome?: string;
    at?: string;
    verdict?: string;
    policy?: string;
    tool_calls?: number;
    tokens?: number;
  } = {},
): EpisodeLine => ({
  task: { id },
  policy: { id: o.policy ?? "vertex:deepseek-ai/deepseek-v4.1-flash-maas:thinking" },
  result: {
    outcome: o.outcome ?? "submitted",
    finished_at: o.at ?? "2026-10-20T00:00:00Z",
    tool_calls: o.tool_calls ?? 4,
    grade: {
      pass,
      fields: [
        { field: "verdict", expected: o.verdict ?? "watching", ok: true },
        { field: "offer.npv_cents", expected: "1", ok: pass },
      ],
    },
    usage: {
      input_tokens: o.tokens ?? 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
    },
  },
});

describe("the statistics", () => {
  it("gives the Wilson interval: 58 of 60 is 88.6 % to 99.1 %", () => {
    const w = wilson(58, 60);
    expect(w.low).toBeCloseTo(0.8864, 3);
    expect(w.high).toBeCloseTo(0.9908, 3);
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it("gives McNemar's exact p from the disagreements alone", () => {
    expect(mcnemarExact(0, 5)).toBeCloseTo(0.0625, 10);
    expect(mcnemarExact(2, 8)).toBeCloseTo(112 / 1024, 10);
    expect(mcnemarExact(1, 1)).toBe(1);
    expect(mcnemarExact(0, 0)).toBe(1);
  });

  it("prices an episode from its tokens, or says it cannot", () => {
    expect(
      costOf("vertex:deepseek-ai/deepseek-v4.1-flash-maas:thinking", line("t", true).result.usage),
    ).toBeCloseTo(0.3, 10);
    expect(costOf("anthropic:claude-opus-5-5:high", line("t", true).result.usage)).toBeCloseTo(
      4,
      10,
    );
    expect(costOf("someone-else", line("t", true).result.usage)).toBeNull();
  });
});

describe("the pairing", () => {
  it("does not score a transport error, takes the newest scored episode, and names what it left out", () => {
    const a = scoreSide([
      line("t1", false, { outcome: "error" }),
      line("t1", true, { at: "2026-10-20T01:00:00Z" }),
      line("t2", false, { at: "2026-10-20T01:00:00Z" }),
      line("t2", true, { at: "2026-10-20T02:00:00Z" }),
      line("t3", false, { outcome: "error" }),
    ]);
    expect(a.byTask.get("t1")?.pass).toBe(true);
    expect(a.byTask.get("t2")?.pass).toBe(true);
    expect(a.unscored).toEqual(["t3"]);

    const b = scoreSide([line("t1", false), line("t2", true), line("t3", true), line("t4", true)]);
    const c = compare(a, b);
    expect(c.tasks).toBe(2);
    expect(c.unpaired).toEqual(["t3", "t4"]);
    expect([c.a.passed, c.b.passed, c.onlyA, c.onlyB]).toEqual([2, 1, 1, 0]);
  });

  it("scores a refusal or a missing answer as a miss, because it is the model's", () => {
    const s = scoreSide([
      line("t1", false, { outcome: "refusal" }),
      line("t2", false, { outcome: "no_submission" }),
    ]);
    expect([...s.byTask.values()].map((x) => x.pass)).toEqual([false, false]);
    expect(s.unscored).toEqual([]);
  });

  it("does not score an episode whose turn never ran, even as the newest", () => {
    const never = { outcome: "no_submission", tool_calls: 0, tokens: 0 } as const;
    const s = scoreSide([
      line("t1", true, { at: "2026-10-20T01:00:00Z" }),
      line("t1", false, { ...never, at: "2026-10-20T02:00:00Z" }),
      line("t2", false, never),
      line("t3", false, { outcome: "no_submission", tool_calls: 0 }),
    ]);
    expect(s.byTask.get("t1")?.pass).toBe(true);
    expect(s.unscored).toEqual(["t2"]);
    // A model that read its task and stopped spent tokens: its miss.
    expect(s.byTask.get("t3")?.pass).toBe(false);
  });

  it("names the tasks both sides missed on the same field, as wording to check", () => {
    const a = scoreSide([line("t1", false), line("t2", false), line("t3", true)]);
    const b = scoreSide([line("t1", false), line("t2", true), line("t3", true)]);
    expect(compare(a, b).sharedMisses).toEqual([{ id: "t1", fields: ["offer.npv_cents"] }]);
  });
});
