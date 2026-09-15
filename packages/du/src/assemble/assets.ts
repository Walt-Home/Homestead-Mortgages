/**
 * `ASSETS`, all four kinds, and the owned property that is the fourth.
 *
 * One XML container, one label space and one `SequenceNumber` space across the
 * four kinds, which is why `du_assets.kind` is a column rather than four
 * tables — and why the label allocator is per container and not per table.
 *
 * An `OWNED_PROPERTY` asset carries no `ASSET_DETAIL` and no `AssetType` at
 * all. A CHECK makes that true in the database; the XSD would have accepted
 * both together, which is the difference between an invariant and a hope.
 */

import { compact, container, leaf, type DuNode } from "../document.js";
import type { DuLabelIndex, DuLabels } from "../labels.js";
import { renderAmount, renderCount, renderIndicator } from "../values.js";
import { addressNode, subjectAddressFields } from "./collateral.js";
import type { LoadedApplication, LoadedAsset } from "./load.js";

/**
 * The owned property's own address, or the subject's.
 *
 * A row that wants to differ from the subject record fills all four columns;
 * one that does not fills none and reads back the subject property, which is
 * what `OwnedPropertySubjectIndicator` being true means in the first place. A
 * non-subject REO always carries its own.
 */
function ownedPropertyAddress(
  property: NonNullable<LoadedAsset["ownedProperty"]>,
  application: LoadedApplication,
): DuNode | null {
  if (property.addressLineText !== null) return addressNode(property);
  if (!property.isSubject) return null;
  return addressNode(subjectAddressFields(application));
}

function ownedProperty(
  property: NonNullable<LoadedAsset["ownedProperty"]>,
  application: LoadedApplication,
): DuNode | null {
  const detail = container(
    "OWNED_PROPERTY_DETAIL",
    compact([
      leaf("OwnedPropertyDispositionStatusType", property.dispositionStatus),
      // The TOTAL of every live lien pointing at this row, not the balance of
      // any one of them. The database derives it from `du_liabilities` on every
      // write, so a credit re-pull that finds a second lien moves the figure
      // without anybody writing it, and nothing here re-adds it up.
      property.lienUpbCents === null
        ? null
        : leaf("OwnedPropertyLienUPBAmount", renderAmount(property.lienUpbCents)),
      property.maintenanceExpenseCents === null
        ? null
        : leaf(
            "OwnedPropertyMaintenanceExpenseAmount",
            renderAmount(property.maintenanceExpenseCents),
          ),
      property.rentalIncomeGrossCents === null
        ? null
        : leaf(
            "OwnedPropertyRentalIncomeGrossAmount",
            renderAmount(property.rentalIncomeGrossCents),
          ),
      // Signed: a rental property that loses money reports a negative net, and
      // DI-C08's ASSET_7 emits -678.00.
      property.rentalIncomeNetCents === null
        ? null
        : leaf("OwnedPropertyRentalIncomeNetAmount", renderAmount(property.rentalIncomeNetCents)),
      leaf("OwnedPropertySubjectIndicator", renderIndicator(property.isSubject)),
    ]),
  );

  const detailOfProperty = container(
    "PROPERTY_DETAIL",
    compact([
      leaf("PropertyCurrentUsageType", property.currentUsage),
      property.estimatedValueCents === null
        ? null
        : leaf("PropertyEstimatedValueAmount", renderAmount(property.estimatedValueCents)),
      leaf("PropertyUsageType", property.intendedUsage),
    ]),
  );

  return container("OWNED_PROPERTY", [
    detail,
    container("PROPERTY", [ownedPropertyAddress(property, application), detailOfProperty]),
  ]);
}

function assetDetail(asset: LoadedAsset): DuNode | null {
  const ulad =
    asset.includedInAssetAccount === null
      ? null
      : container("EXTENSION", [
          container("OTHER", [
            container("ULAD:ASSET_DETAIL_EXTENSION", [
              leaf(
                "ULAD:IncludedInAssetAccountIndicator",
                renderIndicator(asset.includedInAssetAccount),
              ),
            ]),
          ]),
        ]);

  return container(
    "ASSET_DETAIL",
    compact([
      leaf("AssetAccountIdentifier", asset.accountIdentifier),
      asset.cashOrMarketValueCents === null
        ? null
        : leaf("AssetCashOrMarketValueAmount", renderAmount(asset.cashOrMarketValueCents)),
      leaf("AssetType", asset.assetType),
      leaf("AssetTypeOtherDescription", asset.assetTypeOtherDescription),
      leaf("FundsSourceType", asset.fundsSourceType),
      ulad,
    ]),
  );
}

export function buildAssets(
  assets: readonly LoadedAsset[],
  application: LoadedApplication,
  labels: DuLabels,
  index: DuLabelIndex,
): DuNode | null {
  const nodes = assets.map((asset, position) => {
    const children = compact([
      assetDetail(asset),
      container("ASSET_HOLDER", [container("NAME", [leaf("FullName", asset.holderName)])]),
      asset.ownedProperty ? ownedProperty(asset.ownedProperty, application) : null,
    ]);
    // A label is minted for an element that will be written, never for one the
    // builders emptied: a minted-and-dropped label leaves a hole in the
    // numbering and an arc pointing at nothing.
    if (children.length === 0) {
      throw new Error(`du_assets ${asset.id} renders no element and cannot carry a label.`);
    }

    const label = labels.next("asset");
    index.assetByRow.set(asset.id, label);
    if (asset.ownedProperty) index.assetByOwnedProperty.set(asset.ownedProperty.id, label);

    return container(
      "ASSET",
      children,
      // Restarts at 1 under this parent, and is not the label's counter. In
      // DI-C09 a liability is SequenceNumber 4 and LIABILITY_3; never derive
      // one from the other.
      { SequenceNumber: renderCount(position + 1), "xlink:label": label },
    );
  });

  return container("ASSETS", nodes);
}
