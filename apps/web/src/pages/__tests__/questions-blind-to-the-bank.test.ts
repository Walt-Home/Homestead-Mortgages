/**
 * The questions screen reads nothing of the bank.
 *
 * Since 12 October 2026 the bank connects before Section 5 and the residence
 * are asked, so the report is on file when this screen renders. A
 * declaration is asked bare and never rendered beside the data that bears on
 * it (docs/autofill.md, rule d; `buildDeclarations` was deleted for exactly
 * this). Before the swap that was a habit; now it is the only thing between
 * the report and the form, so it is written down as an enumeration of what
 * the page may read, and a list of what it may not.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("../DeclarationsPage.tsx", import.meta.url), "utf8");

describe("the questions screen", () => {
  it("reads the person's own answers and the file's estate type, and nothing else of the file", () => {
    expect(page).toContain("me?.declaration");
    expect(page).toContain("me?.residences");
    expect(page).toContain("file.property?.estateType");
  });

  it("touches no report, no income, no job and no snapshot", () => {
    for (const forbidden of [
      "file.assets",
      "file.credit",
      "incomeSources",
      "employments",
      "identifiedMonthlyRent",
      "identifiedRentPayments",
      "largeDeposits",
      "snapshot",
      "Found",
    ]) {
      expect(page, forbidden).not.toContain(forbidden);
    }
  });

  it("leaves for the review and for nowhere past it", () => {
    expect(page).toMatch(/navigate\(`\/f\/\$\{\w+\}\/review`/);
    expect(page).not.toMatch(/navigate\(`\/f\/\$\{\w+\}\/bank`/);
  });
});
