/**
 * The dated thresholds, pinned to the notice they came from.
 *
 * Every figure here is a number the CFPB republishes each January, and a stale
 * one produces a confidently wrong legal test rather than an error — so these
 * are not "does the lookup work" tests. Two things are being asserted:
 *
 *   1. the shipped figures ARE the published ones, checked the way the notice
 *      itself constrains them rather than by re-typing them, and
 *   2. a year this engine does not hold is refused rather than approximated.
 *
 * The continuity check in the middle is the one worth understanding. The notice
 * indexes all six dollar figures from a single multiplier applied to the
 * statutory bases — $100,000 / $60,000 / $20,000 / $12,500 for the tier bounds,
 * $3,000 / $1,000 for the flat caps — and those bases are continuous: 3% of
 * $100,000 is 5% of $60,000 is $3,000, and 5% of $20,000 is 8% of $12,500 is
 * $1,000. So the indexed figures must be continuous too, to within the dollar
 * each is rounded to. A transcription error in any single figure breaks the
 * continuity; six independently mistyped figures that still line up is not a
 * failure mode that happens.
 */

import { describe, expect, it } from "vitest";
import {
  cents,
  generalQmSpreadCap,
  hoepaPointsAndFeesLimit,
  pointsAndFeesLimit,
  REGULATION_Z_THRESHOLDS,
  thresholdsFor,
  thresholdYearsHeld,
} from "../guidelines.js";

const T2026 = REGULATION_Z_THRESHOLDS[2026]!;

describe("the 2026 Regulation Z thresholds", () => {
  it("carries the five §1026.43(e)(3)(i) tiers as the notice states them", () => {
    // Two of these are DOLLARS and three are percentages. The table this
    // replaced encoded (B) and (D) as 3.9% and 6.6% — each dollar cap divided
    // by the bottom of its own tier, which is right at one loan size and wrong
    // at every other, permissively above it.
    expect(T2026.qmPointsAndFees).toEqual([
      { minLoanAmount: 137_958, limit: { percent: 3 }, paragraph: "§1026.43(e)(3)(i)(A)" },
      { minLoanAmount: 82_775, limit: { dollars: 4_139 }, paragraph: "§1026.43(e)(3)(i)(B)" },
      { minLoanAmount: 27_592, limit: { percent: 5 }, paragraph: "§1026.43(e)(3)(i)(C)" },
      { minLoanAmount: 17_245, limit: { dollars: 1_380 }, paragraph: "§1026.43(e)(3)(i)(D)" },
      { minLoanAmount: 0, limit: { percent: 8 }, paragraph: "§1026.43(e)(3)(i)(E)" },
    ]);
  });

  it("carries HOEPA's two indexed figures, and they are the QM table's own", () => {
    // §1026.32(a)(1)(ii) and §1026.43(e)(3)(i) index from the same $20,000 and
    // $1,000 bases, so HOEPA's small-loan bound IS the QM 5% tier's floor and
    // HOEPA's flat cap IS QM tier (D)'s. Two figures that must move together
    // and are read from two different sentences of one notice.
    expect(T2026.hoepa).toEqual({ smallLoanBelow: 27_592, smallLoanDollarCap: 1_380 });
    expect(T2026.hoepa.smallLoanBelow).toBe(T2026.qmPointsAndFees[2]!.minLoanAmount);
    expect(T2026.qmPointsAndFees[3]!.limit).toEqual({ dollars: T2026.hoepa.smallLoanDollarCap });
  });

  it("sets the General QM APR bounds to the same two indexed loan amounts", () => {
    // §1026.43(e)(2)(vi)'s bounds were published as $110,260 and $66,156 when
    // the General QM Final Rule was written, which are that year's
    // §1026.43(e)(3)(i)(A) and (B) floors. They index together.
    expect(T2026.generalQmApr).toEqual({ top: 137_958, middle: 82_775 });
    expect(T2026.generalQmApr.top).toBe(T2026.qmPointsAndFees[0]!.minLoanAmount);
    expect(T2026.generalQmApr.middle).toBe(T2026.qmPointsAndFees[1]!.minLoanAmount);
  });

  it("holds figures that are continuous at all four tier boundaries", () => {
    // The check described at the top of this file: one multiplier, six bases,
    // so a limit stated as a percentage and the limit stated in dollars beside
    // it must agree to within the rounding of a single dollar.
    const pairs: [number, number, number][] = [
      // [tier bound, percent that applies above it, dollar cap that applies below]
      [137_958, 3, 4_139],
      [82_775, 5, 4_139],
      [27_592, 5, 1_380],
      [17_245, 8, 1_380],
    ];
    for (const [bound, percent, dollars] of pairs) {
      expect(Math.abs((bound * percent) / 100 - dollars)).toBeLessThan(1);
    }
  });

  it("names the publication every one of them came from", () => {
    expect(T2026.source).toContain("2025-12-15");
    expect(T2026.source).toContain("HOEPA");
    expect(T2026.year).toBe(2026);
  });

  it("carries FHFA's 2026 baseline one-unit conforming limit", () => {
    // Not a CPI figure — FHFA indexes it off house prices — so nothing above
    // cross-checks it and it is pinned on its own.
    expect(T2026.conformingLoanLimit).toBe(832_750);
  });
});

describe("a year this engine does not hold", () => {
  it("is refused rather than answered off the nearest year", () => {
    // The same discipline as the APOR series. A threshold from the wrong year
    // is wrong by exactly one annual adjustment and looks like a right one, so
    // the table stops answering and the caller blocks.
    expect(thresholdsFor("2026-01-01")).not.toBeNull();
    expect(thresholdsFor("2025-12-31")).toBeNull();
    expect(thresholdsFor("2027-01-01")).toBeNull();
    expect(thresholdsFor("not-a-date")).toBeNull();
  });

  it("says which years it does hold, so a blocked derivation can name them", () => {
    expect(thresholdYearsHeld()).toEqual([2026]);
  });
});

