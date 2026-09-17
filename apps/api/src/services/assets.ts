/**
 * What a bank pull says the borrower has, written as the rows a casefile
 * carries.
 *
 * `du_assets` existed with writers and nothing called them, so a real file's
 * casefile emitted no assets: the bank pull wrote a snapshot the engine reads
 * and the assembler reads `du_assets`. This is the same reconciliation
 * `income.ts` does for income, done for the accounts and the gifts an asset
 * report carries — one row per account, owned by the person whose bank it
 * is, matched in place on a re-pull, retired when a pull no longer reports
 * it, and never deleted.
 *
 * Four choices, stated:
 *
 *   - **Only accounts the borrower uses to qualify.** `usedForQualifying` is
 *     the borrower's own answer on the bank screen, and a casefile carries the
 *     assets the loan is qualified on. The engine's reserves apply the same
 *     filter to the snapshot.
 *   - **A retirement account is written at its vested balance.** What DU reads
 *     as the account's value is what could be withdrawn, and the vested figure
 *     is the vendor's own statement of that where it gives one.
 *   - **A gift is a `GiftOfCash` from the donor the report names**, with the
 *     relationship mapped onto DU's source list and `Other` carrying the
 *     report's own word. The report evidences the transfer, so the gift is
 *     marked as already in the account. A gift has no vendor id, so the item
 *     id is made of the donor and the transfer date — two gifts from one
 *     donor on one day would be one row, which is the honest reading of two
 *     such entries in a deposit history.
 *   - **A joint account pulled by two people is two rows.** The identity key
 *     opens with the party (`identity.ts` says why), so each person's pull
 *     writes their own row and the household's decision, which reads the
 *     snapshots, folds the pair by institution and mask. Collapsing the rows
 *     on the wire has a whole balance riding on it and is a person's call on
 *     the way out, not a coincidence of keys on the way in.
 *
 * The engine does not read these rows; it reads the snapshot, as
 * `docs/entities.md` says. These are what the submission carries.
 */

import type { Prisma } from "@hm/db";
import { assetIdentityKeys, writeAsset } from "@hm/du";
import type { AssetReport, DepositAccount, GiftFunds } from "@hm/shared";
import type { Db } from "./db.js";

type AssetType = NonNullable<Prisma.DuAssetUncheckedCreateInput["assetType"]>;
type FundsSource = NonNullable<Prisma.DuAssetUncheckedCreateInput["fundsSourceType"]>;

/** URLA 2a, from the vendor's subtype. A brokerage account is reported on the Stocks line. */
const ACCOUNT_TYPE: Record<DepositAccount["type"], AssetType> = {
  checking: "CheckingAccount",
  savings: "SavingsAccount",
  money_market: "MoneyMarketFund",
  brokerage: "Stock",
  retirement: "RetirementFund",
};

/** URLA 4d.1's donor list, from the words a report uses for a relationship. */
const DONOR: Record<string, FundsSource> = {
  parent: "Parent",
  mother: "Parent",
  father: "Parent",
  relative: "Relative",
  sibling: "Relative",
  brother: "Relative",
  sister: "Relative",
  grandparent: "Relative",
  aunt: "Relative",
  uncle: "Relative",
  cousin: "Relative",
  spouse: "Relative",
  partner: "UnmarriedPartner",
  fiance: "UnmarriedPartner",
  fiancee: "UnmarriedPartner",
  friend: "UnrelatedFriend",
  employer: "Employer",
};

const cents = (dollars: number): bigint => BigInt(Math.round(dollars * 100));

function donorSource(relationship: string): {
  fundsSourceType: FundsSource;
  fundsSourceTypeOtherDescription: string | null;
} {
  const word = relationship.trim().toLowerCase();
  const known = DONOR[word];
  return known
    ? { fundsSourceType: known, fundsSourceTypeOtherDescription: null }
    : { fundsSourceType: "Other", fundsSourceTypeOtherDescription: relationship.slice(0, 80) };
}

export interface ReconciledAssets {
  /** Rows this pull wrote or matched, accounts and gifts together. */
  readonly written: number;
  /** Rows of this person's earlier pulls that this pull no longer reports. */
  readonly retired: number;
}

