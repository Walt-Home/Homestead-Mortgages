/**
 * The only shape that can write an asset, a liability or an expense.
 *
 * A live one of any of the three must carry at least one owner arc, and the
 * database says so with a constraint trigger deferred to COMMIT. Prisma's
 * default is a transaction per call, so `prisma.duAsset.create()` followed by
 * `prisma.duAssetParty.create()` fails at the first COMMIT — correctly, and
 * confusingly, because the row it names looks like one the caller just wrote
 * successfully.
 *
 * So the pairing is the signature. Each writer takes its row and its owners
 * together, takes a transaction client rather than the client, and refuses at
 * runtime to run outside a transaction. The owners array is non-empty in the
 * type, which is the same rule stated where a caller reads it.
 *
 * Nothing calls these yet. No route writes a DU row, and the adapters that
 * would turn a bank pull into an ASSET are not written.
 */

import type { Prisma } from "@hm/db";

/**
 * A transaction client. Prisma hands one of these to a `$transaction`
 * callback: the full client minus the methods that would open, extend or close
 * a connection.
 */
export type DuTransaction = Prisma.TransactionClient;

/** At least one, because zero is the state these writers exist to prevent. */
export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * An owner arc, named by the EDGE rather than by the person: the arc's endpoint
 * is the `ROLE` element, which is emitted from `application_parties`.
 *
 * `role` is ours. DU has exactly one notion here — the row belongs to this
 * borrower — and the column defaults to it, so a caller only says anything when
 * it has something to say.
 */
export interface DuOwner {
  readonly applicationPartyId: string;
  readonly role?: string;
}

/**
 * The row a re-pull is replacing, retired in the SAME transaction that writes
 * the replacement and its arcs.
 *
 * Split across two transactions the deferred check aborts the whole pull at
 * COMMIT, naming a row the connector thought it had just created. Taking the
 * superseded row here is what stops a caller expressing the half-done version.
 */
export interface DuSupersede {
  readonly id: string;
  readonly retiredBySnapshotId?: string | null;
  readonly retiredAt?: Date;
}

export interface WriteAssetInput {
  readonly asset: Prisma.DuAssetUncheckedCreateInput;
  readonly owners: NonEmpty<DuOwner>;
  readonly supersedes?: DuSupersede;
}

export interface WriteLiabilityInput {
  readonly liability: Prisma.DuLiabilityUncheckedCreateInput;
  readonly obligors: NonEmpty<DuOwner>;
  readonly supersedes?: DuSupersede;
}

/**
 * An expense takes no `supersedes`, and its absence is the point: `du_expenses`
 * has no `retired_at` column, because a person types an expense and no
 * connector supersedes one.
 */
export interface WriteExpenseInput {
  readonly expense: Prisma.DuExpenseUncheckedCreateInput;
  readonly payers: NonEmpty<DuOwner>;
}

/**
 * A client that can open a CONNECTION is not one that is inside a transaction.
 *
 * TypeScript will not catch the mistake on its own: `PrismaClient` has every
 * method a transaction client has, so it is structurally assignable to the
 * parameter type, and the resulting failure arrives from Postgres at the first
 * implicit COMMIT, about a row that appears to have been written.
 *
 * `$connect` is the discriminator rather than `$transaction`, which reads
 * better and is wrong: a transaction client carries `$transaction` too, because
 * Prisma lets a transaction nest one. `$connect` and `$extends` are the two it
 * does not carry, and connecting is the thing a client inside a transaction has
 * by definition already done.
 */
function assertInsideTransaction(tx: DuTransaction, writer: string): void {
  if (typeof (tx as { $connect?: unknown }).$connect === "function") {
    throw new Error(
      `${writer} must be called inside prisma.$transaction: the row and its owner ` +
        "arcs are checked together at COMMIT, and one statement per transaction " +
        "cannot satisfy that.",
    );
  }
}

/**
 * The owners, checked for the two ways an array can be wrong at runtime after
 * the type has been satisfied at a JavaScript call site or through a spread.
 */
function ownerRows(
  owners: NonEmpty<DuOwner>,
  writer: string,
): { applicationPartyId: string; role?: string }[] {
  if (owners.length === 0) {
    throw new Error(`${writer} needs at least one owner; a row with none cannot be emitted.`);
  }
  const seen = new Set<string>();
  return owners.map((owner) => {
    if (seen.has(owner.applicationPartyId)) {
      throw new Error(
        `${writer} was given ${owner.applicationPartyId} twice; one arc per borrower per row, ` +
          "and a second one is not a bigger share.",
      );
    }
    seen.add(owner.applicationPartyId);
    return {
      applicationPartyId: owner.applicationPartyId,
      ...(owner.role === undefined ? {} : { role: owner.role }),
    };
  });
}

function retirement(supersedes: DuSupersede): {
  retiredAt: Date;
  retiredBySnapshotId?: string | null;
} {
  return {
    retiredAt: supersedes.retiredAt ?? new Date(),
    ...(supersedes.retiredBySnapshotId === undefined
      ? {}
      : { retiredBySnapshotId: supersedes.retiredBySnapshotId }),
  };
}

/** Write an ASSET and the arcs that say whose it is. Returns the new row's id. */
export async function writeAsset(tx: DuTransaction, input: WriteAssetInput): Promise<string> {
  assertInsideTransaction(tx, "writeAsset");
  const owners = ownerRows(input.owners, "writeAsset");
  if (input.supersedes) {
    await tx.duAsset.update({
      where: { id: input.supersedes.id },
      data: retirement(input.supersedes),
    });
  }
  const asset = await tx.duAsset.create({ data: input.asset, select: { id: true } });
  await tx.duAssetParty.createMany({
    data: owners.map((owner) => ({ assetId: asset.id, ...owner })),
  });
  return asset.id;
}

/** Write a LIABILITY and the arcs that say who owes it. */
export async function writeLiability(
  tx: DuTransaction,
  input: WriteLiabilityInput,
): Promise<string> {
  assertInsideTransaction(tx, "writeLiability");
  const obligors = ownerRows(input.obligors, "writeLiability");
  if (input.supersedes) {
    await tx.duLiability.update({
      where: { id: input.supersedes.id },
      data: retirement(input.supersedes),
    });
  }
  const liability = await tx.duLiability.create({ data: input.liability, select: { id: true } });
  await tx.duLiabilityParty.createMany({
    data: obligors.map((obligor) => ({ liabilityId: liability.id, ...obligor })),
  });
  return liability.id;
}

/** Write an EXPENSE and the arcs that say who pays it. */
export async function writeExpense(tx: DuTransaction, input: WriteExpenseInput): Promise<string> {
  assertInsideTransaction(tx, "writeExpense");
  const payers = ownerRows(input.payers, "writeExpense");
  const expense = await tx.duExpense.create({ data: input.expense, select: { id: true } });
  await tx.duExpenseParty.createMany({
    data: payers.map((payer) => ({ expenseId: expense.id, ...payer })),
  });
  return expense.id;
}
