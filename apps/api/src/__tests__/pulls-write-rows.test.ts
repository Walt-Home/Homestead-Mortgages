/**
 * The credit pull and the bank pull write the rows a casefile carries.
 *
 * `du_liabilities` and `du_assets` had writers and nothing called them, so a
 * real file's casefile emitted neither what the borrower owed nor what they
 * had. Now each pull reconciles its report into rows owed or owned by the
 * person whose report it is — matched in place on a re-pull, retired when a
 * report no longer carries them, never deleted — in the same transaction as
 * the snapshot, so a row always names the pull it came from.
 *
 * Against the real Postgres, because the promises are the writer's and the
 * database's: an owner arc checked at COMMIT, an identity index that spans
 * retired rows, a CHECK on every kind's shape.
 */
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { AssetReport } from "@hm/shared";
import { connectorRouter } from "../routes/connectors.js";
import { fileRouter } from "../routes/files.js";
import { reconcileAssets } from "../services/assets.js";
import { ensureApplicationParty } from "../services/applications.js";
import { loadLoanFile, recordSnapshot } from "../services/repository.js";
import { createParty, createUser } from "./support/factories.js";
import { callAs } from "./support/http.js";

const SCREEN_ONE = {
  purpose: "purchase",
  address: { line1: "88 Foster Lane", city: "Austin", state: "tx", postalCode: "78745" },
  propertyType: "single_family",
  occupancy: "primary_residence",
  valueOrPrice: 415_000,
  loanAmount: 332_000,
  downPayment: 83_000,
  statedMonthlyIncome: 9_400,
};

const DANA = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550144",
  dateOfBirth: "1986-11-03",
  ssnVaultHandle: "vault:dana:1",
  ssnLast4: "4321",
  currentAddress: { line1: "9 Fixture Way", city: "Austin", state: "TX", postalCode: "78745" },
  maritalStatus: "married",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  demographics: null,
  statedMonthlyIncome: 7_400,
};

/** A file with an application, one borrower on it, and her authorizations. */
async function authorized() {
  const user = await createUser();
  const created = await callAs<{ id: string }>(user.id, [fileRouter], "POST", "/", SCREEN_ONE);
  const fileId = created.body.id;
  await callAs(user.id, [fileRouter], "POST", `/${fileId}/borrowers`, DANA);
  const dana = (await loadLoanFile(fileId))!.borrowers[0]!;
  for (const kind of ["verification_authorization", "econsent"]) {
    await callAs(user.id, [connectorRouter], "POST", `/${fileId}/consents`, {
      kind,
      borrowerId: dana.id,
    });
  }
  const application = await prisma.application.findUniqueOrThrow({
    where: { loanFileId: fileId },
    select: { id: true },
  });
  const edge = await prisma.applicationParty.findUniqueOrThrow({
    where: { applicationId_partyId: { applicationId: application.id, partyId: dana.partyId } },
    select: { id: true },
  });
  return { user, fileId, dana, applicationId: application.id, edgeId: edge.id };
}

const account = (
  id: string,
  mask: string,
  balance: number,
  overrides: Partial<AssetReport["accounts"][number]> = {},
): AssetReport["accounts"][number] => ({
  id,
  institution: "Fixture Savings Bank",
  type: "checking",
  mask,
  currentBalance: balance,
  balanceHistory: [],
  usedForQualifying: true,
  ...overrides,
});

/** A bank snapshot to hang rows off, and the reconciliation of a report against it. */
async function pulled(
  fileId: string,
  partyId: string,
  reported: Pick<AssetReport, "accounts" | "gifts">,
  retrievedAt = new Date(),
) {
  return prisma.$transaction(async (tx) => {
    const snapshot = await recordSnapshot(
      fileId,
      "bank",
      "fixture-bank",
      `report-${retrievedAt.toISOString()}`,
      reported,
      retrievedAt.toISOString(),
      partyId,
      tx,
    );
    const result = await reconcileAssets(tx, {
      loanFileId: fileId,
      partyId,
      snapshotId: snapshot.id,
      provider: "fixture-bank",
      reported,
      now: retrievedAt,
    });
    return { snapshotId: snapshot.id, ...result };
  });
}

