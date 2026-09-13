/**
 * The cards a borrower is offered, and the ones they must never be.
 *
 * `branchesFor` and the API's `borrowerObligations` answer the same question
 * through the same shared rule. When they disagree the borrower gets one of
 * two bad screens: a file sitting at "Needs you" with nothing on it to press,
 * or a card asking for something the ledger says nobody wants.
 *
 * The failure this file exists to catch is the safe-looking one — widening the
 * filter back to "any outstanding item the borrower owns", which offers an
 * upload for a credit inquiry and a payroll trip to somebody who has already
 * connected their payroll.
 */

import { describe, expect, it } from "vitest";
import { branchesFor } from "../flow.js";
import type { Assessment, OutstandingItem } from "../api.js";

const item = (over: Partial<OutstandingItem>): OutstandingItem => ({
  id: "INC-002",
  screen: "payroll",
  source: "connect_payroll",
  actor: "borrower",
  statement: "Paystubs covering the most recent 30 days",
  severity: "repurchase_unsaleable",
  appliesBecause: "always",
  applicabilityKnown: true,
  missing: "paystubs",
  waitingFor: null,
  ...over,
});

const assessment = (outstanding: OutstandingItem[]): Assessment => ({
  progress: {
    applicable: 0,
    satisfied: 0,
    outstanding: outstanding.length,
    blocked: 0,
    undetermined: 0,
    borrowerOutstanding: outstanding.length,
    lenderOutstanding: 0,
  },
  outstanding,
  blocked: [],
  leverage: [],
});

const paths = (items: OutstandingItem[], payrollLinked = false) =>
  branchesFor(assessment(items), payrollLinked).map((b) => b.path);

describe("which branches a borrower is offered", () => {
  it("offers the payroll card while the employer is unconnected", () => {
    expect(paths([item({})])).toEqual(["payroll"]);
  });

  it("stops offering it once payroll has answered", () => {
    // A second trip through that screen returns the history that is already
    // on the file, so the card would be a button that changes nothing.
    expect(paths([item({})], true)).toEqual([]);
  });

  it("offers the documents card for the letter of explanation", () => {
    expect(
      paths([item({ id: "CRD-008", screen: "upload_fallback", source: "borrower_input" })]),
    ).toEqual(["documents"]);
  });

  it("offers nothing for a finding no upload can clear", () => {
    // CRD-009 is a recent-inquiry finding judged from the credit report, and
    // it carries `borrower_input` on the upload screen. Offering a card for it
    // sends somebody to attach a document that satisfies nothing.
    expect(
      paths([item({ id: "CRD-009", screen: "upload_fallback", source: "borrower_input" })]),
    ).toEqual([]);
  });

  it("offers nothing for the lender's own work, or for work we do ourselves", () => {
    expect(paths([item({ actor: "lender" })])).toEqual([]);
    expect(paths([item({ id: "INC-008", screen: "irs_transcript", source: "esign" })])).toEqual([]);
    expect(
      paths([item({ id: "INC-003", screen: "irs_transcript", source: "connect_irs" })]),
    ).toEqual([]);
  });

  it("offers nothing while we do not yet know whether it applies", () => {
    // "We might still ask" is not a reason to make somebody log into their
    // payroll provider.
    expect(paths([item({ applicabilityKnown: false })])).toEqual([]);
  });

  it("names no requirement id in anything it renders", () => {
    const branches = branchesFor(
      assessment([
        item({}),
        item({ id: "CRD-008", screen: "upload_fallback", source: "borrower_input" }),
      ]),
      false,
    );
    for (const branch of branches) {
      expect(`${branch.title} ${branch.because}`).not.toMatch(/[A-Z]{2,3}-\d{3}/);
    }
  });
});

/**
 * The same fixtures the API records obligations against.
 *
 * Copied from `apps/api/src/__tests__/obligations.test.ts`, which re-derives
 * these items from the real engine on every run and expects these same
 * branches from `borrowerObligations`. Neither workspace can import the
 * other's function — `@hm/requirements` is not a web dependency and `apps/web`
 * is not an API one — so the agreement is held by a table both sides are
 * pinned to. A rule widened on either side moves one of the two lists.
 *
 * The three `declarations` items are outstanding on every fixture — none of
 * them has answered screen 3 — and they must produce no card at all: the
 * questions are a step the flow walks a borrower through, not work a document
 * upload could clear.
 */
const WIRE: readonly {
  readonly who: string;
  readonly payrollLinked: boolean;
  readonly borrowerItems: readonly string[];
  readonly branches: readonly string[];
}[] = [
  {
    who: "clean_w2 through the bank",
    payrollLinked: false,
    borrowerItems: [
      "APP-007|decision|borrower_input",
      "APP-022|declarations|borrower_input",
      "APP-023|declarations|borrower_input",
      "APP-026|declarations|borrower_input",
      "CRD-002|credit|connect_credit",
      "CRD-016|credit|connect_credit",
      "INC-003|irs_transcript|connect_irs",
      "INC-008|irs_transcript|esign",
    ],
    branches: [],
  },
  {
    who: "thin_file_renter through the bank",
    payrollLinked: false,
    borrowerItems: [
      "APP-007|decision|borrower_input",
      "APP-022|declarations|borrower_input",
      "APP-023|declarations|borrower_input",
      "APP-026|declarations|borrower_input",
      "AST-005|bank|connect_bank",
      "AST-007|bank|connect_bank",
      "CRD-002|credit|connect_credit",
      "CRD-016|credit|connect_credit",
      "INC-003|irs_transcript|connect_irs",
      "INC-008|irs_transcript|esign",
    ],
    branches: [],
  },
  {
    who: "variable_income through the bank",
    payrollLinked: false,
    borrowerItems: [
      "APP-007|decision|borrower_input",
      "APP-022|declarations|borrower_input",
      "APP-023|declarations|borrower_input",
      "APP-026|declarations|borrower_input",
      "AST-006|upload_fallback|connect_bank",
      "CRD-002|credit|connect_credit",
      "CRD-008|upload_fallback|borrower_input",
      "CRD-013|bank|connect_bank",
      "CRD-014|credit|connect_credit",
      "CRD-016|credit|connect_credit",
      "INC-002|payroll|connect_payroll",
      "INC-003|irs_transcript|connect_irs",
      "INC-008|irs_transcript|esign",
    ],
    branches: ["payroll", "documents"],
  },
  {
    who: "variable_income through payroll",
    payrollLinked: true,
    borrowerItems: [
      "APP-007|decision|borrower_input",
      "APP-022|declarations|borrower_input",
      "APP-023|declarations|borrower_input",
      "APP-026|declarations|borrower_input",
      "AST-006|upload_fallback|connect_bank",
      "CRD-002|credit|connect_credit",
      "CRD-008|upload_fallback|borrower_input",
      "CRD-013|bank|connect_bank",
      "CRD-014|credit|connect_credit",
      "CRD-016|credit|connect_credit",
      "INC-003|irs_transcript|connect_irs",
      "INC-005|payroll|connect_payroll",
      "INC-006|payroll|connect_payroll",
      "INC-008|irs_transcript|esign",
    ],
    branches: ["documents"],
  },
];

describe("the branches the server would record as owed", () => {
  it("offers a card for each one, and for nothing else", () => {
    for (const row of WIRE) {
      const items = row.borrowerItems.map((spec) => {
        const [id, screen, source] = spec.split("|");
        return item({ id, screen, source });
      });
      expect(paths(items, row.payrollLinked), row.who).toEqual(row.branches);
    }
  });
});
