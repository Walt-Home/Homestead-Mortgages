/**
 * The originator placeholders, and what refuses them.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  assertDealPartiesEmittable,
  assertOriginatorEmittable,
  COMPANY_NMLS_FORMAT,
  originatorPlaceholdersIn,
  PLACEHOLDER_ORIGINATOR,
  widthOf,
} from "../originator.js";

const REAL = {
  companyLegalName: "Supermortgage Inc.",
  companyNmlsId: "1234567",
  originatorFirstName: "Dana",
  originatorLastName: "Whitfield",
  originatorNmlsId: "7654321",
};

const env = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = env;
});

describe("the placeholders", () => {
  it("say what they are, and fit their destinations", () => {
    expect(originatorPlaceholdersIn(PLACEHOLDER_ORIGINATOR)).toHaveLength(5);
    expect(originatorPlaceholdersIn(REAL)).toEqual([]);
    // No NMLSR id has letters in it.
    expect(PLACEHOLDER_ORIGINATOR.companyNmlsId).toMatch(/[A-Z]/);
    expect(PLACEHOLDER_ORIGINATOR.companyNmlsId.length).toBeLessThanOrEqual(
      widthOf(COMPANY_NMLS_FORMAT),
    );
    expect(() => assertOriginatorEmittable(PLACEHOLDER_ORIGINATOR)).not.toThrow();
  });

  it("are refused in production, by field and never by value", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertOriginatorEmittable(PLACEHOLDER_ORIGINATOR)).toThrow(/companyNmlsId/);
    expect(() => assertOriginatorEmittable(PLACEHOLDER_ORIGINATOR)).not.toThrow(/PLCHLD/);
    expect(() => assertOriginatorEmittable(REAL)).not.toThrow();
    // A real value beside a placeholder is still a placeholder.
    expect(() =>
      assertOriginatorEmittable({
        ...REAL,
        originatorNmlsId: PLACEHOLDER_ORIGINATOR.originatorNmlsId,
      }),
    ).toThrow(/originatorNmlsId/);
  });

  it("refuse an empty or over-wide value everywhere", () => {
    expect(() => assertOriginatorEmittable({ ...REAL, companyLegalName: " " })).toThrow(/empty/);
    expect(() =>
      assertOriginatorEmittable({
        ...REAL,
        companyNmlsId: "9".repeat(widthOf(COMPANY_NMLS_FORMAT) + 1),
      }),
    ).toThrow(/characters/);
  });
});

describe("the rows the assembler reads", () => {
  it("are refused in production while they carry the placeholder id", () => {
    const rows = [
      { role: "LoanOriginationCompany", licenseIdentifier: PLACEHOLDER_ORIGINATOR.companyNmlsId },
      { role: "LoanOriginator", licenseIdentifier: "7654321" },
    ];
    expect(() => assertDealPartiesEmittable(rows)).not.toThrow();
    process.env.NODE_ENV = "production";
    expect(() => assertDealPartiesEmittable(rows)).toThrow(/LoanOriginationCompany/);
    expect(() =>
      assertDealPartiesEmittable([{ role: "LoanOriginator", licenseIdentifier: "7654321" }]),
    ).not.toThrow();
  });
});
