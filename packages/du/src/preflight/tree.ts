/**
 * The assembled tree, indexed the four ways the checks read it.
 *
 * Every check below this file asks one of four questions — what sits at this
 * XPath, what value does this container carry, which containers does this one
 * arc to, and where does this element sit among its siblings — and each of them
 * is a walk of the whole document if it is asked of a bare tree. So the walk
 * happens once, here, and the checks are predicates over the result.
 *
 * **A path here carries no predicate.** The generated cardinality, lengths and
 * conditionality tables are keyed on the plain XPath, so `LOANS/LOAN` is one
 * key whether the loan is the subject or one the borrower already owes, and the
 * checks that care read `LoanRoleType` off the attribute. The modeled-set
 * subtraction spells a loan with its predicate for the opposite reason: there,
 * conflating the two would claim a shape nothing holds.
 */

import type { DuNode } from "../document.js";

/** One element, with everything a check needs to place it. */
export interface DuInstance {
  readonly node: DuNode;
  /** The element path from `MESSAGE` down, with no attribute predicates. */
  readonly path: string;
  readonly parent: DuInstance | null;
  /** True when a sibling carries the same element name. */
  readonly repeats: boolean;
  /** The `xlink:label` on this element, when it has one. */
  readonly label: string | null;
}

/** One `RELATIONSHIP`, as the three attributes that are all it carries. */
export interface DuArc {
  readonly instance: DuInstance;
  readonly from: string | undefined;
  readonly to: string | undefined;
  readonly arcrole: string | undefined;
}

export interface DuTree {
  readonly root: DuNode;
  readonly instances: readonly DuInstance[];
  /** Every element at an exact path, in document order. */
  at(path: string): readonly DuInstance[];
  /** Every element at a path, inside one ancestor. */
  within(ancestor: DuInstance, path: string): readonly DuInstance[];
  readonly labels: ReadonlyMap<string, DuInstance>;
  readonly arcs: readonly DuArc[];
  /** The containers at the other end of an arc from this one, either direction. */
  linked(instance: DuInstance): readonly DuInstance[];
}

/** The text of a child data point, or undefined when the element has none. */
export function valueOf(instance: DuInstance, name: string): string | undefined {
  const child = (instance.node.children ?? []).find(
    (candidate) => candidate.name === name && candidate.value !== undefined,
  );
  return child?.value;
}

/** Whether a child data point is present and non-empty. */
export function carries(instance: DuInstance, name: string): boolean {
  const value = valueOf(instance, name);
  return value !== undefined && value !== "";
}

/** Every data point of a name anywhere inside an element, in document order. */
export function valuesUnder(node: DuNode, name: string, into: string[] = []): string[] {
  if (node.name === name && node.value !== undefined && node.value !== "") into.push(node.value);
  const attribute = node.attributes?.[name];
  if (attribute !== undefined && attribute !== "") into.push(attribute);
  for (const child of node.children ?? []) valuesUnder(child, name, into);
  return into;
}

/** True when this element is an ancestor of that one, or is it. */
export function contains(ancestor: DuInstance, instance: DuInstance): boolean {
  for (let level: DuInstance | null = instance; level; level = level.parent) {
    if (level === ancestor) return true;
  }
  return false;
}

export function indexTree(root: DuNode): DuTree {
  const instances: DuInstance[] = [];
  const byPath = new Map<string, DuInstance[]>();
  const labels = new Map<string, DuInstance>();
  const arcs: DuArc[] = [];

  const walk = (node: DuNode, parent: DuInstance | null, prefix: string, repeats: boolean) => {
    const path = prefix === "" ? node.name : `${prefix}/${node.name}`;
    const instance: DuInstance = {
      node,
      path,
      parent,
      repeats,
      label: node.attributes?.["xlink:label"] ?? null,
    };
    instances.push(instance);
    const group = byPath.get(path);
    if (group) group.push(instance);
    else byPath.set(path, [instance]);
    // First one wins, so a duplicated label reports the second as the offender
    // and the check that catches it names both.
    if (instance.label !== null && !labels.has(instance.label))
      labels.set(instance.label, instance);
    if (node.name === "RELATIONSHIP") {
      arcs.push({
        instance,
        from: node.attributes?.["xlink:from"],
        to: node.attributes?.["xlink:to"],
        arcrole: node.attributes?.["xlink:arcrole"],
      });
    }

    const children = node.children ?? [];
    const counts = new Map<string, number>();
    for (const child of children) counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
    for (const child of children) {
      walk(child, instance, path, (counts.get(child.name) ?? 0) > 1);
    }
  };
  walk(root, null, "", false);

  const linkage = new Map<DuInstance, DuInstance[]>();
  const join = (one: DuInstance, other: DuInstance) => {
    const held = linkage.get(one);
    if (held) held.push(other);
    else linkage.set(one, [other]);
  };
  for (const arc of arcs) {
    const from = arc.from === undefined ? undefined : labels.get(arc.from);
    const to = arc.to === undefined ? undefined : labels.get(arc.to);
    if (!from || !to) continue;
    join(from, to);
    join(to, from);
  }

  return {
    root,
    instances,
    at: (path) => byPath.get(path) ?? [],
    within: (ancestor, path) =>
      (byPath.get(path) ?? []).filter((instance) => contains(ancestor, instance)),
    labels,
    arcs,
    linked: (instance) => linkage.get(instance) ?? [],
  };
}
