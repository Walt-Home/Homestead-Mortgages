/**
 * The episode loop, and the proof that every task can be solved.
 *
 * The reference policy follows the rulebook through the tools alone, so
 * its passing every generated task is what says the rulebook, the tools
 * and the grader agree. The rest holds the loop's edges: an answer one
 * cent off fails, no answer scores nothing, a bad submission can be fixed,
 * a bad tool call is an error the policy sees, and the budget is enforced.
 */

import { describe, expect, it } from "vitest";
import type { Observation, Policy, PolicyTurn, ToolCall } from "../episode.js";
import { runEpisode } from "../episode.js";
import {
  HELDOUT_SUITE,
  ReferencePolicy,
  SUBMIT_TOOL,
  generateSuite,
  refiReview,
  specTasks,
} from "../refi/index.js";

const [workedExample] = specTasks();
if (!workedExample) throw new Error("no spec tasks");

/** A policy that plays a fixed script of turns, then stops. */
function scripted(turns: (obs: readonly Observation[]) => ToolCall[][]): Policy {
  return {
    id: "scripted",
    start: () => {
      let i = 0;
      let script: ToolCall[][] | null = null;
      return {
        act: async (obs): Promise<PolicyTurn> => {
          script ??= turns(obs);
          const calls = script[i++] ?? [];
          return { calls, text: "", stop: calls.length ? "tool_calls" : "end" };
        },
      };
    },
  };
}

/** The reference policy, with one figure nudged a cent before it submits. */
function offByOneCent(): Policy {
  const ref = new ReferencePolicy();
  return {
    id: "off-by-one-cent",
    start: (episode) => {
      const s = ref.start(episode);
      return {
        act: async (obs) => {
          const turn = await s.act(obs);
          return {
            ...turn,
            calls: turn.calls.map((c) => {
              if (c.name !== SUBMIT_TOOL) return c;
              const input = c.input as { offer: Record<string, unknown> | null };
              if (!input.offer) return c;
              return {
                ...c,
                input: {
                  ...input,
                  offer: {
                    ...input.offer,
                    npv_cents: String(BigInt(String(input.offer["npv_cents"])) + 1n),
                  },
                },
              };
            }),
          };
        },
      };
    },
  };
}

describe("every task can be solved from the rulebook and the tools", () => {
  const solveAll = async (tasks: ReturnType<typeof specTasks>) => {
    const misses: string[] = [];
    for (const task of tasks) {
      const r = await runEpisode(refiReview, task, new ReferencePolicy());
      if (!r.grade.pass || r.outcome !== "submitted") {
        misses.push(
          `${task.id} ${r.outcome} ${r.grade.fields
            .filter((f) => !f.ok)
            .map((f) => f.field)
            .join(",")}`,
        );
      }
    }
    return misses;
  };

  it("passes the spec's cases", async () => {
    expect(await solveAll(specTasks())).toEqual([]);
  });

  it("passes the whole held-out suite", async () => {
    expect(await solveAll(generateSuite("heldout", HELDOUT_SUITE.seed, HELDOUT_SUITE.n))).toEqual(
      [],
    );
  }, 120_000);

  it("passes a training suite from another seed", async () => {
    expect(await solveAll(generateSuite("train", 11, 300))).toEqual([]);
  }, 120_000);
});

describe("the loop's edges", () => {
  it("fails an answer one cent off", async () => {
    const r = await runEpisode(refiReview, workedExample, offByOneCent());
    expect(r.outcome).toBe("submitted");
    expect(r.grade.pass).toBe(false);
    expect(r.grade.fields.filter((f) => !f.ok).map((f) => f.field)).toEqual(["offer.npv_cents"]);
  });

  it("scores nothing when the policy stops without submitting", async () => {
    const r = await runEpisode(
      refiReview,
      workedExample,
      scripted(() => []),
    );
    expect(r).toMatchObject({
      outcome: "no_submission",
      answer: null,
      grade: { pass: false, score: 0 },
    });
  });

  it("returns a malformed submission as an error the policy can fix", async () => {
    const r = await runEpisode(
      refiReview,
      workedExample,
      scripted(() => [
        [{ id: "a", name: SUBMIT_TOOL, input: { verdict: "approve", reasons: [] } }],
        [
          {
            id: "b",
            name: SUBMIT_TOOL,
            input: { verdict: "watching", reasons: [], offer: null, watch_rate_pct: null },
          },
        ],
      ]),
    );
    expect(r.outcome).toBe("submitted");
    expect(r.transcript.find((e) => e.kind === "observations")).toMatchObject({
      observations: [{ call_id: "a", is_error: true }],
    });
    expect(r.answer?.verdict).toBe("watching");
  });

  it("answers a bad tool call with an error, not a crash", async () => {
    const r = await runEpisode(
      refiReview,
      workedExample,
      scripted(() => [
        [
          { id: "a", name: "reviewLoan", input: {} },
          { id: "b", name: "calculate", input: { expression: "1 +" } },
        ],
      ]),
    );
    const obs = r.transcript.find((e) => e.kind === "observations");
    expect(obs).toMatchObject({
      observations: [
        { call_id: "a", is_error: true },
        { call_id: "b", is_error: true },
      ],
    });
    expect(r.outcome).toBe("no_submission");
  });

  it("ends an episode that spends its tool budget", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `c${i}`,
      name: "calculate",
      input: { expression: "1" },
    }));
    const r = await runEpisode(
      refiReview,
      workedExample,
      scripted(() => [many]),
    );
    expect(r.outcome).toBe("max_tool_calls");
    expect(r.grade.pass).toBe(false);
  });
});
