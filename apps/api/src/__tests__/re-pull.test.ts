/**
 * The same account, across a second bank pull.
 *
 * `du_assets` has the five identity columns and a unique index that spans
 * retired rows, and until now nothing computed a key to write through them. A
 * pull that cannot recognize a row it already wrote has two options and both
 * are wrong: insert a twin, or delete and recreate. Either renumbers every
 * `ASSET_n` on the wire, so a resubmission that reports the identical accounts
 * looks, byte for byte, like a different set of them.
 *
 * What makes this worth a file of its own is the failure that is invisible when
 * it happens. A key built on the row's position in the vendor's list still
 * matches, still updates one row per account, and still leaves every label
 * unchanged — while putting one account's balance and one account's type on the
 * row that belongs to another, with the owner arcs untouched. "leaves every
 * survivor alone when an account disappears between pulls" is that shape, and
 * it fails under a key carrying the row's position, as do both tests in "two
 * rows one vendor cannot tell apart". The two single-account tests below it
 * pass under such a key — one account cannot express another account's balance
 * landing on its row — which is why the three-account one is here at all.
 *
 * One test asserts a mix-up rather than the absence of one. Where the vendor
 * masks the number and reports no opening date, a closed account and its
 * replacement at the same bank are one content key, and the content key is all
 * there is; that is written down as a test because it is the limit of what
 * removing the ordinal bought, and a limit nobody can see is one somebody
 * rediscovers.
 *
 * No adapter is involved. The connectors that would pull an account are not
 * written, so everything below drives the writer with reports made up here,
 * which is also what lets a test report the same account twice on purpose, and
 * lets two pulls of one account be held open against each other until both have
 * looked it up.
 *
 * A tradeline is here too, at the end. The asset writer and the liability
 * writer are written out separately rather than made generic, and separately
 * written code is where a rule ends up applied on one side only.
 *
 * Against the real Postgres, because the matching is a unique index and the
 * ownership is a join.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma, type ApplicationPartyRole, type DuAssetType } from "@hm/db";
import {
  assetIdentityKeys,
  liabilityIdentityKeys,
  resolveIdentities,
  writeAsset,
  writeLiability,
  type AmbiguousGroup,
  type AssetIdentityFacts,
  type DuTransaction,
} from "@hm/du";
import { recordSnapshot } from "../services/repository.js";
import { createLoanFile, createParty, createUser } from "./support/factories.js";

/** A borrower on an application: the arc's endpoint, and the person behind it. */
interface Borrower {
  /** The `application_parties` row an owner arc points at. */
  readonly edgeId: string;
  /** The durable party, which is what `connector_snapshots.party_id` holds. */
  readonly partyId: string;
}

interface Application {
  readonly id: string;
  readonly loanFileId: string;
  readonly borrowers: readonly Borrower[];
}

