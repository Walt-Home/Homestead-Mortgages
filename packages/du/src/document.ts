/**
 * The in-memory tree an assembled submission is, before it is bytes.
 *
 * One node type for every element, because MISMO's document is uniform: a
 * container holds children, a data point holds a string, and both can carry
 * attributes. Nothing here knows what a `LIABILITY` is — `assemble/` builds the
 * shape and `emit.ts` writes it in the order `generated/order.ts` gives, so the
 * one file that could put a child in the wrong place is the one that reads the
 * schema rather than the one that reads our rows.
 *
 * **A container is written when it has a child.** `container()` returns null
 * for an empty one and `compact()` drops the nulls, so a borrower with no
 * residence produces no `<RESIDENCES/>` rather than an empty one. An empty
 * container validates — a document carrying `<EXTENSION><OTHER/></EXTENSION>`
 * passes the whole nine-file chain, exit 0 — and says nothing, which is worse
 * than absent because at review it is indistinguishable from one somebody meant
 * to fill.
 */

/** An element: a data point when it has a `value`, a container when it has `children`. */
export interface DuNode {
  readonly name: string;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly value?: string;
  readonly children?: readonly DuNode[];
}

/** What a builder may be handed: a node, or the absence of one. */
export type MaybeNode = DuNode | null | undefined;

/** Drop the absences, so a caller can list every child it might emit. */
export function compact(nodes: readonly MaybeNode[]): DuNode[] {
  return nodes.filter((node): node is DuNode => node != null);
}

/**
 * A data point, or nothing when there is no value.
 *
 * The empty string is nothing too. A `<CityName></CityName>` is a claim that
 * the city is blank, which no borrower has ever meant.
 */
export function leaf(name: string, value: string | null | undefined): DuNode | null {
  if (value === null || value === undefined || value === "") return null;
  return { name, value };
}

/** A container, or nothing when every child it might have had was absent. */
export function container(
  name: string,
  children: readonly MaybeNode[],
  attributes?: Readonly<Record<string, string>>,
): DuNode | null {
  const kept = compact(children);
  if (kept.length === 0) return null;
  return attributes ? { name, attributes, children: kept } : { name, children: kept };
}

/**
 * An element that is only its attributes.
 *
 * `RELATIONSHIP` is the whole of the reason this exists: an arc carries
 * `SequenceNumber`, `xlink:from`, `xlink:to` and `xlink:arcrole` and has
 * nowhere to put a child, so `container()` would refuse to write it.
 */
export function attributesOnly(name: string, attributes: Readonly<Record<string, string>>): DuNode {
  return { name, attributes };
}
