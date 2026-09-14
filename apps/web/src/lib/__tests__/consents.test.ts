/**
 * Whose signature a screen is reading.
 *
 * `hasConsent` is what the transcript step asks before it decides whether to
 * put a signing panel in front of the borrower, and it answered about the FILE.
 * On a file with one borrower that is the same question. On a joint one it is
 * not: IRS Form 4506-C names a single taxpayer, so a co-borrower's signed
 * 4506-C is not the applicant's — and the step unblocked itself on it, then
 * sent the applicant into a pull the server refuses, because the grant behind
 * the signature it read belongs to somebody else.
 *
 * It answers about a NAMED borrower rather than working one out, and the
 * callers pass `you` off the file response. Resolving the reader as the first
 * row would be the same defect one position over: on a file whose Borrower 1
 * has been replaced, the person reading the screen is not the first row, and
 * the answer would be about somebody else's signature either way.
 */

import { describe, expect, it } from "vitest";
import { hasConsent, type LoanFileView } from "../file.js";

/** As much of the wire shape as `hasConsent` reads. */
const file = (consents: LoanFileView["consents"]): LoanFileView =>
  ({
    borrowers: [
      { id: "b1", firstName: "Dana", lastName: "Whitfield" },
      { id: "b2", firstName: "Theo", lastName: "Okafor" },
    ],
    consents,
  }) as unknown as LoanFileView;

const signed = (borrowerId: string, kind: string): LoanFileView["consents"][number] => ({
  kind,
  borrowerId,
  grantedAt: "2026-09-14T00:00:00.000Z",
});

describe("a signature the screens read", () => {
  it("is the reader's own", () => {
    expect(hasConsent(file([signed("b1", "form_4506c")]), "form_4506c", "b1")).toBe(true);
  });

  it("is not somebody else's on the same file", () => {
    // The whole point. Their 4506-C is theirs, and a screen that took it for
    // the reader's would offer a transcript pull nothing can authorize.
    expect(hasConsent(file([signed("b2", "form_4506c")]), "form_4506c", "b1")).toBe(false);
  });

  it("follows the person and not the position", () => {
    // The file whose ordinal 1 has been refilled: the second row is the person
    // reading the screen, and she is the one who signed here. Answered by
    // position this is the co-borrower's question, and comes back false about
    // a signature she has given.
    const f = file([signed("b2", "form_4506c")]);
    expect(hasConsent(f, "form_4506c", "b2")).toBe(true);
    expect(hasConsent(f, "form_4506c", "b1")).toBe(false);
  });

  it("is not a revoked one, and not a different document", () => {
    expect(
      hasConsent(
        file([{ ...signed("b1", "form_4506c"), revokedAt: "2026-09-15" }]),
        "form_4506c",
        "b1",
      ),
    ).toBe(false);
    expect(hasConsent(file([signed("b1", "econsent")]), "form_4506c", "b1")).toBe(false);
  });

  it("is nothing at all for a reader who is not a borrower here", () => {
    // Every reader of a demo file, and anybody whose file has no row for them.
    expect(hasConsent(undefined, "form_4506c", "b1")).toBe(false);
    expect(hasConsent(file([signed("b1", "form_4506c")]), "form_4506c", null)).toBe(false);
    expect(hasConsent(file([signed("b1", "form_4506c")]), "form_4506c", undefined)).toBe(false);
  });
});
