/**
 * One writer to a servicer's book at a time.
 *
 * A load, a tape taken back, a renumbering, a claim minted and a month
 * closed each read the book and then write on what they read: a load finds
 * the loans it will update, a removal decides which loans only its tape
 * carries, a close meters the loans on the book. Read at READ COMMITTED
 * beside another of them, each can act on a book that is no longer there —
 * a removal deleting a loan a load has just observed, two removals each
 * leaving a loan the other was counting on, a statement billing loans a
 * removal then takes away. So each takes this lock first, inside its own
 * transaction, and the next waits until the first commits and then reads
 * the book as it left it.
 *
 * A transaction-scoped advisory lock keyed on the servicer: it takes no row
 * lock, so nothing else that touches the servicer's row waits on it, and it
 * is released with the transaction whichever way that ends. Taken twice in
 * one transaction it is held once more, never waited on.
 */

import type { Db } from "./db.js";

/** Hold the servicer's book for the rest of this transaction. Call it inside one. */
export async function lockBook(tx: Db, servicerId: string): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext('partner-book'), hashtext(${servicerId}::text))`;
}
