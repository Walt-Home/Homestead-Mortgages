/**
 * The eighteen vendored submissions, as trees.
 *
 * A scanner rather than an XML library, for the reason `build-du.mjs` gives for
 * the same decision: nothing here needs a document object, and adding a parser
 * to the dependency tree to read eighteen files would be the tail wagging the
 * dog. Comments are stripped first, because a `<TAG>` inside one would unbalance
 * the stack.
 *
 * `.mjs` rather than `.ts` because the modeled set and the path-predicate rule
 * live in `scripts/build-du.mjs`, which has no declarations: the round trip has
 * to read the same `MODELED_CHILDREN` the inventory was subtracted from, and
 * re-typing it here would be a second copy to get wrong.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const SAMPLES_DIR = resolve(HERE, "../../../../du-schema/samples");
export const INVENTORY_FILE = resolve(HERE, "../../../../du-schema/du-not-round-tripped.txt");

/**
 * The entry point of the chain: the wrapper, not `MISMO_3.4.0_B324.xsd`.
 *
 * The wrapper is what redefines fourteen MISMO extension types into their DU
 * forms, and validating against MISMO alone accepts a document DU would reject.
 */
const DU_WRAPPER_XSD = resolve(HERE, "../../../../du-schema/xsd/DU_Wrapper_3.4.0_B324.xsd");

/**
 * What `xmllint` says about a document we wrote.
 *
 * It THROWS when `xmllint` is missing rather than reporting success, the same
 * way the vendored package's own validator does: a green tick for a check that
 * did not run is worse than no check at all.
 */
export function xmllintErrors(xml) {
  const directory = mkdtempSync(join(tmpdir(), "hm-du-"));
  const file = join(directory, "emitted.xml");
  try {
    writeFileSync(file, xml);
    const run = spawnSync("xmllint", ["--noout", "--schema", DU_WRAPPER_XSD, file], {
      encoding: "utf8",
    });
    if (run.error) {
      throw new Error(
        `xmllint could not be run (${run.error.message}). Install libxml2 rather than ` +
          "letting this check pass by not happening.",
      );
    }
    if (run.status === 0) return [];
    return (run.stderr ?? "")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.replace(file, "emitted.xml"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The one attribute that is part of a path, and why: see `PATH_PREDICATES`. */
const PATH_PREDICATES = { LOAN: "LoanRoleType" };

const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|[^>"])*)>/g;

/**
 * One element. `children` and `text` are exclusive in this corpus: MISMO
 * carries no mixed content, so a node either holds elements or holds a value.
 */
function node(name, attributes) {
  return { name, attributes, children: [], text: "" };
}

/**
 * The five named entities, decoded on the way in.
 *
 * Five occurrences of `&amp;` across the eighteen — a holder name with an
 * ampersand in it. Left encoded, the emitter would escape the escape and the
 * round trip would report a difference it invented itself.
 */
function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function readAttributes(rest) {
  const attributes = {};
  for (const match of rest.matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1]] = decodeEntities(match[2]);
  }
  return attributes;
}

export function parseSample(xml) {
  const source = xml.replace(/<!--[\s\S]*?-->/g, "");
  const root = node("#document", {});
  const stack = [root];
  let cursor = 0;
  let match;

  while ((match = TAG.exec(source))) {
    const [whole, closing, name, rest] = match;
    if (name.startsWith("?") || whole.startsWith("<?")) {
      cursor = TAG.lastIndex;
      continue;
    }
    const between = source.slice(cursor, match.index);
    cursor = TAG.lastIndex;
    const parent = stack[stack.length - 1];
    if (between.trim() !== "") parent.text += decodeEntities(between.trim());

    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== name) {
        throw new Error(`closes ${name} inside ${open ? open.name : "nothing"}`);
      }
      continue;
    }
    const element = node(name, readAttributes(rest));
    parent.children.push(element);
    if (!rest.trimEnd().endsWith("/")) stack.push(element);
  }

  if (stack.length !== 1) throw new Error("document does not close every element");
  const document = root.children.find((child) => child.name === "MESSAGE");
  if (!document) throw new Error("no MESSAGE element");
  return document;
}