export async function reconcileAssets(
  tx: Db,
  args: {
    readonly loanFileId: string;
    readonly partyId: string;
    readonly snapshotId: string;
    readonly provider: string;
    readonly reported: Pick<AssetReport, "accounts" | "gifts">;
    readonly now: Date;
  },
): Promise<ReconciledAssets> {
  const { loanFileId, partyId, snapshotId, provider, reported, now } = args;

  // A file without an application has nothing a casefile could be assembled
  // from, and nothing to own a row: the rows hang off the application's
  // borrowing edges, not off the file.
  const application = await tx.application.findUnique({
    where: { loanFileId },
    select: { id: true },
  });
  if (!application) return { written: 0, retired: 0 };
  const applicationId = application.id;
  const edge = await tx.applicationParty.findUnique({
    where: { applicationId_partyId: { applicationId, partyId } },
    select: { id: true },
  });
  if (!edge) {
    throw new Error(
      `the person whose bank was pulled (party ${partyId}) is not on application ${applicationId}`,
    );
  }
  const owners = [{ applicationPartyId: edge.id }] as const;
  const lineage = {
    sourceSnapshotId: snapshotId,
    firstSeenSnapshotId: snapshotId,
    lastSeenSnapshotId: snapshotId,
  };

  const touched: string[] = [];
  for (const account of reported.accounts) {
    if (!account.usedForQualifying) continue;
    const keys = assetIdentityKeys(
      { partyId, provider, itemId: account.id },
      {
        kind: "DEPOSIT_ACCOUNT",
        holderName: account.institution,
        accountSubtype: account.type,
        accountIdentifier: account.mask,
        openedOn: null,
      },
    );
    const value =
      account.type === "retirement"
        ? (account.vestedBalance ?? account.currentBalance)
        : account.currentBalance;
    touched.push(
      await writeAsset(tx, {
        matchOnIdentity: true,
        priorIdentityKeys: keys.priorKeys,
        owners,
        asset: {
          applicationId,
          kind: "DEPOSIT_ACCOUNT",
          assetType: ACCOUNT_TYPE[account.type],
          cashOrMarketValueCents: cents(value),
          holderName: account.institution.slice(0, 150),
          accountIdentifier: account.mask.slice(0, 30),
          identityKey: keys.key,
          ...lineage,
        },
      }),
    );
  }

  for (const gift of reported.gifts) {
    touched.push(await writeGift(tx, { applicationId, partyId, provider, gift, owners, lineage }));
  }

  // The retirement and its cause are one statement, so a retired row always
  // names the pull that retired it. Only this person's connector-written
  // rows: the key's party prefix is what says whose a row is.
  const retired = await tx.duAsset.updateMany({
    where: {
      applicationId,
      identityKey: { startsWith: `p:${partyId}:` },
      kind: { in: ["DEPOSIT_ACCOUNT", "GIFT_OR_GRANT"] },
      retiredAt: null,
      id: { notIn: touched },
    },
    data: { retiredAt: now, retiredBySnapshotId: snapshotId },
  });

  return { written: touched.length, retired: retired.count };
}

async function writeGift(
  tx: Db,
  args: {
    readonly applicationId: string;
    readonly partyId: string;
    readonly provider: string;
    readonly gift: GiftFunds;
    readonly owners: readonly [{ readonly applicationPartyId: string }];
    readonly lineage: {
      readonly sourceSnapshotId: string;
      readonly firstSeenSnapshotId: string;
      readonly lastSeenSnapshotId: string;
    };
  },
): Promise<string> {
  const { applicationId, partyId, provider, gift, owners, lineage } = args;
  const source = donorSource(gift.donorRelationship);
  const keys = assetIdentityKeys(
    {
      partyId,
      provider,
      itemId: `gift:${gift.donorName.trim().toLowerCase()}:${gift.transferDate}`,
    },
    { kind: "GIFT_OR_GRANT", assetType: "GiftOfCash", ...source },
  );
  return writeAsset(tx, {
    matchOnIdentity: true,
    priorIdentityKeys: keys.priorKeys,
    owners,
    asset: {
      applicationId,
      kind: "GIFT_OR_GRANT",
      assetType: "GiftOfCash",
      cashOrMarketValueCents: cents(gift.amount),
      fundsSourceType: source.fundsSourceType,
      fundsSourceTypeOtherDescription: source.fundsSourceTypeOtherDescription,
      // The asset report saw the transfer land, which is what "included in
      // the asset account" means.
      includedInAssetAccount: true,
      identityKey: keys.key,
      ...lineage,
    },
  });
}
