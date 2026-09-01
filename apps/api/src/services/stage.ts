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
 */
export async function advanceStage(loanFileId: string, stage: FlowStage): Promise<FlowStage> {
  const file = await prisma.loanFile.findUnique({
    where: { id: loanFileId },
    select: { stage: true },
  });
  if (!file) return stage;
  if (stageIndex(stage) <= stageIndex(file.stage)) return file.stage;

  const updated = await prisma.loanFile.update({
    where: { id: loanFileId },
    data: { stage },
    select: { stage: true },
  });
  return updated.stage;
}
