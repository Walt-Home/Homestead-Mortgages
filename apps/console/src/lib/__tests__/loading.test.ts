import { describe, expect, it } from "vitest";
import { loadingLine } from "../loading.js";

describe("the loading screen's line", () => {
  it("says nothing at first, then what it is doing, then why it is slow", () => {
    expect(loadingLine(0)).toBe("");
    expect(loadingLine(3)).toBe("");
    expect(loadingLine(4)).toBe("Checking with the servicing app.");
    expect(loadingLine(14)).toBe("Checking with the servicing app.");
    expect(loadingLine(15)).toMatch(/^Still waking the servicing app\./);
    expect(loadingLine(90)).toMatch(/carries on by itself\.$/);
  });
});
