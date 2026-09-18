/**
 * The vendor demo page: what it says about an answer, and what it says when
 * there is none.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api.js";
import { vendorDemoVisible } from "../../lib/auth.js";
import {
  LookupView,
  PropertyDemoPage,
  lookupFailureCopy,
  type LookupResponse,
} from "../PropertyDemoPage.js";

const ANSWER: LookupResponse = {
  record: {
    apn: "01-1423-0209",
    county: "TRAVIS",
    legalDescription: "LOT 14 BLK C TRAVIS HEIGHTS ANNEX",
    propertyType: "single_family",
    units: 1,
    attachment: "detached",
    yearBuilt: 1962,
    squareFeet: 1840,
    bedrooms: 3,
    bathrooms: 0,
    lotSizeSqFt: 7405,
    assessedValue: 389000,
    annualPropertyTax: 8216,
    hoaExists: false,
    ownerOfRecord: "WHITFIELD DANA M",
    lastSale: { soldOn: "2017-06-15", price: 268000 },
    priorOwnershipInLastThreeYears: null,
  },
  valuation: { value: 412000, low: 394000, high: 430000, confidence: 88, asOf: "2026-09-10" },
  flood: {
    zone: "X",
    communityId: "480624",
    inSpecialFloodHazardArea: false,
    nfipParticipating: true,
    insuranceRequired: false,
    determinedOn: "2026-09-17",
  },
  provider: "corelogic",
  providers: {
    record: "corelogic",
    valuation: "corelogic-thvOriginations",
    flood: "fixture-flood",
  },
};

describe("the answer", () => {
  const markup = renderToStaticMarkup(<LookupView result={ANSWER} ms={412.6} />);

  it("names who answered each part, and never claims the vendor for the fixture's half", () => {
    expect(markup).toContain("Answered in 413 ms");
    expect(markup).toContain("<code>corelogic</code>");
    expect(markup).toContain("<code>corelogic-thvOriginations</code>");
    expect(markup).toContain("<code>fixture-flood</code>");
  });

  it("lays the record out to be read, and leaves a figure the county did not report out", () => {
    expect(markup).toContain("Single-family, detached");
    expect(markup).toContain("TRAVIS County · APN 01-1423-0209");
    expect(markup).toContain("$389,000");
    expect(markup).toContain("$8,216/yr");
    expect(markup).toContain("1,840 sq ft");
    expect(markup).toContain("$268,000 on 2017-06-15");
    expect(markup).toContain("None on record");
    // Zero bathrooms is a count nobody reported, not a house without one.
    expect(markup).not.toContain("Bathrooms");
  });

  it("shows the valuation and the flood zone, and the bytes beneath them", () => {
    expect(markup).toContain("$412,000");
    expect(markup).toContain("$394,000 – $430,000");
    expect(markup).toContain("88 / 100");
    expect(markup).toContain("Zone X");
    expect(markup).toContain("The raw response");
    expect(markup).toContain("&quot;apn&quot;: &quot;01-1423-0209&quot;");
  });
});

describe("a lookup that did not answer", () => {
  it("says no record, in the server's words", () => {
    const copy = lookupFailureCopy(
      new ApiError(404, "No public record found for 1 Nowhere Ln.", "ADDRESS_NOT_FOUND"),
    );
    expect(copy.title).toBe("No record for that address");
    expect(copy.body).toBe("No public record found for 1 Nowhere Ln.");
  });

  it("says the session may not ask, and otherwise that the lookup did not come back", () => {
    expect(lookupFailureCopy(new ApiError(403, "read only", "PERSONA_READ_ONLY")).title).toBe(
      "This session may not ask",
    );
    expect(lookupFailureCopy(new Error("boom")).title).toBe("The lookup did not come back");
  });
});

describe("the page", () => {
  it("opens with the input and a button that waits for an address", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PropertyDemoPage />
      </MemoryRouter>,
    );
    expect(markup).toContain("The county record, live");
    expect(markup).toContain('id="demo-address"');
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Fetch the property record<\/button>/);
  });

  it("is reachable where the sample borrowers are, sample borrower or not, and nowhere else", () => {
    const on = { demoPersonasEnabled: true };
    expect(vendorDemoVisible(on, { persona: null })).toBe(true);
    expect(vendorDemoVisible(on, { persona: { key: "maya_okafor" } as never })).toBe(true);
    expect(vendorDemoVisible(on, null)).toBe(false);
    expect(vendorDemoVisible({ demoPersonasEnabled: false }, { persona: null })).toBe(false);
    expect(vendorDemoVisible(null, { persona: null })).toBe(false);
  });
});