async function anApplication(
  roles: readonly ApplicationPartyRole[] = ["PRIMARY_BORROWER"],
  parties: readonly string[] = [],
): Promise<Application> {
  const user = await createUser();
  const file = await createLoanFile({ userId: user.id });
  const app = await prisma.application.create({
    data: { loanFileId: file.id, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  const borrowers: Borrower[] = [];
  for (let index = 0; index < roles.length; index += 1) {
    const partyId = parties[index] ?? (await createParty()).id;
    const edge = await prisma.applicationParty.create({
      data: { applicationId: app.id, partyId, role: roles[index]! },
      select: { id: true },
    });
    borrowers.push({ edgeId: edge.id, partyId });
  }
  return { id: app.id, loanFileId: file.id, borrowers };
}

/** One deposit account as a vendor reports it. */
interface ReportedAccount {
  /** The adapter's stable per-item id, for the connectors that have one. */
  readonly itemId?: string;
  readonly holderName: string;
  readonly accountSubtype?: string;
  /** Absent where the vendor masks the number entirely, which is the hard case. */
  readonly accountIdentifier?: string;
  readonly assetType?: DuAssetType;
  readonly balanceCents: bigint;
}

function factsFor(account: ReportedAccount): AssetIdentityFacts {
  return {
    kind: "DEPOSIT_ACCOUNT",
    holderName: account.holderName,
    ...(account.accountSubtype === undefined ? {} : { accountSubtype: account.accountSubtype }),
    ...(account.accountIdentifier === undefined
      ? {}
      : { accountIdentifier: account.accountIdentifier }),
  };
}

interface Pull {
  readonly snapshotId: string;
  /** The row each reported account landed on, answering in the order reported. */
  readonly ids: readonly string[];
  readonly ambiguous: readonly AmbiguousGroup[];
  /** The fallback keys this pull's own rows competed for, and so may not use. */
  readonly sharedPriorKeys: readonly string[];
}

/**
 * A bank pull: the snapshot it is recorded as, the keys its accounts compute,
 * and the rows they land on.
 *
 * One transaction for the whole report, because the owner arcs are checked at
 * COMMIT and a pull that half-lands is not a pull. Rows from an earlier pull
 * that this one does not report are left alone — a report is evidence about the
 * accounts it names and silence about the rest.
 */
async function pull(
  app: Application,
  borrower: Borrower,
  accounts: readonly ReportedAccount[],
): Promise<Pull> {
  const snapshot = await recordSnapshot(
    app.loanFileId,
    "bank",
    "plaid",
    `report-${randomUUID()}`,
    {},
    new Date().toISOString(),
    borrower.partyId,
  );
  // Read back rather than reused: the prefix is the subject of the snapshot the
  // figures came from, so the test gets it the way an ingest would.
  const subject = await prisma.connectorSnapshot.findUniqueOrThrow({
    where: { id: snapshot.id },
    select: { partyId: true, provider: true },
  });
  const plan = resolveIdentities(
    accounts.map((account) =>
      assetIdentityKeys(
        {
          partyId: subject.partyId!,
          provider: subject.provider,
          itemId: account.itemId ?? null,
        },
        factsFor(account),
      ),
    ),
  );

  const ids = await prisma.$transaction(async (tx) => {
    const written: string[] = [];
    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index]!;
      const row = plan.rows[index]!;
      written.push(
        await writeAsset(tx, {
          asset: {
            ...(row.id === null ? {} : { id: row.id }),
            applicationId: app.id,
            kind: "DEPOSIT_ACCOUNT",
            assetType: account.assetType ?? "CheckingAccount",
            cashOrMarketValueCents: account.balanceCents,
            holderName: account.holderName,
            ...(account.accountIdentifier === undefined
              ? {}
              : { accountIdentifier: account.accountIdentifier }),
            identityKey: row.identityKey,
            sourceSnapshotId: snapshot.id,
            firstSeenSnapshotId: snapshot.id,
            lastSeenSnapshotId: snapshot.id,
          },
          owners: [{ applicationPartyId: borrower.edgeId }],
          matchOnIdentity: true,
          priorIdentityKeys: row.priorKeys,
        }),
      );
    }
    return written;
  });

  return {
    snapshotId: snapshot.id,
    ids,
    ambiguous: plan.ambiguous,
    sharedPriorKeys: plan.sharedPriorKeys,
  };
}

/** Every row on the application, oldest first, with whose it is. */
async function assetsOn(applicationId: string) {
  return prisma.duAsset.findMany({
    where: { applicationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      identityKey: true,
      assetType: true,
      cashOrMarketValueCents: true,
      retiredAt: true,
      firstSeenSnapshotId: true,
      lastSeenSnapshotId: true,
      owners: { select: { applicationPartyId: true } },
    },
  });
}

const FIRST_FEDERAL = { holderName: "First Federal", accountSubtype: "checking" };

describe("a re-pull matches the row it already wrote", () => {
  it("revives a retired row rather than inserting a twin beside it", async () => {
    const app = await anApplication();
    const her = app.borrowers[0]!;
    const account = { ...FIRST_FEDERAL, accountIdentifier: "4455", balanceCents: 1_250_000n };

    const first = await pull(app, her, [account]);
    const [before] = await assetsOn(app.id);
    // The account goes quiet and is superseded, then the borrower reconnects.
    await prisma.duAsset.update({
      where: { id: first.ids[0]! },
      data: { retiredAt: new Date(), retiredBySnapshotId: first.snapshotId },
    });
    const second = await pull(app, her, [{ ...account, balanceCents: 1_300_000n }]);

    expect(second.ids).toEqual(first.ids);
    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identityKey).toBe(before!.identityKey);
    expect(rows[0]!.cashOrMarketValueCents).toBe(1_300_000n);
    expect(rows[0]!.retiredAt).toBeNull();
    // An account that came back is the same account, so the pull that first
    // reported it stays the one that first reported it.
    expect(rows[0]!.firstSeenSnapshotId).toBe(first.snapshotId);
    expect(rows[0]!.lastSeenSnapshotId).toBe(second.snapshotId);
    // And the arc is not written twice, which the join's unique index would
    // refuse outright.
    expect(rows[0]!.owners).toEqual([{ applicationPartyId: her.edgeId }]);
  });

  it("leaves every survivor alone when an account disappears between pulls", async () => {
    // Three accounts at one bank, no masks and no vendor ids, so the content
    // key is all there is. Drop the first and re-pull: under a key that carried
    // the row's position, savings would take the checking row and money market
    // would take the savings row, every label on the wire would be unchanged,
    // and two balances would be filed against the wrong accounts.
    const app = await anApplication();
    const her = app.borrowers[0]!;
    const checking = { ...FIRST_FEDERAL, balanceCents: 200_000n };
    const savings = {
      holderName: "First Federal",
      accountSubtype: "savings",
      assetType: "SavingsAccount" as const,
      balanceCents: 3_000_000n,
    };
    const moneyMarket = {
      holderName: "First Federal",
      accountSubtype: "money market",
      assetType: "MoneyMarketFund" as const,
      balanceCents: 500_000n,
    };

    const first = await pull(app, her, [checking, savings, moneyMarket]);
    const before = await assetsOn(app.id);
    const second = await pull(app, her, [savings, moneyMarket]);

    expect(second.ids).toEqual([first.ids[1], first.ids[2]]);
    const after = await assetsOn(app.id);
    expect(after).toHaveLength(3);
    for (let index = 0; index < after.length; index += 1) {
      expect(after[index]!.id, `row ${index}`).toBe(before[index]!.id);
      expect(after[index]!.cashOrMarketValueCents, `row ${index}`).toBe(
        before[index]!.cashOrMarketValueCents,
      );
      expect(after[index]!.assetType, `row ${index}`).toBe(before[index]!.assetType);
      // Nothing retires the account that stopped being reported. A report is
      // evidence about what it names, and somebody has to decide what silence
      // about the rest means.
      expect(after[index]!.retiredAt, `row ${index}`).toBeNull();
    }
  });

  it("follows a vendor id through a changed mask", async () => {
    const app = await anApplication();
    const her = app.borrowers[0]!;
    const first = await pull(app, her, [
      { itemId: "acc_9f2", ...FIRST_FEDERAL, accountIdentifier: "4455", balanceCents: 100n },
    ]);
    // The institution restates the account: new mask, new subtype, new name.
    // A tier-1 key consults none of them.
    const second = await pull(app, her, [
      {
        itemId: "acc_9f2",
        holderName: "First Federal Savings Bank",
        accountSubtype: "savings",
        accountIdentifier: "9911",
        assetType: "SavingsAccount",
        balanceCents: 250n,
      },
    ]);

    expect(second.ids).toEqual(first.ids);
    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetType).toBe("SavingsAccount");
    expect(rows[0]!.cashOrMarketValueCents).toBe(250n);
  });

  it("follows a content key through a changed balance", async () => {
    const app = await anApplication();
    const her = app.borrowers[0]!;
    const account = { ...FIRST_FEDERAL, accountIdentifier: "4455", balanceCents: 100n };
    const first = await pull(app, her, [account]);
    const second = await pull(app, her, [{ ...account, balanceCents: 999n }]);

    expect(second.ids).toEqual(first.ids);
    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cashOrMarketValueCents).toBe(999n);
  });

  it("adds an owner a later pull names and keeps the one already there", async () => {
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    const [her, his] = app.borrowers as [Borrower, Borrower];
    const account = { ...FIRST_FEDERAL, accountIdentifier: "4455", balanceCents: 100n };
    const first = await pull(app, her, [account]);

    const { key } = assetIdentityKeys(
      { partyId: her.partyId, provider: "plaid" },
      factsFor(account),
    );
    await prisma.$transaction((tx) =>
      writeAsset(tx, {
        asset: {
          applicationId: app.id,
          kind: "DEPOSIT_ACCOUNT",
          assetType: "CheckingAccount",
          cashOrMarketValueCents: 100n,
          holderName: account.holderName,
          identityKey: key,
        },
        owners: [{ applicationPartyId: her.edgeId }, { applicationPartyId: his.edgeId }],
        matchOnIdentity: true,
      }),
    );

    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.ids[0]);
    expect(rows[0]!.owners.map((arc) => arc.applicationPartyId).sort()).toEqual(
      [her.edgeId, his.edgeId].sort(),
    );
  });

  it("refuses to be told twice what it is replacing", async () => {
    const app = await anApplication();
    const her = app.borrowers[0]!;
    const first = await pull(app, her, [{ ...FIRST_FEDERAL, balanceCents: 1n }]);

    await expect(
      prisma.$transaction((tx) =>
        writeAsset(tx, {
          asset: {
            applicationId: app.id,
            kind: "DEPOSIT_ACCOUNT",
            assetType: "CheckingAccount",
            cashOrMarketValueCents: 2n,
            holderName: "First Federal",
            identityKey: `manual:${randomUUID()}`,
          },
          owners: [{ applicationPartyId: her.edgeId }],
          matchOnIdentity: true,
          supersedes: { id: first.ids[0]! },
        }),
      ),
    ).rejects.toThrow(/both matchOnIdentity and supersedes/);
  });

  it("refuses keys to fall back to on a write that is not looking anything up", async () => {
    // Silently ignoring them is how an ingest ends up with a second live row
    // for an account it already holds, which is the thing they were computed to
    // prevent.
    const app = await anApplication();
    const her = app.borrowers[0]!;

    await expect(
      prisma.$transaction((tx) =>
        writeAsset(tx, {
          asset: {
            applicationId: app.id,
            kind: "DEPOSIT_ACCOUNT",
            assetType: "CheckingAccount",
            cashOrMarketValueCents: 1n,
            holderName: "First Federal",
            identityKey: `manual:${randomUUID()}`,
          },
          owners: [{ applicationPartyId: her.edgeId }],
          priorIdentityKeys: [`p:${her.partyId}:acct:firstfederal:checking::`],
        }),
      ),
    ).rejects.toThrow(/priorIdentityKeys without matchOnIdentity/);
  });
});

