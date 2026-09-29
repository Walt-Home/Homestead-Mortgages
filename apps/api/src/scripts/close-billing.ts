/**
 * Close the billing month: one statement per servicer for the month that
 * has ended, computed off the tape by the price sheet and kept for good.
 *
 *   npm run billing:close              the month before this one
 *   npm run billing:close -- 2026-09   a named month (a second run writes nothing)
 *
 * What the scheduled Cloud Run job runs on the first of each month. One
 * line per servicer closed, one per servicer already closed, and a
 * summary; exits non-zero only when the run itself failed — a month still
 * running is a refusal the job should never meet, and is reported as one.
 */

import { prisma } from "@hm/db";
import { closeBillingMonth, monthFromKey } from "../services/billing.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const month = arg ? monthFromKey(arg) : undefined;
  const report = await closeBillingMonth({ month, closedBy: "job" });
  for (const c of report.closed) {
    console.log(
      `closed ${report.month} for ${c.slug}: ${c.tokens} tokens, $${(Number(c.cents) / 100).toFixed(2)}`,
    );
  }
  for (const slug of report.alreadyClosed) {
    console.log(`already closed ${report.month} for ${slug}`);
  }
  console.log(
    `closed ${report.month} for ${report.closed.length} servicer(s); ${report.alreadyClosed.length} already closed`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
