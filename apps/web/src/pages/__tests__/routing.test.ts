/**
 * Where the controls that leave a screen actually go.
 *
 * Three rules, all about navigation rather than about rendering, and all of a
 * kind a component test would not catch: a destination, what the history stack
 * holds afterwards, and whether the steps are walked in order at all. They
 * read the source for the reason the design-system test does — the failure is
 * a call that compiles and does the wrong thing, not one that throws.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCREENS, type ScreenPath } from "../../lib/flow.js";

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

/**
 * The forward walk, screen by screen.
 *
 * `flow.test.ts` asserts that every stage resolves to a screen and that every
 * screen has an index — neither of which says a borrower can ever GET to one.
 * The declarations screen shipped with `SCREENS`, a `FlowStage`, a route, six
 * requirements and a stepper dot, and screen 2 still navigated straight to the
 * bank: the whole gate was unreachable, every one of those assertions passed,
 * and the borrower signed screen 5 with nothing to attest to.
 *
 * So the rule is the one thing none of them held — each step names the NEXT
 * step in `SCREENS`, and the list of steps is read off `SCREENS` rather than
 * written out, so a sixth screen fails here until something walks into it.
 */
describe("each step navigates to the one after it", () => {
  /** The screen a borrower leaves, and the file whose submit leaves it. */
  const SUBMITS: Record<ScreenPath, string> = {
    property: "pages/PropertyLoanPage.tsx",
    identity: "pages/IdentityPage.tsx",
    declarations: "pages/DeclarationsPage.tsx",
    bank: "pages/BankPage.tsx",
    // The last step submits to a decision rather than to a screen.
    review: "",
  };

  const paths: readonly ScreenPath[] = SCREENS.map((s) => s.path);
  /** Every screen a borrower leaves for another, paired with the one after it. */
  const steps = paths.flatMap((path, i) => {
    const next = paths[i + 1];
    return next ? [[path, next, paths.slice(i + 2)] as const] : [];
  });

  /** `navigate(`/f/${anything}/<path>`)`, whatever the id is called there. */
  const goesTo = (path: string) => new RegExp("navigate\\(`/f/\\$\\{\\w+\\}/" + path + "`");

  it("has a submit named for every screen but the last", () => {
    // Written as an assertion rather than as a lookup that returns undefined,
    // because a missing entry is the shape this test failed to have before.
    expect(steps).toHaveLength(SCREENS.length - 1);
    for (const [from] of steps) expect(SUBMITS[from], from).not.toBe("");
  });

  it.each(steps.map(([from, next]) => [from, next] as const))("leaves %s for %s", (from, next) => {
    expect(src(SUBMITS[from]), `${from} → ${next}`).toMatch(goesTo(next));
  });

  it.each(steps.map(([from, , beyond]) => [from, beyond] as const))(
    "does not let %s skip ahead",
    (from, beyond) => {
      // The half that catches the real defect: screen 2 pointing at the bank
      // screen matched nothing above, but it also has to be refused here, or
      // a file that keeps both calls would pass.
      for (const path of beyond) {
        expect(src(SUBMITS[from]), `${from} → ${path}`).not.toMatch(goesTo(path));
      }
    },
  );

  it("sends the resumed identity submit the same way", () => {
    // The ID vendor redirects mid-submit, so this page finishes screen 2's
    // work — the pulls and the navigation. Left pointing at the bank screen
    // it is a second way past the declarations, and the one taken by every
    // borrower who scanned a document.
    const resumed = src("pages/IdentityReturnPage.tsx");
    expect(resumed).toMatch(goesTo("declarations"));
    expect(resumed).not.toMatch(goesTo("bank"));
  });
});
