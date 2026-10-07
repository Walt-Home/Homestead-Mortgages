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
  basisPointsPerYear,
  monthsPer,
  CYCLE_CODES,
  cycleBasisPointsPerYear,
} from "../price-sheet.js";

describe("the price sheet", () => {
  it("is version 1.1 of 7 October 2026, at a cent a token", () => {
    expect(PRICE_SHEET.version).toBe("1.1");
    expect(PRICE_SHEET.date).toBe("2026-10-07");
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

  it("names what a monitored loan on a partner's book consumes: every cycle row, 25 basis points a year, and touches", () => {
    expect(CYCLE_CODES).toEqual([
      "A.self_improving_mortgage",
      "A.payment_processing",
      "A.investor_reporting",
      "A.escrow_monitoring",
      "A.statements",
      "A.credit_furnishing",
      "A.escrow_analysis",
      "A.year_end_tax",
    ]);
    expect(MONITORED_BOOK_CODES).toEqual([...CYCLE_CODES, "A.offer_touch"]);
    // The rows add to 25 basis points a year; the self-improving row alone, 1.0's rule, was 21.
    expect(cycleBasisPointsPerYear()).toBe(25);
    expect(basisPointsPerYear(priceRow("A.self_improving_mortgage"))).toBe(21);
    expect(basisPointsPerYear(priceRow("A.escrow_analysis"))).toBeCloseTo(0.06, 10);
    expect(monthsPer("loan_month")).toBe(1);
    expect(monthsPer("loan_year")).toBe(12);
    expect(() => monthsPer("event")).toThrow(/not priced on a balance/);
    expect(() => basisPointsPerYear(priceRow("A.offer_touch"))).toThrow(/not priced on a balance/);
    const touch = priceRow("A.offer_touch");
    expect(touch.tokens).toBe(100);
    expect(touch.basis).toBe("flat");
    expect(touch.cadence).toBe("event");
  });
});
