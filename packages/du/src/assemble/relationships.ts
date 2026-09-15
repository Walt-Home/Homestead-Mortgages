/**
 * The graph, folded out of the join tables.
 *
 * A DU submission is not a nested document with an `ASSET` inside a
 * `BORROWER`. It is a flat set of containers each carrying an `xlink:label`,
 * plus this block, whose elements arc between those labels by arcrole URI. That
 * is the whole reason ownership is a join table here rather than a column: an
 * asset can have more than one owner, and a second owner is a second arc.
 *
 * **Each source's within-source order is fixed, because "a fixed order" was an
 * intention and not a specification.** `SequenceNumber` is assigned 1..N over
 * the concatenation of the sources below, in the order they appear here, and
 * within each source by the emission order of the row the arc leaves and then
 * by the position of the role it arrives at. Without that, one asset with two
 * owners can swap `SequenceNumber` 2 and 3 between two emissions of identical
 * data — diff noise on every resubmission, and a counterexample to the
 * byte-identity claim for this whole block.
 *
 * A `RELATIONSHIP` is an empty element carrying only `SequenceNumber`,
 * `xlink:from`, `xlink:to` and `xlink:arcrole`. There is nowhere on an arc to
 * record an ownership share, an as-of date or a primary flag, which is why none
 * of those has a column.
 *
 * **`DU:UNDERWRITING_VERIFICATION` and its arc are not here.** One verification
 * per report type per party, taken from the latest non-retired snapshot, is a
 * selection rule with a cardinality maximum riding on it, and it lands with the
 * container it points at.
 */

import { attributesOnly, container, type DuNode } from "../document.js";
import { DU_ARCROLES } from "../generated/arcroles.js";
import type { DuLabelIndex } from "../labels.js";
import { employerKey } from "../labels.js";
import { renderCount } from "../values.js";
import type {
  LoadedApplication,
  LoadedAsset,
  LoadedExpense,
  LoadedIncome,
  LoadedLiability,
} from "./load.js";

/** One arc, before it has a sequence number. */
interface Arc {
  readonly from: string;
  readonly to: string;
  readonly arcrole: string;
}

function arcrole(name: string): string {
  const entry = DU_ARCROLES[name];
  if (!entry) throw new Error(`${name} is not an arcrole the generated table carries.`);
  return entry.arcrole;
}

export interface RelationshipsInput {
  readonly application: LoadedApplication;
  readonly assets: readonly LoadedAsset[];
  readonly liabilities: readonly LoadedLiability[];
  readonly expenses: readonly LoadedExpense[];
  readonly income: readonly LoadedIncome[];
  readonly index: DuLabelIndex;
}

export function buildRelationships(input: RelationshipsInput): DuNode | null {
  const { index } = input;
  const arcs: Arc[] = [];

  // Where each borrowing edge's ROLE sits in the document, which is what orders
  // the arcs OUT OF one row.
  //
  // Not the join row's own `(created_at, id)`: `writeAsset` inserts an asset's
  // owner arcs in one statement, so they share a timestamp to the millisecond
  // and the tie falls to a random uuid. That is total and reproducible and it
  // is also arbitrary — one asset's two owners would come out in an order
  // nothing in the document explains, and the pair would read differently on
  // two applications holding the same facts. The endpoint's position is
  // already fixed by `borrower_ordinal`, so using it makes the block read down
  // the document.
  const rolePosition = new Map(
    [...index.roleByApplicationParty.keys()].map((id, position) => [id, position]),
  );
  const byRolePosition = (
    a: { applicationPartyId: string },
    b: { applicationPartyId: string },
  ): number =>
    (rolePosition.get(a.applicationPartyId) ?? Number.MAX_SAFE_INTEGER) -
    (rolePosition.get(b.applicationPartyId) ?? Number.MAX_SAFE_INTEGER);

  // An endpoint with no label is an endpoint whose container is not in this
  // document. The arc is dropped rather than written dangling: a dangling
  // `xlink:to` validates against the whole nine-file chain and means nothing,
  // which is the worst of the two failures. Refusing to emit at all is the
  // preflight's, one commit along.
  const arc = (from: string | undefined, to: string | undefined, name: string): void => {
    if (from === undefined || to === undefined) return;
    arcs.push({ from, to, arcrole: arcrole(name) });
  };

  for (const asset of input.assets) {
    for (const owner of [...asset.owners].sort(byRolePosition)) {
      arc(
        index.assetByRow.get(asset.id),
        index.roleByApplicationParty.get(owner.applicationPartyId),
        "ASSET_IsAssociatedWith_ROLE",
      );
    }
  }

  for (const liability of input.liabilities) {
    for (const obligor of [...liability.obligors].sort(byRolePosition)) {
      arc(
        index.liabilityByRow.get(liability.id),
        index.roleByApplicationParty.get(obligor.applicationPartyId),
        "LIABILITY_IsAssociatedWith_ROLE",
      );
    }
  }

  for (const expense of input.expenses) {
    for (const payer of [...expense.payers].sort(byRolePosition)) {
      arc(
        index.expenseByRow.get(expense.id),
        index.roleByApplicationParty.get(payer.applicationPartyId),
        "EXPENSE_IsAssociatedWith_ROLE",
      );
    }
  }

  // The one arc that is a foreign key rather than a join table, and it points
  // the other way: the column is on the liability, the arc runs from the asset.
  // One property carrying a first mortgage and a HELOC is two arcs out of one
  // asset, which is the shape the key was chosen to express.
  for (const liability of input.liabilities) {
    if (liability.securedByOwnedPropertyId === null) continue;
    arc(
      index.assetByOwnedProperty.get(liability.securedByOwnedPropertyId),
      index.liabilityByRow.get(liability.id),
      "ASSET_IsAssociatedWith_LIABILITY",
    );
  }

  // Emitted only where the row is employment income, which a CHECK ties to the
  // row naming an employer — so the indicator DU reads and the arc DU reads
  // cannot disagree.
  for (const income of input.income) {
    if (!income.employmentIncome || income.employerId === null) continue;
    arc(
      index.incomeItemByRow.get(income.id),
      index.employerByPartyAndEmployer.get(employerKey(income.partyId, income.employerId)),
      "CURRENT_INCOME_ITEM_IsAssociatedWith_EMPLOYER",
    );
  }

  // `from` is the additional borrower and `to` is the group's primary.
  // Reversing it makes DU read the wrong borrower as primary.
  for (const link of input.application.jointCredit) {
    arc(
      index.roleByApplicationParty.get(link.fromApplicationPartyId),
      index.roleByApplicationParty.get(link.toApplicationPartyId),
      "ROLE_SharesJointCreditReportWith_ROLE",
    );
  }

  return container(
    "RELATIONSHIPS",
    arcs.map((entry, position) =>
      attributesOnly("RELATIONSHIP", {
        SequenceNumber: renderCount(position + 1),
        "xlink:from": entry.from,
        "xlink:to": entry.to,
        "xlink:arcrole": entry.arcrole,
      }),
    ),
    { "xsi:type": "RELATIONSHIPS" },
  );
}
