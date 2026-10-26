/**
 * Spell a servicer's stored loan numbers as digits.
 *
 *   npm run book:renumber -- <slug>                         say what would change, change nothing
 *   npm run book:renumber -- <slug> --apply                 rewrite the ones that can be, in one transaction
 *   npm run book:renumber -- <slug> --point-zero [--apply]  and the whole numbers stored with ".0" too
 *
 * For a book loaded before the reader spelled numbers plainly. A tape
 * written by a spreadsheet writer that stores loan numbers as numbers
 * reached production on 26 October 2026 with every number in scientific
 * notation ("1.002027994E9"), and the reader kept the stored text, so the
 * loans it made carry that spelling and next month's tape — read as
 * digits now — would match none of them. This rewrites
 * `loans.servicer_loan_number` to the digits wherever no other loan on the
 * book already has them, and lists the ones where another does: two loans
 * for one mortgage, which a person settles, usually by taking a tape back
 * at the desk. A number that differs by more than notation (a dash, a
 * space, a leading zero) is listed and left as written.
 *
 * The same writer stores a number below 10^7 as "1234567.0", and a
 * workbook's reader now drops the ".0". Those are listed and left unless
 * `--point-zero` says the book came from workbooks: a CSV is read as
 * written, and a servicer whose CSVs say ".0" means it. The observations
 * keep what each tape said. See `services/loan-numbers.ts`.
 */

import { prisma } from "@hm/db";
import { renumberBook } from "../services/loan-numbers.js";

const SHOWN = 20;
const FLAGS = new Set(["--apply", "--point-zero"]);

async function main(): Promise<void> {
  const [slug, ...flags] = process.argv.slice(2);
  if (!slug || slug.startsWith("--") || flags.some((f) => !FLAGS.has(f))) {
    console.error("usage: npm run book:renumber -- <slug> [--point-zero] [--apply]");
    process.exit(2);
  }
  const r = await renumberBook({
    slug,
    apply: flags.includes("--apply"),
    pointZero: flags.includes("--point-zero"),
  });
  console.log(`${r.servicer.displayName}: ${r.loansOnBook} loan(s) on the book`);
  console.log(`${r.spelledDifferently} loan number(s) the reader would spell differently today`);
  console.log(`${r.renumberable.length} to rewrite, with digits no other loan has`);
  for (const p of r.renumberable.slice(0, SHOWN)) console.log(`  ${p.number} -> ${p.plain}`);
  if (r.renumberable.length > SHOWN) console.log(`  … and ${r.renumberable.length - SHOWN} more`);
  console.log(
    `${r.collisions.length} whose digits another loan on the book already has (left as written)`,
  );
  for (const p of r.collisions) {
    const others = p.collidesWith.map((o) => `${o.number} (${o.loanId})`).join(", ");
    console.log(`  ${p.number} (${p.loanId}) -> ${p.plain}, already ${others}`);
  }
  if (r.pointZeroKept.length > 0) {
    console.log(
      `${r.pointZeroKept.length} whole number(s) stored with ".0" (left as written; --point-zero rewrites them)`,
    );
    for (const p of r.pointZeroKept.slice(0, SHOWN)) console.log(`  ${p.number} -> ${p.plain}`);
  }
  if (r.keptAsWritten.length > 0) {
    console.log(`${r.keptAsWritten.length} differing by more than notation (left as written)`);
    for (const k of r.keptAsWritten.slice(0, SHOWN)) console.log(`  ${k.number} (${k.plain})`);
  }
  console.log(
    r.applied
      ? `${r.renumbered} loan number(s) rewritten`
      : "Dry run: nothing was written. Run again with --apply to rewrite.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
