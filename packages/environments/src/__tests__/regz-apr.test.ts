/**
 * regz-apr: regz-price-tests with the Appendix J solve taken out of the
 * tools. Only Step 3 and the tools change; the search the rulebook
 * describes lands on the engine's APR; every task can be solved through
 * the tools; and few draws need redrawing to be fair.
 */

import { describe, expect, it } from "vitest";
import { runEpisode } from "../episode.js";
import { sha256, toJsonLine } from "../record.js";
import { REGZ_RULEBOOK, drawRegzTask, regzPayload, type RegzTask } from "../regz/index.js";
import {
  REGZ_APR_DRAW,
  REGZ_APR_HELDOUT_SUITE,
  REGZ_APR_RULEBOOK,
  REGZ_APR_TOOLS,
  RegzAprReferencePolicy,
  STEP_THREE_SEARCH,
  executeRegzAprTool,
  generateRegzAprSuite,
  generateRegzAprTask,
  regzApr,
} from "../regz-apr/index.js";

const solveAll = async (tasks: readonly RegzTask[]) => {
  const misses: string[] = [];
  for (const task of tasks) {
    const r = await runEpisode(regzApr, task, new RegzAprReferencePolicy());
    if (!r.grade.pass) {
      const wrong = r.grade.fields
        .filter((f) => !f.ok)
        .map((f) => `${f.field} ${f.expected}/${f.got}`);
      misses.push(`${task.id} ${r.outcome} ${r.error ?? ""} ${wrong.join("; ")}`);
    }
  }
  return misses;
};

describe("regz-apr", () => {
  it("changes Step 3 and the tools, and nothing else", () => {
    expect(REGZ_APR_RULEBOOK).toContain(STEP_THREE_SEARCH);
    expect(REGZ_APR_RULEBOOK.replace(STEP_THREE_SEARCH, "")).toBe(
      REGZ_RULEBOOK.replace(/Otherwise the APR is annual_percentage_rate\([^)]*\)\./, ""),
    );
    const names = REGZ_APR_TOOLS.map((t) => t.name);
    expect(names).not.toContain("annual_percentage_rate");
    expect(names).toContain("present_value");
    expect(() => executeRegzAprTool("annual_percentage_rate", {})).toThrow(/no tool named/);
  });

  it("can be solved by the search the rulebook describes: the reference passes the held-out suite", async () => {
    expect(
      await solveAll(
        generateRegzAprSuite("heldout", REGZ_APR_HELDOUT_SUITE.seed, REGZ_APR_HELDOUT_SUITE.n),
      ),
    ).toEqual([]);
  }, 120_000);

  it("can be solved on a training suite from another seed", async () => {
    expect(await solveAll(generateRegzAprSuite("train", 11, 200))).toEqual([]);
  }, 120_000);

  it("is fair to grade on most first draws", () => {
    const draws = Array.from({ length: 600 }, (_, i) => drawRegzTask("train", 3, i, REGZ_APR_DRAW));
    expect(draws.filter((d) => d.attempts > 1).length).toBeLessThan(48);
  });

  it("still draws the held-out suite every reported score was measured on", () => {
    // A change here moves every score: bump REGZ_APR_ENVIRONMENT_VERSION, then the pin.
    expect(
      sha256(generateRegzAprSuite("heldout", 1, 200).map(toJsonLine).join("")),
    ).toMatchInlineSnapshot(`"f89a3b3b57aacef870d98d4a6ec81e9b7fe025cc2002edca58673b9bc1136eb8"`);
  });

  it("rebuilds a task from its coordinates, and never draws a held-out quote into training", () => {
    expect(toJsonLine(generateRegzAprTask("train", 7, 17))).toBe(
      toJsonLine(generateRegzAprSuite("train", 7, 30)[17]),
    );
    const fp = (t: RegzTask) => toJsonLine(regzPayload(t));
    const held = new Set(generateRegzAprSuite("heldout", 1, 200).map(fp));
    expect(generateRegzAprSuite("train", 1, 600).filter((t) => held.has(fp(t)))).toEqual([]);
  });
});
