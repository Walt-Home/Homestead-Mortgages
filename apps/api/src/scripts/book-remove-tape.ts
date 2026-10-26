/**
 * Take one tape off a servicer's book, from a shell.
 *
 *   npm run book:remove-tape -- <slug>                       list the book's tapes and what each would remove
 *   npm run book:remove-tape -- <slug> <tapeId> <loans> --reason "<why>" --by "<name>"
 *                                                           take it back
 *
 * The console's "Remove this tape…" on a servicer's page is the way a
 * person does this; this is the same `removeTape`, for a book an admin
 * has to set right before anyone can sign in to it, or from a deploy's
 * shell. The count is the number of loans the removal deletes, as the
 * listing names it, and a removal with any other count is refused. The
 * removal row names whoever `--by` says, under the id `cli`, so nobody
 * reading the book's removals takes it for a console session.
 */

import { prisma } from "@hm/db";
import { bookTapes, removeTape } from "../services/tape-removal.js";

function flag(args: string[], name: string): string | null {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [slug, tapeId, loans] = args;
  if (!slug) {
    console.error(
      'usage: npm run book:remove-tape -- <slug> [<tapeId> <loans> --reason "<why>" --by "<name>"]',
    );
    process.exit(2);
  }
  if (!tapeId) {
    const book = await bookTapes(slug);
    console.log(`${book.servicer.displayName}: ${book.loansOnBook} loan(s) on the book`);
    for (const t of book.tapes) {
      console.log(
        `  ${t.id}  ${t.filename ?? "(no file name)"}  as of ${t.asOf}, loaded ${t.loadedAt}: ` +
          `${t.loansCreated} new, ${t.duplicates} duplicate(s); removes ${t.removes.loans} loan(s)` +
          (t.removable.ok ? "" : ` — cannot be removed: ${t.removable.reasons.join(" ")}`),
      );
    }
    console.log(
      `  check: ${book.check.created} made − ${book.check.removed} removed = ${book.check.loansOnBook}` +
        (book.check.adds ? "" : " (DOES NOT ADD UP)"),
    );
    return;
  }
  const reason = flag(args, "--reason");
  const by = flag(args, "--by");
  if (!loans || !/^\d+$/.test(loans) || !reason || !by) {
    console.error("A removal needs the loan count, --reason and --by.");
    process.exit(2);
  }
  const done = await removeTape({
    slug,
    tapeId,
    confirmLoans: Number(loans),
    reason,
    staff: { id: "cli", legalName: by },
  });
  const r = done.removal;
  console.log(
    `Removed ${r.filename ?? r.tapeId} (as of ${r.asOf}): ${r.loansRemoved} loan(s), ` +
      `${r.observationsRemoved} observation(s). ${done.loansOnBook} loan(s) on the book now.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
