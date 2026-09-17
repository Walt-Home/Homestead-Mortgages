/**
 * How title will read, and how it reads now.
 *
 * URLA L2.1 is the name that will be on title once the loan closes — one
 * sentence, verbatim, "Andy America and Amy America" — and L2.4 is how those
 * names hold it. L2.2 is the same sentence for the title as it stands, which
 * only a refinance has. Both are facts about the deal rather than about a
 * person, so they live on the application as `du_vestings` rows, one per
 * status, and the file carries them beside `estateType`.
 *
 * Whole set or nothing: a save states the proposed vesting and either states
 * or clears the current one, the way the residences are written.
 */

import { prisma } from "@hm/db";
import type { TitleVesting, VestingType } from "@hm/shared";
import { AppError } from "../middleware/error-handler.js";
import { ownsTransaction, type Db } from "./db.js";

export interface VestingInput {
  readonly proposed: { readonly fullName: string; readonly vestingType: VestingType | null };
  readonly current?: { readonly fullName: string; readonly vestingType: VestingType | null } | null;
}

/** What the file carries: Current before Proposed, deterministically. */
export async function vestingsOnFile(loanFileId: string, db: Db = prisma): Promise<TitleVesting[]> {
  const rows = await db.duVesting.findMany({
    where: { application: { loanFileId } },
    orderBy: { status: "asc" },
    select: { status: true, fullName: true, vestingType: true },
  });
  return rows.map((r) => ({ status: r.status, fullName: r.fullName, vestingType: r.vestingType }));
}

export async function recordVesting(
  loanFileId: string,
  input: VestingInput,
  db: Db = prisma,
): Promise<TitleVesting[]> {
  if (ownsTransaction(db)) {
    try {
      return await prisma.$transaction((tx) => recordVesting(loanFileId, input, tx));
    } catch (err) {
      // The deferred ten-party trigger fires at COMMIT, outside any row's
      // write, and its sentence is Postgres's. A full household is a refusal
      // rather than a fault.
      if (err instanceof Error && /DEAL\/PARTIES\/PARTY is 1:10/.test(err.message)) {
        throw new AppError(
          409,
          "This application already carries the ten parties Desktop Underwriter allows.",
          "PARTY_CEILING",
        );
      }
      throw err;
    }
  }
  const application = await db.application.findUnique({
    where: { loanFileId },
    select: { id: true },
  });
  if (!application)
    throw new AppError(409, "This file is not an application yet.", "NO_APPLICATION");

  await db.duVesting.upsert({
    where: { applicationId_status: { applicationId: application.id, status: "Proposed" } },
    create: {
      applicationId: application.id,
      status: "Proposed",
      fullName: input.proposed.fullName,
      vestingType: input.proposed.vestingType,
    },
    update: { fullName: input.proposed.fullName, vestingType: input.proposed.vestingType },
  });
  if (input.current) {
    await db.duVesting.upsert({
      where: { applicationId_status: { applicationId: application.id, status: "Current" } },
      create: {
        applicationId: application.id,
        status: "Current",
        fullName: input.current.fullName,
        vestingType: input.current.vestingType,
      },
      update: { fullName: input.current.fullName, vestingType: input.current.vestingType },
    });
  } else {
    await db.duVesting.deleteMany({ where: { applicationId: application.id, status: "Current" } });
  }
  return vestingsOnFile(loanFileId, db);
}
