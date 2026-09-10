/**
 * What the upload screen is allowed to put a control under.
 *
 * The rule is stated once, in `@hm/shared`, and asked by three callers: the
 * branch cards, the API's record of what the borrower owes, and this screen.
 * This screen was the one that still listed everything the borrower owned on
 * it, which offers "Attach a document" against a finding the engine derives
 * for itself — a recent credit inquiry, a bankruptcy seasoned from a date.
 * Somebody attaches a file and the item is still there afterwards, which reads
 * as the product being broken rather than as the item never having been
 * theirs to clear.
 */

import { describe, expect, it } from "vitest";
import { attachable, signatureKind } from "../UploadPage.js";
import { documentTitle } from "../../components/SignDocument.js";
import type { OutstandingItem } from "../../lib/api.js";

const item = (over: Partial<OutstandingItem>): OutstandingItem => ({
  id: "CRD-008",
  screen: "upload_fallback",
  source: "borrower_input",
  actor: "borrower",
  statement: "Letter of explanation for the derogatory account",
  severity: "repurchase_unsaleable",
  appliesBecause: "a collection is on the report",
  applicabilityKnown: true,
  missing: "a letter",
  waitingFor: null,
  ...over,
});

const listed = (items: OutstandingItem[], payrollLinked = false) =>
  attachable(items, payrollLinked).map((o) => o.id);

describe("the items the upload screen offers", () => {
  it("offers the letter of explanation, which an upload does clear", () => {
    expect(listed([item({})])).toEqual(["CRD-008"]);
  });

  it("offers nothing for a finding the engine derives for itself", () => {
    // CRD-009 is read out of the credit report and CRD-006 out of the
    // engine's own bankruptcy seasoning. Both sit on this screen and neither
    // moves for any document a borrower can send.
    expect(listed([item({ id: "CRD-009" })])).toEqual([]);
    expect(listed([item({ id: "CRD-006", source: "document_upload" })])).toEqual([]);
  });

  it("offers nothing for work that is not the borrower's to do here", () => {
    // AST-006 lands on this screen but its source is the bank connection, so
    // an upload control under it asks for the wrong thing entirely.
    expect(listed([item({ id: "AST-006", source: "connect_bank" })])).toEqual([]);
    expect(listed([item({ actor: "lender" })])).toEqual([]);
  });

  it("offers nothing while we do not yet know whether it applies", () => {
    expect(listed([item({ applicabilityKnown: false })])).toEqual([]);
  });

  it("leaves the other screens' items to the other screens", () => {
    expect(listed([item({ id: "INC-002", screen: "payroll", source: "connect_payroll" })])).toEqual(
      [],
    );
  });
});

/**
 * The heading over a signature, which used to be the requirements sheet's.
 *
 * The card read "4506-C executed" — the registry's `statement`, in the words
 * the underwriting sheet uses for a row that is done. It now reads the title
 * out of the panel the button opens, so the two cannot name different
 * documents, and `signatureKind` is the single mapping both of them ask.
 */
describe("what the upload screen calls a document it wants signed", () => {
  it("names each of the three the way the signing panel does", () => {
    expect(documentTitle(signatureKind("INC-008"))).toBe("IRS Form 4506-C");
    expect(documentTitle(signatureKind("APP-012"))).toBe("Electronic delivery");
    expect(documentTitle(signatureKind("APP-005"))).toBe("Authorization to verify");
  });

  /**
   * `signable` is every outstanding item whose source is `esign`, and the
   * sheet is free to add a fourth. Whatever it adds falls through to the
   * verification authorization, so the card is never headed by nothing.
   */
  it("has a name for a requirement it has never seen", () => {
    expect(documentTitle(signatureKind("UW-042"))).toBe("Authorization to verify");
  });
});
