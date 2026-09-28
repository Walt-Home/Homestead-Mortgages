import { describe, expect, it } from "vitest";
import { countVerdicts, VERDICT_FILTERS, VERDICT_RANK, type Verdict } from "../tape.js";

describe("the verdicts as filters", () => {
  it("counts every row under its verdict, the unreviewed under none", () => {
    const rows: { v: Verdict | null }[] = [
      { v: "candidate" },
      { v: "excluded" },
      { v: "excluded" },
      { v: null },
      { v: "not_now" },
    ];
    expect(countVerdicts(rows, (r) => r.v)).toEqual({
      candidate: 1,
      watching: 0,
      not_now: 1,
      excluded: 2,
      none: 1,
    });
  });

  it("reads in the engine's order, the unreviewed last", () => {
    const verdicts = VERDICT_FILTERS.filter((f): f is Verdict => f !== "none");
    expect(verdicts.map((v) => VERDICT_RANK[v])).toEqual([0, 1, 2, 3]);
    expect(VERDICT_FILTERS.at(-1)).toBe("none");
  });
});
