/**
 * Where each borrower sits in the submitted document.
 *
 * DU conveys a borrower's position by document order and label ordinal — no
 * element states it — so `application_parties.borrower_ordinal` is the only
 * place the position lives. One module holds that rule because the readers and
 * the writers have to name the SAME person: `loadLoanFile` sorts its borrowers
 * here, and every screen that writes one resolves "Borrower 1" here, so a file
 * cannot show one person's answers and save them onto another's row.
 *
 * Creation order is the fallback and nothing more. It agrees with document
 * order on every file that has only ever grown, which is why it survived this
 * long — but a borrower dropped and replaced fills the vacancy at their
 * ordinal and is the NEWEST row on the file, and there the two orders name
 * different people.
 */

import type { Prisma } from "@hm/db";
import type { Db } from "./db.js";

/**
 * Ordered by creation and then by id: two borrowers created in one transaction
 * can share a millisecond at TIMESTAMP(3), so the id breaks the tie — an
 * arbitrary rule, but a stable one, and an unordered read would make which
 * person a file is about depend on the planner.
 */
const CREATION_ORDER: Prisma.BorrowerOrderByWithRelationInput[] = [
  { createdAt: "asc" },
  { id: "asc" },
];

/** A party with no ordinal sorts after everybody who has one. */
const UNPOSITIONED = Number.MAX_SAFE_INTEGER;

/**
 * Where each party sits, by party id.
 *
 * Empty for a file with no application, and a party with no entry is on the
 * file without being on the credit request yet.
 */
export async function borrowerOrdinals(
  db: Db,
  loanFileId: string,
  partyIds: readonly string[],
): Promise<Map<string, number>> {
  if (partyIds.length === 0) return new Map();
  const rows = await db.applicationParty.findMany({
    where: {
      application: { loanFileId },
      partyId: { in: [...partyIds] },
      borrowerOrdinal: { not: null },
    },
    select: { partyId: true, borrowerOrdinal: true },
  });
  return new Map(rows.map((r) => [r.partyId, r.borrowerOrdinal!]));
}

/** Least ordinal first, creation order under it, exactly as `loadLoanFile` sorts. */
export function documentOrder<T extends { readonly partyId: string }>(
  inCreationOrder: readonly T[],
  ordinals: ReadonlyMap<string, number>,
): T[] {
  return [...inCreationOrder].sort(
    (a, b) => (ordinals.get(a.partyId) ?? UNPOSITIONED) - (ordinals.get(b.partyId) ?? UNPOSITIONED),
  );
}

/**
 * The borrower row whose request this file is — Borrower 1 as the submission
 * means it.
 *
 * This is `primaryBorrower` reached through the database rather than through a
 * projection, and it exists because the writers need it before there is a
 * projection to read. A screen that prefilled itself from the person at
 * ordinal 1 and then saved onto the oldest row was reading one person and
 * writing another; on a file whose ordinal 1 was refilled those are not the
 * same borrower, and the save landed on somebody who had not been asked.
 *
 * Null when nobody is on the file yet, which is a caller's to refuse: each of
 * them owes a different sentence for it.
 */
export async function primaryBorrowerRow(
  db: Db,
  loanFileId: string,
): Promise<{ id: string; partyId: string } | null> {
  const rows = await db.borrower.findMany({
    where: { loanFileId },
    orderBy: CREATION_ORDER,
    select: { id: true, partyId: true },
  });
  if (rows.length === 0) return null;
  const ordinals = await borrowerOrdinals(
    db,
    loanFileId,
    rows.map((r) => r.partyId),
  );
  return documentOrder(rows, ordinals)[0]!;
}
