/**
 * refi-policy states the review as a policy, so the one thing to prove is
 * that nothing the grading depends on was lost in the rewriting: every
 * field, code and verdict the step rulebook names, and every threshold,
 * appears in the policy. The tasks, tools and grader are refi-tape's.
 */

import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { POLICY, refiPolicy, renderPolicyTask } from "../refi-policy/index.js";
import {
  TAPE_RULEBOOK,
  TapeReferencePolicy,
  generateTapeSuite,
  tapeSpecTasks,
} from "../refi-tape/index.js";

/** Every snake_case name in a text: the fields, the codes, the tools. */
const names = (text: string): Set<string> =>
  new Set(text.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? []);

describe("refi-policy", () => {
  it("names every field, code and verdict the step rulebook names", () => {
    const missing = [...names(TAPE_RULEBOOK)].filter((n) => !POLICY.includes(n));
    expect(missing).toEqual([]);
  });

  it("states every threshold and constant the grading turns on", () => {
    for (const fact of [
      "25 basis points",
      "84 months",
      "360 months",
      "60 months",
      "36 days",
      "6 days",
      "÷ 365",
      "100000 cents",
      "1%",
      "200000 cents",
      "10000",
      "9700",
      "9000",
      "7500",
      "8000",
      "12 months",
      "24 months",
      "90 days",
      "0.25",
      "0.125",
      "above 5",
      "divided by 100",
      "3, 6, 9 or F",
      '"late" or "delinq"',
      "makes it 30",
      "round half up",
      "three decimals",
      "one decimal place",
    ]) {
      expect(POLICY, fact).toContain(fact);
    }
  });

  it("says each outcome and its precedence", () => {
    expect(POLICY).toContain("The outcome is the first of these that applies");
    for (const v of ["not_reviewable", "excluded", "candidate", "not_now", "watching"])
      expect(POLICY).toContain(`"${v}"`);
    expect(POLICY).toContain(
      "only the first of these that applies, in the order given, is reported",
    );
  });

  it("gives no numbered procedure", () => {
    expect(POLICY).not.toMatch(/\bStep \d/);
    expect(POLICY).not.toMatch(/^\d+\. /m);
  });

  it("asks for the policy in the task, and runs end to end on refi-tape's tasks", async () => {
    const [task] = tapeSpecTasks();
    if (!task) throw new Error("no spec task");
    expect(renderPolicyTask(task)).toMatch(/Apply the policy/);
    expect(renderPolicyTask(task)).not.toMatch(/rulebook/);
    for (const t of [task, ...generateTapeSuite("heldout", 1, 20)]) {
      expect((await runEpisode(refiPolicy, t, new TapeReferencePolicy())).grade.pass, t.id).toBe(
        true,
      );
    }
  });
});
