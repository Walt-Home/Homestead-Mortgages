/**
 * A loan number is digits, however a file spelled it.
 *
 * A servicer's loan number is how the next tape finds a loan again, and it
 * is matched as written. On 26 October 2026 a re-exported tape carried its
 * numbers in scientific notation — "1.002027994E9" for 1002027994 — because
 * the spreadsheet writer that made it stored them as numbers, and the
 * reader kept the stored text. None of its 245 loans matched the ones the
 * first copy of the tape had made, and every one was made a second time.
 *
 * The reader now spells a number plainly (`plainLoanNumber` in
 * `@hm/partner-book`). What is here is the book's side of it:
 *
 *   - a near duplicate is a loan on a tape whose number is not on the book
 *     as written but is in another spelling of the same digits; the preview
 *     names them and a load with any is refused unless the person loading
 *     says they are meant (`TAPE_NEAR_DUPLICATES`)
 *   - the numbers already stored in scientific notation are rewritten to
 *     their digits by `npm run book:renumber`, one transaction, never where
 *     that would make two loans one number; the observations keep what each
 *     tape said, because they are the record of it. A whole number stored
 *     with ".0" — a Java writer's double below 10^7 — is listed, and
 *     rewritten only when the person running it says the book came from
 *     workbooks (`--point-zero`), since a CSV may say ".0" on purpose
 */

import { prisma } from "@hm/db";
import { plainLoanNumber, readLoanNumber } from "@hm/partner-book";
import { AppError } from "../middleware/error-handler.js";
import { lockBook } from "./book-lock.js";
import { type Db, ownsTransaction } from "./db.js";

/**
 * The key two spellings of one loan number share: its plain digits when it
 * has them, and the number as written when it does not — a number with
 * letters in it is compared as itself.
 */
export const loanNumberKey = (number: string): string => plainLoanNumber(number) ?? number.trim();

/** One tape row whose number is a loan already on the book, spelled another way. */
export interface NearDuplicate {
  readonly row: number;
  /** The number as this tape spells it. */
  readonly number: string;
  /** The number as the book holds it. */
  readonly onBook: string;
}

export interface NearDuplicates {
  readonly count: number;
  /** The first few hundred, in tape order; `count` is all of them. */
  readonly rows: readonly NearDuplicate[];
}

export const NEAR_DUPLICATES_SHOWN = 200;

/** Every loan number on a servicer's book, as written. One query, one column. */
async function numbersOnBook(db: Db, servicerId: string): Promise<string[]> {
  const loans = await db.loan.findMany({
    where: { servicerId, servicerLoanNumber: { not: null } },
    select: { servicerLoanNumber: true },
  });
  return loans.map((l) => l.servicerLoanNumber!);
}

/**
 * The loans on a tape that the book already holds under another spelling.
 * A number on the book exactly as the tape writes it is the same loan and
 * an update, and is not counted; a number nobody holds in any spelling is
 * a new loan. Null servicer, no book, nothing near.
 */
export async function nearDuplicatesOnBook(
  db: Db,
  servicerId: string | null,
  rows: readonly { readonly row: number; readonly number: string }[],
): Promise<NearDuplicates> {
  if (!servicerId || rows.length === 0) return { count: 0, rows: [] };
  const held = await numbersOnBook(db, servicerId);
  const exact = new Set(held);
  // Key → the spelling the book holds, preferring one already plain.
  const byKey = new Map<string, string>();
  for (const n of held) {
    const key = loanNumberKey(n);
    const prior = byKey.get(key);
    if (prior === undefined || (prior !== key && n === key)) byKey.set(key, n);
  }
  const near: NearDuplicate[] = [];
  for (const r of rows) {
    if (exact.has(r.number)) continue;
    const onBook = byKey.get(loanNumberKey(r.number));
    if (onBook !== undefined) near.push({ row: r.row, number: r.number, onBook });
  }
  return { count: near.length, rows: near.slice(0, NEAR_DUPLICATES_SHOWN) };
}

/** The refusal a load meets when its tape carries loans the book holds under another spelling. */
export function nearDuplicateRefusal(near: NearDuplicates): AppError {
  const first = near.rows[0];
  const example = first
    ? ` Row ${first.row}, ${first.number}, is ${first.onBook} on the book.`
    : "";
  return new AppError(
    409,
    `${near.count} loan${near.count === 1 ? "" : "s"} on this tape ${near.count === 1 ? "is" : "are"} already on the book under another spelling of the number.${example} Nothing was loaded.`,
    "TAPE_NEAR_DUPLICATES",
    { nearDuplicates: near },
  );
}

/* ── renumbering a book stored as a writer's doubles ──────────────────── */

/** A number written as a mantissa and a power of ten, the way a spreadsheet writer stores a double. */
const SCIENTIFIC = /^\s*[+-]?\d+(?:\.\d+)?[eE][+-]?\d+\s*$/;

/**
 * A whole number and ".0" — how a Java writer stores a double below 10^7.
 * Never with a leading zero, which no stored number has.
 */
const POINT_ZERO = /^\s*(?:0|[1-9]\d*)\.0+\s*$/;

export interface RenumberPair {
  readonly loanId: string;
  readonly number: string;
  readonly plain: string;
  /** The other loans on the book whose number reads as the same digits. */
  readonly collidesWith: readonly { readonly loanId: string; readonly number: string }[];
}