describe("two rows one vendor cannot tell apart", () => {
  it("are both written unmatched, and neither takes the other's row", async () => {
    // Same bank, same subtype, no mask and no vendor id: the content key
    // identifies neither of them. Matching by arrival order is exactly how a
    // balance ends up under the wrong account, so neither is matched at all and
    // the pair is handed back for somebody to resolve.
    const app = await anApplication();
    const her = app.borrowers[0]!;
    const twin = { ...FIRST_FEDERAL, balanceCents: 100n };
    const first = await pull(app, her, [twin, { ...twin, balanceCents: 200n }]);

    expect(first.ambiguous).toHaveLength(1);
    expect(first.ambiguous[0]!.rowIds).toEqual(first.ids);
    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.identityKey).toBe(`unmatched:${row.id}`);
    }
  });

  it("never collide with the next pull's, which is what keeps the report", async () => {
    // The stated cost: the old rows stay live beside the new ones until
    // somebody says which is which. A renumbered label is visible in a diff and
    // a balance filed under the wrong owner is not, so the report is kept and
    // the submission is what gets stopped.
    const app = await anApplication();
    const her = app.borrowers[0]!;
    const twin = { ...FIRST_FEDERAL, balanceCents: 100n };
    const first = await pull(app, her, [twin, { ...twin, balanceCents: 200n }]);
    const second = await pull(app, her, [twin, { ...twin, balanceCents: 200n }]);

    expect(second.ids.some((id) => first.ids.includes(id))).toBe(false);
    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.identityKey)).size).toBe(4);
  });
});

