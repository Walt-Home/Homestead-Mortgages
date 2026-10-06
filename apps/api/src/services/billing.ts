/**
 * A servicer is billed off its tape.
 *
 * The price sheet says what a watched loan on a partner's book consumes —
 * the self-improving mortgage row per $100,000 of balance per loan-month,
 * and offer touches — and `@hm/billing` is that arithmetic, pure. This is
 * what feeds it and keeps what it says: every loan a servicer's tape put
 * on the book, the day each was loaded, every observation the tapes wrote,
 * and one closed statement per servicer per month, append-only, written
 * by the month-close job once the month has ended.
 *
 * Three standings for a month. **Closed**: the row exists and is answered
 * verbatim, whatever a later tape says. **Open**: the month has ended and
 * nobody has closed it, so it is computed live through the month's end and
 * will match the row the close writes. **Running**: this month, computed
 * through today, which is what has been consumed and not what would be.
 *
 * Offer touches are zero today and said so: an offer is a card on the
 * person's loan page and no mail (`refi-offers.ts`), and the claim
 * invitation the desk mails is an invitation, not a touch. When an offer
 * is sent to a homeowner, count it here.
 */

import { prisma, Prisma } from "@hm/db";
import {
  meterMonth,
  meterTerms,
  runRate,
  runRateWire,
  monthKey,
  PRICE_SHEET,
  statementWire,
  type MeteredLoan,
  type MeteredObservation,
  type ObservedStatus,
  type RunRateWire,
  type StatementWire,
} from "@hm/billing";
import {
  addDays,
  addMonths,
  compare,
  endOfMonth,
  plainDate,
  startOfMonth,
  type PlainDate,
} from "@hm/kernel/calendar";
import { AppError } from "../middleware/error-handler.js";
import type { Db } from "./db.js";
import { dayEt } from "./refi-offers.js";
import { assertSlug } from "./tape-desk.js";

/** The console role that opens billing. Admin, and nobody else. */
export const BILLING_ROLES = ["admin"] as const;

const isoDay = (d: Date): PlainDate => plainDate(d.toISOString().slice(0, 10));
const dateOf = (day: PlainDate): Date => new Date(`${day}T00:00:00.000Z`);

/** "YYYY-MM" to the first day of that month; anything else is refused. */
export function monthFromKey(key: string): PlainDate {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) {
    throw new AppError(400, "A month is written YYYY-MM.", "BAD_MONTH");
  }
  return plainDate(`${key}-01`);
}

export interface BillingServicer {
  readonly slug: string;
  readonly displayName: string;
  readonly integrationDepth: string;
  /** The committed annual pool, in tokens, as a decimal string; null until set. */
  readonly annualTokenPool: string | null;
  /** The day the first loan of theirs was loaded; null for a servicer with no book. */
  readonly since: string | null;
}

async function servicerBySlug(slug: string, db: Db): Promise<BillingServicer & { id: string }> {
  const s = await db.servicer.findUnique({
    where: { slug: assertSlug(slug) },
    select: {
      id: true,
      slug: true,
      displayName: true,
      integrationDepth: true,
      annualTokenPool: true,
      loans: {
        where: { servicerLoanNumber: { not: null } },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { createdAt: true },
      },
    },
  });
  if (!s) throw new AppError(404, "No servicer by that name.", "NOT_FOUND");
  return {
    id: s.id,
    slug: s.slug,
    displayName: s.displayName,
    integrationDepth: s.integrationDepth,
    annualTokenPool: s.annualTokenPool?.toString() ?? null,
    since: s.loans[0] ? dayEt(s.loans[0].createdAt) : null,
  };
}

/**
 * The book as the meter reads it: every loan the tape put on it, the day it
 * was loaded, and every observation on or before the month's end. Two
 * queries, neither carrying a parameter per loan — a book is thousands of
 * rows, and a relation load would name each one.
 */
async function meteredBook(
  servicerId: string,
  monthEnd: PlainDate,
  db: Db,
): Promise<MeteredLoan[]> {
  const [loans, observations] = await Promise.all([
    db.loan.findMany({
      where: { servicerId, servicerLoanNumber: { not: null } },
      select: { id: true, servicerLoanNumber: true, createdAt: true },
      orderBy: { servicerLoanNumber: "asc" },
    }),
    db.servicingObservation.findMany({
      where: { loan: { servicerId }, asOf: { lte: dateOf(monthEnd) } },
      select: { loanId: true, asOf: true, status: true, principalBalanceCents: true },
      orderBy: { asOf: "asc" },
    }),
  ]);
  const byLoan = new Map<string, MeteredObservation[]>();
  for (const o of observations) {
    const list = byLoan.get(o.loanId) ?? [];
    list.push({
      asOf: isoDay(o.asOf),
      status: o.status.toLowerCase() as ObservedStatus,
      principalBalanceCents: o.principalBalanceCents,
    });
    byLoan.set(o.loanId, list);
  }
  return loans.map((l) => ({
    loanId: l.id,
    number: l.servicerLoanNumber!,
    watchedFrom: dayEt(l.createdAt),
    observations: byLoan.get(l.id) ?? [],
    // No offer has been sent to a homeowner yet; see the header.
    touches: 0,
  }));
}

