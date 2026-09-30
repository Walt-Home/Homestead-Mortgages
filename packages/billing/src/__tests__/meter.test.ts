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

  it("rounds half-up once, to the token", () => {
    // $441,366.13 × 1,750 / 100,000 = 7,723.907… → 7,724 for a whole month.
    expect(tokensForBalance(44_136_613n, 1750, 30, 30)).toBe(7724n);
    // One day of it: 257.46… → 257.
    expect(tokensForBalance(44_136_613n, 1750, 1, 30)).toBe(257n);
  });
});

describe("the month's statement", () => {
  it("bills the sample book a whole month off the self-improving mortgage row alone", () => {
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
    // Per loan, half-up: the twelve round to these, and the total is their sum.
    const perLoan = s.loans.map((c) => c.tokens);
    expect(perLoan).toEqual([
      7724n,
      6480n,
      8567n,
      5773n,
      10393n,
      4966n,
      6917n,
      6214n,
      4696n,
      5620n,
      5839n,
      5064n,
    ]);
    expect(s.tokens).toBe(78_253n);
    expect(s.cents).toBe(78_253n);
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]!.code).toBe("A.self_improving_mortgage");
    expect(s.lines[0]!.tokens).toBe(78_253n);
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
    expect(s.tokens).toBe(467n);
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
    expect(c.tokens).toBe(875n);
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
    expect(s.tokens).toBe(1575n);
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
    expect(s.tokens).toBe(583n);
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
    expect(s.tokens).toBe(1950n);
    expect(s.loans[0]!.touchTokens).toBe(200n);
  });

  it("spells every bigint as a decimal string on the wire", () => {
    const loans = [loan("A", "2026-09-01", [{ asOf: "2026-09-01", balance: 10_000_000n }])];
    const w = statementWire(meterMonth(loans, day("2026-09-01")));
    expect(w.tokens).toBe("1750");
    expect(w.cents).toBe("1750");
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
