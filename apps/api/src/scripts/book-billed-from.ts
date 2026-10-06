/**
 * Move the day a servicer's book is billed from.
 *
 *   npm run book:billed-from -- <slug> <YYYY-MM-DD>          loans billed from a later day than this
 *   npm run book:billed-from -- <slug> <YYYY-MM-DD> --all    every loan on the book
 *
 * For a tape that was loaded late. The desk takes the month a tape is for
 * since 6 October 2026, but the first real book reached production before
 * it did: Grander's September tape, loaded on 5 October, was billed from 5
 * October. This sets `loans.watched_from`, which the meter reads, and
 * prints what it changed; the statements already closed are not touched,
 * because a closed statement is what was invoiced. Without `--all`, a
 * loan already billed from an earlier day keeps it.
 */

import { prisma } from "@hm/db";

async function main(): Promise<void> {
  const [slug, day, flag] = process.argv.slice(2);
  if (!slug || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || (flag && flag !== "--all")) {
    console.error("usage: npm run book:billed-from -- <slug> <YYYY-MM-DD> [--all]");
    process.exit(2);
  }
  const from = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) throw new Error(`${day} is not a day`);
  const servicer = await prisma.servicer.findUnique({
    where: { slug },
    select: { id: true, displayName: true },
  });
  if (!servicer) throw new Error(`no servicer with slug ${slug}`);
  const where = {
    servicerId: servicer.id,
    servicerLoanNumber: { not: null },
    ...(flag === "--all" ? {} : { OR: [{ watchedFrom: null }, { watchedFrom: { gt: from } }] }),
  };
  const before = await prisma.loan.groupBy({
    by: ["watchedFrom"],
    where,
    _count: { _all: true },
    orderBy: { watchedFrom: "asc" },
  });
  for (const row of before) {
    console.log(
      `${row._count._all} loan(s) billed from ${row.watchedFrom?.toISOString().slice(0, 10) ?? "the load day"}`,
    );
  }
  const changed = await prisma.loan.updateMany({ where, data: { watchedFrom: from } });
  console.log(`${servicer.displayName}: ${changed.count} loan(s) now billed from ${day}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
