/**
 * The one rule about what a borrower is actually being asked to do.
 *
 * Two callers read it — the card the web offers and the obligation the API
 * records — and the failure this guards is them disagreeing: a file parked at
 * "needs you" over a requirement no upload and no connection can satisfy,
 * with a branch card that clears nothing.
 */

import { describe, expect, it } from "vitest";
import {
  BORROWER_MUST_ACT,
  DOCUMENT_SATISFIABLE,
  PAYROLL_SATISFIABLE,
  branchCanSatisfy,
} from "../branches.js";

/** Every source a branch is ever offered for, plus the two deliberately not. */
const SOURCES = [...BORROWER_MUST_ACT, "connect_irs", "esign"];

describe("what a branch can clear", () => {
  it("keeps the two lists apart and non-empty", () => {
    expect(DOCUMENT_SATISFIABLE.length).toBeGreaterThan(0);
    expect(PAYROLL_SATISFIABLE.length).toBeGreaterThan(0);
    expect(DOCUMENT_SATISFIABLE.filter((id) => PAYROLL_SATISFIABLE.includes(id))).toEqual([]);
  });

  it("offers the documents branch for the letter of explanation", () => {
    // CRD-008 arrives as `borrower_input` on the upload_fallback screen; the
    // thing that satisfies it is a document, whichever of the two sources the
    // sheet gave it.
    expect(branchCanSatisfy({ requirementId: "CRD-008", source: "borrower_input" }, false)).toBe(
      true,
    );
    expect(branchCanSatisfy({ requirementId: "CRD-008", source: "document_upload" }, true)).toBe(
      true,
    );
  });

  it("offers the payroll branch only while no payroll is linked", () => {
    expect(branchCanSatisfy({ requirementId: "INC-002", source: "connect_payroll" }, false)).toBe(
      true,
    );
    expect(branchCanSatisfy({ requirementId: "INC-002", source: "connect_payroll" }, true)).toBe(
      false,
    );
  });

  it("never offers a branch for a finding the borrower cannot act on", () => {
    // These three are read out of the credit report and the income history.
    // A file held at "needs you" for one of them waits forever, because the
    // upload that would clear it does not exist.
    for (const id of ["CRD-009", "INC-005", "INC-006"]) {
      for (const source of SOURCES) {
        for (const payrollLinked of [false, true]) {
          expect(
            branchCanSatisfy({ requirementId: id, source }, payrollLinked),
            `${id} ${source}`,
          ).toBe(false);
        }
      }
    }
  });

  it("never offers a branch for bankruptcy seasoning, which the engine derives", () => {
    // CRD-006 is `document_upload` in the sheet and satisfied by a derivation
    // in the code. An upload screen for it would be a screen with no answer.
    expect(branchCanSatisfy({ requirementId: "CRD-006", source: "document_upload" }, false)).toBe(
      false,
    );
  });

  it("refuses the sources that are ours to do, whatever the requirement", () => {
    for (const id of [...DOCUMENT_SATISFIABLE, ...PAYROLL_SATISFIABLE]) {
      expect(branchCanSatisfy({ requirementId: id, source: "connect_irs" }, false)).toBe(false);
      expect(branchCanSatisfy({ requirementId: id, source: "esign" }, false)).toBe(false);
    }
  });

  it("refuses an unknown requirement rather than guessing", () => {
    expect(branchCanSatisfy({ requirementId: "XYZ-001", source: "document_upload" }, false)).toBe(
      false,
    );
  });
});
