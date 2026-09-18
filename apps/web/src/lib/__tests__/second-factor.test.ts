/**
 * The second step's words and its two rules.
 *
 * The copy is held to the same rules as every other catalog — no promise the
 * product cannot keep, no British spelling, no vendor claim — and the two
 * rules the screen leans on are held here rather than inside the JSX: which
 * kind of code was typed, and what a refusal is called.
 */

import { describe, expect, it } from "vitest";
import { BRITISH, DAY_FIRST, DELIVERY_TIME, PROMISES, REQ_ID, VENDOR_CLAIM } from "@hm/shared";
import { ApiError } from "../api.js";
import { SECOND_FACTOR_COPY, codeKind, errorFor, formatSecret } from "../second-factor.js";

/** Every string in the catalog, with the one function called at both shapes. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return [value(1), value(7)].map(String);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("the copy", () => {
  const COPY = strings(SECOND_FACTOR_COPY);

  it("has something to check", () => {
    expect(COPY.length).toBeGreaterThan(20);
  });

  for (const [name, rule] of Object.entries({
    PROMISES,
    DELIVERY_TIME,
    REQ_ID,
    BRITISH,
    DAY_FIRST,
    VENDOR_CLAIM,
  })) {
    it(`breaks no ${name} rule`, () => {
      expect(COPY.filter((s) => rule.test(s))).toEqual([]);
    });
  }
});

describe("which kind of code was typed", () => {
  it("is the app for six digits, however spaced", () => {
    expect(codeKind("123456")).toBe("app");
    expect(codeKind("123 456")).toBe("app");
    expect(codeKind(" 123-456 ")).toBe("app");
  });

  it("is a recovery code for anything else", () => {
    expect(codeKind("abcde-fghjk")).toBe("recovery");
    expect(codeKind("ABCDE FGHJK")).toBe("recovery");
    expect(codeKind("1234567")).toBe("recovery");
  });
});

describe("the key, read back by hand", () => {
  it("comes in groups of four", () => {
    expect(formatSecret("ABCDEFGHIJKLMNOP")).toBe("ABCD EFGH IJKL MNOP");
    expect(formatSecret("ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
  });
});

describe("what a refusal is called", () => {
  it("passes the lock through, because the minutes are in it", () => {
    const locked = new ApiError(
      429,
      "Too many wrong codes. Try again in 14 minutes.",
      "SECOND_FACTOR_LOCKED",
    );
    expect(errorFor(locked, "app")).toBe(locked.message);
  });

  it("names the kind of code that missed", () => {
    const wrong = new ApiError(401, "That code did not match.", "WRONG_CODE");
    expect(errorFor(wrong, "app")).toBe(SECOND_FACTOR_COPY.errors.wrongCode);
    expect(errorFor(wrong, "recovery")).toBe(SECOND_FACTOR_COPY.errors.wrongRecovery);
  });

  it("says what the server said for anything else it said, and a plain sentence otherwise", () => {
    const other = new ApiError(
      409,
      "Start by adding the authenticator app.",
      "NO_ENROLLMENT_IN_PROGRESS",
    );
    expect(errorFor(other, "app")).toBe(other.message);
    expect(errorFor(new TypeError("fetch failed"), "app")).toBe(SECOND_FACTOR_COPY.errors.generic);
  });
});