/** The eighteen, by file name, so a failure names the sample it came from. */
export function readSamples() {
  return readdirSync(SAMPLES_DIR)
    .filter((name) => name.endsWith(".xml"))
    .sort()
    .map((name) => ({ name, xml: readFileSync(join(SAMPLES_DIR, name), "utf8") }));
}

/** The element path of a node, with the one attribute that belongs in a path. */
export function segmentOf(element) {
  const attribute = PATH_PREDICATES[element.name];
  if (!attribute) return element.name;
  const value = element.attributes[attribute];
  if (value === undefined) {
    throw new Error(`${element.name} has no ${attribute}, and that is what says which one it is.`);
  }
  return `${element.name}[@${attribute}="${value}"]`;
}

/** Every element path a parsed sample carries. */
export function pathsIn(element, prefix = "", into = new Set()) {
  const path = prefix === "" ? segmentOf(element) : `${prefix}/${segmentOf(element)}`;
  into.add(path);
  for (const child of element.children) pathsIn(child, path, into);
  return into;
}

/**
 * The sample, reduced to the elements this model claims.
 *
 * A path that is not modeled takes its subtree with it, which is what makes the
 * result something the emitter can be handed: a container the model does not
 * claim has no place in the sequence our order table would put its children in.
 */
export function keepModeled(element, modeled, prefix = "") {
  const path = prefix === "" ? segmentOf(element) : `${prefix}/${segmentOf(element)}`;
  if (!modeled.has(path)) return null;
  const kept = node(element.name, element.attributes);
  kept.text = element.text;
  for (const child of element.children) {
    const keptChild = keepModeled(child, modeled, path);
    if (keptChild) kept.children.push(keptChild);
  }
  return kept;
}

/** A parsed tree in the shape `emitDocument` takes. */
export function toDuNode(element) {
  if (element.children.length === 0 && element.text !== "") {
    return { name: element.name, attributes: element.attributes, value: element.text };
  }
  return {
    name: element.name,
    attributes: element.attributes,
    children: element.children.map(toDuNode),
  };
}

/**
 * Where each `xlink:label` sits, as a position rather than as a name.
 *
 * Labels are document-scoped names and Fannie Mae's own files disagree about
 * how they are formed — `DI-C09` writes `<LIABILITY SequenceNumber="4"
 * xlink:label="LIABILITY_3">` while `DI-C02` tracks them — so comparing the
 * strings would compare a naming convention. What an arc MEANS is which
 * container it points at, and that is the container's position among its own
 * kind in document order.
 */
export function labelPositions(element, counters = new Map(), into = new Map()) {
  const label = element.attributes["xlink:label"];
  if (label !== undefined) {
    const n = (counters.get(element.name) ?? 0) + 1;
    counters.set(element.name, n);
    into.set(label, `${element.name}#${n}`);
  }
  for (const child of element.children) labelPositions(child, counters, into);
  return into;
}

/**
 * A tree as comparable lines, in document order.
 *
 * Values verbatim, `SequenceNumber` verbatim, and every arc with both ends
 * resolved to a position. An arc whose label resolves to nothing is written as
 * the raw label, so a dangling end fails the comparison rather than
 * disappearing from it.
 */
export function project(element, positions, prefix = "", out = []) {
  const path = prefix === "" ? segmentOf(element) : `${prefix}/${segmentOf(element)}`;
  const parts = [path];
  if (element.attributes.SequenceNumber !== undefined) {
    parts.push(`SequenceNumber=${element.attributes.SequenceNumber}`);
  }
  if (element.name === "RELATIONSHIP") {
    const from = element.attributes["xlink:from"];
    const to = element.attributes["xlink:to"];
    parts.push(`from=${positions.get(from) ?? from}`);
    parts.push(`to=${positions.get(to) ?? to}`);
    parts.push(`arcrole=${element.attributes["xlink:arcrole"]}`);
  }
  if (element.children.length === 0 && element.text !== "") parts.push(`=${element.text}`);
  out.push(parts.join("\t"));
  for (const child of element.children) project(child, positions, path, out);
  return out;
}

/** The generated inventory, as the set of paths it lists. */
export function readInventory() {
  return new Set(
    readFileSync(INVENTORY_FILE, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.startsWith("#"))
      .map((line) => line.trim().split(/\s+/).slice(2).join(" ")),
  );
}
