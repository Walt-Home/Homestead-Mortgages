/**
 * Reconcile invoices with the payment provider: retry every delivery that
 * could not be acted on, then read every invoice that can still move and
 * bring its row in line.
 *
 *   npm run billing:reconcile
 *
 * What the scheduled Cloud Run job runs each hour. The provider retries a
 * delivery for three days and then stops; this is what makes the fourth
 * day safe, and what catches a payment taken back after an invoice was
 * paid. Exits non-zero when something could not be reconciled, so the
 * job's alert means a person should look; a draft the provider never
 * answered for is reported and is not a failure, because pressing Draft
 * again resumes it.
 */

import { prisma } from "@hm/db";
import { invoicingStanding, reconcileInvoices } from "../services/billing-invoices.js";

async function main(): Promise<void> {
  const standing = invoicingStanding();
  const report = await reconcileInvoices();
  console.log(
    `reconciled with ${standing.provider}: ` +
      `${report.events.retried} event(s) retried, ${report.events.settled} settled, ` +
      `${report.events.stillFailing} still failing; ` +
      `${report.invoices.checked} invoice(s) read, ${report.invoices.changed} changed, ` +
      `${report.invoices.failed} could not be read`,
  );
  for (const id of report.stranded) {
    console.log(`stranded draft ${id}: the provider never answered; Draft it again to resume`);
  }
  if (report.events.stillFailing > 0 || report.invoices.failed > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
