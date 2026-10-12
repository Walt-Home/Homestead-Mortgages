/**
 * No screen starts on an answer.
 *
 * Screen 1 started on purchase, primary residence and single family; screen 2
 * on a U.S. citizen, unmarried, with the E-SIGN box ticked, speaking English,
 * never in the military, a first-time buyer when the county had no record;
 * and both review screens re-sent "en" and `?? true` at signing. Each was a
 * statement nobody made, recorded under the borrower's own principal and
 * attested by their signature. `docs/states.md`: occupancy may not be
 * defaulted; `docs/decisions.md`: null means nobody asked, and it is not
 * "rent". These read the sources so the defaults cannot come back quietly.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("screen 1", () => {
  const page = src("pages/PropertyLoanPage.tsx");

  it("starts purpose, occupancy and property type unanswered", () => {
    expect(page).not.toMatch(/useState\("purchase"\)/);
    expect(page).not.toMatch(/useState\("primary_residence"\)/);
    expect(page).not.toMatch(/useState\("single_family"\)/);
    expect(page).not.toMatch(/\?\?\s*"purchase"/);
  });

  it("offers a blank to choose from on all three", () => {
    expect(page.match(/Choose one/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("screen 2", () => {
  const page = src("pages/IdentityPage.tsx");

  it("starts citizenship, marital status and the consent unanswered", () => {
    expect(page).not.toMatch(/\?\?\s*"us_citizen"/);
    expect(page).not.toMatch(/\?\?\s*"unmarried"/);
    expect(page).not.toMatch(/econsent[\s\S]{0,120}\?\?\s*true/);
  });

  it("asks language and military service rather than sending English and no", () => {
    expect(page).not.toMatch(/preferredLanguage:\s*"en"/);
    expect(page).toMatch(/isMilitary:\s*military === "yes"/);
    expect(page.match(/Choose one/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("states nothing about first-time buying, which screen 3 asks", () => {
    expect(page).toMatch(/firstTimeHomebuyer:\s*null/);
    expect(page).not.toContain("priorOwnershipInLastThreeYears");
  });

  it("does not tick the co-borrower in as an occupant", () => {
    expect(page).not.toMatch(/coLivesHere[\s\S]{0,40}useState\(true\)/);
    expect(page).toMatch(/occupiesProperty:\s*coLivesHere === "yes"/);
  });
});

describe("the two review saves", () => {
  for (const path of ["pages/ReviewPage.tsx", "pages/CoBorrowerReviewPage.tsx"]) {
    it(`${path} re-sends the row and invents nothing`, () => {
      const page = src(path);
      expect(page).not.toMatch(/preferredLanguage:\s*"en"/);
      expect(page).not.toMatch(/firstTimeHomebuyer:[^\n]*\?\?\s*true/);
      expect(page).toMatch(/firstTimeHomebuyer:[^\n]*\?\?\s*null/);
    });
  }
});
