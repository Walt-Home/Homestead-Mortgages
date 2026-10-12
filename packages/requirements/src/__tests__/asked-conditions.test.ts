/**
 * Two conditions that read an answer nobody may be assumed to have given.
 *
 * `preferredLanguage` projected as "en" and `isMilitary` as false for a party
 * with no such fact until 12 October 2026, so `borrower_lep` could never be
 * true and no file ever had a military borrower it was not told of. Both are
 * three-valued now: a person nobody has asked leaves the condition
 * undetermined, which is the same rule every other condition keeps.
 */

import { describe, expect, it } from "vitest";
import type { Borrower, LoanFile } from "@hm/shared";
import { evaluateCondition } from "../conditions.js";

const file = (...borrowers: Partial<Borrower>[]): LoanFile =>
  ({ borrowers }) as unknown as LoanFile;

describe("borrower_lep", () => {
  it("cannot know until somebody is asked", () => {
    expect(evaluateCondition("borrower_lep", file())).toBeNull();
    expect(evaluateCondition("borrower_lep", file({ preferredLanguage: null }))).toBeNull();
  });

  it("reads English, and a person who would rather not say, as no handling owed", () => {
    expect(evaluateCondition("borrower_lep", file({ preferredLanguage: "en" }))).toBe(false);
    expect(evaluateCondition("borrower_lep", file({ preferredLanguage: "declined" }))).toBe(false);
  });

  it("is true of the file when it is true of anybody on it", () => {
    expect(evaluateCondition("borrower_lep", file({ preferredLanguage: "es" }))).toBe(true);
    expect(
      evaluateCondition(
        "borrower_lep",
        file({ preferredLanguage: "en" }, { preferredLanguage: "vi" }),
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        "borrower_lep",
        file({ preferredLanguage: null }, { preferredLanguage: "other" }),
      ),
    ).toBe(true);
  });

  it("stays undetermined while one person has not answered and nobody has said yes", () => {
    expect(
      evaluateCondition(
        "borrower_lep",
        file({ preferredLanguage: "en" }, { preferredLanguage: null }),
      ),
    ).toBeNull();
  });
});

describe("military_borrower", () => {
  it("cannot know until somebody is asked", () => {
    expect(evaluateCondition("military_borrower", file())).toBeNull();
    expect(evaluateCondition("military_borrower", file({ isMilitary: null }))).toBeNull();
    expect(
      evaluateCondition("military_borrower", file({ isMilitary: false }, { isMilitary: null })),
    ).toBeNull();
  });

  it("answers what the borrowers said", () => {
    expect(evaluateCondition("military_borrower", file({ isMilitary: false }))).toBe(false);
    expect(evaluateCondition("military_borrower", file({ isMilitary: true }))).toBe(true);
    expect(
      evaluateCondition("military_borrower", file({ isMilitary: null }, { isMilitary: true })),
    ).toBe(true);
  });
});
