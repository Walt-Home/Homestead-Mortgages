/**
 * What screen 2 says when the person will not read back.
 *
 * The server's projection error names a borrower id and a fact predicate.
 * Both are ours; neither belongs in front of a borrower. These pin that every
 * predicate the projection can refuse has a sentence in the screen's own
 * words, and that the sentence carries nothing from the server's message.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calendarDate } from "../../lib/ledger.js";
import { repairMessage } from "../IdentityPage.js";

/** Every predicate `requireIdentity` can throw for, by name. */
const REQUIRED_PREDICATES = [
  "legal_name",
  "current_address",
  "marital_status",
  "citizenship",
  "date_of_birth",
  "ssn_token",
  "email",
  "phone",
];

describe("the repair message", () => {
  it("names a field for every required fact", () => {
    for (const predicate of REQUIRED_PREDICATES) {
      const message = repairMessage(predicate);
      expect(message, predicate).not.toBe(repairMessage(undefined));
      expect(message, predicate).toMatch(/^Something about .+ did not go through\./);
    }
  });

  it("never leaks the server's vocabulary", () => {
    for (const predicate of [...REQUIRED_PREDICATES, undefined, "something_new"]) {
      const message = repairMessage(predicate);
      expect(message).not.toMatch(/fact|predicate|borrower|projection|_/i);
      expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    }
  });

  it("falls back to the whole form for a predicate it has no words for", () => {
    expect(repairMessage("something_new")).toBe(repairMessage(undefined));
  });
});

/**
 * The one date this screen shows back to the person it belongs to.
 *
 * Read out of the source, because the value comes from a vendor round-trip
 * this repo cannot make in a test. The claim is that the screen renders the
 * document's date through the formatter rather than the vendor's `1985-03-12`
 * — in a module that carries a paragraph on why every other date on a screen
 * is written month-first.
 */
describe("the date on the document", () => {
  const src = readFileSync(new URL("../IdentityPage.tsx", import.meta.url), "utf8");
  const line = src.split("\n").find((l) => l.includes("Born "));

  it("puts a borrower's birthday in words, not in the vendor's format", () => {
    expect(line).toBeDefined();
    expect(line).toContain("calendarDate(identity.dateOfBirth)");
    expect(line).not.toContain("${identity.dateOfBirth}");
    expect(calendarDate("1985-03-12")).toBe("March 12, 1985");
  });
});
