/**
 * These tests guard the seam between Drew's spreadsheet and the code.
 *
 * The registry is generated, so nothing here checks the values themselves —
 * `npm run requirements:verify` does that. What these check is that every row
 * the sheet contains has somewhere to land: a condition predicate, an
 * evaluator, and a place in an acyclic graph. When the sheet grows, these are
 * what fail.
 */

import { describe, expect, it } from "vitest";
import {
  BORROWER_MUST_ACT,
  BRANCH_FOR_SCREEN,
  DOCUMENT_SATISFIABLE,
  PAYROLL_SATISFIABLE,
} from "@hm/shared";
import type { LoanFile } from "@hm/shared";
import { REQUIREMENTS, DANGLING_REFERENCES } from "../generated.js";
import { CONDITIONS, evaluateCondition } from "../conditions.js";
import { EVALUATORS } from "../satisfaction.js";
import { EDGES, topologicalOrder } from "../graph.js";

describe("registry", () => {
  it("carries every row of the V1 sheet", () => {
    expect(REQUIREMENTS.length).toBe(77);
  });

  it("has a condition predicate for every requirement", () => {
    const missing = REQUIREMENTS.filter((r) => !(r.condition in CONDITIONS)).map((r) => r.id);
    expect(missing).toEqual([]);
  });

  it("has a satisfaction evaluator for every requirement", () => {
    const missing = REQUIREMENTS.filter((r) => !(r.id in EVALUATORS)).map((r) => r.id);
    expect(missing).toEqual([]);
  });

  it("has no evaluator for a requirement that no longer exists", () => {
    const ids = new Set(REQUIREMENTS.map((r) => r.id));
    const orphans = Object.keys(EVALUATORS).filter((id) => !ids.has(id));
    expect(orphans).toEqual([]);
  });

  it("assigns every requirement a unique id", () => {
    expect(new Set(REQUIREMENTS.map((r) => r.id)).size).toBe(REQUIREMENTS.length);
  });
});

describe("dependency graph", () => {
  it("is acyclic", () => {
    // A cycle means two requirements each claim to precede the other, which is
    // a contradiction in the sheet rather than a bug here. The failure message
    // names the requirements so it can be taken back to Drew.
    expect(topologicalOrder().cycle).toEqual([]);
  });

  it("orders every requirement", () => {
    expect(topologicalOrder().order.length).toBe(REQUIREMENTS.length);
  });

  it("only draws edges between requirements the sheet defines", () => {
    const ids = new Set(REQUIREMENTS.map((r) => r.id));
    const bad = EDGES.filter((e) => !ids.has(e.from) || !ids.has(e.to));
    expect(bad).toEqual([]);
  });

  it("records the closing-stage references the V1 sheet does not define", () => {
    // Six timing constraints point at CLS-001, CLS-002 and CLS-013 — the
    // closing-stage family, which lives in a sheet that does not exist yet.
    // If this count changes, either the sheet grew a closing section or a
    // reference was fixed, and either way somebody should look.
    expect(DANGLING_REFERENCES.map((d) => d.to).sort()).toEqual([
      "CLS-001",
      "CLS-002",
      "CLS-002",
      "CLS-002",
      "CLS-002",
      "CLS-013",
    ]);
  });
});

describe("APP-011 — demographic collection", () => {
  // Regulation B is about the ASKING. The UI once hardcoded
  // {ethnicity:"declined", race:"declined", sex:"declined"} for every borrower
  // and this evaluator marked a "Regulatory violation" requirement satisfied on
  // the strength of it — recording that a person declined a question they were
  // never shown. That is the only place this codebase asserted something false
  // about a borrower.
  const borrower = (demographics: unknown) => ({ borrowers: [{ demographics }] }) as never;

  it("is unsatisfied when the questions were never asked", () => {
    const r = EVALUATORS["APP-011"]!(borrower(null));
    expect(r.status).toBe("unsatisfied");
  });

  it("is unsatisfied when an answer is blank, which is not a decline", () => {
    const r = EVALUATORS["APP-011"]!(
      borrower({ ethnicity: [], race: [], sex: "", visualObservationNoted: false }),
    );
    expect(r.status).toBe("unsatisfied");
    if (r.status === "unsatisfied") {
      expect(r.missing).toContain("ethnicity");
      expect(r.missing).toContain("race");
      expect(r.missing).toContain("sex");
    }
  });

  it("is satisfied by a genuine decline", () => {
    const r = EVALUATORS["APP-011"]!(
      borrower({
        ethnicity: "declined",
        race: "declined",
        sex: "declined",
        visualObservationNoted: false,
      }),
    );
    expect(r.status).toBe("satisfied");
  });

  it("is satisfied by real answers", () => {
    const r = EVALUATORS["APP-011"]!(
      borrower({
        ethnicity: ["Not Hispanic or Latino"],
        race: ["White"],
        sex: "Female",
        visualObservationNoted: false,
      }),
    );
    expect(r.status).toBe("satisfied");
  });

  it("is satisfied when some are answered and others declined", () => {
    const r = EVALUATORS["APP-011"]!(
      borrower({
        ethnicity: ["Hispanic or Latino"],
        race: "declined",
        sex: "Male",
        visualObservationNoted: false,
      }),
    );
    expect(r.status).toBe("satisfied");
  });
});

describe("the branch rule names requirements that exist", () => {
  // `@hm/shared` holds the rule because the web reads it and the web does not
  // carry the 77 rows. That is also why nothing over there can notice a typo:
  // an id that no longer matches a row turns a branch off in silence, and the
  // borrower gets no card for work that is genuinely theirs.
  const byId = new Map(REQUIREMENTS.map((r) => [r.id, r]));

  it("puts every document-satisfiable id on the documents branch", () => {
    for (const id of DOCUMENT_SATISFIABLE) {
      const r = byId.get(id);
      expect(r, id).toBeDefined();
      expect(BORROWER_MUST_ACT as readonly string[], id).toContain(r!.source);
      expect(BRANCH_FOR_SCREEN[r!.screen as keyof typeof BRANCH_FOR_SCREEN], id).toBe("documents");
    }
  });

  it("puts every payroll-satisfiable id on the payroll branch", () => {
    for (const id of PAYROLL_SATISFIABLE) {
      const r = byId.get(id);
      expect(r, id).toBeDefined();
      expect(r!.source, id).toBe("connect_payroll");
      expect(BRANCH_FOR_SCREEN[r!.screen as keyof typeof BRANCH_FOR_SCREEN], id).toBe("payroll");
    }
  });
});

describe("a referral has not decided anything", () => {
  /**
   * Rule 2: `null` is not `false`. `denial_or_counteroffer` gates UW-016 —
   * whether the borrower is owed written reasons — and a `referred` decision
   * has concluded nothing about that. Answering `false` would let a file that
   * is about to be declined report itself as owing no notice, which is the
   * requirement disappearing at exactly the moment it starts to matter.
   */
  const outcomeIs = (outcome: string) =>
    evaluateCondition("denial_or_counteroffer", {
      decision: { outcome },
    } as unknown as LoanFile);

  it("cannot know yet on referred, the same as on pending", () => {
    expect(outcomeIs("referred")).toBeNull();
    expect(outcomeIs("pending")).toBeNull();
  });

  it("still answers for the words that have decided", () => {
    // The precondition for the case above: this predicate does return
    // booleans, so `null` is a deliberate third answer rather than the only
    // one it knows how to give.
    expect(outcomeIs("denied")).toBe(true);
    expect(outcomeIs("counteroffer")).toBe(true);
    expect(outcomeIs("approved_with_conditions")).toBe(false);
  });
});
