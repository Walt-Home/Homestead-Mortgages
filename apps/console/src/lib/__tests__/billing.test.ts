import { describe, expect, it } from "vitest";
import { monthLabel, monthOf, monthsSince, tokensWord } from "../billing.js";

describe("billing's words", () => {
  it("names a month", () => {
    expect(monthLabel("2026-09")).toBe("September 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("nonsense")).toBe("nonsense");
    expect(monthOf("2026-09-29")).toBe("2026-09");
  });

  it("lists the months a book has been on ours, newest first", () => {
    expect(monthsSince("2026-08-15", "2026-09-29")).toEqual(["2026-09", "2026-08"]);
    expect(monthsSince("2025-11-03", "2026-02-01")).toEqual([
      "2026-02",
      "2026-01",
      "2025-12",
      "2025-11",
    ]);
    expect(monthsSince(null, "2026-09-29")).toEqual(["2026-09"]);
    // A load day in the future, by a clock's disagreement, is still this month.
    expect(monthsSince("2026-10-02", "2026-09-29")).toEqual(["2026-09"]);
  });

  it("counts tokens", () => {
    expect(tokensWord("78253")).toBe("78,253 tokens");
    expect(tokensWord(1)).toBe("1 token");
    expect(tokensWord("0")).toBe("0 tokens");
  });
});
