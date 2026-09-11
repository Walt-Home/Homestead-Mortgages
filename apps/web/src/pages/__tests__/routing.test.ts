/**
 * Where the controls that leave a screen actually go.
 *
 * Two rules, both about navigation rather than about rendering, and both of a
 * kind a component test would not catch: one is a destination, the other is
 * what the history stack holds afterwards. They read the source for the reason
 * the design-system test does — the failure is a call that compiles and does
 * the wrong thing, not one that throws.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("every ending sends a borrower to their own applications", () => {
  /**
   * The old label was "Done", and the old destination was the pitch.
   *
   * A person who has just read "We can't approve this" has no reason to see
   * "The Greatest Mortgage Ever Offered", and no reason to be told they are
   * done with something they did not choose to end. Both halves changed, and
   * the destination is the index route, which is now their own page.
   */
  it("does not offer 'Done' at the end of the flow", () => {
    expect(src("pages/ReviewPage.tsx")).not.toMatch(/>\s*Done\s*</);
  });

  it("names the applications, on all three controls that leave for the index", () => {
    for (const file of ["pages/ReviewPage.tsx", "App.tsx", "pages/PlaidReturnPage.tsx"]) {
      expect(src(file), file).toContain("Back to your applications");
      expect(src(file), file).not.toContain("Back to your files");
    }
  });
});

describe("the back button cannot reach a form that makes a file", () => {
  /**
   * Screen 1 is the only screen whose submit CREATES something.
   *
   * Everywhere else, pressing Back and submitting again writes over the same
   * file. Here it opens a second application for the same house, and the
   * borrower never chose to start one — they pressed Back. So the navigation
   * off a creating submit replaces its history entry rather than pushing.
   *
   * `!editing` is the whole of the condition: the same screen reached with a
   * fileId is an edit, its submit creates nothing, and taking that entry off
   * the stack would break the ordinary Back out of a correction.
   */
  it("replaces the history entry when screen 1 created the file", () => {
    const submit = src("pages/PropertyLoanPage.tsx");
    expect(submit).toMatch(/navigate\(`\/f\/\$\{id\}\/identity`,[\s\S]*?replace: !editing/);
  });

  it("still pushes when the same screen is only editing one", () => {
    // Asserted as the negative of the rule above rather than trusted: a bare
    // `replace: true` would pass the test above and silently take the edit's
    // Back with it.
    expect(src("pages/PropertyLoanPage.tsx")).not.toMatch(/replace:\s*true/);
  });
});
