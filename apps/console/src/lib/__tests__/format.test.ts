/**
 * His API answers in three timestamp shapes and money as strings of cents;
 * these are the readers every screen goes through.
 */

import { describe, expect, it } from "vitest";
import { fmtDate, fmtRelative, money, parseTs, pct, words } from "../format.js";

describe("parseTs", () => {
  it("reads ISO, Postgres text and plain dates", () => {
    expect(parseTs("2026-09-22T14:03:11.123Z")?.toISOString()).toBe("2026-09-22T14:03:11.123Z");
    expect(parseTs("2026-09-22 14:03:11.123456+00")?.toISOString()).toBe(
      "2026-09-22T14:03:11.123Z",
    );
    expect(parseTs("2026-09-22 09:03:11-05")?.toISOString()).toBe("2026-09-22T14:03:11.000Z");
    expect(parseTs("2026-09-22")).not.toBeNull();
    expect(parseTs(null)).toBeNull();
    expect(parseTs("not a date")).toBeNull();
  });
  it("shows a plain date as the day it names, whatever the zone", () => {
    expect(fmtDate("2026-09-01")).toBe("Sep 1, 2026");
  });
  it("says how long ago, or in how long", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    expect(fmtRelative("2026-09-22T11:59:40Z", now)).toBe("just now");
    expect(fmtRelative("2026-09-22T09:00:00Z", now)).toBe("3h ago");
    expect(fmtRelative("2026-09-25T12:00:00Z", now)).toBe("in 3d");
    expect(fmtRelative("2026-09-01", now)).toBe("21d ago");
  });
});

describe("money", () => {
  it("reads cents as strings, numbers or bigints", () => {
    expect(money("44136613")).toBe("$441,366.13");
    expect(money(306979)).toBe("$3,069.79");
    expect(money(-5n)).toBe("−$0.05");
    expect(money(null)).toBe("—");
    expect(money("59300000", { compact: true })).toBe("$593.0K");
  });
  it("shows a percent without trailing zeros", () => {
    expect(pct("6.625")).toBe("6.625%");
    expect(pct("7.250")).toBe("7.25%");
    expect(pct(7)).toBe("7%");
  });
  it("turns a code into words", () => {
    expect(words("human_portal_task")).toBe("Human portal task");
    expect(words("waiting_approval")).toBe("Waiting approval");
  });
});
