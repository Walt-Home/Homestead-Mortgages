/**
 * An output budget is the environment's (decided 26 October 2026): an
 * environment that needs more than the policies' default per turn says so,
 * the run's `--max-tokens` overrides it, and neither touches what the task
 * is or how it is graded, so no fingerprint carries it.
 */

import { describe, expect, it } from "vitest";
import { BOARDING_FINGERPRINT, boardingTriage } from "../boarding/index.js";
import { CONTACT_AUDIT_FINGERPRINT, contactAudit } from "../contact-audit/index.js";
import { DEFAULT_OUTPUT_BUDGET, outputBudgetFor, parseMaxTokens } from "../episode.js";
import { refiReview } from "../refi/index.js";
import { INTAKE_FINGERPRINT, tapeIntake } from "../tape-intake/index.js";

describe("the output budget", () => {
  it("is 32,000 on boarding-triage, tape-intake and contact-audit, and unset where the default serves", () => {
    expect(DEFAULT_OUTPUT_BUDGET).toBe(16000);
    expect(boardingTriage.outputBudget).toBe(32000);
    expect(tapeIntake.outputBudget).toBe(32000);
    expect(contactAudit.outputBudget).toBe(32000);
    expect(refiReview.outputBudget).toBeUndefined();
  });

  it("is in no fingerprint: the task and its grading are the same at any budget", () => {
    for (const f of [BOARDING_FINGERPRINT, INTAKE_FINGERPRINT, CONTACT_AUDIT_FINGERPRINT])
      expect(JSON.stringify(f)).not.toMatch(/budget|max.?tokens/i);
  });

  it("is the run's if it asked, else the environment's, else the policy's own", () => {
    expect(outputBudgetFor(16000, boardingTriage)).toBe(16000);
    expect(outputBudgetFor(64000, tapeIntake)).toBe(64000);
    expect(outputBudgetFor(undefined, boardingTriage)).toBe(32000);
    expect(outputBudgetFor(undefined, tapeIntake)).toBe(32000);
    expect(outputBudgetFor(undefined, contactAudit)).toBe(32000);
    expect(outputBudgetFor(16000, contactAudit)).toBe(16000);
    expect(outputBudgetFor(24000, refiReview)).toBe(24000);
    expect(outputBudgetFor(undefined, refiReview)).toBeUndefined();
    expect(outputBudgetFor(undefined, {})).toBeUndefined();
  });

  it("reads --max-tokens as a positive whole number, and refuses anything else", () => {
    expect(parseMaxTokens(undefined)).toBeUndefined();
    expect(parseMaxTokens("32000")).toBe(32000);
    for (const bad of ["", " ", "0", "-1", "1.5", "32k", "abc"])
      expect(() => parseMaxTokens(bad)).toThrow(/--max-tokens must be a positive whole number/);
  });
});
