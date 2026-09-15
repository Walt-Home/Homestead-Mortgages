/**
 * The tree, as bytes, in the one order the XSD actually enforces.
 *
 * MISMO writes every container as an `xsd:sequence`, so element order is
 * structural: a serializer that sorts its children alphabetically produces a
 * document that fails validation, and the tempting
 * alphabetical-with-EXTENSION-last shortcut is wrong for `DEAL`, `PARTY`,
 * `ROLE`, `EMPLOYER`, `COLLATERAL`, `CONTACT_POINT` and `LICENSE` among others,
 * all of which a DU submission leans on. So the order comes from
 * `generated/order.ts`, which is read out of the vendored schema chain, and
 * nothing here sorts anything.
 *
 * **A child the sequence does not name stops the emission.** That is the same
 * discipline `scripts/build-du.mjs` follows: a document that validates and says
 * the wrong thing is worse than one that was never written, and a misspelled
 * element name is exactly how you get one.
 */

import { CHILD_ORDER, TYPE_FOR_PATH } from "./generated/order.js";
import type { DuNode } from "./document.js";

/**
 * The containers with no row in the generated order table, and why each is
 * safe without one.
 *
 * `EXTENSION` and `OTHER` are the extension envelope, and their sequence IS in
 * the table under the owning type's name — see `orderFor`, which derives the
 * key rather than special-casing them. What is left is `RELATIONSHIPS`, which
 * holds one repeated child and has no sequence to get wrong: the arcs' order is
 * the fold in `assemble/relationships.ts`, fixed before the emitter sees them.
 */
const NO_SEQUENCE = new Set(["RELATIONSHIPS"]);

/**
 * The child sequence for the container at `path`, or null when it has none.
 *
 * Three lookups, in order, and each is reading the generated table rather than
 * guessing at it. The XPath first, because `SUBJECT_PROPERTY` is a `PROPERTY`
 * and its own name would find nothing. Then the element name, for the wrappers
 * — `ASSETS`, `ROLES` — that carry no row of their own in the DU Map. Then the
 * extension envelope: the schema names the anonymous type inside an `EXTENSION`
 * after the container that owns it, so the `EXTENSION` under `ASSET_DETAIL` is
 * `ASSET_DETAIL_EXTENSION` and the `OTHER` inside that is
 * `ASSET_DETAIL_EXTENSION/OTHER`.
 */
function orderFor(path: string, ancestry: readonly string[]): readonly string[] | null {
  const byPath = TYPE_FOR_PATH[path];
  if (byPath && CHILD_ORDER[byPath]) return CHILD_ORDER[byPath];

  const name = ancestry[ancestry.length - 1]!;
  const byName = CHILD_ORDER[name];
  if (byName) return byName;

  if (name === "EXTENSION" || name === "OTHER") {
    const ownerIndex = ancestry.length - (name === "EXTENSION" ? 2 : 3);
    const owner = ancestry[ownerIndex];
    if (owner) {
      const ownerType = TYPE_FOR_PATH[ancestry.slice(0, ownerIndex + 1).join("/")] ?? owner;
      const key = name === "EXTENSION" ? `${ownerType}_EXTENSION` : `${ownerType}_EXTENSION/OTHER`;
      if (CHILD_ORDER[key]) return CHILD_ORDER[key];
    }
  }

  if (NO_SEQUENCE.has(name)) return null;

  throw new Error(
    `No child sequence for ${path}. generated/order.ts is read from the vendored schema ` +
      "chain, so a container it does not carry is one this document should not contain.",
  );
}

/**
 * The children, in schema order, with repeats kept in the order they were
 * assembled.
 *
 * Grouping by name and walking the sequence is what makes the sort stable
 * without being a sort: eleven `ASSET`s under one `ASSETS` come out in the
 * order `assemble/assets.ts` put them, which is the `(created_at, id)` order
 * that every label and every `SequenceNumber` is assigned over.
 */
function inSchemaOrder(children: readonly DuNode[], sequence: readonly string[]): DuNode[] {
  const byName = new Map<string, DuNode[]>();
  for (const child of children) {
    const group = byName.get(child.name);
    if (group) group.push(child);
    else byName.set(child.name, [child]);
  }
  const ordered: DuNode[] = [];
  for (const name of sequence) {
    const group = byName.get(name);
    if (!group) continue;
    ordered.push(...group);
    byName.delete(name);
  }
  const unknown = [...byName.keys()];
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.join(", ")} ${unknown.length === 1 ? "is not a child" : "are not children"} ` +
        `the schema sequence admits here: ${sequence.join(", ")}.`,
    );
  }
  return ordered;
}

/**
 * The five characters XML reserves, in the two places they can appear.
 *
 * Attribute values are escaped for the quote as well, because a holder name
 * with an apostrophe in it is ordinary and a double quote in one is not
 * unthinkable.
 */
function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function renderAttributes(attributes: Readonly<Record<string, string>> | undefined): string {
  if (!attributes) return "";
  return Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
}

function write(node: DuNode, ancestry: readonly string[], depth: number, out: string[]): void {
  const indent = "\t".repeat(depth);
  const attributes = renderAttributes(node.attributes);

  if (node.value !== undefined) {
    out.push(`${indent}<${node.name}${attributes}>${escapeText(node.value)}</${node.name}>`);
    return;
  }

  const children = node.children ?? [];
  if (children.length === 0) {
    out.push(`${indent}<${node.name}${attributes}/>`);
    return;
  }

  const path = ancestry.join("/");
  const sequence = orderFor(path, ancestry);
  const ordered = sequence ? inSchemaOrder(children, sequence) : [...children];

  out.push(`${indent}<${node.name}${attributes}>`);
  for (const child of ordered) write(child, [...ancestry, child.name], depth + 1, out);
  out.push(`${indent}</${node.name}>`);
}

/**
 * A tree, as the bytes that go on the wire.
 *
 * Tab indentation and a trailing newline, both matching the eighteen vendored
 * samples — not because either is required, but because a submission somebody
 * has to read beside one of Fannie Mae's should not differ from it in ways that
 * are not about the data.
 */
export function emitDocument(root: DuNode): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  write(root, [root.name], 0, out);
  return `${out.join("\n")}\n`;
}
