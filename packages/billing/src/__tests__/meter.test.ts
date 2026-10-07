/**
 * The tape meter over the sample book and over the edges a month has: a
 * loan loaded mid-month, one the tape reports paid off, one loaded after
 * the month, a month still running, and the rounding, held per loan.
 */

import { describe, expect, it } from "vitest";
import { sampleBook } from "@hm/partner-book";
import { plainDate } from "@hm/kernel/calendar";
import {
  meterMonth,
  monthKey,
  statementWire,
  tokensForBalance,
  type MeteredLoan,
} from "../meter.js";

const day = plainDate;

function loan(
  number: string,
  watchedFrom: string,
  observations: readonly {
    asOf: string;
    balance: bigint;
    status?: MeteredLoan["observations"][number]["status"];
  }[],
  touches = 0,
): MeteredLoan {
  return {
    loanId: `id-${number}`,
    number,
    watchedFrom: day(watchedFrom),
    observations: observations.map((o) => ({
      asOf: day(o.asOf),
      status: o.status ?? "current",
      principalBalanceCents: o.balance,
    })),
    touches,
  };
}

describe("tokens for a balance", () => {
  it("is 1,750 per $100,000 for a whole month, and pro rata by day", () => {
    expect(tokensForBalance(10_000_000n, 1750, 30, 30)).toBe(1750n);
    expect(tokensForBalance(23_000_000n, 1750, 30, 30)).toBe(4025n);
    // Eight days of a thirty-day month on $100,000: 1,750 × 8 / 30 = 466.67 → 467.
    expect(tokensForBalance(10_000_000n, 1750, 8, 30)).toBe(467n);
    expect(tokensForBalance(10_000_000n, 1750, 0, 30)).toBe(0n);
    expect(tokensForBalance(0n, 1750, 30, 30)).toBe(0n);
  });

  it("charges a loan-year rate a twelfth a month: 25,000 per $100,000 is 2,083.33 a whole month", () => {
    expect(tokensForBalance(10_000_000n, 25_000, 30, 30, 12)).toBe(2083n);
    expect(tokensForBalance(23_000_000n, 25_000, 30, 30, 12)).toBe(4792n);
    // Eight days of a thirty-day month on $100,000: 2,083.33 × 8 / 30 = 555.56 → 556.
    expect(tokensForBalance(10_000_000n, 25_000, 8, 30, 12)).toBe(556n);
    // Twelve whole months at a steady balance are exactly the year's 25,000: 25 basis points.
    expect(tokensForBalance(10_000_000n, 25_000, 30, 30, 12) * 12n).toBe(24_996n);
    expect(tokensForBalance(120_000_000n, 25_000, 30, 30, 12) * 12n).toBe(300_000n);
  });

  it("rounds half-up once, to the token", () => {
    // $441,366.13 × 1,750 / 100,000 = 7,723.907… → 7,724 for a whole month.
    expect(tokensForBalance(44_136_613n, 1750, 30, 30)).toBe(7724n);
    // One day of it: 257.46… → 257.
    expect(tokensForBalance(44_136_613n, 1750, 1, 30)).toBe(257n);
  });
});