describe("the subject party is in the key", () => {
  it("keeps two borrowers' indistinguishable accounts apart", async () => {
    // One application, one bank, one account number, and the only thing between
    // them is the prefix. Without it the second pull updates the first
    // borrower's row and leaves the owner arc pointing at the first borrower —
    // her balance, filed under him, with nothing on the wire looking wrong.
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    const [her, his] = app.borrowers as [Borrower, Borrower];
    const joint = { ...FIRST_FEDERAL, accountIdentifier: "4455" };

    await pull(app, her, [{ ...joint, balanceCents: 1_000_000n }]);
    // Two vendors' reports about one account are two pieces of evidence, and
    // they are allowed to disagree — which is what makes a crossing visible.
    await pull(app, his, [{ ...joint, balanceCents: 1_100_000n, assetType: "SavingsAccount" }]);

    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(2);
    const [hers, theirs] = rows as [(typeof rows)[number], (typeof rows)[number]];
    expect(hers.identityKey.replace(her.partyId, "")).toBe(
      theirs.identityKey.replace(his.partyId, ""),
    );
    expect(hers.cashOrMarketValueCents).toBe(1_000_000n);
    expect(hers.assetType).toBe("CheckingAccount");
    expect(hers.owners).toEqual([{ applicationPartyId: her.edgeId }]);
    expect(theirs.cashOrMarketValueCents).toBe(1_100_000n);
    expect(theirs.assetType).toBe("SavingsAccount");
    expect(theirs.owners).toEqual([{ applicationPartyId: his.edgeId }]);
  });

  it("is the durable party, so one person's account is one key on two applications", async () => {
    // The `application_parties` row is per application. Keyed on the edge, the
    // same person's same account computes a different key on a second
    // application, and every re-pull there writes a fresh row for something we
    // have held all along.
    const party = await createParty();
    const one = await anApplication(["PRIMARY_BORROWER"], [party.id]);
    const two = await anApplication(["PRIMARY_BORROWER"], [party.id]);
    const account = { ...FIRST_FEDERAL, accountIdentifier: "4455", balanceCents: 1n };

    await pull(one, one.borrowers[0]!, [account]);
    await pull(two, two.borrowers[0]!, [account]);

    const [onFirst] = await assetsOn(one.id);
    const [onSecond] = await assetsOn(two.id);
    expect(onFirst!.identityKey).toBe(onSecond!.identityKey);
    expect(onFirst!.id).not.toBe(onSecond!.id);
    expect(one.borrowers[0]!.edgeId).not.toBe(two.borrowers[0]!.edgeId);
  });
});

