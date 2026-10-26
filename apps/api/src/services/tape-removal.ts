/**
 * A servicer's tapes, added up, and a tape taken back.
 *
 * A book is the sum of its tapes: every loan on it was made by one, and a
 * tape that made loans twice shows as loans that were not there before.
 * On 26 October 2026 the desk's count of Grander's book read 1,749 where
 * the person loading it expected 1,867, because a re-exported copy of a
 * tape already loaded had made 245 of its loans a second time and one
 * batch was still to come. Nothing on the desk said which tape made which
 * loans, and nothing could take one back. This is both:
 *
 *   tapes    every tape on the book, oldest first: what it was, what it
 *            read and refused, what it made and how much of that is still
 *            on the book, its balance, the loans it made that another tape
 *            had made first in another spelling of the number, and whether
 *            it can be taken back and why not — beside every tape that was
 *            taken back, and a check that the tapes' loans less the
 *            removals' are the loans on the book
 *   remove   one tape off the book, in one transaction, with a reason and
 *            the count of loans it deletes typed by the person removing it
 *
 * What a removal deletes is what only that tape knows. A loan another tape
 * also carries stays, and loses only this tape's observation of it; a loan
 * nobody else observed goes, with the reviews that rested on it and the
 * provisional person it was made with. The import row goes last, and a
 * `partner_book_removals` row says what it was and who took it back.
 *
 * A tape cannot be taken back once anything has been built on a loan only
 * it has: a claim, or any move besides a tape's report that it ended; an
 * offer, an application that refinances it, or a closed statement — a
 * closed month is what was invoiced, and a loan on it is a charge somebody
 * can read. Nor once it has ended a loan another tape also carries and no
 * other tape calls ended: an ended loan is final, and the removal could
 * not take back what this tape said of it. The same check answers the
 * reconciliation and guards the removal, so a tape the desk shows as
 * removable is one the removal will take. The removal holds the servicer's
 * book while it decides and deletes (`book-lock.ts`), so what it read is
 * what it deletes.
 */

import { prisma } from "@hm/db";
import { AppError } from "../middleware/error-handler.js";
import { lockBook } from "./book-lock.js";
import { type Db, ownsTransaction } from "./db.js";
import { loanNumberKey } from "./loan-numbers.js";
import { assertSlug } from "./tape-desk.js";

/* ── the plan: what taking a tape back would delete, and what stops it ──── */

