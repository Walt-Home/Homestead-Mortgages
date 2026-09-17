/**
 * Submit one application to Desktop Underwriter by hand, or again.
 *
 *   npm run du:submit --workspace=@hm/api -- <loanFileId>
 *
 * The decision route submits on its own after every decision. This is for an
 * operator: a resubmission after a refusal was resolved, or a first submission
 * on a file decided before the route did it. It goes through the same service,
 * so a resubmission carries the casefile id DU minted the first time and one
 * loan does not open two cases. Nothing here prints the document.
 */

import { prisma } from "@hm/db";
import { loadLoanFile } from "../services/repository.js";
import { submitApplicationToDu } from "../services/du-submission.js";

async function main(): Promise<void> {
  const loanFileId = process.argv[2];
  if (!loanFileId) {
    console.error("usage: du:submit <loanFileId>");
    process.exitCode = 2;
    return;
  }
  const file = await loadLoanFile(loanFileId);
  if (!file) {
    console.error(`no loan file ${loanFileId}`);
    process.exitCode = 1;
    return;
  }
  const outcome = await submitApplicationToDu({ loanFileId, file, now: new Date() });
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.status === "refused" || outcome.status === "failed") process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