describe("the month's statement", () => {
  it("bills the sample book a whole month off the monitored-book rate alone", () => {
    const book = sampleBook();
    const loans = book.loans.map((l) =>
      loan(l.servicer_loan_number, "2026-08-15", [{ asOf: "2026-09-01", balance: l.upb_cents }]),
    );
    const s = meterMonth(loans, day("2026-09-10"));
    expect(s.month).toBe("2026-09");
    expect(s.from).toBe("2026-09-01");
    expect(s.to).toBe("2026-09-30");
    expect(s.through).toBe("2026-09-30");
    expect(s.daysInMonth).toBe(30);
    expect(s.loansOnBook).toBe(12);
    expect(s.loansBilled).toBe(12);
    expect(s.loanDays).toBe(360);
    expect(s.loanMonths).toBe("12.00");
    expect(s.balanceCents).toBe(447_158_188n);
    // Per loan, half-up, at 25,000 ÷ 12 per $100,000 a month: balance ÷ 4,800, rounded —
    // computed apart from the meter — and the total is their sum.
    const perLoan = s.loans.map((c) => c.tokens);
    expect(perLoan).toEqual([
      9195n,
      7714n,
      10198n,
      6873n,
      12373n,
      5912n,
      8235n,
      7397n,
      5591n,
      6691n,
      6951n,
      6029n,
    ]);
    expect(s.tokens).toBe(93_159n);
    expect(s.cents).toBe(93_159n);
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]!.code).toBe("A.monitored_book");
    expect(s.lines[0]!.cadence).toBe("loan_year");
    expect(s.lines[0]!.tokensEach).toBe(25_000);
    expect(s.lines[0]!.tokens).toBe(93_159n);
    expect(s.lines[0]!.quantity).toEqual({
      kind: "loan_months",
      loanMonths: "12.00",
      loanDays: 360,
      loans: 12,
      balanceCents: 447_158_188n,
    });
    expect(s.lines[1]!.code).toBe("A.offer_touch");
    expect(s.lines[1]!.tokens).toBe(0n);
    expect(s.lines[1]!.quantity).toEqual({ kind: "events", count: 0 });
    // Every loan is current and unbilled for nothing.
    for (const c of s.loans) expect(c.notBilled).toBeNull();
  });

  it("counts a loan from the day it was loaded, not the tape's as-of", () => {
    const loans = [loan("A", "2026-09-23", [{ asOf: "2026-09-01", balance: 10_000_000n }])];
    const s = meterMonth(loans, day("2026-09-01"));
    expect(s.loans[0]!.days).toBe(8);
    expect(s.loans[0]!.basis?.asOf).toBe("2026-09-01");
    expect(s.tokens).toBe(556n);
    expect(s.loanMonths).toBe("0.27");
  });

  it("stops the day a tape reports the loan ended, and reads the balance from before", () => {
    const loans = [
      loan("A", "2026-08-01", [
        { asOf: "2026-09-01", balance: 10_000_000n },
        { asOf: "2026-09-16", balance: 0n, status: "paid_off" },
      ]),
    ];
    const s = meterMonth(loans, day("2026-09-01"));
    const c = s.loans[0]!;
    expect(c.endedOn).toBe("2026-09-16");
    expect(c.days).toBe(15);
    expect(c.basis?.principalBalanceCents).toBe(10_000_000n);
    // Fifteen of thirty days: 2,083.33 ÷ 2 = 1,041.67 → 1,042.
    expect(c.tokens).toBe(1042n);
    // The month after, nothing: the loan is counted on the book and billed for nothing.
    const next = meterMonth(loans, day("2026-10-01"));
    expect(next.loansOnBook).toBe(1);
    expect(next.loansBilled).toBe(0);
    expect(next.loans).toHaveLength(0);
    expect(next.tokens).toBe(0n);
  });

  it("reads the newest balance on or before the month's end, never a later tape's", () => {
    const loans = [
      loan("A", "2026-08-01", [
        { asOf: "2026-09-01", balance: 10_000_000n },
        { asOf: "2026-09-20", balance: 9_000_000n },
        { asOf: "2026-10-01", balance: 8_000_000n },
      ]),
    ];
    const s = meterMonth(loans, day("2026-09-01"));
    expect(s.loans[0]!.basis?.asOf).toBe("2026-09-20");
    // $90,000 a whole month: 1,875.
    expect(s.tokens).toBe(1875n);
  });

  it("bills nothing for a loan loaded after the month, or before any tape gave it a balance", () => {
    const later = loan("A", "2026-10-03", [{ asOf: "2026-10-01", balance: 10_000_000n }]);
    const noBalance = loan("B", "2026-09-01", []);
    const s = meterMonth([later, noBalance], day("2026-09-01"));
    expect(s.loansOnBook).toBe(2);
    expect(s.loansBilled).toBe(0);
    expect(s.tokens).toBe(0n);
  });

  it("counts a month still running only through the day asked for", () => {
    const loans = [loan("A", "2026-09-01", [{ asOf: "2026-09-01", balance: 10_000_000n }])];
    const s = meterMonth(loans, day("2026-09-01"), { through: day("2026-09-10") });
    expect(s.through).toBe("2026-09-10");
    expect(s.loans[0]!.days).toBe(10);
    // Ten of thirty days: 694.44 → 694.
    expect(s.tokens).toBe(694n);
    // A day past the month's end is the month's end.
    expect(meterMonth(loans, day("2026-09-01"), { through: day("2026-10-15") }).through).toBe(
      "2026-09-30",
    );
  });

  it("charges a touch at 100 tokens flat, on top of the balance line", () => {
    const loans = [loan("A", "2026-09-01", [{ asOf: "2026-09-01", balance: 10_000_000n }], 2)];
    const s = meterMonth(loans, day("2026-09-01"));
    expect(s.lines[1]!.tokens).toBe(200n);
    expect(s.lines[1]!.quantity).toEqual({ kind: "events", count: 2 });
    expect(s.tokens).toBe(2283n);
    expect(s.loans[0]!.touchTokens).toBe(200n);
  });

  it("spells every bigint as a decimal string on the wire", () => {
    const loans = [loan("A", "2026-09-01", [{ asOf: "2026-09-01", balance: 10_000_000n }])];
    const w = statementWire(meterMonth(loans, day("2026-09-01")));
    expect(w.tokens).toBe("2083");
    expect(w.cents).toBe("2083");
    expect(w.balanceCents).toBe("10000000");
    expect(w.loans[0]!.basis?.principalBalanceCents).toBe("10000000");
    expect(w.lines[0]!.quantity).toEqual({
      kind: "loan_months",
      loanMonths: "1.00",
      loanDays: 30,
      loans: 1,
      balanceCents: "10000000",
    });
    expect(() => JSON.stringify(w)).not.toThrow();
  });

  it("keys a month as YYYY-MM", () => {
    expect(monthKey(day("2026-09-29"))).toBe("2026-09");
    expect(monthKey(day("2026-01-01"))).toBe("2026-01");
  });
});

