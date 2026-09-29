/**
 * The sheet's own arithmetic, held. Every figure here is printed on the
 * sheet — the subtotal, the standard year, the standard runs and the five
 * worked examples in section E — so a transcription error in the table
 * fails here rather than on somebody's invoice.
 */

import { describe, expect, it } from "vitest";
import {
  MONITORED_BOOK_CODES,
  PRICE_ROWS,
  PRICE_SHEET,
  priceRow,
  rowsIn,
  standardCycleTokensPer100k,
  standardPurchaseRunTokens,
  standardRefinanceRunTokens,
} from "../price-sheet.js";

describe("the price sheet", () => {
  it("is version 1.0 of 28 September 2026, at a cent a token", () => {
    expect(PRICE_SHEET.version).toBe("1.0");
    expect(PRICE_SHEET.date).toBe("2026-09-28");
    expect(PRICE_SHEET.tokenCents).toBe(1n);
    expect(PRICE_SHEET.balanceUnitCents).toBe(10_000_000n);
  });

  it("names every row once, in a section, with at least one process reference", () => {
    const codes = PRICE_ROWS.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const r of PRICE_ROWS) {
      expect(r.code.startsWith(`${r.section[0]}.`)).toBe(true);
      expect(r.processes.length).toBeGreaterThan(0);
      expect(r.tokens).toBeGreaterThan(0);
      expect(Number.isInteger(r.tokens)).toBe(true);
    }
    expect(() => priceRow("Z.nothing")).toThrow(/no row/);
  });

  it("section A sums to 25 basis points: 2,075 × 12 + 100 = 25,000 per $100,000", () => {
    const { monthly, annual, year } = standardCycleTokensPer100k();
    expect(monthly).toBe(2075);
    expect(annual).toBe(100);
    expect(year).toBe(25_000);
    // Every section A row is per $100,000 of balance.
    for (const r of rowsIn("A")) expect(r.basis).toBe("per_100k");
    // A loan whose escrow is waived skips the annual analysis row: 24,940 a year.
    expect(year - priceRow("A.escrow_analysis").tokens).toBe(24_940);
  });

  it("section B's standard refinance run is 60,000 tokens, and the purchase run 58,500 or 60,000 with MI", () => {
    expect(standardRefinanceRunTokens()).toBe(60_000);
    expect(standardPurchaseRunTokens({ mortgageInsurance: false })).toBe(58_500);
    expect(standardPurchaseRunTokens({ mortgageInsurance: true })).toBe(60_000);
    expect(rowsIn("B")).toHaveLength(49);
    expect(rowsIn("B_EXTRA")).toHaveLength(18);
  });

  it("carries sections C and D in full", () => {
    expect(rowsIn("C")).toHaveLength(15);
    expect(rowsIn("D")).toHaveLength(30);
    for (const r of [...rowsIn("C"), ...rowsIn("D")]) expect(r.basis).toBe("flat");
  });

  describe("section E, what it adds up to", () => {
    const per100k = standardCycleTokensPer100k().year;

    it("$100,000 of balance, one standard year: 25,000 tokens, $250", () => {
      expect(per100k).toBe(25_000);
      expect(per100k * Number(PRICE_SHEET.tokenCents)).toBe(25_000);
    });

    it("a $230,000 standard loan, one year: 57,500 tokens — servicing rows $92, self-improving mortgage $483", () => {
      // $230,000 is 2.3 units of $100,000; integer arithmetic, like the meter's.
      const per230k = (tokensPer100k: number) => (tokensPer100k * 23) / 10;
      const selfImproving = per230k(priceRow("A.self_improving_mortgage").tokens * 12);
      const servicing = per230k(per100k - priceRow("A.self_improving_mortgage").tokens * 12);
      expect(selfImproving).toBe(48_300);
      expect(servicing).toBe(9_200);
      expect(selfImproving + servicing).toBe(57_500);
    });

    it("a standard refinance run: 60,000 tokens, $600", () => {
      expect(standardRefinanceRunTokens()).toBe(60_000);
    });

    it("a loan 90 days delinquent that cures through a Flex Modification: 43,000 tokens", () => {
      const cure =
        3 * priceRow("D.delinquent_loan_month").tokens +
        priceRow("D.early_intervention_notice").tokens +
        priceRow("D.right_party_contact").tokens +
        priceRow("D.continuity_of_contact").tokens +
        priceRow("D.property_inspection").tokens +
        priceRow("D.lossmit_acknowledged").tokens +
        priceRow("D.complete_application_evaluation").tokens +
        priceRow("D.flex_modification").tokens;
      expect(cure).toBe(43_000);
    });

    it("a $6 billion servicing book, one standard year: 1.5 billion tokens, $15 million", () => {
      const tokens = (6_000_000_000 / 100_000) * per100k;
      expect(tokens).toBe(1_500_000_000);
      expect(tokens / 100).toBe(15_000_000);
    });
  });

  it("names the two rows a monitored loan on a partner's book consumes", () => {
    expect(MONITORED_BOOK_CODES).toEqual(["A.self_improving_mortgage", "A.offer_touch"]);
    const rate = priceRow("A.self_improving_mortgage");
    expect(rate.tokens).toBe(1750);
    expect(rate.basis).toBe("per_100k");
    expect(rate.cadence).toBe("loan_month");
    const touch = priceRow("A.offer_touch");
    expect(touch.tokens).toBe(100);
    expect(touch.basis).toBe("flat");
    expect(touch.cadence).toBe("event");
  });
});
