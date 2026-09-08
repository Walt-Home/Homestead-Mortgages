/**
 * Rows to test against.
 *
 * Deliberately minimal: each factory sets the columns the schema requires and
 * nothing else, so a test that cares about a field has to say so, and a
 * migration that adds a required column breaks the factory rather than
 * silently giving every test a default nobody chose.
 */

import { prisma } from "@hm/db";
import type { FlowStage } from "@hm/db";
import { recordBorrowerFacts, type BorrowerInput } from "../../services/party.js";

let seq = 0;
const unique = () => `${Date.now().toString(36)}-${(seq += 1)}`;

export async function createUser(): Promise<{ id: string; email: string }> {
  const tag = unique();
  const user = await prisma.user.create({
    data: { googleSub: `sub-${tag}`, email: `person-${tag}@example.test` },
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
