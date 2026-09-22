/**
 * The mortgage's words, held to the copy rules whether or not a state that
 * would render them is reachable today — the same standing `home-copy.test.ts`
 * gives the home page's.
 */

import { describe, expect, it } from "vitest";
import {
  BRITISH,
  DAY_FIRST,
  DELIVERY_TIME,
  PROMISES,
  RATE_COMMITMENT,
  REQ_ID,
  VENDOR_CLAIM,
} from "@hm/shared";
import { LOAN_STATES } from "@hm/shared";
import * as copy from "../loan-copy.js";
import { calendarDate, dollars, ratePct } from "../loan.js";
import { entryFor } from "../states.js";

/** Every sentence the module can produce, including the ones its functions build. */
function everything(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const [name, value] of Object.entries(copy)) {
    if (typeof value === "string") out.push({ name, text: value });
  }
  for (const v of Object.values(copy.VERDICT)) {
    out.push({ name: "VERDICT.lead", text: v.lead }, { name: "VERDICT.body", text: v.body });
  }
  for (const state of LOAN_STATES) {
    for (const servicer of ["Northlight Mortgage Servicing (sample partner)", null]) {
      out.push({ name: `mortgageLead(${state})`, text: copy.mortgageLead(state, servicer) });
      out.push({ name: `mortgageBody(${state})`, text: copy.mortgageBody(state, servicer) });
    }
  }
  out.push(
    { name: "fromYourServicer", text: copy.fromYourServicer("Grander", "September 1, 2026") },
    { name: "notWired", text: copy.notWired("Grander") },
    { name: "checkedOn", text: copy.checkedOn("September 21, 2026") },
    { name: "readLiveAt", text: copy.readLiveAt("September 21, 2026") },
    { name: "openUntil", text: copy.openUntil("October 21, 2026") },
    { name: "standingWords", text: copy.standingWords("DELINQUENT", 30) },
    { name: "standingWords", text: copy.standingWords("DELINQUENT", null) },
    { name: "MORTGAGE_CLAIM.title", text: copy.MORTGAGE_CLAIM.title },
    { name: "MORTGAGE_CLAIM.body", text: copy.MORTGAGE_CLAIM.body("Grander", "Phoenix", "AZ") },
    { name: "MORTGAGE_CLAIM.body", text: copy.MORTGAGE_CLAIM.body(null, null, null) },
    { name: "MORTGAGE_CLAIM.yours", text: copy.MORTGAGE_CLAIM.yours },
    { name: "MORTGAGE_CLAIM.thisIsMine", text: copy.MORTGAGE_CLAIM.thisIsMine },
  );
  return out;
}

describe("what the mortgage page says", () => {
  it("promises no channel, no deadline and no rate, and names no vendor", () => {
    for (const { name, text } of everything()) {
      expect(text, `${name}: ${text}`).not.toMatch(PROMISES);
      expect(text, `${name}: ${text}`).not.toMatch(DELIVERY_TIME);
      expect(text, `${name}: ${text}`).not.toMatch(RATE_COMMITMENT);
      expect(text, `${name}: ${text}`).not.toMatch(VENDOR_CLAIM);
      expect(text, `${name}: ${text}`).not.toMatch(REQ_ID);
      expect(text, `${name}: ${text}`).not.toMatch(BRITISH);
      expect(text, `${name}: ${text}`).not.toMatch(DAY_FIRST);
    }
  });

  it("has a heading for every loan state the machine has, from the catalog", () => {
    for (const state of LOAN_STATES) {
      const entry = entryFor(`loan_${state}`);
      expect(entry, state).toBeDefined();
      const lead = copy.mortgageLead(state, "Grander");
      expect(lead.length).toBeGreaterThan(5);
      if (state !== "imported_unclaimed") expect(lead).toBe(entry!.heading);
    }
    expect(copy.mortgageLead("imported_unclaimed", "Grander")).toBe(
      "Grander shared this mortgage with us",
    );
  });

  it("says a verdict in one of exactly four ways", () => {
    expect(Object.keys(copy.VERDICT).sort()).toEqual([
      "candidate",
      "excluded",
      "not_now",
      "watching",
    ]);
  });
});

describe("how a mortgage's figures are said", () => {
  it("says cents as whole dollars through the one formatter", () => {
    expect(dollars("44136613")).toBe("$441,366");
    expect(dollars("27485")).toBe("$275");
    expect(dollars(null)).toBeNull();
    expect(dollars("not a number")).toBeNull();
  });

  it("says a rate the way the note quotes it", () => {
    expect(ratePct("7.250")).toBe("7.25%");
    expect(ratePct("6.375")).toBe("6.375%");
    expect(ratePct("6.000")).toBe("6%");
    expect(ratePct(null)).toBeNull();
  });

  it("says a day month-first and never shifts it by a time zone", () => {
    expect(calendarDate("2026-10-01")).toBe("October 1, 2026");
    expect(calendarDate("2026-09-21T15:28:17.432Z")).toBe("September 21, 2026");
    expect(calendarDate("")).toBeNull();
    expect(calendarDate(null)).toBeNull();
  });
});
