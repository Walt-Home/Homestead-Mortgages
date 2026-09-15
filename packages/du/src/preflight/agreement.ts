/**
 * The two figures a casefile states twice, and has to state the same way.
 *
 * **An owned property's lien balance is the total of the liens against it, and
 * there is no single-lien qualifier.** The qualifier was the bug: the
 * specification defines the figure as the total of all remaining mortgages and
 * liens against the property, one shipped sample sums two liens to 206,514.00
 * and three more sum two to 420,306.00, and checking only the single-lien case
 * left the multi-lien shape — the one the asset-to-liability arc exists to
 * express — with no check anywhere. The database derives the column from the
 * liabilities on both sides of that relationship, so a hand-written wrong total
 * is overwritten rather than accepted; this is the same promise read off the
 * bytes, against a serializer that might have read a column no trigger
 * maintained.
 *
 * **The borrower count is checked only where it is written.** Eight of the
 * eighteen shipped samples — every FHA file and every VA file — carry no
 * `BorrowerCount` at all, so a check that required one would refuse casefiles
 * Fannie Mae ships. It is checked against the subject loan alone: a related
 * loan is one the borrower already owes, and how many people are on it says
 * nothing about how many are asking for this one.
 */

import { DU_ARCROLES } from "../generated/arcroles.js";
import { subjectLoans } from "./cardinality.js";
import { ASSET, BORROWER, LIABILITY_DETAIL, LOAN_DETAIL, OWNED_PROPERTY_DETAIL } from "./paths.js";
import type { Findings } from "./report.js";
import { valueOf, type DuInstance, type DuTree } from "./tree.js";

const SECURES = DU_ARCROLES["ASSET_IsAssociatedWith_LIABILITY"]!.arcrole;

/** An amount as cents, or null when it is not written as one. */
function cents(value: string | undefined): bigint | null {
  if (value === undefined || !/^-?\d+\.\d{2}$/.test(value)) return null;
  return BigInt(value.replace(".", ""));
}

/** The amount, as the two-place decimal the casefile writes. */
function asAmount(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  return `${negative ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n)
    .toString()
    .padStart(2, "0")}`;
}

function liensAgainst(asset: DuInstance, tree: DuTree): DuInstance[] {
  const secured = tree.arcs
    .filter((arc) => arc.arcrole === SECURES && arc.from === asset.label && arc.to !== undefined)
    .map((arc) => tree.labels.get(arc.to!))
    .filter((instance): instance is DuInstance => instance !== undefined);
  return secured.flatMap((liability) => tree.within(liability, LIABILITY_DETAIL));
}

export function checkAgreement(tree: DuTree, findings: Findings): void {
  for (const asset of tree.at(ASSET)) {
    for (const property of tree.within(asset, OWNED_PROPERTY_DETAIL)) {
      const stated = cents(valueOf(property, "OwnedPropertyLienUPBAmount"));
      if (stated === null) continue;
      const liens = liensAgainst(asset, tree);
      let total = 0n;
      for (const lien of liens) total += cents(valueOf(lien, "LiabilityUnpaidBalanceAmount")) ?? 0n;
      if (total === stated) continue;
      findings.add(
        "derived-figure-disagrees",
        `${asset.label ?? asset.path} -> OwnedPropertyLienUPBAmount`,
        `States ${asAmount(stated)} against ${liens.length} ` +
          `${liens.length === 1 ? "lien" : "liens"} totaling ${asAmount(total)}. The figure is ` +
          "the total of every remaining mortgage and lien against the property.",
      );
    }
  }

  const borrowers = tree.at(BORROWER).length;
  for (const loan of subjectLoans(tree)) {
    for (const detail of tree.within(loan, LOAN_DETAIL)) {
      const stated = valueOf(detail, "BorrowerCount");
      if (stated === undefined) continue;
      if (Number(stated) === borrowers) continue;
      findings.add(
        "derived-figure-disagrees",
        `${LOAN_DETAIL}#BorrowerCount`,
        `States ${stated} borrowers against ${borrowers} in the casefile.`,
      );
    }
  }
}