describe("a vendor id that arrives, and one that goes away", () => {
  it("keeps the row when the bank starts numbering the accounts it reports", async () => {
    // The first pull could only write a content key. The second computes a
    // vendor key no row carries, and a matcher that knew only that would leave
    // the row live and write a twin beside it — one account, two rows, the
    // balance counted twice and nothing raised.
    const app = await anApplication();
    const her = app.borrowers[0]!;
    const account = { ...FIRST_FEDERAL, accountIdentifier: "4455", balanceCents: 100n };

    const first = await pull(app, her, [account]);
    const second = await pull(app, her, [{ ...account, itemId: "acc_9f2", balanceCents: 250n }]);

    expect(second.ids).toEqual(first.ids);
    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cashOrMarketValueCents).toBe(250n);
    // And the row MOVES onto the key it was found with. Left under the content
    // key it would keep answering to a string any later account at that bank in
    // that subtype also computes.
    expect(rows[0]!.identityKey).toBe(`p:${her.partyId}:vendor:plaid:acc_9f2`);
  });

  it("writes a second row when the bank stops numbering them, and nothing says so", async () => {
    // The movement that cannot be covered: an id that disappears leaves nothing
    // to compute the old key from. The cost is stated here rather than found in
    // a balance sheet — two live rows for one account, until somebody retires
    // one.
    const app = await anApplication();
    const her = app.borrowers[0]!;
    const account = { ...FIRST_FEDERAL, accountIdentifier: "4455", balanceCents: 100n };

    const first = await pull(app, her, [{ ...account, itemId: "acc_9f2" }]);
    const second = await pull(app, her, [account]);

    expect(second.ids).not.toEqual(first.ids);
    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.retiredAt === null)).toBe(true);
  });

  it("lets neither of two newly numbered twins take the row they share", async () => {
    // Both fall back to one content key, and following it would land both on
    // that row inside one transaction, the second overwriting the first. That
    // loses a balance rather than duplicating one, so neither follows it and
    // the key they competed for is named.
    const app = await anApplication();
    const her = app.borrowers[0]!;
    const twin = { ...FIRST_FEDERAL, balanceCents: 100n };

    const first = await pull(app, her, [twin]);
    const second = await pull(app, her, [
      { ...twin, itemId: "acc_1", balanceCents: 700n },
      { ...twin, itemId: "acc_2", balanceCents: 800n },
    ]);

    expect(second.sharedPriorKeys).toHaveLength(1);
    expect(second.ids).not.toContain(first.ids[0]);
    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.id).toBe(first.ids[0]);
    expect(rows[0]!.cashOrMarketValueCents).toBe(100n);
  });
});

