/**
 * Which screen a file is allowed to open on.
 *
 * The rule reads like a small one and its absence was not: `stage` is a
 * high-water mark that only moves forward, so a withdrawn file still points at
 * the screen the borrower was last on. The guard used to sit on the bare
 * /f/:id route alone, and nothing in the product links there — every list link
 * goes straight at /f/:id/<screen> — so a file that had ended opened the bank
 * or identity screen and asked the person who ended it to do more work on it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { landingScreen } from "../file.js";

const at = (status: string, terminal: boolean) => ({ status, terminal });

/** Every screen and branch a file link can point at, review excepted. */
const ELSEWHERE = ["property", "identity", "bank", "payroll", "irs", "documents"];

describe("where an ended file lands", () => {
  it("sends a withdrawn file opened at the bank screen to review", () => {
    expect(landingScreen(at("withdrawn", true), "bank")).toBe("review");
  });

  it("sends every terminal word, from every screen", () => {
    for (const status of ["withdrawn", "canceled", "denied", "funded"]) {
      for (const screen of ELSEWHERE) {
        expect(landingScreen(at(status, true), screen), `${status} at ${screen}`).toBe("review");
      }
    }
  });

  it("sends a held file too", () => {
    // `suspended` is not terminal — the file is stopped on somebody else's
    // answer — and there is still nothing on those screens for the borrower.
    expect(landingScreen(at("suspended", false), "identity")).toBe("review");
  });

  it("leaves the review screen where it is", () => {
    // Otherwise the redirect has nowhere to land and the router loops.
    expect(landingScreen(at("withdrawn", true), "review")).toBeNull();
  });

  it("leaves a live file alone", () => {
    for (const status of ["draft", "intake_received", "awaiting_borrower", "in_underwriting"]) {
      for (const screen of ELSEWHERE) {
        expect(landingScreen(at(status, false), screen), `${status} at ${screen}`).toBeNull();
      }
    }
  });

  it("leaves a file with no application alone", () => {
    // A file from before the join has no state to read, and inventing one for
    // it would strand it on the review screen forever.
    expect(landingScreen(null, "bank")).toBeNull();
    expect(landingScreen(undefined, "bank")).toBeNull();
  });
});

describe("where the shell applies it", () => {
  /**
   * Read out of the source, because FileShell needs a router, a query client
   * and a fetched file, and there is no DOM in this repo to give them. The
   * claim is about WHERE the check sits: on the shell every route under
   * /f/:fileId passes through, and against the last path segment rather than
   * the step the nav is highlighting — a branch path renders under the review
   * step and would otherwise look like it had already landed.
   */
  const src = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
  const shell = src.slice(src.indexOf("function FileShell()"));

  it("checks it in the shell, beside the repair redirect", () => {
    expect(shell).toContain("landingScreen(file.data?.applicationState, last)");
    expect(shell.indexOf("needsRepair(file.error)")).toBeLessThan(shell.indexOf("landingScreen("));
  });

  it("no longer leaves it on the index route alone", () => {
    // The bug, stated: this was the whole guard, on the one route nothing
    // links to.
    const resume = src.slice(
      src.indexOf("function ResumeToStage()"),
      src.indexOf("function ReviewShim()"),
    );
    expect(resume).not.toContain("terminal");
  });
});
