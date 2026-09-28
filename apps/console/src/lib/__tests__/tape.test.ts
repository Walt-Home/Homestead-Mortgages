import { describe, expect, it } from "vitest";
import * as tape from "../tape.js";
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

describe("the team, as people paste it", () => {
  it("reads a bare address, Name <address>, and a comma either way round", () => {
    const { parseTeamLines } = tape;
    expect(
      parseTeamLines(
        "ops@servicer.com\n\nJane Doe <jane@servicer.com>\nbob@servicer.com, Bob Ray\nAnn Lee, ann@servicer.com\nnot an address\n",
      ),
    ).toEqual([
      { email: "ops@servicer.com", name: null },
      { email: "jane@servicer.com", name: "Jane Doe" },
      { email: "bob@servicer.com", name: "Bob Ray" },
      { email: "ann@servicer.com", name: "Ann Lee" },
      { email: "not an address", name: null },
    ]);
  });
});
