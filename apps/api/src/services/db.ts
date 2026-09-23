/**
 * The client a service writes through.
 *
 * Every service that writes takes one of these as its LAST parameter, with the
 * global client as the default. A route that has opened a transaction passes
 * it in, and the service's writes land inside the route's boundary — the
 * borrower row and the ledger row commit together or not at all. A caller
 * with no transaction passes nothing and gets the behavior it always had.
 *
 * Prisma cannot nest interactive transactions, so a service that opens its
 * own must first know whether it was handed one. Identity is the test: the
 * global client IS the "no transaction" case. A structural check (`"$transaction"
 * in db`) would be wrong in the other direction, because a transaction client
 * is the global client with that method removed, and a future extension could
 * put it back.
 */

import { prisma } from "@hm/db";
import type { Prisma } from "@hm/db";

export type Db = Prisma.TransactionClient;

/** True when the caller passed no transaction and this call may open one. */
export const ownsTransaction = (db: Db): boolean => db === (prisma as unknown as Db);

/** Rows per `createMany`: well inside Postgres's 65,535 bound parameters at thirty columns. */
export const CREATE_MANY_CHUNK = 500;

/**
 * Write a large set in chunks, in order. A servicer's book is thousands of
 * rows, and one statement per row inside one transaction is minutes; one
 * statement per five hundred is seconds.
 */
export async function inChunks<T>(
  rows: readonly T[],
  write: (chunk: T[], offset: number) => Promise<unknown>,
  size = CREATE_MANY_CHUNK,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await write(rows.slice(i, i + size), i);
  }
}
