/**
 * What screen 1 knows, and what it is allowed to say it knows.
 *
 * Two failures, both of them the screen asserting something nobody
 * established. The lookup's 403 — which is every lookup for a sample borrower,
 * because the session is refused every write — was rendered as a finding about
 * the borrower's county, on the first thing anybody does in this product. And
 * this was the one screen with no read-only check at all, so a sample file
 * showed a live Continue that saved, failed, and explained itself afterwards.
 *
 * The rule is a function so a test can hold it; the rest is read out of the
 * source, because rendering this screen would need a router, a query client
 * and a server, and the defects live in a catch block and a `disabled`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CASH_OUT_NOT_YET } from "@hm/shared";
import { ApiError } from "../../lib/api.js";
import { lookupMissFor, prefillFrom } from "../PropertyLoanPage.js";

const src = readFileSync(new URL("../PropertyLoanPage.tsx", import.meta.url), "utf8");

describe("a lookup that came back with nothing", () => {
  it("calls a refusal a refusal", () => {
    // PERSONA_READ_ONLY, the answer every sample borrower gets. Nothing was
    // retrieved, so nothing about the property was learned.
    expect(
      lookupMissFor(new ApiError(403, "This is a sample borrower.", "PERSONA_READ_ONLY")),
    ).toBe("refused");
  });

  it("calls an empty answer an empty answer", () => {
    // The provider ran and holds no record for the address.
    expect(lookupMissFor(new ApiError(404, "No record", "ADDRESS_NOT_FOUND"))).toBe("no_record");
  });

  it("treats anything it cannot read as an empty answer, not a refusal", () => {
    // A network failure never reaches here as an ApiError. Claiming a refusal
    // for one would be the same invention in the other direction.
    expect(lookupMissFor(new TypeError("Failed to fetch"))).toBe("no_record");
    expect(lookupMissFor(undefined)).toBe("no_record");
  });

  it("says nothing about counties on a lookup that never ran", () => {
    // The sentence this screen used to print for a 403, verbatim. It is an
    // explanation of a search nobody performed.
    expect(src).not.toContain("new builds and some counties");
    expect(src).not.toContain("We could not find public records for this address");
  });

  it("keeps the stub's own words for the case the stub causes", () => {
    // The accurate explanation was already on this screen and was gated on
    // the autocomplete finding nothing — which is not the case it describes.
    // A chosen address that no record backs is.
    expect(src).toContain("This prototype can only retrieve records for three sample addresses");
    const panel = src.slice(src.indexOf("{lookupMiss && address && ("));
    expect(panel).toContain("This prototype can only retrieve records for three sample addresses");
  });
});

describe("a sample file on screen 1", () => {
  it("makes the same read-only check its sibling screens make", () => {
    expect(src).toContain("const readOnly = data?.file.isDemo === true;");
  });

  it("does not offer a Continue that will be refused", () => {
    const button = src.slice(src.indexOf('className="super-btn super-btn-primary"'));
    expect(button.slice(0, button.indexOf(">"))).toContain("readOnly");
  });

  it("refuses the submit itself, not only the button", () => {
    // A form with no enabled submit button still submits on Enter in some
    // browsers, and the PATCH behind it is the thing that 403s.
    const submit = src.slice(src.indexOf("async function submit("));
    expect(submit.slice(0, submit.indexOf("if (!address)"))).toContain("if (readOnly) return;");
  });
});

describe("a down payment that leaves no loan", () => {
  /**
   * The gate cannot answer this, so the screen must not ask it.
   *
   * A down payment covering the price leaves a loan of nothing, the pricing
   * port refuses to quote nothing, and `POST /property/affordability` answered
   * a raw 500 that this screen rendered verbatim — "Internal server error", on
   * the one screen whose job is to tell somebody their loan cannot work. The
   * server refuses it as a request now; this is the half that answers before
   * the round trip. Ordinary input on a refinance, where the field reads "How
   * much equity are you keeping?" and an owner with no mortgage left types the
   * whole value.
   */
  const submit = src.slice(src.indexOf("async function submit("));
  const beforeGate = submit.slice(0, submit.indexOf("/property/affordability"));

  it("is caught before the gate is called", () => {
    expect(beforeGate).toContain("if (priceNum > 0 && downNum >= priceNum)");
  });

  it("says which of the two questions the borrower was answering", () => {
    expect(beforeGate).toContain("there is no loan to check");
    expect(beforeGate).toContain("That leaves no loan to refinance");
  });
});