describe("the credit pull", () => {
  it("writes each tradeline as a liability the borrower owes, in one transaction with the snapshot", async () => {
    const h = await authorized();
    const res = await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/credit`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const snapshot = await prisma.connectorSnapshot.findFirstOrThrow({
      where: { loanFileId: h.fileId, kind: "credit" },
      select: { id: true, payload: true },
    });
    const report = snapshot.payload as { tradelines: { creditorName: string; type: string }[] };
    const rows = await prisma.duLiability.findMany({
      where: { applicationId: h.applicationId },
      orderBy: { createdAt: "asc" },
      include: { obligors: { select: { applicationPartyId: true } } },
    });
    expect(rows).toHaveLength(report.tradelines.length);
    // The bureau's kind on DU's list: an auto loan and a student loan are
    // installment debt; a card is revolving.
    expect(rows.map((r) => [r.holderName, r.liabilityType])).toEqual(
      report.tradelines.map((t) => [
        t.creditorName,
        { auto: "Installment", student: "Installment", revolving: "Revolving" }[t.type],
      ]),
    );
    for (const row of rows) {
      expect(row.obligors).toEqual([{ applicationPartyId: h.edgeId }]);
      expect(row.sourceSnapshotId).toBe(snapshot.id);
      expect(row.firstSeenSnapshotId).toBe(snapshot.id);
      expect(row.identityKey.startsWith(`p:${h.dana.partyId}:vendor:`)).toBe(true);
      expect(row.payoffStatus).toBe(false);
      expect(row.accountIdentifier).toBeNull();
      expect(row.retiredAt).toBeNull();
    }
    expect(rows.every((r) => r.monthlyPaymentCents > 0n)).toBe(true);
  });
});

describe("the bank pull", () => {
  it("writes each qualifying account as a deposit asset the borrower owns", async () => {
    const h = await authorized();
    const res = await callAs(h.user.id, [connectorRouter], "POST", `/${h.fileId}/bank`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const snapshot = await prisma.connectorSnapshot.findFirstOrThrow({
      where: { loanFileId: h.fileId, kind: "bank" },
      select: { id: true, payload: true },
    });
    const report = snapshot.payload as unknown as AssetReport;
    const rows = await prisma.duAsset.findMany({
      where: { applicationId: h.applicationId },
      orderBy: { createdAt: "asc" },
      include: { owners: { select: { applicationPartyId: true } } },
    });
    const qualifying = report.accounts.filter((a) => a.usedForQualifying);
    expect(rows).toHaveLength(qualifying.length + report.gifts.length);
    expect(
      rows
        .slice(0, qualifying.length)
        .map((r) => [
          r.kind,
          r.assetType,
          r.holderName,
          r.accountIdentifier,
          r.cashOrMarketValueCents,
        ]),
    ).toEqual(
      qualifying.map((a) => [
        "DEPOSIT_ACCOUNT",
        ({ checking: "CheckingAccount", savings: "SavingsAccount" } as Record<string, string>)[
          a.type
        ],
        a.institution,
        a.mask,
        BigInt(Math.round(a.currentBalance * 100)),
      ]),
    );
    for (const row of rows) {
      expect(row.owners).toEqual([{ applicationPartyId: h.edgeId }]);
      expect(row.sourceSnapshotId).toBe(snapshot.id);
    }
  });

  it("re-pulls in place: the row keeps its id, an account that vanished is retired, one that returns is revived", async () => {
    const h = await authorized();
    const first = await pulled(h.fileId, h.dana.partyId, {
      accounts: [account("a1", "1111", 10_000), account("a2", "2222", 5_000)],
      gifts: [],
    });
    expect(first).toMatchObject({ written: 2, retired: 0 });
    const before = await prisma.duAsset.findMany({
      where: { applicationId: h.applicationId },
      orderBy: { accountIdentifier: "asc" },
    });
    expect(before.map((r) => r.accountIdentifier)).toEqual(["1111", "2222"]);

    // The balance moved and the second account is gone.
    const second = await pulled(h.fileId, h.dana.partyId, {
      accounts: [account("a1", "1111", 12_500)],
      gifts: [],
    });
    expect(second).toMatchObject({ written: 1, retired: 1 });
    const after = await prisma.duAsset.findMany({
      where: { applicationId: h.applicationId },
      orderBy: { accountIdentifier: "asc" },
    });
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after[0]).toMatchObject({
      cashOrMarketValueCents: 1_250_000n,
      firstSeenSnapshotId: first.snapshotId,
      lastSeenSnapshotId: second.snapshotId,
      retiredAt: null,
    });
    expect(after[1]).toMatchObject({
      retiredBySnapshotId: second.snapshotId,
      lastSeenSnapshotId: first.snapshotId,
    });
    expect(after[1]!.retiredAt).not.toBeNull();

    // It comes back: the same row, live again, first seen where it was first seen.
    const third = await pulled(h.fileId, h.dana.partyId, {
      accounts: [account("a1", "1111", 12_500), account("a2", "2222", 5_100)],
      gifts: [],
    });
    expect(third).toMatchObject({ written: 2, retired: 0 });
    const revived = await prisma.duAsset.findUniqueOrThrow({ where: { id: after[1]!.id } });
    expect(revived).toMatchObject({
      retiredAt: null,
      retiredBySnapshotId: null,
      firstSeenSnapshotId: first.snapshotId,
      lastSeenSnapshotId: third.snapshotId,
      cashOrMarketValueCents: 510_000n,
    });
    expect(await prisma.duAsset.count({ where: { applicationId: h.applicationId } })).toBe(2);
  });

  it("writes a retirement account at its vested balance, and skips an account not used to qualify", async () => {
    const h = await authorized();
    await pulled(h.fileId, h.dana.partyId, {
      accounts: [
        account("r1", "9001", 100_000, { type: "retirement", vestedBalance: 80_000 }),
        account("x1", "9002", 40_000, { usedForQualifying: false }),
      ],
      gifts: [],
    });
    const rows = await prisma.duAsset.findMany({ where: { applicationId: h.applicationId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assetType: "RetirementFund",
      cashOrMarketValueCents: 8_000_000n,
      accountIdentifier: "9001",
    });
  });

  it("writes a gift as cash from the donor, already in the account, with Other carrying the report's own word", async () => {
    const h = await authorized();
    await pulled(h.fileId, h.dana.partyId, {
      accounts: [],
      gifts: [
        {
          amount: 20_000,
          donorName: "Raj Raman",
          donorRelationship: "parent",
          transferDate: "2026-08-20",
        },
        {
          amount: 2_500,
          donorName: "M. Okafor",
          donorRelationship: "landlord",
          transferDate: "2026-08-22",
        },
      ],
    });
    const rows = await prisma.duAsset.findMany({
      where: { applicationId: h.applicationId },
      orderBy: { cashOrMarketValueCents: "desc" },
    });
    expect(
      rows.map((r) => [
        r.kind,
        r.assetType,
        r.fundsSourceType,
        r.fundsSourceTypeOtherDescription,
        r.includedInAssetAccount,
        r.cashOrMarketValueCents,
      ]),
    ).toEqual([
      ["GIFT_OR_GRANT", "GiftOfCash", "Parent", null, true, 2_000_000n],
      ["GIFT_OR_GRANT", "GiftOfCash", "Other", "landlord", true, 250_000n],
    ]);
  });

  it("keeps two people's rows apart: a co-borrower's pull writes theirs and retires none of the applicant's", async () => {
    const h = await authorized();
    await pulled(h.fileId, h.dana.partyId, {
      accounts: [account("a1", "1111", 10_000)],
      gifts: [],
    });
    const theo = await createParty();
    const edge = await ensureApplicationParty(prisma, h.applicationId, theo.id, "CO_BORROWER");
    // The same joint account, on his report under his vendor id.
    const his = await pulled(h.fileId, theo.id, {
      accounts: [account("z9", "1111", 10_000)],
      gifts: [],
    });
    expect(his).toMatchObject({ written: 1, retired: 0 });
    const rows = await prisma.duAsset.findMany({
      where: { applicationId: h.applicationId },
      include: { owners: { select: { applicationPartyId: true } } },
    });
    // Two pulls, two rows: folding them is a person's call on the way out.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.retiredAt === null)).toBe(true);
    expect(new Set(rows.map((r) => r.owners[0]!.applicationPartyId))).toEqual(
      new Set([h.edgeId, edge.id]),
    );
  });
});
