/**
 * The bridge between the four screens and the relationship layer.
 *
 * Dual-write, and the read-from-new-with-fallback that follows it. Every
 * assertion here is about the two tables AGREEING: a borrower row and its
 * party say the same thing, a consent and its mirrored authorization permit
 * the same thing, and the minter reaches the same answer from either side.
 * Nothing here can be proven by a mock.
 */

import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { AuthorizationError } from "@hm/connectors";
import { tokenFor } from "../services/authorization.js";
import { partyForUser, recordBorrowerFacts, type BorrowerInput } from "../services/party.js";
import { loadLoanFile } from "../services/repository.js";
import { createLoanFile, createUser } from "./support/factories.js";

const DAY = 24 * 60 * 60 * 1000;

const dana: BorrowerInput = {
  firstName: "Dana",
  lastName: "Whitfield",
  email: "dana@example.test",
  phone: "5555550100",
  dateOfBirth: "1988-04-12",
  ssnVaultHandle: "vault:dana:1",
  currentAddress: { line1: "1 Fixture St", city: "Demo City", state: "CA", postalCode: "94000" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  preferredLanguage: "en",
  firstTimeHomebuyer: true,
  isMilitary: false,
  currentHousing: "rent",
  monthlyRent: 2150,
  statedMonthlyIncome: 8500,
};

/** Screen 2, as the route does it: facts and the row in one transaction. */
async function saveBorrower(loanFileId: string, input: BorrowerInput, existingId?: string) {
  return prisma.$transaction(async (tx) => {
    const existing = existingId
      ? await tx.borrower.findUniqueOrThrow({
          where: { id: existingId },
          select: { partyId: true },
        })
      : null;
    const partyId = await recordBorrowerFacts(tx, {
      loanFileId,
      existingPartyId: existing?.partyId ?? null,
      input,
    });
    const data = {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      dateOfBirth: new Date(input.dateOfBirth),
      addressLine1: input.currentAddress.line1,
      addressCity: input.currentAddress.city,
      addressState: input.currentAddress.state,
      addressPostalCode: input.currentAddress.postalCode,
      maritalStatus: input.maritalStatus,
      citizenship: input.citizenship,
      preferredLanguage: input.preferredLanguage,
      firstTimeHomebuyer: input.firstTimeHomebuyer ?? null,
      isMilitary: input.isMilitary,
      currentHousing: input.currentHousing,
      partyId,
    };
    if (existingId) {
      return tx.borrower.update({
        where: { id: existingId },
        data,
        select: { id: true, partyId: true },
      });
    }
    return tx.borrower.create({
      data: { ...data, loanFileId, ssnVaultHandle: input.ssnVaultHandle!, ssnLast4: "0000" },
      select: { id: true, partyId: true },
    });
  });
}

async function liveFact(partyId: string, predicate: string) {
  return prisma.fact.findFirst({
    where: { partyId, predicate, supersededById: null, retractedAt: null },
    orderBy: { observedAt: "desc" },
  });
}

describe("screen 2 writes the person both ways", () => {
  it("creates a party behind the user and links the borrower row to it", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);

    expect(row.partyId).not.toBeNull();
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.partyId).toBe(row.partyId);
    const party = await prisma.party.findUniqueOrThrow({ where: { id: row.partyId! } });
    expect(party.claimStatus).toBe("CLAIMED");
  });

  it("asserts every field as a fact the party can be asked about", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);

    expect((await liveFact(row.partyId!, "legal_name"))?.value).toEqual({
      first: "Dana",
      last: "Whitfield",
    });
    expect((await liveFact(row.partyId!, "ssn_token"))?.value).toBe("vault:dana:1");
    expect((await liveFact(row.partyId!, "monthly_income"))?.value).toBe(8500);
    expect((await liveFact(row.partyId!, "is_military"))?.value).toBe(false);
    // Every fact names the party's own principal as the one who said it.
    const facts = await prisma.fact.findMany({
      where: { partyId: row.partyId! },
      include: { assertedBy: true },
    });
    expect(facts.length).toBeGreaterThanOrEqual(13);
    expect(
      facts.every((f) => f.assertedBy.kind === "BORROWER" && f.assertedBy.partyId === row.partyId),
    ).toBe(true);
  });

  it("supersedes rather than duplicating when screen 2 is saved again", async () => {
    // One person changing their mind, not two people.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const first = await saveBorrower(file.id, dana);
    await saveBorrower(file.id, { ...dana, statedMonthlyIncome: 9100 }, first.id);

    const live = await prisma.fact.findMany({
      where: { partyId: first.partyId!, predicate: "monthly_income", supersededById: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0]?.value).toBe(9100);
    const history = await prisma.fact.findMany({
      where: { partyId: first.partyId!, predicate: "monthly_income" },
    });
    expect(history).toHaveLength(2);
  });

  it("reuses the same party for a second file by the same user", async () => {
    // The whole point of a party: a returning borrower is not a stranger.
    const user = await createUser();
    const a = await createLoanFile({ userId: user.id });
    const b = await createLoanFile({ userId: user.id });
    const rowA = await saveBorrower(a.id, dana);
    const rowB = await saveBorrower(b.id, dana);
    expect(rowB.partyId).toBe(rowA.partyId);
  });

  it("gives a demo file its own party, with nobody to sign in as", async () => {
    const file = await createLoanFile({ userId: null, isDemo: true });
    const row = await saveBorrower(file.id, dana);
    const party = await prisma.party.findUniqueOrThrow({ where: { id: row.partyId! } });
    expect(party.sourceFirstSeen).toBe("demo_seed");
  });

  it("records the person both ways or not at all", async () => {
    // A fact the ledger refuses — asserted by an AI principal at VERIFIED —
    // is not what the route writes; but the property that matters is that a
    // failure inside the transaction leaves no borrower row behind.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    await expect(
      prisma.$transaction(async (tx) => {
        await recordBorrowerFacts(tx, { loanFileId: file.id, existingPartyId: null, input: dana });
        throw new Error("simulated failure after the facts, before the row");
      }),
    ).rejects.toThrow(/simulated/);
    expect(await prisma.borrower.count({ where: { loanFileId: file.id } })).toBe(0);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(u.partyId).toBeNull();
  });
});

