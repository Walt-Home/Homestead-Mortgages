/**
 * The graph, which is the half of a submission the schema cannot see.
 *
 * A DU casefile is a flat set of labeled containers and a block of arcs between
 * them, and libxml2 accepts a dangling `xlink:to`, a duplicate `xlink:label`,
 * an invented arcrole URI and a document with the whole `RELATIONSHIPS` block
 * deleted. Each of those is a casefile that parses and says something nobody
 * meant: an asset owned by nobody, two containers answering to one name, an
 * association Fannie Mae has no rule for.
 *
 * **An arc that resolves is not yet an arc that means anything.** Both ends have
 * to be the container the arcrole is about: an `ASSET_IsAssociatedWith_ROLE`
 * pointing at a liability, or at the asset it left, resolves, carries a defined
 * arcrole and validates against the whole chain, and it still leaves the asset
 * belonging to nobody. So each end is compared against the element the
 * generated table puts there, and belonging to somebody means an arc out of the
 * container under an arcrole that starts at that container — not merely an arc.
 *
 * `SequenceNumber` is here too, for the same reason and not because it is an
 * arc: it is uniqueness among siblings and nothing else — it restarts under
 * each parent, gaps are legal and present in Fannie Mae's own files, and
 * nothing may derive it from a label or a label from it.
 */

import { DU_ARCROLES, type DuArcRoleEndpoint } from "../generated/arcroles.js";
import { ASSET, EXPENSE, LIABILITY } from "./paths.js";
import type { Findings } from "./report.js";
import type { DuTree } from "./tree.js";

/** The eleven arcs, by the URI an `xlink:arcrole` attribute spells. */
const ARCROLE_BY_URI = new Map(Object.values(DU_ARCROLES).map((entry) => [entry.arcrole, entry]));

/**
 * The element the specification puts at one end of an arc.
 *
 * The name and not the path, because the tab writes the role endpoints as
 * `DEAL/PARTIES/PARTY/ROLE` — eliding the plural container every document
 * actually carries — and one loan endpoint carries a typographic quote inside
 * its predicate. Anchoring either spelling literally would refuse all eighteen
 * shipped samples. The element name is the part every spelling agrees on, and
 * it is what separates a liability from a role.
 */
function elementAt(endpoint: DuArcRoleEndpoint): string {
  const last = endpoint.xpath.slice(endpoint.xpath.lastIndexOf("/") + 1);
  const predicate = last.indexOf("[");
  return predicate === -1 ? last : last.slice(0, predicate);
}

/**
 * The containers an arc must leave.
 *
 * An asset, a liability or an expense with no arc out of it belongs to nobody:
 * DU reads ownership off the graph, so a row that reaches the wire unarced is
 * a balance in the casefile that no borrower is asked about. The database
 * already refuses a COMMIT that leaves one ownerless, and this is the same
 * promise checked where the bytes are, against a serializer that might have
 * dropped the arc rather than the row.
 */
const MUST_BE_A_SOURCE = [ASSET, LIABILITY, EXPENSE];

export function checkGraph(tree: DuTree, findings: Findings): void {
  const seen = new Set<string>();
  for (const instance of tree.instances) {
    if (instance.label === null) continue;
    if (seen.has(instance.label)) {
      findings.add(
        "label-not-unique",
        instance.label,
        `${instance.path} carries a label another container already answers to, so every arc ` +
          "naming it points at both.",
      );
    }
    seen.add(instance.label);
  }

  // Keyed on the element the arcrole starts at, so that an asset is asked for
  // an arc that an asset is allowed to make rather than for any arc at all.
  const sources = new Map<string, Set<string>>();
  for (const arc of tree.arcs) {
    for (const [end, label] of [
      ["xlink:from", arc.from],
      ["xlink:to", arc.to],
    ] as const) {
      if (label === undefined || !tree.labels.has(label)) {
        findings.add(
          "arc-endpoint-unresolved",
          arc.instance.path,
          `An arc's ${end} names ${label === undefined ? "nothing" : label}, which no container ` +
            "in this document declares.",
        );
      }
    }
    const arcrole = arc.arcrole === undefined ? undefined : ARCROLE_BY_URI.get(arc.arcrole);
    if (!arcrole) {
      findings.add(
        "arcrole-unknown",
        arc.instance.path,
        "An arc carries an arcrole that is not one of the eleven the specification names. " +
          "Desktop Underwriter has no rule for an association it does not define.",
      );
      continue;
    }
    if (arc.from !== undefined) {
      const kind = elementAt(arcrole.from);
      const held = sources.get(kind) ?? new Set<string>();
      held.add(arc.from);
      sources.set(kind, held);
    }
    for (const [end, label, endpoint] of [
      ["xlink:from", arc.from, arcrole.from],
      ["xlink:to", arc.to, arcrole.to],
    ] as const) {
      // A disputed endpoint is one the tab names two ways, and the generated
      // table declares that rather than picking a winner. Neither does this.
      if (endpoint.disputed) continue;
      const instance = label === undefined ? undefined : tree.labels.get(label);
      if (!instance) continue;
      const wanted = elementAt(endpoint);
      if (instance.node.name === wanted) continue;
      findings.add(
        "arc-endpoint-wrong-container",
        arc.instance.path,
        `${arcrole.name} puts a ${wanted} at its ${end} and this one lands on a ` +
          `${instance.node.name}. An arc between the wrong containers resolves, validates and ` +
          "associates nothing Desktop Underwriter has a rule for.",
      );
    }
  }

  for (const path of MUST_BE_A_SOURCE) {
    const kind = path.slice(path.lastIndexOf("/") + 1);
    for (const instance of tree.at(path)) {
      if (instance.label !== null && (sources.get(kind)?.has(instance.label) ?? false)) continue;
      findings.add(
        "container-has-no-arc",
        instance.label ?? instance.path,
        `${instance.path} is the source of no arc, so nothing in the casefile says whose it is.`,
      );
    }
  }

  for (const instance of tree.instances) {
    const children = instance.node.children ?? [];
    const numbers = new Map<string, Set<string>>();
    for (const child of children) {
      const sequence = child.attributes?.SequenceNumber;
      if (sequence === undefined) continue;
      const held = numbers.get(child.name) ?? new Set<string>();
      if (held.has(sequence)) {
        findings.add(
          "sequence-number-not-unique",
          `${instance.path}/${child.name}`,
          `Two ${child.name} elements under one parent share SequenceNumber ${sequence}, which ` +
            "is the one thing that number is for.",
        );
      }
      held.add(sequence);
      numbers.set(child.name, held);
    }
  }
}