export type StatementStanding = "closed" | "open" | "running";

export interface StatementAnswer {
  readonly servicer: BillingServicer;
  readonly statement: StatementWire;
  readonly standing: StatementStanding;
  readonly closed: {
    readonly id: string;
    readonly closedAt: string;
    readonly closedBy: string;
  } | null;
}

/** A servicer's statement for a month: the closed row, or the meter run live. */
export async function statementFor(
  args: { readonly slug: string; readonly month: PlainDate; readonly now?: Date },
  db: Db = prisma,
): Promise<StatementAnswer> {
  const servicer = await servicerBySlug(args.slug, db);
  const month = startOfMonth(args.month);
  const today = dayEt(args.now ?? new Date());
  if (compare(month, startOfMonth(today)) > 0) {
    throw new AppError(400, `${monthKey(month)} has not started.`, "MONTH_AHEAD");
  }
  const closed = await db.billingStatement.findUnique({
    where: { servicerId_month: { servicerId: servicer.id, month: dateOf(month) } },
    select: { id: true, closedAt: true, closedBy: true, statement: true },
  });
  const { id: _id, ...card } = servicer;
  void _id;
  if (closed) {
    return {
      servicer: card,
      statement: closed.statement as unknown as StatementWire,
      standing: "closed",
      closed: { id: closed.id, closedAt: closed.closedAt.toISOString(), closedBy: closed.closedBy },
    };
  }
  const running = monthKey(month) === monthKey(today);
  const loans = await meteredBook(servicer.id, endOfMonth(month), db);
  const statement = meterMonth(loans, month, running ? { through: today } : {});
  return {
    servicer: card,
    statement: statementWire(statement),
    standing: running ? "running" : "open",
    closed: null,
  };
}

/**
 * The book's run rate today — MRR and ARR, as the meter's own estimates
 * (`@hm/billing`, `runRate`): a whole month at the newest balances, and
 * twelve of them. Read live, like the running month.
 */
export async function runRateFor(
  slug: string,
  opts: { readonly now?: Date } = {},
  db: Db = prisma,
): Promise<RunRateWire> {
  const today = dayEt(opts.now ?? new Date());
  const servicer = await servicerBySlug(slug, db);
  const book = await meteredBook(servicer.id, today, db);
  return runRateWire(runRate(book, today));
}

/** The sheet's terms the meter runs on, for the page that says how a charge is computed. */
export const billingTerms = meterTerms;

export interface ClosedStatement {
  readonly id: string;
  readonly month: string;
  readonly sheetVersion: string;
  readonly loansBilled: number;
  readonly loanMonths: string;
  readonly balanceCents: string;
  readonly tokens: string;
  readonly cents: string;
  readonly closedAt: string;
  readonly closedBy: string;
}

const closedRow = (r: {
  id: string;
  month: Date;
  sheetVersion: string;
  loansBilled: number;
  loanMonths: Prisma.Decimal;
  balanceCents: bigint;
  tokens: bigint;
  cents: bigint;
  closedAt: Date;
  closedBy: string;
}): ClosedStatement => ({
  id: r.id,
  month: monthKey(isoDay(r.month)),
  sheetVersion: r.sheetVersion,
  loansBilled: r.loansBilled,
  loanMonths: r.loanMonths.toFixed(2),
  balanceCents: r.balanceCents.toString(),
  tokens: r.tokens.toString(),
  cents: r.cents.toString(),
  closedAt: r.closedAt.toISOString(),
  closedBy: r.closedBy,
});

const CLOSED_SELECT = {
  id: true,
  month: true,
  sheetVersion: true,
  loansBilled: true,
  loanMonths: true,
  balanceCents: true,
  tokens: true,
  cents: true,
  closedAt: true,
  closedBy: true,
} as const;

/** A servicer's closed statements, newest first. */
export async function listStatements(slug: string, db: Db = prisma): Promise<ClosedStatement[]> {
  const servicer = await servicerBySlug(slug, db);
  const rows = await db.billingStatement.findMany({
    where: { servicerId: servicer.id },
    orderBy: { month: "desc" },
    select: CLOSED_SELECT,
  });
  return rows.map(closedRow);
}

export interface CloseReport {
  readonly month: string;
  readonly closed: readonly {
    readonly slug: string;
    readonly tokens: string;
    readonly cents: string;
  }[];
  readonly alreadyClosed: readonly string[];
}

/**
 * Close a month: one statement per servicer, computed through the month's
 * end and kept. The month before this one by default — what the job on
 * the first of the month means — and a month still running is refused,
 * because a statement is what was consumed, not a forecast. A second
 * close of the same month writes nothing and says so.
 */
