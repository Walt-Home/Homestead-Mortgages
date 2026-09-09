/**
 * No screen invents an income.
 *
 * The stated monthly income is a fact about a real person: screen 1 records it
 * on the party, the server supersedes that fact whenever a later save restates
 * one, and the receipt counts it as one of its six pieces. So a screen that
 * sends a filler number to satisfy a schema does not send a harmless number —
 * it overwrites a true figure with a false one and then stamps the receipt
 * with the false one. The field is optional for exactly this reason, and an
 * absent income leaves the recorded figure standing.
 *
 * Read out of the source rather than exercised, because the defect lives in
 * one argument of one fetch on the ordinary submit path. Rendering these pages
 * would need a router, a query client and a server; the literal is the whole
 * claim, and reading it fails on the line that would carry it back.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PAGES = new URL("../", import.meta.url);

/** Every screen, so a new one is covered the day it is written. */
const sources = readdirSync(PAGES)
  .filter((name) => name.endsWith(".tsx"))
  .map((name) => ({ name, text: readFileSync(new URL(name, PAGES), "utf8") }));

describe("what the screens send as a stated income", () => {
  it("covers every page", () => {
    expect(sources.length).toBeGreaterThan(4);
  });

  it("never sends a number nobody stated", () => {
    for (const { name, text } of sources) {
      const lines = text.split("\n").filter((l) => l.includes("statedMonthlyIncome:"));
      for (const line of lines) {
        // `statedMonthlyIncome: 1` — a placeholder standing in for a figure.
        expect(line, name).not.toMatch(/statedMonthlyIncome:\s*\d/);
        // `statedMonthlyIncome: statedIncome || 1` — the same placeholder,
        // reached only when the screen has lost the real figure, which is the
        // case where a borrower is most likely to be carrying one.
        expect(line, name).not.toMatch(/statedMonthlyIncome:[^,}]*(\|\||\?\?)\s*\d/);
      }
    }
  });

  it("omits the field on the screen that may not have the figure", () => {
    const identity = sources.find((s) => s.name === "IdentityPage.tsx");
    expect(identity).toBeDefined();
    const line = identity!.text.split("\n").find((l) => l.includes("statedMonthlyIncome:"));
    expect(line).toBeDefined();
    // Spread conditionally: present when screen 1's figure survived the trip
    // here, absent otherwise. An unconditional key cannot express "absent".
    expect(line).toMatch(/\.\.\.\(/);
  });

  it("states none at all on the review screen", () => {
    const review = sources.find((s) => s.name === "ReviewPage.tsx");
    expect(review).toBeDefined();
    // Screen 4 asks for no figure and holds none. The borrower it re-sends
    // already has one on record.
    expect(review!.text).not.toContain("statedMonthlyIncome");
  });
});
