/**
 * The two JSON blocks, parsed by the shape they are meant to hold.
 */

import { describe, expect, it } from "vitest";
import { UNCOMPUTED_RATIOS, UNCOMPUTED_RESERVES } from "../types/decision.js";
import {
  RATIO_KEYS,
  RatiosSchema,
  RESERVE_KEYS,
  ReserveAssessmentSchema,
} from "../decision-figures.js";

describe("a ratio block", () => {
  it("is exactly the eight figures, each finite or null", () => {
    expect(RATIO_KEYS).toHaveLength(8);
    expect(RatiosSchema.parse(UNCOMPUTED_RATIOS)).toEqual(UNCOMPUTED_RATIOS);
    expect(RatiosSchema.parse({ ...UNCOMPUTED_RATIOS, ltv: 80 })).toMatchObject({ ltv: 80 });
  });

  it("refuses an empty block, a string, an extra key and infinity", () => {
    expect(() => RatiosSchema.parse({})).toThrow();
    expect(() => RatiosSchema.parse({ ...UNCOMPUTED_RATIOS, ltv: "80" })).toThrow();
    expect(() => RatiosSchema.parse({ ...UNCOMPUTED_RATIOS, extra: 1 })).toThrow();
    expect(() => RatiosSchema.parse({ ...UNCOMPUTED_RATIOS, dtiBack: Infinity })).toThrow();
  });
});

describe("a reserve block", () => {
  it("is exactly the four figures", () => {
    expect(RESERVE_KEYS).toHaveLength(4);
    expect(ReserveAssessmentSchema.parse(UNCOMPUTED_RESERVES)).toEqual(UNCOMPUTED_RESERVES);
    expect(() =>
      ReserveAssessmentSchema.parse({ ...UNCOMPUTED_RESERVES, satisfied: "yes" }),
    ).toThrow();
    expect(() => ReserveAssessmentSchema.parse({})).toThrow();
  });
});