interface RemovalPlan {
  /** The loans only this tape has observed: the ones a removal deletes. */
  readonly loanIds: readonly string[];
  readonly observations: number;
  /** Reviews resting on this tape's observations, or on a loan it deletes. */
  readonly reviews: number;
  /** Plain-English reasons it cannot be taken back; empty when it can. */
  readonly reasons: readonly string[];
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const monthName = (d: Date): string =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(d);

/**
 * What taking each tape back would delete, and why it cannot be, for every
 * import named. Set-based: a handful of statements whatever the size of
 * the book, each keyed on the import ids or one array of loan ids.
 */
async function removalPlans(
  db: Db,
  servicerId: string,
  importIds: readonly string[],
): Promise<Map<string, RemovalPlan>> {
  const plans = new Map<string, RemovalPlan>();
  if (importIds.length === 0) return plans;
  const imports = [...importIds];

  // The loans each tape alone has observed.
  const exclusive = await db.$queryRaw<{ import_id: string; loan_id: string }[]>`
    SELECT o."import_id"::text AS import_id, o."loan_id"::text AS loan_id
      FROM "servicing_observations" o
     WHERE o."import_id" = ANY(${imports}::uuid[])
       AND NOT EXISTS (
             SELECT 1 FROM "servicing_observations" x
              WHERE x."loan_id" = o."loan_id" AND x."import_id" <> o."import_id")`;
  const loansOf = new Map<string, { loanId: string }[]>();
  for (const r of exclusive) {
    const list = loansOf.get(r.import_id) ?? [];
    list.push({ loanId: r.loan_id });
    loansOf.set(r.import_id, list);
  }
  const allLoans = exclusive.map((r) => r.loan_id);

  const [observations, reviews, moved, claimed, offered, refinancing, closed, resting, ended] =
    await Promise.all([
      db.servicingObservation.groupBy({
        by: ["importId"],
        where: { importId: { in: imports } },
        _count: { _all: true },
      }),
      db.$queryRaw<{ import_id: string; n: number }[]>`
        SELECT i::text AS import_id,
               (SELECT count(*) FROM (
                  SELECT r."id" FROM "loan_reviews" r
                    JOIN "servicing_observations" o ON o."id" = r."observation_id"
                   WHERE o."import_id" = i
                  UNION
                  SELECT r."id" FROM "loan_reviews" r
                   WHERE r."loan_id" IN (
                         SELECT o."loan_id" FROM "servicing_observations" o
                          WHERE o."import_id" = i
                            AND NOT EXISTS (
                                  SELECT 1 FROM "servicing_observations" x
                                   WHERE x."loan_id" = o."loan_id" AND x."import_id" <> i))
               ) AS gone)::int AS n
          FROM unnest(${imports}::uuid[]) AS i`,
      // The loans only one of these tapes has that something besides a tape
      // has moved. A loan born unclaimed whose every move a tape reported
      // ended on the word of this tape, or of one already taken back, and
      // goes with it, its ledger by cascade; any other move — a claim, most
      // likely, or a loan born somewhere other than a tape — is somebody's.
      db.$queryRaw<{ loan_id: string }[]>`
        SELECT l."id"::text AS loan_id FROM "loans" l
         WHERE l."id" = ANY(${allLoans}::uuid[])
           AND l."status" <> 'IMPORTED_UNCLAIMED'
           AND NOT (
                 EXISTS (
                   SELECT 1 FROM "loan_transitions" t
                    WHERE t."loan_id" = l."id" AND t."seq" = 1
                      AND t."from_state" = 'IMPORTED_UNCLAIMED')
                 AND NOT EXISTS (
                   SELECT 1 FROM "loan_transitions" t
                    WHERE t."loan_id" = l."id"
                      AND t.reason_code IS DISTINCT FROM 'servicer_reported'))`,
      db.$queryRaw<{ loan_id: string }[]>`
        SELECT DISTINCT "loan_id"::text AS loan_id FROM "loan_claims"
         WHERE "loan_id" = ANY(${allLoans}::uuid[])`,
      db.$queryRaw<{ loan_id: string }[]>`
        SELECT DISTINCT "loan_id"::text AS loan_id FROM "refi_offers"
         WHERE "loan_id" = ANY(${allLoans}::uuid[])`,
      db.$queryRaw<{ loan_id: string }[]>`
        SELECT DISTINCT "prior_loan_id"::text AS loan_id FROM "applications"
         WHERE "prior_loan_id" = ANY(${allLoans}::uuid[])`,
      // Every closed month that billed a loan only one of these tapes has.
      db.$queryRaw<{ loan_id: string; month: Date }[]>`
        SELECT DISTINCT l->>'loanId' AS loan_id, s."month" AS month
          FROM "billing_statements" s
         CROSS JOIN LATERAL jsonb_array_elements(s."statement"->'loans') AS l
         WHERE s."servicer_id" = ${servicerId}::uuid
           AND l->>'loanId' = ANY(${allLoans}::text[])`,
      // Offers made off a review that rests on one of these tapes' observations.
      db.$queryRaw<{ import_id: string; loan_id: string }[]>`
        SELECT o."import_id"::text AS import_id, f."loan_id"::text AS loan_id
          FROM "refi_offers" f
          JOIN "loan_reviews" r ON r."id" = f."review_id"
          JOIN "servicing_observations" o ON o."id" = r."observation_id"
         WHERE o."import_id" = ANY(${imports}::uuid[])`,
      // Loans another tape also carries that one of these tapes reported
      // ended, and moved: an ended loan is final, so taking the tape back
      // would leave it ended on the word of no tape left on the book. One
      // another tape also calls ended is left as that tape says.
      db.$queryRaw<{ import_id: string; n: number }[]>`
        SELECT i."id"::text AS import_id, count(DISTINCT l."id")::int AS n
          FROM "partner_book_imports" i
         CROSS JOIN LATERAL jsonb_array_elements(i."report"->'loans') AS c
          JOIN "loans" l ON l."id" = (c->>'loan_id')::uuid
         WHERE i."id" = ANY(${imports}::uuid[])
           AND c->>'moved' IN ('payoff_posted', 'charge_off_posted', 'term_completed')
           AND EXISTS (
                 SELECT 1 FROM "servicing_observations" x
                  WHERE x."loan_id" = l."id" AND x."import_id" <> i."id")
           AND NOT EXISTS (
                 SELECT 1 FROM "servicing_observations" x
                  WHERE x."loan_id" = l."id" AND x."import_id" <> i."id"
                    AND x."status" IN ('PAID_OFF', 'CHARGED_OFF', 'MATURED'))
         GROUP BY i."id"`,
    ]);

  const observationsOf = new Map(observations.map((o) => [o.importId, o._count._all]));
  const reviewsOf = new Map(reviews.map((r) => [r.import_id, r.n]));
  const endedOf = new Map(ended.map((r) => [r.import_id, r.n]));
  const movedSet = new Set(moved.map((r) => r.loan_id));
  const claimedSet = new Set(claimed.map((r) => r.loan_id));
  const offeredSet = new Set(offered.map((r) => r.loan_id));
  const refinancingSet = new Set(refinancing.map((r) => r.loan_id));
  const closedMonths = new Map<string, Date[]>();
  for (const c of closed) {
    const list = closedMonths.get(c.loan_id) ?? [];
    list.push(c.month);
    closedMonths.set(c.loan_id, list);
  }

  for (const importId of imports) {
    const loans = loansOf.get(importId) ?? [];
    const ids = new Set(loans.map((l) => l.loanId));
    const reasons: string[] = [];
    const count = (set: Set<string>) => loans.filter((l) => set.has(l.loanId)).length;
    const movedOn = count(movedSet);
    if (movedOn > 0) {
      reasons.push(
        `${movedOn} of the loans it would remove ${plural(movedOn, "has", "have")} been claimed, or moved by something other than a tape.`,
      );
    }
    const withClaims = count(claimedSet);
    if (withClaims > 0) {
      reasons.push(
        `${withClaims} of the loans it would remove ${plural(withClaims, "has", "have")} a claim link minted.`,
      );
    }
    const withOffers = count(offeredSet);
    if (withOffers > 0) {
      reasons.push(
        `${withOffers} of the loans it would remove ${plural(withOffers, "has", "have")} a refinance offer.`,
      );
    }
    const refinanced = count(refinancingSet);
    if (refinanced > 0) {
      reasons.push(
        `${refinanced} of the loans it would remove ${plural(refinanced, "is", "are")} being refinanced by an application.`,
      );
    }
    const byMonth = new Map<number, number>();
    for (const l of loans) {
      for (const m of closedMonths.get(l.loanId) ?? []) {
        byMonth.set(m.getTime(), (byMonth.get(m.getTime()) ?? 0) + 1);
      }
    }
    for (const [month, n] of [...byMonth.entries()].sort((a, b) => a[0] - b[0])) {
      reasons.push(`${monthName(new Date(month))} is closed with ${n} of these loans.`);
    }
    const restingOffers = resting.filter(
      (r) => r.import_id === importId && !ids.has(r.loan_id),
    ).length;
    if (restingOffers > 0) {
      reasons.push(
        `${restingOffers} refinance ${plural(restingOffers, "offer rests", "offers rest")} on what this tape said about a loan another tape also carries.`,
      );
    }
    const endedHere = endedOf.get(importId) ?? 0;
    if (endedHere > 0) {
      reasons.push(
        `${endedHere} ${plural(endedHere, "loan", "loans")} another tape also carries ${plural(endedHere, "was", "were")} ended on this tape's word alone, and an ended loan cannot be reopened.`,
      );
    }
    plans.set(importId, {
      loanIds: loans.map((l) => l.loanId),
      observations: observationsOf.get(importId) ?? 0,
      reviews: reviewsOf.get(importId) ?? 0,
      reasons,
    });
  }
  return plans;
}

/* ── the book's tapes, added up ─────────────────────────────────────────── */

export interface RefusedRow {
  readonly row: number;
  readonly number: string | null;
  readonly code: string;
  readonly column: string | null;
}

export interface BookTape {
  readonly id: string;
  readonly filename: string | null;
  readonly asOf: string;
  readonly loadedAt: string;
  /** The day the loans this tape made are billed from; null when they differ, or none is left. */
  readonly billedFrom: string | null;
  readonly rowsTotal: number;
  readonly rowsLoaded: number;
  readonly rowsRefused: number;
  readonly loansCreated: number;
  readonly loansUpdated: number;
  readonly loansUnchanged: number;
  readonly loansStillOnBook: number;
  /** This tape's observations' principal balances, summed: cents, as a decimal string. */
  readonly balanceCents: string;
  /** The rows that made no loan, in tape order; the first few hundred, `rowsRefused` is all. */
  readonly refused: readonly RefusedRow[];
  /** Loans this tape made whose number, spelled plainly, another tape had made first. */
  readonly duplicates: number;
  readonly duplicatesOf: readonly { readonly tapeId: string; readonly loans: number }[];
  readonly removable: { readonly ok: boolean; readonly reasons: readonly string[] };
  /** What taking this tape back deletes; `loans` is the count a removal must be confirmed with. */
  readonly removes: {
    readonly loans: number;
    readonly observations: number;
    readonly reviews: number;
  };
}

export interface TapeRemovalRecord {
  readonly id: string;
  readonly tapeId: string;
  readonly filename: string | null;
  readonly asOf: string;
  readonly loansRemoved: number;
  readonly observationsRemoved: number;
  readonly balanceCents: string;
  readonly reason: string;
  readonly removedBy: string | null;
  readonly removedByName: string | null;
  readonly removedAt: string;
}

export interface BookTapes {
  readonly servicer: { readonly slug: string; readonly displayName: string };
  readonly loansOnBook: number;
  readonly tapes: readonly BookTape[];
  readonly removals: readonly TapeRemovalRecord[];
  /** The tapes' loans, less what removals took, against the book: `adds` when they agree. */
  readonly check: {
    readonly created: number;
    readonly removed: number;
    readonly loansOnBook: number;
    readonly adds: boolean;
  };
}

export const REFUSED_SHOWN = 500;

/**
 * The codes that keep a row off the book whatever else it carries. An
 * unreadable cell loads with the fact blank, and a balance or rate past
 * what is plausible loads with the column named; `implausible_value` is a
 * refusal only when the contract itself would not take the row, which the
 * report shows as a row whose number made no loan.
 */
const REFUSING = new Set([
  "no_loan_number",
  "loan_number_scientific",
  "loan_number_not_exact",
  "no_state",
  "no_balance_or_rate",
  "duplicate_row",
  "name_unsplit",
  "no_property_address",
  "no_term",
]);

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

async function servicerOf(slug: string, db: Db) {
  const servicer = await db.servicer.findUnique({
    where: { slug: assertSlug(slug) },
    select: { id: true, slug: true, displayName: true },
  });
  if (!servicer) throw new AppError(404, "No servicer by that name.", "NOT_FOUND");
  return servicer;
}

const loansOnBookOf = (db: Db, servicerId: string) =>
  db.loan.count({ where: { servicerId, servicerLoanNumber: { not: null } } });

const removalRecord = (r: {
  id: string;
  importId: string;
  tapeFilename: string | null;
  asOf: Date;
  loansRemoved: number;
  observationsRemoved: number;
  balanceCents: bigint;
  reason: string;
  removedBy: string;
  removedByName: string | null;
  removedAt: Date;
}): TapeRemovalRecord => ({
  id: r.id,
  tapeId: r.importId,
  filename: r.tapeFilename,
  asOf: isoDay(r.asOf),
  loansRemoved: r.loansRemoved,
  observationsRemoved: r.observationsRemoved,
  balanceCents: r.balanceCents.toString(),
  reason: r.reason,
  removedBy: r.removedBy,
  removedByName: r.removedByName,
  removedAt: r.removedAt.toISOString(),
});

/** A servicer's tapes, oldest first, each with what it made and what is left of it, and whether it can be taken back. */
export async function bookTapes(slug: string, db: Db = prisma): Promise<BookTapes> {
  const servicer = await servicerOf(slug, db);
  const imports = await db.partnerBookImport.findMany({
    where: { servicerId: servicer.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      tapeFilename: true,
      asOf: true,
      createdAt: true,
      rowsTotal: true,
      rowsLoaded: true,
      rowsRejected: true,
      loansCreated: true,
      loansUpdated: true,
      loansUnchanged: true,
    },
  });
  const ids = imports.map((i) => i.id);

  const [made, balances, exceptions, plans, loansOnBook, removals] = await Promise.all([
    // The loans each tape made, as its own report names them, that are still on the book.
    db.$queryRaw<{ import_id: string; number: string | null; watched_from: Date | null }[]>`
      SELECT i."id"::text AS import_id, l."servicer_loan_number" AS number, l."watched_from" AS watched_from
        FROM "partner_book_imports" i
       CROSS JOIN LATERAL jsonb_array_elements(i."report"->'loans') AS c
        JOIN "loans" l ON l."id" = (c->>'loan_id')::uuid AND l."servicer_id" = i."servicer_id"
       WHERE i."servicer_id" = ${servicer.id}::uuid AND c->>'change' = 'created'`,
    db.servicingObservation.groupBy({
      by: ["importId"],
      where: { importId: { in: ids } },
      _sum: { principalBalanceCents: true },
    }),
    // The exceptions that can have kept a row off the book; which did is settled below.
    db.$queryRaw<
      {
        import_id: string;
        row: number;
        number: string | null;
        code: string;
        column: string | null;
      }[]
    >`
      SELECT i."id"::text AS import_id, (e->>'row')::int AS row, e->>'servicer_loan_number' AS number,
             e->>'code' AS code, e->>'column' AS column
        FROM "partner_book_imports" i
       CROSS JOIN LATERAL jsonb_array_elements(i."report"->'exceptions') AS e
       WHERE i."servicer_id" = ${servicer.id}::uuid
         AND (e->>'code' = ANY(${[...REFUSING]}::text[])
              OR (e->>'code' = 'implausible_value'
                  AND NOT EXISTS (
                        SELECT 1 FROM jsonb_array_elements(i."report"->'loans') AS x
                         WHERE x->>'servicer_loan_number' = e->>'servicer_loan_number')))`,
    removalPlans(db, servicer.id, ids),
    loansOnBookOf(db, servicer.id),
    db.partnerBookRemoval.findMany({
      where: { servicerId: servicer.id },
      orderBy: { removedAt: "asc" },
    }),
  ]);

  const madeBy = new Map<string, { number: string | null; watchedFrom: Date | null }[]>();
  for (const m of made) {
    const list = madeBy.get(m.import_id) ?? [];
    list.push({ number: m.number, watchedFrom: m.watched_from });
    madeBy.set(m.import_id, list);
  }
  const balanceOf = new Map(
    balances.map((b) => [b.importId, b._sum.principalBalanceCents ?? 0n] as const),
  );
  const refusedBy = new Map<string, Map<number, RefusedRow>>();
  for (const e of exceptions) {
    const rows = refusedBy.get(e.import_id) ?? new Map<number, RefusedRow>();
    const prior = rows.get(e.row);
    // One entry a row, naming what refused it before anything that only flagged it.
    if (!prior || (!REFUSING.has(prior.code) && REFUSING.has(e.code))) {
      rows.set(e.row, { row: e.row, number: e.number, code: e.code, column: e.column });
    }
    refusedBy.set(e.import_id, rows);
  }

  // The first tape to make a loan under each spelling-free number, oldest first.
  const firstBy = new Map<string, string>();
  const tapes: BookTape[] = imports.map((i) => {
    const mine = madeBy.get(i.id) ?? [];
    const starts = new Set(mine.map((m) => (m.watchedFrom ? isoDay(m.watchedFrom) : "")));
    const billedFrom = starts.size === 1 && !starts.has("") ? [...starts][0]! : null;
    const of = new Map<string, number>();
    const keys = new Set<string>();
    for (const m of mine) {
      if (m.number === null) continue;
      const key = loanNumberKey(m.number);
      keys.add(key);
      const first = firstBy.get(key);
      if (first !== undefined && first !== i.id) of.set(first, (of.get(first) ?? 0) + 1);
    }
    for (const key of keys) if (!firstBy.has(key)) firstBy.set(key, i.id);
    const plan = plans.get(i.id)!;
    return {
      id: i.id,
      filename: i.tapeFilename,
      asOf: isoDay(i.asOf),
      loadedAt: i.createdAt.toISOString(),
      billedFrom,
      rowsTotal: i.rowsTotal,
      rowsLoaded: i.rowsLoaded,
      rowsRefused: i.rowsRejected,
      loansCreated: i.loansCreated,
      loansUpdated: i.loansUpdated,
      loansUnchanged: i.loansUnchanged,
      loansStillOnBook: mine.length,
      balanceCents: (balanceOf.get(i.id) ?? 0n).toString(),
      refused: [...(refusedBy.get(i.id)?.values() ?? [])]
        .sort((a, b) => a.row - b.row)
        .slice(0, REFUSED_SHOWN),
      duplicates: [...of.values()].reduce((n, k) => n + k, 0),
      duplicatesOf: [...of.entries()].map(([tapeId, loans]) => ({ tapeId, loans })),
      removable: { ok: plan.reasons.length === 0, reasons: plan.reasons },
      removes: {
        loans: plan.loanIds.length,
        observations: plan.observations,
        reviews: plan.reviews,
      },
    };
  });

  const created =
    imports.reduce((n, i) => n + i.loansCreated, 0) +
    removals.reduce((n, r) => n + r.loansCreated, 0);
  const removed = removals.reduce((n, r) => n + r.loansRemoved, 0);
  return {
    servicer: { slug: servicer.slug, displayName: servicer.displayName },
    loansOnBook,
    tapes,
    removals: removals.map(removalRecord),
    check: { created, removed, loansOnBook, adds: created - removed === loansOnBook },
  };
}

/* ── taking a tape back ─────────────────────────────────────────────────── */

export interface TapeRemoval {
  readonly removal: TapeRemovalRecord;
  readonly loansOnBook: number;
}

/**
 * Take one tape off a servicer's book, in one transaction: the reviews that
 * rested on what it said, every observation it wrote, the loans only it had
 * observed (their parties' links and ledger with them), the provisional
 * people those loans leave with nobody, and the import row; then the
 * removal row. Refused when anything has been built on a loan it would
 * delete, and when the count typed is not the count it deletes.
 */
export async function removeTape(
  args: {
    readonly slug: string;
    readonly tapeId: string;
    /** The number of loans the person removing it says it deletes. */
    readonly confirmLoans: number;
    readonly reason: string;
    readonly staff: { readonly id: string; readonly legalName: string | null };
  },
  db: Db = prisma,
): Promise<TapeRemoval> {
  const servicer = await servicerOf(args.slug, db);
  const reason = args.reason.trim();
  if (reason.length < 1 || reason.length > 500) {
    throw new AppError(
      400,
      "Say why the tape is being taken back, in 500 characters or fewer.",
      "BAD_REASON",
    );
  }
  const notHere = () =>
    new AppError(404, "No tape by that id on this servicer's book.", "NOT_FOUND");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.tapeId)) {
    throw notHere();
  }

  const run = async (tx: Db): Promise<TapeRemoval> => {
    // The book first: a load, a claim, another removal or a month's close
    // under way finishes before the plan below reads what only this tape
    // carries, and none starts until this commits (`book-lock.ts`). Two
    // removals of one tape wait for each other, and the second finds it gone.
    await lockBook(tx, servicer.id);
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"::text AS id FROM "partner_book_imports"
       WHERE "id" = ${args.tapeId}::uuid AND "servicer_id" = ${servicer.id}::uuid
       FOR UPDATE`;
    if (!locked) throw notHere();
    const tape = await tx.partnerBookImport.findUniqueOrThrow({
      where: { id: args.tapeId },
      select: {
        id: true,
        asOf: true,
        tapeSha256: true,
        tapeFilename: true,
        rowsTotal: true,
        loansCreated: true,
      },
    });
    const plan = (await removalPlans(tx, servicer.id, [tape.id])).get(tape.id)!;
    if (plan.reasons.length > 0) {
      throw new AppError(409, plan.reasons.join(" "), "TAPE_NOT_REMOVABLE", {
        reasons: plan.reasons,
      });
    }
    const loanIds = [...plan.loanIds];
    if (args.confirmLoans !== loanIds.length) {
      throw new AppError(
        400,
        `Taking this tape back removes ${loanIds.length} ${plural(loanIds.length, "loan", "loans")}, and ${args.confirmLoans} ${plural(args.confirmLoans, "was", "were")} confirmed. Nothing was removed.`,
        "CONFIRM_MISMATCH",
        { loansToRemove: loanIds.length, confirmed: args.confirmLoans },
      );
    }

    const [balance] = await tx.$queryRaw<{ cents: string }[]>`
      SELECT COALESCE(sum("principal_balance_cents"), 0)::text AS cents
        FROM "servicing_observations" WHERE "import_id" = ${tape.id}::uuid`;
    const people = await tx.$queryRaw<{ party_id: string }[]>`
      SELECT DISTINCT "party_id"::text AS party_id FROM "loan_parties"
       WHERE "loan_id" = ANY(${loanIds}::uuid[])`;
    const partyIds = people.map((p) => p.party_id);

    // Reviews first: an observation's key on a review is SET NULL, and a
    // review is append-only, so one left standing refuses the delete below.
    const reviewsRemoved = await tx.$executeRaw`
      DELETE FROM "loan_reviews" WHERE "id" IN (
        SELECT r."id" FROM "loan_reviews" r
          JOIN "servicing_observations" o ON o."id" = r."observation_id"
         WHERE o."import_id" = ${tape.id}::uuid
        UNION
        SELECT r."id" FROM "loan_reviews" r WHERE r."loan_id" = ANY(${loanIds}::uuid[]))`;
    const observationsRemoved = await tx.$executeRaw`
      DELETE FROM "servicing_observations" WHERE "import_id" = ${tape.id}::uuid`;
    // Their links to people and their ledger go with them, by cascade.
    const loansRemoved = await tx.$executeRaw`
      DELETE FROM "loans" WHERE "id" = ANY(${loanIds}::uuid[])`;
    // The people the tape made them with, when nothing else knows them; their facts go with them.
    const partiesRemoved = await tx.$executeRaw`
      DELETE FROM "parties" p
       WHERE p."id" = ANY(${partyIds}::uuid[])
         AND p."claim_status" = 'PROVISIONAL'
         AND NOT EXISTS (SELECT 1 FROM "loan_parties" x WHERE x."party_id" = p."id")
         AND NOT EXISTS (SELECT 1 FROM "application_parties" x WHERE x."party_id" = p."id")
         AND NOT EXISTS (SELECT 1 FROM "users" x WHERE x."party_id" = p."id")
         AND NOT EXISTS (SELECT 1 FROM "principals" x WHERE x."party_id" = p."id")
         AND NOT EXISTS (SELECT 1 FROM "parties" x WHERE x."merged_into_party_id" = p."id")
         AND NOT EXISTS (
               SELECT 1 FROM "loan_claims" x
                WHERE x."party_id" = p."id" OR x."accepted_by_party_id" = p."id")`;
    await tx.$executeRaw`DELETE FROM "partner_book_imports" WHERE "id" = ${tape.id}::uuid`;

    const row = await tx.partnerBookRemoval.create({
      data: {
        servicerId: servicer.id,
        importId: tape.id,
        asOf: tape.asOf,
        tapeSha256: tape.tapeSha256,
        tapeFilename: tape.tapeFilename,
        rowsTotal: tape.rowsTotal,
        loansCreated: tape.loansCreated,
        loansRemoved,
        observationsRemoved,
        reviewsRemoved,
        partiesRemoved,
        balanceCents: BigInt(balance?.cents ?? "0"),
        reason,
        removedBy: args.staff.id,
        removedByName: args.staff.legalName,
      },
    });
    return { removal: removalRecord(row), loansOnBook: await loansOnBookOf(tx, servicer.id) };
  };
  return ownsTransaction(db)
    ? prisma.$transaction(run, { maxWait: 10_000, timeout: 120_000 })
    : run(db);
}