describe("the purposes screen 1 offers", () => {
  /**
   * V1 is a conventional purchase or a simple rate-and-term refinance.
   *
   * The screen used to offer "Refinancing and taking cash out", and a borrower
   * who chose it was carried the whole way through a flow nobody intends to
   * underwrite. Read out of the source for the reason the rest of this file
   * is: the options are JSX, and rendering this screen needs a router, a query
   * client and a server.
   */
  const select = src.slice(src.indexOf('id="purpose"'));
  const control = select.slice(0, select.indexOf("</Field>"));

  it("does not put a cash-out refinance in front of anybody", () => {
    // The option list is `V1_LOAN_PURPOSES` and not three literals, so
    // widening the scope is one entry in `@hm/shared` rather than a literal
    // somebody has to find here.
    expect(control).toContain("V1_LOAN_PURPOSES.map");
    expect(control).not.toContain('<option value="cash_out_refinance">');
  });

  it("names it only on a file that is already one, and as a choice nobody can make", () => {
    expect(control).toContain("{outOfScope && (");
    const named = control.slice(control.indexOf("{outOfScope && ("));
    expect(named).toContain("disabled");
    expect(named).toContain("CASH_OUT_NOT_YET");
  });

  it("tells that borrower what we do take, in the words the route answers with", () => {
    // One sentence, in `@hm/shared`, so the screen and the 422 cannot drift.
    expect(CASH_OUT_NOT_YET).toContain("We do not do cash-out refinances yet");
    expect(CASH_OUT_NOT_YET).toContain("purchase");
  });

  it("stops the save rather than letting the route be the only refusal", () => {
    const submit = src.slice(src.indexOf("async function submit("));
    const before = submit.slice(0, submit.indexOf("/property/affordability"));
    expect(before).toContain("if (outOfScope)");
    expect(before).toContain("setError(CASH_OUT_NOT_YET)");
  });
});

describe("coming back to screen 1 on a file that already exists", () => {
  /** A condo, opened as a cash-out refinance before V1's scope was settled. */
  const file = {
    property: {
      address: { line1: "12 Kestrel Ct", city: "Austin", state: "TX", postalCode: "78745" },
      propertyType: "condominium",
      // Screen 1 neither shows nor sets this. It is here because the file type
      // carries it, and screen 3 is what answers it.
      estateType: null,
      occupancy: "second_home",
      valueOrPrice: 415_000,
    },
    loan: {
      purpose: "cash_out_refinance",
      loanAmount: 300_000,
      downPayment: 83_000,
      cashToBorrower: 40_000,
    },
  };

  it("has nothing to put back before the file has been read", () => {
    expect(prefillFrom(undefined)).toBeNull();
    expect(prefillFrom({ property: null, loan: null })).toBeNull();
  });

  it("brings back the property type the county told us", () => {
    // The only control that can set this renders under `lookupMiss && address`,
    // and a prefill sets neither — so a type this did not restore was a type
    // the next Continue silently rewrote to `single_family`, moving the LTV
    // ceiling and the reserve tier with it.
    expect(prefillFrom(file)?.propertyType).toBe("condominium");
  });

  it("restores nothing for a control the screen no longer has", () => {
    // The cash-out box is gone with the option that reached it, so there is
    // no field for a figure to be put back into. A prefill that still carried
    // one would be restoring state onto a screen that cannot show it.
    expect(prefillFrom(file)).not.toHaveProperty("cashOut");
    expect(src).not.toContain("cashToBorrower");
  });

  it("still brings back everything it used to", () => {
    // The purpose included, unchanged. A file that says cash-out is what that
    // borrower asked us for, and the screen does not quietly rewrite it into
    // a loan they did not request.
    const filled = prefillFrom(file)!;
    expect(filled.address.line1).toBe("12 Kestrel Ct");
    expect(filled.query).toBe("12 Kestrel Ct, Austin");
    expect(filled.purpose).toBe("cash_out_refinance");
    expect(filled.occupancy).toBe("second_home");
    expect(filled.price).toBe("415000");
    expect(filled.down).toBe("83000");
  });

  it("is applied field for field, so restoring one and not setting it is not a fix", () => {
    // The defect was never in what the screen knew — it was in what the effect
    // did with it. Read out of the source, because there is no DOM here and
    // the claim is that every field this answers reaches a setter.
    const effect = src.slice(src.indexOf("const filled = prefillFrom("));
    const body = effect.slice(0, effect.indexOf("}, [data?.file]);"));
    for (const key of Object.keys(prefillFrom(file)!)) {
      expect(body, key).toContain(`filled.${key}`);
    }
  });
});
