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
 * An asset and a liability additionally have a second path — `matchOnIdentity`
 * — for a pull reporting a row it may have reported before. It is opt-in
 * rather than the default because "write this row" and "reconcile this row
 * against what we hold" are different intents, and a caller that meant the
 * first and silently got the second would overwrite a row it believed it was
 * creating. `identity.ts` is where the key that path matches on comes from.
 *
 * That path takes a lock, for a reason a single-threaded reading hides: look up
 * then insert is two statements, and two pulls of one account that interleave
 * between them both miss and both insert. The unique index refuses the second,
 * which is the important half — there is never a duplicate row — but it refuses
 * it by aborting a whole pull with a message naming an index, and a borrower
 * who double-clicked connect is the ordinary way to produce it. Retrying inside
 * the transaction is not available: a unique violation aborts the transaction
 * in Postgres, so every statement after it fails too. So the race is settled
 * before the lookup instead of discovered after the insert.
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

/**
 * The flag that turns a write into a re-pull.
 *
 * Set it and the writer looks the row up by `(application, identity key)` and
 * updates the one it finds instead of inserting beside it. That is the whole
 * point of the identity columns: a pull that can only insert a twin or delete
 * and recreate renumbers every `ASSET_n` on the wire, and a row that went away
 * and came back is one row rather than two.
 *
 * A retired row found this way is REVIVED rather than left alone, which is what
 * the unique index spanning retired rows exists to permit.
 *
 * It cannot be combined with `supersedes`: on this path the replacement IS the
 * row, so naming another row to retire as well says two different things about
 * what is being replaced.
 */
export interface MatchOnIdentity {
  readonly matchOnIdentity?: boolean;
  /**
   * Keys this row may already be stored under, tried in order after the one it
   * is being written with and only when that one finds nothing.
   *
   * `identity.ts` computes them, and there is one case: a provider that started
   * supplying item ids between two pulls, whose earlier pull wrote a content
   * key the new one no longer computes. A row found this way is MOVED onto the
   * key it was written with, once, rather than left answering to a content key
   * a later account at the same bank could also compute.
   */
  readonly priorIdentityKeys?: readonly string[];
}

export interface WriteAssetInput extends MatchOnIdentity {
  readonly asset: Prisma.DuAssetUncheckedCreateInput;
  readonly owners: NonEmpty<DuOwner>;
  readonly supersedes?: DuSupersede;
}

