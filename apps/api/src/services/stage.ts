/**
 * Flow stage, which only ever moves forward.
 *
 * The stage is what "resume where you left off" reads, and what decides which
 * steps a person may click back to. Every connector route used to set it
 * directly, which meant revisiting an earlier screen and re-running it dragged
 * the whole flow backwards — you would connect your bank again to look at it,
 * and land back on the payroll step having already done payroll.
 *
 * So stage is a HIGH-WATER MARK, not a cursor. Where you are is the URL; how
 * far you have got is this.
 */

import { prisma } from "@hm/db";
import type { FlowStage } from "@hm/db";

/** Flow order. The index is the only thing that makes "forward" meaningful. */
export const STAGE_ORDER: readonly FlowStage[] = [
  "PROPERTY_LOAN",
  "IDENTITY",
  "CREDIT",
  "DECLARATIONS",
  "BANK",
  "PAYROLL",
  "IRS_TRANSCRIPT",
  "UPLOAD_FALLBACK",
  "DECISION",
  "PERSISTENT_CONSENT",
  "COMPLETE",
];

export function stageIndex(stage: FlowStage): number {
  const i = STAGE_ORDER.indexOf(stage);
  // An unknown stage sorting last would silently mark a file complete. Sorting
  // first is the safe direction: it can only ever be advanced past.
  return i === -1 ? 0 : i;
}

/**
 * Advance to `stage` only if it is further along than where the file already
 * is. Returns the stage the file ends up at.
 *
 * ONE statement, not a read followed by a write. The read-then-write version
 * looked correct and lost races: two connector callbacks landing together both
 * read the old stage, both decided they were moving forward, and the slower
 * write won — leaving the file at the LESSER of the two stages, which is the
 * exact rewind this function exists to prevent. It is not a rare interleaving
 * either; it is what happens whenever a borrower finishes two connectors at
 * once. A test against a real Postgres caught it on the first run.
 *
 * The guard is `WHERE stage IN (everything earlier than the target)`, evaluated
 * by Postgres under the row lock, so whichever transaction goes second sees the
 * other's stage and matches nothing.
 */
export async function advanceStage(loanFileId: string, stage: FlowStage): Promise<FlowStage> {
  const earlier = STAGE_ORDER.slice(0, stageIndex(stage));

  // An empty list means the target is the first stage, or is not in the order
  // at all — either way nothing can advance TO it, and `updateMany` with an
  // empty `in` matches no rows rather than every row.
  if (earlier.length > 0) {
    const { count } = await prisma.loanFile.updateMany({
      where: { id: loanFileId, stage: { in: earlier } },
      data: { stage },
    });
    if (count === 1) return stage;
  }

  // We did not move it. Either it is already at or past `stage`, or it is gone.
  const file = await prisma.loanFile.findUnique({
    where: { id: loanFileId },
    select: { stage: true },
  });
  return file?.stage ?? stage;
}
