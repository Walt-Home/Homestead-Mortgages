/**
 * Dollars in and out of the new tables.
 *
 * The legacy loan_files columns are Decimal(14,2); a loan scenario stores
 * bigint cents, because a money column that can hold a fraction of a cent is
 * a rounding argument waiting to happen. These are the only two conversions,
 * and every view converts at the boundary: no bigint ever reaches `res.json`,
 * which throws on one.
 */

import type { Prisma } from "@hm/db";

export const toCents = (n: number | Prisma.Decimal): bigint => BigInt(Math.round(Number(n) * 100));

export const fromCents = (c: bigint): number => Number(c) / 100;
