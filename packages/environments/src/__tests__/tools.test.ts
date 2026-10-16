/**
 * The tools, held to the engine's own figures.
 *
 * Every money tool is one of the engine's exported primitives, and these
 * are the figures the servicing spec's worked example 1 names; the date
 * tools are the kernel's; the calculator is exact and runs nothing but
 * arithmetic.
 */

import { describe, expect, it } from "vitest";
import { calculate } from "../calculate.js";
import { executeTool } from "../refi/tools.js";

const run = (name: string, input: unknown) =>
  JSON.parse(executeTool(name, input)) as Record<string, unknown>;

describe("the money tools are the engine's arithmetic", () => {
  it("levels a payment to the cent: $560,000 at 6.125 % over 360 is $3,402.62", () => {
    expect(
      run("level_payment", {
        principal_cents: "56000000",
        annual_rate_pct: "6.125",
        term_months: 360,
      }),
    ).toEqual({
      payment_cents: "340262",
    });
  });

  it("schedules a balance: $565,000 at 7.000 % after 24 payments of $3,758.96 is $553,106.41", () => {
    expect(
      run("balance_after", {
        start_balance_cents: "56500000",
        annual_rate_pct: "7.000",
        payment_cents: "375896",
        payments: 24,
      }),
    ).toEqual({ balance_cents: "55310641" });
  });

  it("prices a per diem at rate ÷ 365: $553,106.41 at 7.000 % is $106.08", () => {
    expect(run("per_diem", { balance_cents: "55310641", annual_rate_pct: "7.000" })).toEqual({
      per_diem_cents: "10608",
    });
  });

  it("discounts a monthly amount: $356.34 for 84 months at 6.125 % is $24,292.78", () => {
    expect(
      run("present_value", { monthly_amount_cents: "35634", annual_rate_pct: "6.125", months: 84 }),
    ).toEqual({
      present_value_cents: "2429278",
    });
  });
});

describe("the date tools", () => {
  it("adds days and clamps months to the month's end", () => {
    expect(run("date_add", { date: "2026-10-01", days: 36 })).toEqual({ date: "2026-11-06" });
    expect(run("date_add", { date: "2024-01-31", months: 1 })).toEqual({ date: "2024-02-29" });
    expect(run("date_add", { date: "2026-10-01", months: -24 })).toEqual({ date: "2024-10-01" });
  });

  it("counts days, finds a month's end, and counts whole months as the engine does", () => {
    expect(run("days_between", { from: "2026-11-01", to: "2026-11-12" })).toEqual({ days: 11 });
    expect(run("end_of_month", { date: "2026-11-12" })).toEqual({ date: "2026-11-30" });
    expect(run("whole_months_between", { from: "2023-02-06", to: "2026-11-06" })).toEqual({
      months: 45,
    });
    expect(run("whole_months_between", { from: "2023-02-07", to: "2026-11-06" })).toEqual({
      months: 44,
    });
  });
});

describe("a malformed call is an error, never a guess", () => {
  it("refuses dollars where cents are asked, a bad date, an unknown tool and a missing field", () => {
    expect(() =>
      executeTool("per_diem", { balance_cents: "553106.41", annual_rate_pct: "7.000" }),
    ).toThrow(/integer cents/);
    expect(() => executeTool("end_of_month", { date: "2026-02-30" })).toThrow(/invalid date/);
    expect(() => executeTool("review_loan", {})).toThrow(/no tool named/);
    expect(() =>
      executeTool("level_payment", { principal_cents: "100", annual_rate_pct: "6" }),
    ).toThrow(/term_months/);
  });
});

describe("the calculator", () => {
  it("is exact, and rounds only where asked", () => {
    expect(calculate("0.1 + 0.2")).toBe("0.3");
    expect(calculate("55310641 + 10608 * 11")).toBe("55427329");
    expect(calculate("round(56000000 * 10000 / 80000000)")).toBe("7000");
    expect(calculate("round((7.000 - 6.125) * 100, 1)")).toBe("87.5");
    expect(calculate("ceil(55908229 / 100000) * 100000")).toBe("56000000");
    expect(calculate("max(round(56000000 * 0.01), 200000)")).toBe("560000");
    expect(calculate("floor((7.000 - 0.25) * 8) / 8")).toBe("6.75");
    expect(calculate("round(2.5)")).toBe("3");
    expect(calculate("round(-2.5)")).toBe("-3");
    expect(calculate("-(3 - 5) × 2 ÷ 4 − 1")).toBe("0");
  });

  it("runs nothing but arithmetic", () => {
    expect(() => calculate("process.exit(1)")).toThrow();
    expect(() => calculate("constructor(1)")).toThrow(/unknown function/);
    expect(() => calculate("__proto__(1)")).toThrow(/unknown function/);
    expect(() => calculate("tostring(1)")).toThrow(/unknown function/);
    expect(() => calculate("1 / 0")).toThrow(/division by zero/);
    expect(() => calculate("(1 + 2")).toThrow();
    expect(() => calculate("1 +")).toThrow();
    expect(() => calculate("1e9")).toThrow();
    expect(() => calculate("(".repeat(60) + "1" + ")".repeat(60))).toThrow(/nested too deeply/);
  });
});
