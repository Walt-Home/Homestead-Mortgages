/**
 * The dependency graph hiding in the `Timing constraint` column.
 *
 * "Before UW-004" and "After CRD-001" are edges, and once you draw them the
 * sheet stops being a checklist and becomes an order of operations. That is
 * what lets the product answer the only question a borrower actually asks —
 * "what is left?" — with the work that is genuinely unblocked rather than the
 * whole outstanding list.
 */

import { REQUIREMENTS, DANGLING_REFERENCES } from "./generated.js";
import type { Requirement } from "./types.js";

export interface Edge {
  /** Must be satisfied first. */
  readonly from: string;
  /** Cannot proceed until `from` is satisfied. */
  readonly to: string;
}

const byId = new Map<string, Requirement>(REQUIREMENTS.map((r) => [r.id, r]));

export function getRequirement(id: string): Requirement | undefined {
  return byId.get(id);
}

export function allRequirements(): readonly Requirement[] {
  return REQUIREMENTS;
}

export { DANGLING_REFERENCES };

/**
 * Edges among requirements this sheet defines.
 *
 * References to CLS-* are excluded — those are closing-stage requirements from
 * a sheet that does not exist yet, so an edge to them would be an edge to
 * nothing. `DANGLING_REFERENCES` keeps them visible instead of dropping them
 * silently; see `docs/requirements.md`.
 */
export const EDGES: readonly Edge[] = (() => {
  const edges: Edge[] = [];
  for (const r of REQUIREMENTS) {
    const t = r.timing;
    if (!("refs" in t) || !t.refs) continue;
    for (const ref of t.refs) {
      if (!byId.has(ref)) continue;
      if (t.kind === "before") edges.push({ from: r.id, to: ref });
      // `after` and the requirement-relative `deadline` both mean the other
      // requirement comes first.
      else edges.push({ from: ref, to: r.id });
    }
  }
  return edges;
})();

function push(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

const dependenciesOf = new Map<string, string[]>();
const dependentsOf = new Map<string, string[]>();
for (const e of EDGES) {
  push(dependenciesOf, e.to, e.from);
  push(dependentsOf, e.from, e.to);
}

/** Requirements that must be satisfied before `id` can be. */
export function dependencies(id: string): readonly string[] {
  return dependenciesOf.get(id) ?? [];
}

/** Requirements blocked by `id`. */
export function dependents(id: string): readonly string[] {
  return dependentsOf.get(id) ?? [];
}

/**
 * Everything `id` transitively waits on. Used to explain a blocked item as
 * "waiting on the credit pull" rather than "waiting on UW-002".
 */
export function transitiveDependencies(id: string): readonly string[] {
  const seen = new Set<string>();
  const stack = [...dependencies(id)];
  while (stack.length) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...dependencies(next));
  }
  return [...seen];
}

export interface TopoResult {
  readonly order: readonly string[];
  /** Non-empty only if the sheet has contradicted itself. */
  readonly cycle: readonly string[];
}

/**
 * Kahn's algorithm. A cycle here would mean two requirements each claim to
 * come before the other, which is a defect in the sheet rather than in the
 * code — so it is returned rather than thrown, and surfaced by the test.
 */
export function topologicalOrder(): TopoResult {
  const indegree = new Map<string, number>();
  for (const r of REQUIREMENTS) indegree.set(r.id, 0);
  for (const e of EDGES) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);

  // Seed in sheet order so the output is stable and reads screen-by-screen.
  const queue = REQUIREMENTS.filter((r) => indegree.get(r.id) === 0).map((r) => r.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of dependents(id)) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  const placed = new Set(order);
  const cycle =
    order.length === REQUIREMENTS.length
      ? []
      : REQUIREMENTS.map((r) => r.id).filter((id) => !placed.has(id));
  return { order, cycle };
}