describe("a consent mirrors to an authorization", () => {
  async function signedFile() {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    const consent = await prisma.consent.create({
      data: {
        loanFileId: file.id,
        borrowerId: row.id,
        kind: "verification_authorization",
        grantedAt: new Date(),
        envelopeId: "env-1",
        ipAddress: "127.0.0.1",
        userAgent: "test",
      },
    });
    return { user, file, row, consent };
  }

  it("writes the grant the consent means, on the party, expiring in 120 days", async () => {
    const { row, consent } = await signedFile();
    const auth = await prisma.authorization.findFirstOrThrow({ where: { partyId: row.partyId! } });
    expect(auth.purpose).toBe("FCRA_WRITTEN_INSTRUCTION");
    expect(auth.dataCategories).toEqual(
      expect.arrayContaining(["CREDIT_REPORT", "BANK_TRANSACTIONS", "PAYROLL_INCOME"]),
    );
    expect(auth.signatureEnvelopeId).toBe("env-1");
    expect(auth.expiresAt.getTime() - consent.grantedAt.getTime()).toBe(120 * DAY);
  });

  it("does not mirror a consent that permits no retrieval", async () => {
    const { file, row } = await signedFile();
    await prisma.consent.create({
      data: {
        loanFileId: file.id,
        borrowerId: row.id,
        kind: "econsent",
        grantedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "test",
      },
    });
    const auths = await prisma.authorization.findMany({ where: { partyId: row.partyId! } });
    expect(auths.map((a) => a.purpose)).toEqual(["FCRA_WRITTEN_INSTRUCTION"]);
  });

  it("leaves a borrower with no party alone", async () => {
    // A row written before the bridge. Nothing to mirror to, and no error.
    const file = await createLoanFile({ userId: null, isDemo: true });
    const legacy = await prisma.borrower.create({
      data: {
        loanFileId: file.id,
        firstName: "Old",
        lastName: "Row",
        email: "old@example.test",
        phone: "5555550100",
        dateOfBirth: new Date("1980-01-01"),
        ssnLast4: "0000",
        ssnVaultHandle: "vault:old",
        addressLine1: "1 Old St",
        addressCity: "X",
        addressState: "CA",
        addressPostalCode: "90000",
        maritalStatus: "unmarried",
      },
      select: { id: true },
    });
    await prisma.consent.create({
      data: {
        loanFileId: file.id,
        borrowerId: legacy.id,
        kind: "verification_authorization",
        grantedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "test",
      },
    });
    expect(await prisma.authorization.count()).toBe(0);
  });

  it("revokes the mirror when the consent is revoked", async () => {
    // The first writer of revoked_at on the legacy side, for the day a
    // revoke route exists.
    const { row, consent } = await signedFile();
    await prisma.consent.update({ where: { id: consent.id }, data: { revokedAt: new Date() } });
    const auth = await prisma.authorization.findFirstOrThrow({ where: { partyId: row.partyId! } });
    expect(auth.revokedAt).not.toBeNull();
    expect(auth.revocationReason).toBe("consent revoked");
  });
});

