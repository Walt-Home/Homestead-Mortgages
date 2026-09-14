/**
 * The transcript branch's words, against the rules every borrower line keeps.
 *
 * They were literals inside `ConnectPages.tsx` until this file existed, which
 * is the whole reason it does: no rule ran over them, and all four said "your"
 * about a retrieval that names one taxpayer. The module is what makes "may
 * this sentence render?" a question somebody can answer, and this is the half
 * that answers it.
 *
 * It reads the module's exports rather than a list written out here. A
 * hand-written list is one somebody adds a string without joining.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRITISH, DAY_FIRST, DELIVERY_TIME, PROMISES, REQ_ID, VENDOR_CLAIM } from "@hm/shared";
import { TRANSCRIPT_COPY } from "../transcript-copy.js";

const LINES = Object.values(TRANSCRIPT_COPY);

const CONNECT_SOURCE = readFileSync(
  new URL("../../pages/ConnectPages.tsx", import.meta.url),
  "utf8",
);

describe("the transcript branch's words", () => {
  it("keeps the five rules the rest of the borrower copy keeps", () => {
    for (const line of LINES) {
      expect(line, line).not.toMatch(PROMISES);
      expect(line, line).not.toMatch(DELIVERY_TIME);
      expect(line, line).not.toMatch(REQ_ID);
      expect(line, line).not.toMatch(BRITISH);
      expect(line, line).not.toMatch(DAY_FIRST);
    }
  });

  it("claims nothing that depends on which adapter answered", () => {
    // The IRS adapter here is a fixture. Saying what a form authorizes is not
    // a claim about a vendor; saying transcripts were retrieved would be, and
    // the result block is what says that.
    for (const line of LINES) expect(line, line).not.toMatch(VENDOR_CLAIM);
  });

  it("says whose transcripts, and whose signature releases them", () => {
    // The point of the module. Form 4506-C names one taxpayer, so every
    // "your" on this screen is one person's — and unqualified it read as the
    // household's on a joint file.
    expect(TRANSCRIPT_COPY.promise).toContain("your own filed income");
    expect(TRANSCRIPT_COPY.needsSignature).toContain("your transcripts");
    expect(TRANSCRIPT_COPY.needsSignature).toContain("names one taxpayer");
    expect(TRANSCRIPT_COPY.needsSignature).toContain("covers your records alone");
  });

  it("is what the screen renders, rather than a second copy of it", () => {
    // A catalog nothing imports is a catalog whose rules protect nothing.
    for (const key of Object.keys(TRANSCRIPT_COPY)) {
      expect(CONNECT_SOURCE, key).toContain(`TRANSCRIPT_COPY.${key}`);
    }
    for (const line of LINES) expect(CONNECT_SOURCE).not.toContain(line);
  });

  it("gates itself on the reader's own signature, not on the file's first row", () => {
    // The server resolves the subject of this pull from the person asking, so
    // a screen reading Borrower 1's consent asks about somebody the request is
    // not about — and on a file whose applicant has been replaced it told the
    // borrower who had signed that we still needed her signature.
    expect(CONNECT_SOURCE).toContain('hasConsent(file, "form_4506c", you)');
  });
});
