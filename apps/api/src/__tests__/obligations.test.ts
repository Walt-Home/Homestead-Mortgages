/**
 * What the ledger is allowed to say is on the borrower.
 *
 * The failure this guards is a file parked at "Needs you" forever. The engine
 * reports plenty of outstanding work a borrower nominally owns — a recent
 * credit inquiry, a commission history nine months long, a gap in employment —
 * and none of it can be cleared by anything the product can put on a screen.
 * Treating those as obligations writes `borrower_owes` after every act, so the
 * application never leaves `awaiting_borrower` and the decision edges are never
 * legal. The narrowing lives in `@hm/shared`; this is the proof it holds
 * against the real engine and the real fixtures.
 *
 * No database: obligations are a pure function of a file, and so is the web's
 * `branchesFor`. The last test here writes down what the API puts on the wire
 * for each fixture and what it comes to, and the web's `branches.test.ts`
 * holds the identical table against `branchesFor` — so the card the borrower
 * is offered and the state the ledger records cannot drift apart.
 */

import { describe, expect, it } from "vitest";
import type { PersonaId } from "@hm/connectors";
import { actorFor, outstanding } from "@hm/requirements";
import type { BranchPath, LoanFile } from "@hm/shared";
import { borrowerObligations } from "../services/obligations.js";
import { connectedThrough } from "./support/in-memory-file.js";

const branches = (file: LoanFile) => borrowerObligations(file).map((o) => o.branch);

/**
 * What the API serves, and what it comes to, for every fixture at every step.
 *
 * `apps/web` is not a dependency of `apps/api` and `@hm/requirements` is not
 * one of the web's, so `branchesFor` and `borrowerObligations` cannot be run
 * side by side in one process. A literal both sides are pinned to is the next
 * best thing: `apps/web/src/lib/__tests__/branches.test.ts` holds this same
 * table and runs `branchesFor` over these exact items, expecting these exact
 * branches. Widening the rule on either side fails one of the two, and the
 * item list below is re-derived from the real engine on every run, so it
 * cannot quietly stop describing the fixtures it names.
 *
 * `ID|screen|source`, borrower-owned and known to apply — the assessment's
 * `actor: "borrower"` with `applicabilityKnown: true`.
 *
 * The four `declarations` rows are on every fixture because none of these
 * files has answered screen 3, and they are the point of the second assertion:
 * work a borrower genuinely owns, on a screen that is a STEP, must never
 * become a branch card. `branchCanSatisfy` is what keeps them off the list —
 * a `borrower_input` item is a branch only when a document upload could clear
 * it — and widening that rule would put a "few documents" card in front of
 * somebody whose outstanding work is a question the flow already walks them
 * through.
 */