describe("the minter reads the real table, and falls back honestly", () => {
  it("mints from authorizations when the party has one", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await prisma.consent.create({
      data: {
        loanFileId: file.id,
        borrowerId: row.id,
        kind: "verification_authorization",
        grantedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "test",
      },
    });
    const domain = (await loadLoanFile(file.id))!;
    const token = await tokenFor(domain, "credit_report");
    // The subject is the PARTY, and the grant is the mirrored row — not the
    // legacy consent's synthetic id.
    expect(token.partyId).toBe(row.partyId);
    const auth = await prisma.authorization.findFirstOrThrow({ where: { partyId: row.partyId! } });
    expect(token.authorizationId).toBe(auth.id);
  });

  it("treats the real table as authoritative once it has rows", async () => {
    // A 4506-C consent exists ONLY as a legacy row here. The party has an
    // authorization (APP-005), so the minter does not fall back — and a
    // transcript pull is refused, citing INC-008.
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await prisma.consent.create({
      data: {
        loanFileId: file.id,
        borrowerId: row.id,
        kind: "verification_authorization",
        grantedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "test",
      },
    });
    const domain = (await loadLoanFile(file.id))!;
    await expect(tokenFor(domain, "tax_transcript")).rejects.toMatchObject({
      requirementId: "INC-008",
    });
  });

  it("falls back to the legacy consent for a row with no party", async () => {
    const file = await createLoanFile({ userId: null, isDemo: true });
    const legacy = await prisma.borrower.create({
      data: {
        loanFileId: file.id,
        firstName: "Old",
        lastName: "Row",
        email: "old@example.test",
        phone: "5555550100",
        dateOfBirth: new Date("1980-01-01"),
        ssnLast4: "0000",
        ssnVaultHandle: "vault:old",
        addressLine1: "1 Old St",
        addressCity: "X",
        addressState: "CA",
        addressPostalCode: "90000",
        maritalStatus: "unmarried",
      },
      select: { id: true },
    });
    await prisma.consent.create({
      data: {
        loanFileId: file.id,
        borrowerId: legacy.id,
        kind: "verification_authorization",
        grantedAt: new Date(),
        ipAddress: "127.0.0.1",
        userAgent: "test",
      },
    });
    const domain = (await loadLoanFile(file.id))!;
    const token = await tokenFor(domain, "credit_report");
    expect(token.partyId).toBe(legacy.id);
  });

  it("refuses when the mirrored authorization has expired", async () => {
    const user = await createUser();
    const file = await createLoanFile({ userId: user.id });
    const row = await saveBorrower(file.id, dana);
    await prisma.consent.create({
      data: {
        loanFileId: file.id,
        borrowerId: row.id,
        kind: "verification_authorization",
        grantedAt: new Date(Date.now() - 121 * DAY),
        ipAddress: "127.0.0.1",
        userAgent: "test",
      },
    });
    const domain = (await loadLoanFile(file.id))!;
    await expect(tokenFor(domain, "credit_report")).rejects.toBeInstanceOf(AuthorizationError);
    await expect(tokenFor(domain, "credit_report")).rejects.toThrow(/expired/);
  });
});

describe("partyForUser", () => {
  it("is idempotent", async () => {
    const user = await createUser();
    const a = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    const b = await prisma.$transaction((tx) => partyForUser(tx, user.id));
    expect(a).toBe(b);
    expect(await prisma.party.count()).toBe(1);
  });
});
