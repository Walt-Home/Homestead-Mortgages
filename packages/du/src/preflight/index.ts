/**
 * The gate. It refuses to emit.
 *
 * `xmllint` passing is a lint: the schema enforces element order, enumerated
 * values and boolean casing, and essentially nothing about what a casefile
 * MEANS. A dangling arc, a duplicate label, an invented arcrole, five borrowers
 * where four are allowed, a deleted `RELATIONSHIPS` block and a casefile with
 * no loan and no party all validate against the whole nine-file chain. This is
 * the thing that says no.
 *
 * **Where a refusal goes.** It is thrown to whoever asked for the document, and
 * that is an operator or a job — nothing renders it to a borrower. There is no
 * mailer here and nothing puts engine output in front of a person without a
 * decision behind it, and a preflight failure is not a decision: it says the
 * casefile could not be assembled correctly, which is a fact about this system
 * and not about the person applying. A finding names an XPath, a label or a row
 * id, and never a value, so it is safe in a log and useless to somebody
 * fishing.
 *
 * **Everything it finds is blocking.** A preflight that warned would be a
 * second lint, and the reason this exists is that the schema is not enough.
 */

import type { DuNode } from "../document.js";
import { checkAgreement } from "./agreement.js";
import { checkCardinality } from "./cardinality.js";
import { checkConditionality, checkRequired } from "./conditionality.js";
import { checkFormat } from "./format.js";
import { checkGraph } from "./graph.js";
import { checkMatching, type DuIdentityRow } from "./matching.js";
import { collectFindings, type DuPreflightFinding, type DuPreflightReport } from "./report.js";
import { indexTree } from "./tree.js";

export interface DuPreflightInput {
  /** The assembled casefile, before it is bytes. */
  readonly document: DuNode;
  /**
   * The live asset and liability rows the casefile was assembled from.
   *
   * Only their identity is read, and only to find the ones the matcher could
   * not tell apart — which is the one check that cannot be made from the
   * document, because an unmatchable key is a fact about the pull that produced
   * a row rather than anything the row emits.
   */
  readonly identities?: readonly DuIdentityRow[];
}

/**
 * Thrown instead of returning bytes.
 *
 * Its own class rather than a plain `Error` so a caller can tell "this casefile
 * is wrong" from "the assembler could not read a row", and so the findings
 * survive as data rather than only as a message somebody has to parse back.
 */
export class DuPreflightRefusal extends Error {
  readonly findings: readonly DuPreflightFinding[];

  constructor(findings: readonly DuPreflightFinding[]) {
    super(
      `Refusing to emit: ${findings.length} ${findings.length === 1 ? "thing" : "things"} ` +
        `Desktop Underwriter would reject or misread.\n${findings
          .map((finding) => `  ${finding.check} ${finding.where}: ${finding.message}`)
          .join("\n")}`,
    );
    this.name = "DuPreflightRefusal";
    this.findings = findings;
  }
}

export function runPreflight(input: DuPreflightInput): DuPreflightReport {
  const tree = indexTree(input.document);
  const findings = collectFindings();

  checkGraph(tree, findings);
  checkCardinality(tree, findings);
  checkRequired(tree, findings);
  checkConditionality(tree, findings);
  checkFormat(tree, findings);
  checkAgreement(tree, findings);
  checkMatching(input.identities ?? [], findings);

  return { ok: findings.found.length === 0, findings: findings.found };
}

export { CONDITIONAL_RULES, REQUIRED_RULES } from "./conditionality.js";
export { DU_SUBSET_AT, NOT_CHECKED_AGAINST_A_SUBSET } from "./enumerations.js";
export type { DuIdentityRow } from "./matching.js";
export type { DuPreflightCheck, DuPreflightFinding, DuPreflightReport } from "./report.js";