export interface WriteLiabilityInput extends MatchOnIdentity {
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

/**
 * The two intentions a caller cannot hold at once.
 *
 * `supersedes` retires a row and writes a new one beside it; matching replaces
 * a row by updating it. Asking for both would retire the row and then revive
 * it, in that order, which is not a state anybody means.
 */
function assertOneReplacement(input: { supersedes?: DuSupersede }, writer: string): void {
  if (input.supersedes) {
    throw new Error(
      `${writer} was given both matchOnIdentity and supersedes. A matched row is ` +
        "replaced by being updated, so there is no second row to retire.",
    );
  }
}

/**
 * Prior keys are only ever consulted on the matching path.
 *
 * Handed in without `matchOnIdentity` they would do nothing at all, and doing
 * nothing at all is how an ingest ends up with a second live row for an account
 * it holds — the exact outcome the keys were computed to prevent. So it is
 * refused rather than ignored.
 */
function assertPriorKeysAreUsable(
  input: { matchOnIdentity?: boolean; priorIdentityKeys?: readonly string[] },
  writer: string,
): void {
  if (!input.matchOnIdentity && (input.priorIdentityKeys?.length ?? 0) > 0) {
    throw new Error(
      `${writer} was given priorIdentityKeys without matchOnIdentity. Keys a row may ` +
        "already be stored under are for looking it up, and this call is not looking " +
        "anything up.",
    );
  }
}

/**
 * Hold this application's identity space until the transaction ends.
 *
 * The window is exactly the first sighting: two pulls that both find nothing
 * both insert, and the unique index over `(application_id, identity_key)`
 * refuses the second and takes its whole pull with it. Waiting here turns that
 * into the second pull matching the row the first one just wrote, which is what
 * it meant in the first place. Re-pulls of a row that already exists never
 * needed it — an UPDATE takes its own row lock — so the cost is one round trip
 * on a path that is already several.
 *
 * A transaction-scoped advisory lock, in the two-integer key space, which
 * Postgres keeps separate from the single-bigint one the test suite uses. It is
 * taken per application rather than per key, so a pull can never take two and
 * two pulls can never deadlock trading them.
 */
async function lockIdentitySpace(tx: DuTransaction, applicationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('du_row_identity'), hashtext(${applicationId}::text))`;
}

/** The key this pull writes, then the keys the row may already be stored under. */
function candidateKeys(identityKey: string, prior: readonly string[] | undefined): string[] {
  return [identityKey, ...(prior ?? [])];
}

/** The part of a matched row that decides how it is updated. */
interface Matched {
  readonly identityKey: string;
  readonly firstSeenSnapshotId: string | null;
}

/**
 * The row this asset is, if the application already holds it.
 *
 * The keys are tried in order and the first hit wins, so a row still filed
 * under a content key is found by a pull that has since been given a vendor id.
 */
async function matchedAsset(tx: DuTransaction, input: WriteAssetInput) {
  for (const identityKey of candidateKeys(input.asset.identityKey, input.priorIdentityKeys)) {
    const found = await tx.duAsset.findUnique({
      where: {
        applicationId_identityKey: { applicationId: input.asset.applicationId, identityKey },
      },
      select: {
        id: true,
        identityKey: true,
        firstSeenSnapshotId: true,
        owners: { select: { applicationPartyId: true } },
      },
    });
    if (found) return found;
  }
  return null;
}

/** The same, for a tradeline. */
async function matchedLiability(tx: DuTransaction, input: WriteLiabilityInput) {
  for (const identityKey of candidateKeys(input.liability.identityKey, input.priorIdentityKeys)) {
    const found = await tx.duLiability.findUnique({
      where: {
        applicationId_identityKey: { applicationId: input.liability.applicationId, identityKey },
      },
      select: {
        id: true,
        identityKey: true,
        firstSeenSnapshotId: true,
        obligors: { select: { applicationPartyId: true } },
      },
    });
    if (found) return found;
  }
  return null;
}

/**
 * What a re-pull may change about a row it recognized: everything it reported
 * except the columns that say which row this is.
 *
 * Its id and its application are what was matched on. `createdAt` stays because
 * the emitted rows are ordered by `(createdAt, id)`, so a re-pull that moved it
 * would renumber the file while reporting that nothing had changed.
 *
 * The key is written only when the row was found under a different one, which
 * happens on exactly one movement: a provider that has started numbering the
 * accounts it used to report only by name. That row's identity has not changed
 * and the string it is filed under has, so the move is made here, once, on the
 * evidence of the vendor's own id.
 *
 * `firstSeenSnapshotId` is kept where the row already has one, because a first
 * sighting that moves is not a first sighting. `retiredAt` and
 * `retiredBySnapshotId` are cleared unconditionally: an account reported again
 * is live again, and reviving in place is what the unique index spanning
 * retired rows is for.
 */
function assetRevision(
  reported: Prisma.DuAssetUncheckedCreateInput,
  matched: Matched,
): Prisma.DuAssetUncheckedUpdateInput {
  const {
    id: _id,
    applicationId: _applicationId,
    identityKey,
    createdAt: _createdAt,
    firstSeenSnapshotId: reportedFirstSeen,
    ...changed
  } = reported;
  return {
    ...changed,
    ...(identityKey === matched.identityKey ? {} : { identityKey }),
    ...(matched.firstSeenSnapshotId === null ? { firstSeenSnapshotId: reportedFirstSeen } : {}),
    retiredAt: null,
    retiredBySnapshotId: null,
  };
}

/**
 * The same, for a tradeline. Written out twice rather than made generic: the
 * two Prisma input types share no supertype that would keep these field names
 * checked, and a helper that took `Record<string, unknown>` would accept a
 * column that does not exist.
 */
function liabilityRevision(
  reported: Prisma.DuLiabilityUncheckedCreateInput,
  matched: Matched,
): Prisma.DuLiabilityUncheckedUpdateInput {
  const {
    id: _id,
    applicationId: _applicationId,
    identityKey,
    createdAt: _createdAt,
    firstSeenSnapshotId: reportedFirstSeen,
    ...changed
  } = reported;
  return {
    ...changed,
    ...(identityKey === matched.identityKey ? {} : { identityKey }),
    ...(matched.firstSeenSnapshotId === null ? { firstSeenSnapshotId: reportedFirstSeen } : {}),
    retiredAt: null,
    retiredBySnapshotId: null,
  };
}

/**
 * The owners this pull named that the matched row does not already carry.
 *
 * Arcs are ADDED and never removed. A pull is one vendor's report about one
 * person, so it is not evidence that the other owner of a joint account has
 * stopped owning it — and an account whose last arc was dropped because the
 * co-owner's bank was not the one pulled is a row that cannot be emitted at
 * all.
 */
function newOwners(
  held: readonly { applicationPartyId: string }[],
  named: readonly { applicationPartyId: string; role?: string }[],
): { applicationPartyId: string; role?: string }[] {
  const known = new Set(held.map((arc) => arc.applicationPartyId));
  return named.filter((owner) => !known.has(owner.applicationPartyId));
}

/** Write an ASSET and the arcs that say whose it is. Returns the row's id. */
export async function writeAsset(tx: DuTransaction, input: WriteAssetInput): Promise<string> {
  assertInsideTransaction(tx, "writeAsset");
  assertPriorKeysAreUsable(input, "writeAsset");
  const owners = ownerRows(input.owners, "writeAsset");

  if (input.matchOnIdentity) {
    assertOneReplacement(input, "writeAsset");
    await lockIdentitySpace(tx, input.asset.applicationId);
    const matched = await matchedAsset(tx, input);
    if (matched) {
      await tx.duAsset.update({
        where: { id: matched.id },
        data: assetRevision(input.asset, matched),
      });
      const missing = newOwners(matched.owners, owners);
      if (missing.length > 0) {
        await tx.duAssetParty.createMany({
          data: missing.map((owner) => ({ assetId: matched.id, ...owner })),
        });
      }
      return matched.id;
    }
  }

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
  assertPriorKeysAreUsable(input, "writeLiability");
  const obligors = ownerRows(input.obligors, "writeLiability");

  if (input.matchOnIdentity) {
    assertOneReplacement(input, "writeLiability");
    await lockIdentitySpace(tx, input.liability.applicationId);
    const matched = await matchedLiability(tx, input);
    if (matched) {
      await tx.duLiability.update({
        where: { id: matched.id },
        data: liabilityRevision(input.liability, matched),
      });
      const missing = newOwners(matched.obligors, obligors);
      if (missing.length > 0) {
        await tx.duLiabilityParty.createMany({
          data: missing.map((obligor) => ({ liabilityId: matched.id, ...obligor })),
        });
      }
      return matched.id;
    }
  }

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