export async function closeBillingMonth(
  args: { readonly month?: PlainDate; readonly closedBy: string; readonly now?: Date },
  db: Db = prisma,
): Promise<CloseReport> {
  const today = dayEt(args.now ?? new Date());
  const month = startOfMonth(args.month ?? addMonths(today, -1));
  const last = endOfMonth(month);
  if (compare(last, today) >= 0) {
    throw new AppError(
      409,
      `${monthKey(month)} has not ended; it can be closed from ${addDays(last, 1)}.`,
      "MONTH_OPEN",
      { closesOn: addDays(last, 1) },
    );
  }
  const servicers = await db.servicer.findMany({
    orderBy: { slug: "asc" },
    select: { id: true, slug: true },
  });
  const closed: { slug: string; tokens: string; cents: string }[] = [];
  const alreadyClosed: string[] = [];
  for (const s of servicers) {
    const existing = await db.billingStatement.findUnique({
      where: { servicerId_month: { servicerId: s.id, month: dateOf(month) } },
      select: { id: true },
    });
    if (existing) {
      alreadyClosed.push(s.slug);
      continue;
    }
    const loans = await meteredBook(s.id, last, db);
    const statement = meterMonth(loans, month);
    const wire = statementWire(statement);
    await db.billingStatement.create({
      data: {
        servicerId: s.id,
        month: dateOf(month),
        sheetVersion: PRICE_SHEET.version,
        loansBilled: statement.loansBilled,
        loanMonths: new Prisma.Decimal(statement.loanMonths),
        balanceCents: statement.balanceCents,
        tokens: statement.tokens,
        cents: statement.cents,
        statement: wire as unknown as Prisma.InputJsonValue,
        closedBy: args.closedBy,
      },
      select: { id: true },
    });
    closed.push({ slug: s.slug, tokens: wire.tokens, cents: wire.cents });
  }
  return { month: monthKey(month), closed, alreadyClosed };
}

export interface BillingServicerCard extends BillingServicer {
  readonly loansOnBook: number;
  /** This month, through today. */
  readonly running: {
    readonly month: string;
    readonly through: string;
    readonly loansBilled: number;
    readonly balanceCents: string;
    readonly tokens: string;
    readonly cents: string;
  };
  readonly lastClosed: ClosedStatement | null;
  /** The closed statements of this calendar year, summed — what the pool has been drawn on. */
  readonly yearToDate: { readonly year: number; readonly tokens: string; readonly cents: string };
}

/** Every servicer, with what its book is consuming this month and what was last closed. */
export async function billingServicers(
  opts: { readonly now?: Date } = {},
  db: Db = prisma,
): Promise<BillingServicerCard[]> {
  const now = opts.now ?? new Date();
  const today = dayEt(now);
  const thisMonth = startOfMonth(today);
  const year = Number(today.slice(0, 4));
  const rows = await db.servicer.findMany({
    orderBy: { displayName: "asc" },
    select: { slug: true },
  });
  return Promise.all(
    rows.map(async ({ slug }) => {
      const answer = await statementFor({ slug, month: thisMonth, now }, db);
      const servicer = await servicerBySlug(slug, db);
      const [last, ytd] = await Promise.all([
        db.billingStatement.findFirst({
          where: { servicerId: servicer.id },
          orderBy: { month: "desc" },
          select: CLOSED_SELECT,
        }),
        db.billingStatement.aggregate({
          where: { servicerId: servicer.id, month: { gte: dateOf(plainDate(`${year}-01-01`)) } },
          _sum: { tokens: true, cents: true },
        }),
      ]);
      const { id: _id, ...card } = servicer;
      void _id;
      const s = answer.statement;
      return {
        ...card,
        loansOnBook: s.loansOnBook,
        running: {
          month: s.month,
          through: s.through,
          loansBilled: s.loansBilled,
          balanceCents: s.balanceCents,
          tokens: s.tokens,
          cents: s.cents,
        },
        lastClosed: last ? closedRow(last) : null,
        yearToDate: {
          year,
          tokens: (ytd._sum.tokens ?? 0n).toString(),
          cents: (ytd._sum.cents ?? 0n).toString(),
        },
      };
    }),
  );
}

/** Record, or clear, the annual token pool a servicer committed to. */
export async function setAnnualTokenPool(
  args: { readonly slug: string; readonly tokens: bigint | null },
  db: Db = prisma,
): Promise<BillingServicer> {
  if (args.tokens !== null && args.tokens < 0n) {
    throw new AppError(400, "A token pool is a whole number of tokens, or none.", "BAD_POOL");
  }
  const servicer = await servicerBySlug(args.slug, db);
  await db.servicer.update({
    where: { id: servicer.id },
    data: { annualTokenPool: args.tokens },
    select: { id: true },
  });
  const { id: _id, ...card } = await servicerBySlug(args.slug, db);
  void _id;
  return card;
}
