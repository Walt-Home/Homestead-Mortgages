/**
 * Review every monitored loan for the day, once.
 *
 *   npm run review:run                 today, in the creditor's zone
 *   npm run review:run -- 2026-09-22   a named day (a re-run writes nothing)
 *
 * What the scheduled Cloud Run job runs each morning, and what the deploy
 * runs once after the seed so a fresh deployment has a verdict on every
 * monitored loan before anyone looks. One line per loan reviewed, one per
 * loan skipped with the reason, and a summary; exits non-zero only when the
 * run itself failed, because a loan the tape cannot describe is a fact to
 * report and not a reason to stop the others.
 */

import { prisma } from "@hm/db";
import { plainDate } from "@hm/kernel/calendar";
import { reviewMonitoredLoans, todayEt } from "../services/loan-review.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const asOf = arg ? plainDate(arg) : todayEt();
  const report = await reviewMonitoredLoans({ asOf });
  for (const r of report.reviewed) {
    const rate = r.candidateRatePct ? ` at ${r.candidateRatePct}` : "";
    console.log(
      `review ${r.servicerLoanNumber ?? r.loanId} ${r.verdict}${rate} [${r.reasons.join(", ")}]`,
    );
  }
  for (const s of report.skipped) {
    console.log(`skipped ${s.servicerLoanNumber ?? s.loanId}: ${s.reason}`);
  }
  const analystSkips = Object.entries(report.analyst.skipped)
    .map(([why, n]) => `${n} ${why}`)
    .join(", ");
  console.log(
    `reviewed ${report.reviewed.length} of ${report.monitored} monitored loans as of ${report.asOf}; ` +
      `${report.alreadyReviewed} already reviewed today; ${report.skipped.length} skipped; ` +
      `${report.offersOpened} offers opened, ${report.offersExpired} lapsed; ` +
      `analyst wrote ${report.analyst.written}${analystSkips ? ` (skipped: ${analystSkips})` : ""}`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