const WIRE: readonly {
  readonly persona: PersonaId;
  readonly through: "credit" | "bank" | "payroll";
  readonly borrowerItems: readonly string[];
  readonly branches: readonly BranchPath[];
}[] = [
  {
    persona: "clean_w2",
    through: "bank",
    borrowerItems: [
      "APP-007|decision|borrower_input",
      "APP-022|declarations|borrower_input",
      "APP-023|declarations|borrower_input",
      "APP-026|declarations|borrower_input",
      "APP-028|declarations|borrower_input",
      "APP-029|decision|borrower_input",
      "CRD-002|credit|connect_credit",
      "CRD-016|credit|connect_credit",
      "INC-003|irs_transcript|connect_irs",
      "INC-008|irs_transcript|esign",
    ],
    branches: [],
  },
  {
    persona: "thin_file_renter",
    through: "bank",
    borrowerItems: [
      "APP-007|decision|borrower_input",
      "APP-022|declarations|borrower_input",
      "APP-023|declarations|borrower_input",
      "APP-026|declarations|borrower_input",
      "APP-028|declarations|borrower_input",
      "APP-029|decision|borrower_input",
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
    persona: "variable_income",
    through: "bank",
    borrowerItems: [
      "APP-007|decision|borrower_input",
      "APP-022|declarations|borrower_input",
      "APP-023|declarations|borrower_input",
      "APP-026|declarations|borrower_input",
      "APP-028|declarations|borrower_input",
      "APP-029|decision|borrower_input",
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
    persona: "variable_income",
    through: "payroll",
    borrowerItems: [
      "APP-007|decision|borrower_input",
      "APP-022|declarations|borrower_input",
      "APP-023|declarations|borrower_input",
      "APP-026|declarations|borrower_input",
      "APP-028|declarations|borrower_input",
      "APP-029|decision|borrower_input",
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

/** The borrower-owned half of the assessment, in the wire's own words. */
const wireItems = (file: LoanFile): string[] =>
  outstanding(file)
    .filter((a) => actorFor(a.requirement) === "borrower" && a.applies === true)
    .map((a) => `${a.requirement.id}|${a.requirement.screen}|${a.requirement.source}`);

describe("what the borrower still owes", () => {
  it("asks for payroll when the bank could not verify the income", async () => {
    // The variable-income fixture's asset report comes back `insufficient`,
    // which is the whole reason the payroll branch exists.
    const file = await connectedThrough("variable_income", "bank");
    expect(branches(file)).toContain("payroll");
  });

  it("asks for nothing on a clean file the bank could verify", async () => {
    const file = await connectedThrough("clean_w2", "bank");
    expect(branches(file)).toEqual([]);
  });

  it("stops asking for payroll once payroll is connected", async () => {
    // Connecting again returns the same history. A file held here would be
    // held on a screen whose only button changes nothing.
    const before = await connectedThrough("variable_income", "bank");
    const after = await connectedThrough("variable_income", "payroll");
    expect(branches(before)).toContain("payroll");
    expect(branches(after)).not.toContain("payroll");
  });

  it("never turns an engine finding into an obligation", async () => {
    // INC-005 and INC-006 are read out of the income history: a commission
    // source with nine months behind it, and a four-month gap in employment.
    // Both stay outstanding forever once payroll has answered, because
    // connecting again returns the same history. They are conditions on a
    // decided file, owned by the borrower and explained to them — not a reason
    // to stop the file at "needs you" waiting for a document that cannot exist.
    const file = await connectedThrough("variable_income", "payroll");
    const outstandingIds = outstanding(file)
      .filter((a) => a.applies === true)
      .map((a) => a.requirement.id);
    const owed = borrowerObligations(file).flatMap((o) => o.requirementIds);
    for (const id of ["INC-005", "INC-006"]) {
      // The precondition matters: an id no fixture reaches would pass the
      // second assertion for the wrong reason.
      expect(outstandingIds, `${id} should still be outstanding`).toContain(id);
      expect(owed, `${id} must not be an obligation`).not.toContain(id);
    }
    // And the one on the same file that a branch CAN clear is still asked for,
    // so this is not passing because nothing is owed at all.
    expect(owed).toContain("CRD-008");
    expect(branches(file)).toContain("documents");
  });

  it("never sends anybody down a branch for the 4506-C or a transcript pull", async () => {
    // INC-008 is `esign` and universal, and the transcript pull is ours to
    // make. Treating either as a branch trigger sent every clean W-2 borrower
    // to authorize something the review screen was about to ask them to sign.
    for (const persona of ["clean_w2", "thin_file_renter", "variable_income"] as const) {
      for (const through of ["credit", "bank", "payroll"] as const) {
        const file = await connectedThrough(persona, through);
        const owed = borrowerObligations(file);
        expect(
          owed.map((o) => o.branch),
          `${persona}/${through}`,
        ).not.toContain("irs");
        const sources = outstanding(file)
          .filter((a) => owed.flatMap((o) => o.requirementIds).includes(a.requirement.id))
          .map((a) => a.requirement.source);
        expect(sources, `${persona}/${through}`).not.toContain("esign");
        expect(sources, `${persona}/${through}`).not.toContain("connect_irs");
      }
    }
  });

  it("carries the requirement ids, and only server-side", async () => {
    const file = await connectedThrough("variable_income", "bank");
    const payroll = borrowerObligations(file).find((o) => o.branch === "payroll");
    expect(payroll?.reason).toBe("payroll_connection_needed");
    expect(payroll?.requirementIds).toContain("INC-002");
  });

  it("agrees with the branch cards the borrower is offered", async () => {
    // Both halves matter. The item list is what `GET /assessment` puts on the
    // wire for a borrower-owned item, so it is the input `branchesFor` reads;
    // the branch list is what this side comes to from the same engine output.
    // Widening the rule moves one of the two, whichever side it is widened on.
    for (const row of WIRE) {
      const file = await connectedThrough(row.persona, row.through);
      const where = `${row.persona}/${row.through}`;
      expect(wireItems(file).sort(), `${where} items`).toEqual([...row.borrowerItems].sort());
      expect(branches(file), where).toEqual(row.branches);
    }
  });
});
