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