describe("what the content key cannot tell apart", () => {
  it("gives a closed account's replacement its row, and its owners with it", async () => {
    // Asserted because it is true, not because it is wanted. The bank masks the
    // number and reports no opening date, so a joint account that closed and an
    // individual one opened at the same bank in the same subtype compute one
    // key. The second pull matches the first account's row, takes its balance
    // and its type, and keeps the arcs — the joint-becomes-individual mix-up,
    // arriving from a direction the ordinal was never the cause of. Refusing to
    // match cannot reach it: that rule compares rows inside one pull, and these
    // two accounts are never reported together.
    const app = await anApplication(["PRIMARY_BORROWER", "CO_BORROWER"]);
    const [her, his] = app.borrowers as [Borrower, Borrower];
    const joint = { ...FIRST_FEDERAL, balanceCents: 5_000_000n };

    const first = await pull(app, her, [joint]);
    const { key } = assetIdentityKeys({ partyId: her.partyId, provider: "plaid" }, factsFor(joint));
    await prisma.$transaction((tx) =>
      writeAsset(tx, {
        asset: {
          applicationId: app.id,
          kind: "DEPOSIT_ACCOUNT",
          assetType: "CheckingAccount",
          cashOrMarketValueCents: joint.balanceCents,
          holderName: joint.holderName,
          identityKey: key,
        },
        owners: [{ applicationPartyId: her.edgeId }, { applicationPartyId: his.edgeId }],
        matchOnIdentity: true,
      }),
    );

    // That account closes. She opens a new one, hers alone, at the same bank.
    const second = await pull(app, her, [{ ...joint, balanceCents: 1_200_000n }]);

    expect(second.ids).toEqual(first.ids);
    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cashOrMarketValueCents).toBe(1_200_000n);
    expect(rows[0]!.owners).toHaveLength(2);
  });
});