describe("the points-and-fees limit is a dollar figure", () => {
  const limitOf = (loan: number, total: number) =>
    pointsAndFeesLimit(loan, total, T2026).limitCents;

  it("applies 3% of the total loan amount at and above the top tier", () => {
    expect(limitOf(200_000, 195_000)).toBe(cents(5_850));
    expect(limitOf(137_958, 135_000)).toBe(cents(4_050));
  });

  it("applies tier (B) as a flat $4,139, not as a percentage of anything", () => {
    // The whole finding. Under the old 3.9% a $137,000 loan was allowed $5,343
    // where the rule allows $4,139 — a non-QM loan handed the §1026.43(e)(1)
    // presumption of compliance — and a $83,000 one was allowed $3,237 where
    // the rule allows $4,139, failing a loan that is a qualified mortgage.
    expect(limitOf(137_000, 135_000)).toBe(cents(4_139));
    expect(limitOf(90_000, 88_000)).toBe(cents(4_139));
    expect(limitOf(82_775, 80_000)).toBe(cents(4_139));
    // What the percentage encoding would have said, for the record.
    expect(Math.round(137_000 * 3.9)).toBeGreaterThan(cents(4_139));
    expect(Math.round(83_000 * 3.9)).toBeLessThan(cents(4_139));
  });

  it("applies tier (D) as a flat $1,380 and tier (E) as 8%", () => {
    expect(limitOf(20_000, 18_700)).toBe(cents(1_380));
    expect(limitOf(17_245, 16_000)).toBe(cents(1_380));
    expect(limitOf(17_244, 16_000)).toBe(cents(1_280));
  });

  it("chooses the tier on the note amount and the percentage on the total", () => {
    // §1026.43(b)(5) defines "loan amount" as the note principal, and
    // §1026.43(e)(3)(i) states its bounds in those terms and its percentages
    // against the §1026.32(b)(4) total loan amount. Two figures, on purpose:
    // the same $140,000 note is tier (A) whatever the fees did to the total.
    expect(limitOf(140_000, 136_000)).toBe(cents(4_080));
    // And the same TOTAL under a smaller note is tier (B)'s flat dollars.
    expect(limitOf(137_000, 136_000)).toBe(cents(4_139));
  });

  it("names its own basis and paragraph, because the derivation records both", () => {
    expect(pointsAndFeesLimit(90_000, 88_000, T2026)).toMatchObject({
      basis: "$4,139 flat (§1026.43(e)(3)(i)(B))",
      paragraph: "§1026.43(e)(3)(i)(B)",
    });
    expect(pointsAndFeesLimit(200_000, 195_000, T2026).basis).toContain(
      "3% of the §1026.32(b)(4) total loan amount",
    );
  });
});

describe("HOEPA's fee trigger is tiered, not a flat 5%", () => {
  it("is 5% of the total loan amount at and above the small-loan bound", () => {
    expect(hoepaPointsAndFeesLimit(30_000, 28_260, T2026).limitCents).toBe(cents(1_413));
    expect(hoepaPointsAndFeesLimit(27_592, 26_000, T2026).limitCents).toBe(cents(1_300));
  });

  it("is the LESSER of 8% and $1,380 below it", () => {
    // A flat 5% under the bound is always the smaller number, so the old code
    // never under-flagged — it over-flagged, and an over-flag here is a denial
    // with a Regulation B notice naming a rule that does not reach the loan.
    expect(hoepaPointsAndFeesLimit(20_000, 18_700, T2026).limitCents).toBe(cents(1_380));
    expect(Math.round(18_700 * 5)).toBeLessThan(cents(1_380));
    // Small enough that 8% is the binding half.
    expect(hoepaPointsAndFeesLimit(15_000, 14_000, T2026).limitCents).toBe(cents(1_120));
    expect(hoepaPointsAndFeesLimit(15_000, 14_000, T2026).basis).toContain("the percentage");
    expect(hoepaPointsAndFeesLimit(20_000, 18_700, T2026).basis).toContain("the flat dollar cap");
  });
});

describe("the General QM spread threshold", () => {
  it("gives a manufactured home under the top bound 6.5 points", () => {
    // §1026.43(e)(2)(vi)(D). Without it a manufactured-home loan of $100,000
    // was measured against 3.5 and labelled non_qm on a threshold that does not
    // apply to it — restrictive, and stored on an append-only decision.
    expect(generalQmSpreadCap(100_000, "manufactured", T2026)).toEqual({
      points: 6.5,
      paragraph: "§1026.43(e)(2)(vi)(D)",
      manufacturedHome: true,
    });
    expect(generalQmSpreadCap(100_000, "single_family", T2026).points).toBe(3.5);
  });

  it("stops giving it at the top bound, where (A) takes over", () => {
    expect(generalQmSpreadCap(137_958, "manufactured", T2026)).toMatchObject({
      points: 2.25,
      paragraph: "§1026.43(e)(2)(vi)(A)",
      manufacturedHome: false,
    });
    expect(generalQmSpreadCap(137_957, "manufactured", T2026).points).toBe(6.5);
  });

  it("keeps (A), (B) and (C) for everything else", () => {
    expect(generalQmSpreadCap(200_000, "condo", T2026).points).toBe(2.25);
    expect(generalQmSpreadCap(82_775, "condo", T2026).points).toBe(3.5);
    expect(generalQmSpreadCap(82_774, "condo", T2026).points).toBe(6.5);
  });
});
