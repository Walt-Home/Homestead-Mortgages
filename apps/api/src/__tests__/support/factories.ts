/**
 * Rows to test against.
 *
 * Deliberately minimal: each factory sets the columns the schema requires and
 * nothing else, so a test that cares about a field has to say so, and a
 * migration that adds a required column breaks the factory rather than
 * silently giving every test a default nobody chose.
 */

import { prisma } from "@hm/db";
import type { ApplicationPartyRole, FlowStage, PartyClaimStatus } from "@hm/db";
import { createImportedLoan } from "../../services/loans.js";
import { recordBorrowerFacts, type BorrowerInput } from "../../services/party.js";

let seq = 0;
const unique = () => `${Date.now().toString(36)}-${(seq += 1)}`;

export async function createUser(
  data: { personaKey?: string; name?: string } = {},
): Promise<{ id: string; email: string }> {
  const tag = unique();
  const user = await prisma.user.create({
    data: {
      googleSub: `sub-${tag}`,
      email: `person-${tag}@example.test`,
      ...(data.personaKey ? { personaKey: data.personaKey } : {}),
      ...(data.name ? { name: data.name } : {}),
    },
    select: { id: true, email: true },
  });
  return user;
}

export async function createLoanFile(
  data: { userId?: string | null; isDemo?: boolean; stage?: FlowStage } = {},
): Promise<{ id: string }> {
  return prisma.loanFile.create({
    data: {
      userId: data.userId ?? null,
      isDemo: data.isDemo ?? false,
      ...(data.stage ? { stage: data.stage } : {}),
    },
    select: { id: true },
  });
}

/** Screen 2, as the route does it: facts on the party, and the row, in one transaction. */
export async function saveBorrower(loanFileId: string, input: BorrowerInput, existingId?: string) {
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
      currentHousing: input.currentHousing,
      monthlyRent: input.monthlyRent ?? null,
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
      data: { ...data, loanFileId, ssnLast4: "0000" },
      select: { id: true, partyId: true },
    });
  });
}

/** A consent row on a file, which the trigger mirrors to the party's grant. */
export async function consent(
  loanFileId: string,
  borrowerId: string,
  kind: string,
  grantedAt = new Date(),
) {
  return prisma.consent.create({
    data: {
      loanFileId,
      borrowerId,
      kind,
      grantedAt,
      envelopeId: `env-${kind}`,
      ipAddress: "127.0.0.1",
      userAgent: "test",
    },
  });
}

/**
 * A person the product knows about, with or without a sign-in behind them.
 *
 * Bare, this takes the column default, which is PROVISIONAL — a record a
 * partner told us about, not somebody who has agreed to be here. A test that
 * grants an authorization has to pass `claimStatus: "CLAIMED"`, or
 * `authorizations_require_a_claimed_party` refuses the insert.
 */
export async function createParty(
  data: { claimStatus?: PartyClaimStatus; sourceFirstSeen?: string } = {},
): Promise<{ id: string }> {
  return prisma.party.create({
    data: {
      kind: "PERSON",
      ...(data.claimStatus ? { claimStatus: data.claimStatus } : {}),
      ...(data.sourceFirstSeen ? { sourceFirstSeen: data.sourceFirstSeen } : {}),
    },
    select: { id: true },
  });
}

/**
 * A mortgage a servicer told us about, with the given people on it.
 *
 * Through the constructor rather than `prisma.loan.create`, so a test that
 * starts from a loan starts from one the product could have made: born
 * `imported_unclaimed`, at seq 0, with its parties written in the same act.
 */
export async function importedLoan(
  parties: readonly { partyId: string; role?: ApplicationPartyRole }[],
  overrides: { servicerId?: string | null } = {},
): Promise<{ id: string }> {
  const { loanId } = await createImportedLoan(prisma, {
    terms: {
      rateType: "FIXED",
      noteRateBps: 625,
      termMonths: 360,
      originalPrincipalCents: 41_600_000n,
      originatedOn: new Date("2021-06-01"),
    },
    property: { line1: "42 Oak Street", city: "Demo City", state: "CA", postalCode: "94000" },
    // What a feed that did not say looks like. Nothing may infer one.
    axes: {},
    parties: parties.map((p) => ({ partyId: p.partyId, role: p.role ?? "PRIMARY_BORROWER" })),
    servicerId: overrides.servicerId ?? null,
  });
  return { id: loanId };
}