export interface RenumberReport {
  readonly servicer: { readonly slug: string; readonly displayName: string };
  readonly loansOnBook: number;
  /** Loans whose number the reader would spell differently today. */
  readonly spelledDifferently: number;
  /**
   * Of those, the ones whose difference is more than notation — a dash, a
   * space, a leading zero. The servicer may well write them that way on
   * every tape, so they are reported and left as written.
   */
  readonly keptAsWritten: readonly {
    readonly loanId: string;
    readonly number: string;
    readonly plain: string;
  }[];
  /**
   * Whole numbers stored with a ".0", left as written because `pointZero`
   * was not asked for. A workbook's reader spells them without it now, so a
   * book loaded from a Java writer's workbook holds them; a CSV is read as
   * written, so a servicer whose CSVs say ".0" holds them too, rightly.
   * Which one a book is, a person says. Empty when `pointZero` was asked for.
   */
  readonly pointZeroKept: readonly RenumberPair[];
  /** Numbers to rewrite whose digits no other loan on the book has. */
  readonly renumberable: readonly RenumberPair[];
  /** Numbers to rewrite whose digits another loan on the book already has. */
  readonly collisions: readonly RenumberPair[];
  readonly applied: boolean;
  /** Rows rewritten; zero on a dry run. */
  readonly renumbered: number;
}

/**
 * Spell a servicer's stored loan numbers the way the reader spells a
 * workbook's stored number now.
 *
 * Scientific notation is always rewritten: the reader can no longer make
 * it from either kind of file, so a number in it is a tape's from before.
 * A whole number with ".0" is rewritten only with `pointZero`, because a
 * CSV is still read as written and may say ".0" on every tape. Each is
 * rewritten to what `readLoanNumber` makes of it from a workbook, and only
 * where no other loan has those digits already.
 *
 * Dry by default: what would change, and which numbers would land on a
 * loan the book already has under the same digits — those are two loans
 * for one mortgage, a thing for a person to settle (usually by taking one
 * tape back), and are never rewritten. With `apply`, the book is held
 * (`book-lock.ts`), read, and the rest rewritten in one statement in that
 * one transaction. Only `loans.servicer_loan_number` moves: the
 * observations are what each tape said and stay as they were.
 */
export async function renumberBook(
  args: { readonly slug: string; readonly apply: boolean; readonly pointZero?: boolean },
  db: Db = prisma,
): Promise<RenumberReport> {
  if (args.apply && ownsTransaction(db)) {
    return prisma.$transaction((tx) => renumberBook(args, tx), {
      maxWait: 10_000,
      timeout: 120_000,
    });
  }
  const servicer = await db.servicer.findUnique({
    where: { slug: args.slug },
    select: { id: true, slug: true, displayName: true },
  });
  if (!servicer) throw new AppError(404, `No servicer goes by ${args.slug}.`, "NOT_FOUND");
  // Nothing loads onto or takes from the book between this read and the write.
  if (args.apply) await lockBook(db, servicer.id);
  const loans = await db.loan.findMany({
    where: { servicerId: servicer.id, servicerLoanNumber: { not: null } },
    select: { id: true, servicerLoanNumber: true },
    orderBy: { servicerLoanNumber: "asc" },
  });
  const byKey = new Map<string, { loanId: string; number: string }[]>();
  for (const l of loans) {
    const key = loanNumberKey(l.servicerLoanNumber!);
    const group = byKey.get(key) ?? [];
    group.push({ loanId: l.id, number: l.servicerLoanNumber! });
    byKey.set(key, group);
  }
  const keptAsWritten: { loanId: string; number: string; plain: string }[] = [];
  const pointZeroKept: RenumberPair[] = [];
  const renumberable: RenumberPair[] = [];
  const collisions: RenumberPair[] = [];
  let spelledDifferently = 0;
  for (const l of loans) {
    const number = l.servicerLoanNumber!;
    const plain = plainLoanNumber(number);
    if (plain === null || plain === number) continue;
    spelledDifferently += 1;
    const pointZero = POINT_ZERO.test(number);
    const read = SCIENTIFIC.test(number) || pointZero ? readLoanNumber(number, "xlsx") : null;
    if (typeof read !== "string") {
      keptAsWritten.push({ loanId: l.id, number, plain });
      continue;
    }
    const others = (byKey.get(loanNumberKey(read)) ?? []).filter((o) => o.loanId !== l.id);
    const pair = { loanId: l.id, number, plain: read, collidesWith: others };
    if (pointZero && !args.pointZero) pointZeroKept.push(pair);
    else (others.length > 0 ? collisions : renumberable).push(pair);
  }

  let renumbered = 0;
  if (args.apply && renumberable.length > 0) {
    const ids = renumberable.map((p) => p.loanId);
    const plains = renumberable.map((p) => p.plain);
    renumbered = await db.$executeRaw`
      UPDATE "loans" AS l
         SET "servicer_loan_number" = v.plain, "updated_at" = now()
        FROM (SELECT unnest(${ids}::uuid[]) AS id, unnest(${plains}::text[]) AS plain) AS v
       WHERE l.id = v.id AND l.servicer_id = ${servicer.id}::uuid`;
  }
  return {
    servicer: { slug: servicer.slug, displayName: servicer.displayName },
    loansOnBook: loans.length,
    spelledDifferently,
    keptAsWritten,
    pointZeroKept,
    renumberable,
    collisions,
    applied: args.apply,
    renumbered,
  };
}