describe("a tradeline across a second credit pull", () => {
  /** One tradeline, written the way a credit pull would write it. */
  async function reportTradeline(
    app: Application,
    her: Borrower,
    reported: { itemId?: string; unpaidBalanceCents: bigint },
  ): Promise<string> {
    const facts = {
      holderName: "Shoreline CU",
      liabilityType: "Revolving",
      accountIdentifier: "0027",
    } as const;
    const { key, priorKeys } = liabilityIdentityKeys(
      {
        partyId: her.partyId,
        provider: "creditco",
        ...(reported.itemId === undefined ? {} : { itemId: reported.itemId }),
      },
      facts,
    );
    return prisma.$transaction((tx) =>
      writeLiability(tx, {
        liability: {
          applicationId: app.id,
          liabilityType: facts.liabilityType,
          holderName: facts.holderName,
          accountIdentifier: facts.accountIdentifier,
          unpaidBalanceCents: reported.unpaidBalanceCents,
          monthlyPaymentCents: 5_000n,
          payoffStatus: false,
          identityKey: key,
        },
        obligors: [{ applicationPartyId: her.edgeId }],
        matchOnIdentity: true,
        priorIdentityKeys: priorKeys,
      }),
    );
  }

  it("follows the same rules the asset writer does, which is why they are asserted twice", async () => {
    // The two writers are written out separately on purpose, and separately
    // written code is where a rule gets applied on one side only.
    const app = await anApplication();
    const her = app.borrowers[0]!;

    const first = await reportTradeline(app, her, { unpaidBalanceCents: 90_000n });
    const revalued = await reportTradeline(app, her, { unpaidBalanceCents: 74_000n });
    const numbered = await reportTradeline(app, her, {
      itemId: "tl_77",
      unpaidBalanceCents: 60_000n,
    });

    expect(revalued).toBe(first);
    expect(numbered).toBe(first);
    const rows = await prisma.duLiability.findMany({
      where: { applicationId: app.id },
      select: { id: true, identityKey: true, unpaidBalanceCents: true, obligors: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unpaidBalanceCents).toBe(60_000n);
    expect(rows[0]!.identityKey).toBe(`p:${her.partyId}:vendor:creditco:tl_77`);
    expect(rows[0]!.obligors).toHaveLength(1);
  });
});

describe("two pulls arriving at once", () => {
  it("write one row rather than aborting the loser", async () => {
    // Look up then insert is two statements, and a borrower who double-clicks
    // connect is the ordinary way to get between them. Both pulls find nothing,
    // both insert, and the unique index over (application, identity key) takes
    // the second one's whole pull down with a message naming an index. Retrying
    // inside the transaction is not available — a unique violation aborts it —
    // so the writer settles the race before the lookup instead.
    const app = await anApplication();
    const her = app.borrowers[0]!;
    const account = { ...FIRST_FEDERAL, accountIdentifier: "4455", balanceCents: 0n };
    const { key } = assetIdentityKeys(
      { partyId: her.partyId, provider: "plaid" },
      factsFor(account),
    );

    // Both transactions open, and both have spoken to Postgres, before either
    // looks the account up. Starting two pulls and hoping does not reach the
    // window — it is one statement wide, and whichever pull gets there first
    // usually finishes before the other has begun.
    let arrived = 0;
    let bothOpen: () => void = () => {};
    const open = new Promise<void>((resolve) => {
      bothOpen = resolve;
    });
    const waitForTheOther = async (tx: DuTransaction): Promise<void> => {
      await tx.$executeRaw`SELECT 1`;
      arrived += 1;
      if (arrived === 2) bothOpen();
      await open;
    };

    const write = (balanceCents: bigint): Promise<string> =>
      prisma.$transaction(async (tx) => {
        await waitForTheOther(tx);
        return writeAsset(tx, {
          asset: {
            applicationId: app.id,
            kind: "DEPOSIT_ACCOUNT",
            assetType: "CheckingAccount",
            cashOrMarketValueCents: balanceCents,
            holderName: account.holderName,
            accountIdentifier: account.accountIdentifier,
            identityKey: key,
          },
          owners: [{ applicationPartyId: her.edgeId }],
          matchOnIdentity: true,
        });
      });

    const [one, two] = await Promise.all([write(100n), write(200n)]);

    expect(one).toBe(two);
    const rows = await assetsOn(app.id);
    expect(rows).toHaveLength(1);
    // Which pull landed second is the race itself; that exactly one row holds
    // one of the two balances is the property.
    expect([100n, 200n]).toContain(rows[0]!.cashOrMarketValueCents);
    expect(rows[0]!.owners).toEqual([{ applicationPartyId: her.edgeId }]);
  });
});
