/**
 * The tier that refuses to match, arriving where it was always going to bite.
 *
 * When two rows in one pull compute the same content key, that key identifies
 * neither of them, so both are written under a key that matches nothing and the
 * ambiguity is left for a person. Without this check that arrangement is
 * decoration: the two rows emit as two independent accounts, which is exactly
 * the double-count the old arrival-order tiebreak got approximately right.
 * Picking one by arrival order is the thing that stopped; refusing is what
 * replaced it.
 *
 * **What the failure can name, and what it cannot.** The key the rows collided
 * on is not stored — the row keeps the unmatchable key it was given, not the one
 * it lost — so the report names the table, the row, and the pull that last
 * reported it, which is what a person needs to open that report and see which
 * two accounts are in question. Naming the collision itself would need a column
 * to hold it.
 *
 * **It is a refusal and not a warning.** The two readings of an ambiguous pair
 * differ by a whole account's balance. The same answer covers the joint account
 * reported on two borrowers' pulls: collapsing those into one row with two
 * owners needs a vendor saying they are one account — a shared item identifier,
 * not a matching mask — and no adapter here exposes one.
 */

import { UNMATCHED_PREFIX } from "../identity.js";
import type { Findings } from "./report.js";

/** One live row on the application, as much of it as this check reads. */
export interface DuIdentityRow {
  /** The table it came from, so a row id can be looked up. */
  readonly table: "du_assets" | "du_liabilities";
  readonly id: string;
  readonly identityKey: string;
  /** The pull that last reported it, and null for a row a person typed. */
  readonly lastSeenSnapshotId: string | null;
}

export function checkMatching(rows: readonly DuIdentityRow[], findings: Findings): void {
  for (const row of rows) {
    if (!row.identityKey.startsWith(UNMATCHED_PREFIX)) continue;
    const pull =
      row.lastSeenSnapshotId === null
        ? "no pull reports it"
        : `the pull that reported it is ${row.lastSeenSnapshotId}`;
    findings.add(
      "identity-unmatched",
      `${row.table} ${row.id}`,
      `Two rows in one pull looked alike enough that neither could be told from the other, so ` +
        `this one matches nothing and ${pull}. Emitting both would state two accounts where ` +
        "there may be one.",
    );
  }
}
