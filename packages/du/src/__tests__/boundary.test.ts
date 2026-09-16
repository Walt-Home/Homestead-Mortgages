/**
 * The compute boundary, held against the corpus.
 *
 * Every figure in a decision's `ratios` and `reserves` is one Desktop
 * Underwriter derives for itself. The claim has two halves and both are
 * checkable against the generated Map: the MISMO element for the figure is
 * NOT a destination the Map lists, and the data points DU derives it from
 * ARE. The day a workbook upgrade lists `LTVRatioPercent`, the first half
 * fails, and that is the day somebody has to decide whether to assert it.
 */

import { describe, expect, it } from "vitest";
import { DU_DERIVED_FIGURES } from "@hm/shared";
import { DU_FORMATS } from "../generated/lengths.js";

/** The data-point names the Map lists, off the `PATH#Name#ref` keys. */
const LISTED = new Set(
  Object.keys(DU_FORMATS)
    .map((key) => key.split("#")[1])
    .filter((name): name is string => Boolean(name)),
);

describe("what DU derives and what we send", () => {
  it("lists no figure we shadow", () => {
    const named = Object.values(DU_DERIVED_FIGURES)
      .map((f) => f.mismo)
      .filter((m): m is string => m !== null);
    expect(named.length).toBeGreaterThanOrEqual(8);
    expect(named.filter((m) => LISTED.has(m))).toEqual([]);
  });

  it("lists every input we say DU derives them from", () => {
    const inputs = new Set(Object.values(DU_DERIVED_FIGURES).flatMap((f) => f.from));
    expect(inputs.size).toBeGreaterThanOrEqual(8);
    expect([...inputs].filter((name) => !LISTED.has(name))).toEqual([]);
  });
});