describe("the run rate", () => {
  it("is a whole month at the newest balances, twelve times over, and leaves out what the meter would", async () => {
    const { meterTerms, runRate, runRateWire } = await import("../meter.js");
    const loans = [
      // $200,000 at the newest tape: 2 × 2,083.33 = 4,166.67 → 4,167 tokens a month.
      loan("A", "2026-09-01", [
        { asOf: "2026-09-30", balance: 25_000_000n },
        { asOf: "2026-10-05", balance: 20_000_000n },
      ]),
      // Reported paid off: nothing.
      loan("B", "2026-09-01", [
        { asOf: "2026-09-30", balance: 10_000_000n },
        { asOf: "2026-10-05", balance: 0n, status: "paid_off" },
      ]),
      // Loaded after the day: not yet in the rate.
      loan("C", "2026-10-20", [{ asOf: "2026-10-05", balance: 10_000_000n }]),
      // No balance: nothing.
      loan("D", "2026-09-01", [{ asOf: "2026-10-05", balance: 0n }]),
      // $123,456.78: 2,572.02 → 2,572, rounded once, as the meter rounds a loan-month.
      loan("E", "2026-09-01", [{ asOf: "2026-10-05", balance: 12_345_678n }]),
    ];
    const r = runRate(loans, day("2026-10-06"));
    expect(r.loans).toBe(2);
    expect(r.loansOnBook).toBe(5);
    expect(r.balanceCents).toBe(32_345_678n);
    // 4,167 + 2,572.
    expect(r.monthlyTokens).toBe(6_739n);
    expect(r.monthlyCents).toBe(6_739n);
    expect(r.annualTokens).toBe(80_868n);
    expect(r.annualCents).toBe(80_868n);
    // A whole month of the loans in the rate agrees with it to the token.
    const whole = meterMonth([loans[0]!, loans[4]!], day("2026-10-01"));
    expect(whole.tokens).toBe(r.monthlyTokens);
    expect(runRateWire(r)).toEqual({
      asOf: "2026-10-06",
      loans: 2,
      loansOnBook: 5,
      balanceCents: "32345678",
      monthlyTokens: "6739",
      monthlyCents: "6739",
      annualTokens: "80868",
      annualCents: "80868",
    });
    expect(meterTerms()).toEqual({
      sheet: { version: "1.1", date: "2026-10-07" },
      rateTokensPer100k: 25_000,
      rateCadence: "loan_year",
      basisPointsPerYear: 25,
      touchTokens: 100,
      tokenCents: "1",
      balanceUnitCents: "10000000",
    });
  });
});
