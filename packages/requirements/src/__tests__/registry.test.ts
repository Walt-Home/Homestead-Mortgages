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
import { REQUIREMENTS, DANGLING_REFERENCES } from "../generated.js";
import { CONDITIONS } from "../conditions.js";
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
