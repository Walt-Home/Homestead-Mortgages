/**
 * The placeholder institution, and the one thing that must be true of it.
 *
 * A placeholder that can reach Fannie Mae is not a placeholder, it is a wrong
 * answer with a comment beside it. So the refusal is what this file is about:
 * it fires on the values that stand in the tree today, it names which of the
 * two is still standing, and it stops firing the moment both are real.
 *
 * The widths are asserted against the generated table rather than against the
 * numbers in the header, because the header is prose and the table is what the
 * specification says.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DU_FORMATS } from "../generated/lengths.js";
import {
  assertInstitutionEmittable,
  placeholdersIn,
  LENDER_LOAN_IDENTIFIER_FORMAT,
  PLACEHOLDER_INSTITUTION,
  SUBMITTING_PARTY_IDENTIFIER_FORMAT,
  type DuInstitution,
} from "../institution.js";

/** What Grander's own numbers would look like once somebody holds them. */
const REAL: DuInstitution = {
  lenderLoanIdentifier: "HM2026000000123",
  submittingPartyIdentifier: "123456",
};

const WAS = process.env.NODE_ENV;

afterEach(() => {
  if (WAS === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = WAS;
});

/** Run a function as the deployed service sees the world. */
function inProduction(run: () => void): void {
  process.env.NODE_ENV = "production";
  run();
}

describe("the institution a casefile is submitted under", () => {
  it("takes its widths from the specification and not from this file", () => {
    expect(DU_FORMATS[LENDER_LOAN_IDENTIFIER_FORMAT]).toEqual({ kind: "string", maxLength: 15 });
    expect(DU_FORMATS[SUBMITTING_PARTY_IDENTIFIER_FORMAT]).toEqual({
      kind: "string",
      maxLength: 6,
    });
    expect(PLACEHOLDER_INSTITUTION.lenderLoanIdentifier).toHaveLength(15);
    expect(PLACEHOLDER_INSTITUTION.submittingPartyIdentifier).toHaveLength(6);
  });

  it("says which of the two is still a placeholder", () => {
    expect(placeholdersIn(PLACEHOLDER_INSTITUTION)).toEqual([
      "lenderLoanIdentifier",
      "submittingPartyIdentifier",
    ]);
    expect(
      placeholdersIn({ ...PLACEHOLDER_INSTITUTION, submittingPartyIdentifier: "123456" }),
    ).toEqual(["lenderLoanIdentifier"]);
    expect(placeholdersIn(REAL)).toEqual([]);
  });

  it("assembles against a placeholder in development and refuses to in production", () => {
    // The whole of the guarantee. Development is where a placeholder is the
    // honest value; a deployed service has no business writing one onto a
    // federal submission, and there is no flag that turns this off.
    expect(() => assertInstitutionEmittable(PLACEHOLDER_INSTITUTION)).not.toThrow();
    inProduction(() => {
      expect(() => assertInstitutionEmittable(PLACEHOLDER_INSTITUTION)).toThrow(
        /placeholder institution: lenderLoanIdentifier and submittingPartyIdentifier/,
      );
    });
  });

  it("refuses a half-replaced institution, naming the half that is left", () => {
    // The failure a single boolean would miss: somebody sets the real
    // seller/servicer number, nothing mints a loan number yet, and the
    // casefile goes out stating one institution and a placeholder loan.
    inProduction(() => {
      expect(() =>
        assertInstitutionEmittable({ ...REAL, lenderLoanIdentifier: "PLACEHOLDER-DEV" }),
      ).toThrow(/placeholder institution: lenderLoanIdentifier\./);
    });
  });

  it("lets a real institution through in production", () => {
    inProduction(() => {
      expect(() => assertInstitutionEmittable(REAL)).not.toThrow();
    });
  });

  it("refuses a value too wide for its destination, or empty", () => {
    expect(() =>
      assertInstitutionEmittable({ ...REAL, lenderLoanIdentifier: "0123456789012345" }),
    ).toThrow(/16 characters at a destination that takes 15/);
    expect(() =>
      assertInstitutionEmittable({ ...REAL, submittingPartyIdentifier: "1234567" }),
    ).toThrow(/7 characters at a destination that takes 6/);
    expect(() => assertInstitutionEmittable({ ...REAL, lenderLoanIdentifier: "" })).toThrow(
      /is empty/,
    );
  });

  it("refuses the six characters Fannie Mae's note forbids in a loan number", () => {
    for (const bad of ["A<1", "A>1", "A&1", "A'1", 'A"1', "A%1"]) {
      expect(() => assertInstitutionEmittable({ ...REAL, lenderLoanIdentifier: bad })).toThrow(
        /forbids/,
      );
    }
  });
});
