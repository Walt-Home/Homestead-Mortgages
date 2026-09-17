/**
 * What the assessor record says about the building, in the two columns a DU
 * submission reads.
 *
 * Both are retrieved rather than asked, because both describe a building and
 * the county is who holds them. Neither is defaulted: an address no vendor
 * answers for writes nothing here, the columns stay null, and the preflight
 * refuses the casefile — which is a refusal we own, where a 1 and a `Detached`
 * would be an invented fact on a federal submission.
 *
 * A unit count outside one to four is kept OUT of the column rather than
 * clipped into it. Five units is a commercial loan this product does not
 * underwrite, `loan_files_financed_unit_count_is_one_to_four` refuses the row,
 * and a file left with no unit count is refused later by name — where a 4
 * standing in for a 12 would not be.
 *
 * A service rather than a piece of the route, because the sample borrowers
 * walk the same lookup: a seed that recorded the county's snapshot and left
 * these two columns null produced eight files the preflight refused by name.
 */

import type { DuAttachmentType } from "@hm/db";
import type { PropertyRecord } from "@hm/shared";
import type { Db } from "./db.js";

const ATTACHMENT: Readonly<Record<PropertyRecord["attachment"], DuAttachmentType>> = {
  attached: "Attached",
  detached: "Detached",
};

export function buildingFacts(record: PropertyRecord) {
  const attachment: DuAttachmentType | undefined = ATTACHMENT[record.attachment];
  if (!attachment) {
    throw new Error(
      `${JSON.stringify(record.attachment)} is not an attachment this route can name. Add it ` +
        "to ATTACHMENT; do not leave the column as it was.",
    );
  }
  return {
    financedUnitCount: record.units >= 1 && record.units <= 4 ? record.units : null,
    propertyAttachmentType: attachment,
  };
}

/** Write the two facts off the record, and nothing off anything the client sent. */
export async function recordBuildingFacts(
  db: Db,
  loanFileId: string,
  record: PropertyRecord,
): Promise<void> {
  await db.loanFile.update({ where: { id: loanFileId }, data: buildingFacts(record) });
}
