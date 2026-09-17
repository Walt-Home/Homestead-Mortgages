/**
 * What screen 2 asks a borrower who has already answered it.
 *
 * Nothing on this screen read the file. That held while the only way back onto
 * it was the repair path — which exists because the person will not project,
 * so there is nothing to read — and stopped holding the moment the stepper's
 * dots became links: a borrower going back to fix a phone number met an empty
 * form that would not submit without scanning a document again and retyping a
 * Social Security number.
 *
 * The server never wanted either. `identitySchema` marks the vault handle
 * optional and says so in as many words, and the borrowers route only refuses
 * a first save with no SSN. The screen was the whole of the demand.
 *
 * The rules are functions so a test can hold them; the wiring is read out of
 * the source, because rendering this screen would need a router, a query
 * client and a server.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { revisitFrom, ssnRequired } from "../IdentityPage.js";

const src = readFileSync(new URL("../IdentityPage.tsx", import.meta.url), "utf8");

const file = {
  borrowers: [
    {
      firstName: "Omar",
      lastName: "Haddad",
      dateOfBirth: "1984-03-12",
      phone: "512-555-0134",
      citizenship: "permanent_resident",
      maritalStatus: "married",
      ssn: { last4: "4417" },
      currentAddress: { line1: "12 Kestrel Ct", city: "Austin", state: "TX", postalCode: "78745" },
    },
  ],
} as unknown as Parameters<typeof revisitFrom>[0];

const noBorrower = { borrowers: [] } as unknown as Parameters<typeof revisitFrom>[0];

describe("a borrower coming back to screen 2", () => {
  it("knows nothing before the file has been read", () => {
    expect(revisitFrom(undefined)).toBeNull();
    expect(revisitFrom(noBorrower)).toBeNull();
  });

  it("comes back to the name, date of birth and address already on file", () => {
    // The three the document read the first time. Without them the submit
    // returns at `if (!identity)` and the screen cannot be sent at all.
    const known = revisitFrom(file)!;
    expect(known.identity.firstName).toBe("Omar");
    expect(known.identity.lastName).toBe("Haddad");
    expect(known.identity.dateOfBirth).toBe("1984-03-12");
    expect(known.identity.address.city).toBe("Austin");
  });

  it("comes back to the three answers they typed", () => {
    const known = revisitFrom(file)!;
    expect(known.phone).toBe("512-555-0134");
    expect(known.citizenship).toBe("permanent_resident");
    expect(known.maritalStatus).toBe("married");
  });

  it("assumes nothing about citizenship the file did not record", () => {
    const missing = {
      borrowers: [
        { ...(file as { borrowers: Record<string, unknown>[] }).borrowers[0], citizenship: null },
      ],
    } as unknown as Parameters<typeof revisitFrom>[0];
    expect(revisitFrom(missing)!.citizenship).toBe("us_citizen");
  });
});

describe("the social security number", () => {
  it("is asked for the first time", () => {
    // The server refuses a first save without one, so the screen must ask.
    expect(ssnRequired(undefined)).toBe(true);
    expect(ssnRequired(noBorrower)).toBe(true);
  });

  it("is not asked for again once it is on record", () => {
    expect(ssnRequired(file)).toBe(false);
  });

  it("is what the input actually consults", () => {
    // A predicate nothing reads is a rule that holds only in a test, and this
    // one is a bare `required` attribute away from being back.
    const input = src.slice(src.indexOf('id="ssn"'));
    expect(input.slice(0, input.indexOf("/>"))).toContain(
      "required={ssnRequired(data?.file, data?.you ?? null)}",
    );
  });

  it("is never minted from a field the borrower left alone", () => {
    // No digits, no vault handle: an empty box on a revisit must not supersede
    // the handle the file already holds with one built from nothing.
    expect(src).toContain("digits.length >= 4");
  });
});

describe("where the screen gets what it knows", () => {
  it("seeds itself from the file, for the person signed in", () => {
    // `you` is the server's answer to which borrower is reading the screen.
    // Seeded from the first row instead, a co-borrower's revisit would show
    // them the applicant's details and save their corrections onto her.
    const effect = src.slice(src.indexOf("const seeded = useRef(false);"));
    const body = effect.slice(0, effect.indexOf("}, [data?.file]);"));
    expect(body).toContain("revisitFrom(data?.file, data?.you ?? null)");
    // And nothing at all for a co-borrower who has claimed their invitation
    // and not yet said who they are: the file holds the applicant's details,
    // and there is nobody else's to seed from.
    expect(body).toContain("if (meInvited) return;");
    expect(body).toContain("setIdentity(known.identity)");
    expect(body).toContain("setPhone(");
    expect(body).toContain("setCitizenship(known.citizenship)");
    expect(body).toContain("setMaritalStatus(known.maritalStatus)");
  });

  it("seeds once, so Scan again is not undone the instant it is pressed", () => {
    const effect = src.slice(src.indexOf("const seeded = useRef(false);"));
    const body = effect.slice(0, effect.indexOf("}, [data?.file]);"));
    expect(body).toContain("if (seeded.current || draft) return;");
    expect(body).toContain("seeded.current = true;");
  });

  it("stays out of the way of a borrower coming back from the identity vendor", () => {
    // A draft is written immediately before the redirect and read on the way
    // back, and the effect below it writes what the vendor actually returned.
    // The file's older facts must not get in front of that.
    const seed = src.indexOf("const seeded = useRef(false);");
    const vendor = src.indexOf("identity-document/complete");
    expect(seed).toBeGreaterThan(-1);
    expect(vendor).toBeGreaterThan(seed);
  });
});
