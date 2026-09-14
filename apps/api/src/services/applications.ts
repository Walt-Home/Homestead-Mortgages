/**
 * The one join from a loan file to the credit request it became.
 *
 * `applications.loan_file_id` is NOT NULL and UNIQUE, so this is a lookup and
 * not a person-path join — which would be ambiguous the moment one party holds
 * two files. Everything that wants to know where a file stands comes through
 * `applicationForFile`, and a file created before the join existed answers
 * null. Null means "no application on record", never "draft": a legacy file
 * that acquired a draft at its next save would wear "You've started" over work
 * that finished months ago.
 *
 * There is NO lazy creation anywhere. `POST /api/files` is the only production
 * writer of an `applications` row, because a credit request begins when
 * somebody asks for credit and not when a page happens to be loaded.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@hm/db";
import type { ApplicationPartyRole, LoanPurpose, Prisma } from "@hm/db";
import type { ApplicationState } from "@hm/shared";
import { proposeScenario, type ScenarioTerms } from "./evidence.js";
import { toCents } from "./money.js";
import { BORROWING_ROLES, toDomainState } from "./transition.js";
import type { Db } from "./db.js";

export interface ApplicationRef {
  readonly id: string;
  readonly status: ApplicationState;
  readonly statusSeq: number;
  readonly statusEnteredAt: Date;
}

/** This file's application, or null for a file created before the join. */
export async function applicationForFile(
  db: Db,
  loanFileId: string,
): Promise<ApplicationRef | null> {
  const row = await db.application.findUnique({
    where: { loanFileId },
    select: { id: true, status: true, statusSeq: true, statusEnteredAt: true },
  });
  if (!row) return null;
  return {
    id: row.id,
    status: toDomainState(row.status),
    statusSeq: row.statusSeq,
    statusEnteredAt: row.statusEnteredAt,
  };
}

/**
 * The identifier this loan's every submission carries.
 *
 * Read before the engine runs, so a recomputation reaches Desktop Underwriter
 * as a resubmission of the same case rather than as a case it has never seen.
 * A file with no application answers with its own id: stable per file, which
 * is the only property required, and not a value minted per run.
 */
export async function casefileIdForFile(loanFileId: string, db: Db = prisma): Promise<string> {
  const row = await db.application.findUnique({
    where: { loanFileId },
    select: { ausCasefileId: true },
  });
  return row?.ausCasefileId ?? loanFileId;
}

/**
 * Screen 1, in the new layer: the request, who is making it, and its terms.
 *
 * Born at DRAFT with sequence 0 — the state a file starts in needs no ledger
 * row, and the constraint that every move writes one exempts it. The scenario
 * insert fires the receipt trigger, which finds no pins and returns; nothing
 * here can stamp an application by accident.
 *
 * A uniqueness violation on `loan_file_id` is not a race to absorb: the file
 * was created in this same transaction, so a collision means two applications
 * were asked for on one file and the 500 is the correct answer.
 *
 * The casefile is minted here and nowhere else. Filling it in lazily on the
 * first submission would make that run a second writer of a row this layer
 * owns, and two concurrent runs would each read null and each mint one.
 */
export async function createDraftApplication(
  tx: Db,
  args: { loanFileId: string; partyId: string; terms: ScenarioTerms },
): Promise<{ applicationId: string; scenarioId: string }> {
  const app = await tx.application.create({
    data: { loanFileId: args.loanFileId, ausCasefileId: randomUUID() },
    select: { id: true },
  });
  await ensureApplicationParty(tx, app.id, args.partyId, "PRIMARY_BORROWER");
  const scenario = await proposeScenario(app.id, args.terms, tx);
  return { applicationId: app.id, scenarioId: scenario.id };
}

/** What a membership is, once it has one: the edge, and its DU position. */
export interface ApplicationPartyRef {
  readonly id: string;
  /** Borrower 1 through 4, or null for a role that emits no `BORROWER`. */
  readonly borrowerOrdinal: number | null;
}

/**
 * Put a party on an application, once, at a DU Borrower position.
 *
 * Create-only: an existing membership keeps the role and the position it has,
 * because a demotion or a promotion is a decision somebody makes rather than a
 * side effect of saving a screen.
 *
 * The position is not optional. `application_parties` carries a CHECK that ties
 * a borrowing role to a number, and this is the only thing in the product that
 * writes one of those rows — which is why the constraint and this function are
 * one change rather than two.
 *
 * The lock is what makes two savers safe. `createMany({ skipDuplicates: true })`
 * used to absorb a race for free, because the only thing two writers could
 * collide on was a row they both wanted to exist. An ordinal is different: two
 * writers reading the same vacancy both compute the same number, and the unique
 * index gives the loser an error instead of a row. So the application row is
 * locked before the vacancies are read, and the second writer queues behind the
 * first and sees what it did.
 */
export async function ensureApplicationParty(
  tx: Db,
  applicationId: string,
  partyId: string,
  role: ApplicationPartyRole,
): Promise<ApplicationPartyRef> {
  // Taken before the read, not after: a lock acquired once the vacancies are
  // already in hand protects nothing.
  await tx.$queryRaw`SELECT "id" FROM "applications" WHERE "id" = ${applicationId}::uuid FOR UPDATE`;

  const existing = await tx.applicationParty.findUnique({
    where: { applicationId_partyId: { applicationId, partyId } },
    select: { id: true, borrowerOrdinal: true },
  });
  if (existing) return existing;

  return tx.applicationParty.create({
    data: {
      applicationId,
      partyId,
      role,
      borrowerOrdinal: BORROWING_ROLES.includes(role)
        ? await freeBorrowerOrdinal(tx, applicationId, role)
        : null,
    },
    select: { id: true, borrowerOrdinal: true },
  });
}

/**
 * The smallest unused Borrower position on this application, and not `max + 1`.
 *
 * Dropping a borrower before a resubmission is an ordinary operation — the
 * ownership arcs cascade off the edge precisely so it can be — and counting
 * rather than allocating turns it into a lockout: ordinals 1 through 4 filled,
 * borrower 3 leaves, and the replacement is handed 5, which
 * `application_parties_borrower_ordinal_is_one_to_four` refuses. A fourth
 * borrower rejected on an application holding three.
 *
 * Reuse is correct here for the same reason it is cheap: the ordinal is a
 * position in one submitted document rather than an identity, so a vacancy is
 * filled and nobody is renumbered.
 *
 * The search starts at 2 for every role but the primary. Position 1 is the
 * primary borrower's — `application_parties_one_first_borrower` says there is
 * only ever one — so a hole there means the application has lost its primary,
 * and appending a co-borrower is not the operation that fills it.
 *
 * Must run inside the caller's lock on the application row.
 */
async function freeBorrowerOrdinal(
  tx: Db,
  applicationId: string,
  role: ApplicationPartyRole,
): Promise<number> {
  const from = role === "PRIMARY_BORROWER" ? 1 : 2;
  const free = await tx.$queryRaw<{ n: number }[]>`
    SELECT n FROM generate_series(${from}, 4) AS n
     WHERE n NOT IN (
       SELECT "borrower_ordinal" FROM "application_parties"
        WHERE "application_id" = ${applicationId}::uuid AND "borrower_ordinal" IS NOT NULL
     )
     ORDER BY n LIMIT 1`;

  const n = free[0]?.n;
  // By name, because the CHECK would say "violates constraint" about a number
  // nobody chose, and the operation that failed is a person being added to a
  // household that is already four people.
  if (n === undefined) {
    throw new Error(
      `application ${applicationId} already holds four borrowers and DU allows four; a ${role} cannot be added`,
    );
  }
  return n;
}

/** The screen-1 columns a scenario is built from. A loan file row, narrowed. */
export interface LoanFileRow {
  readonly purpose: LoanPurpose | null;
  readonly occupancy: string | null;
  readonly loanAmount: Prisma.Decimal | null;
  readonly downPayment: Prisma.Decimal | null;
  readonly valueOrPrice: Prisma.Decimal | null;
  readonly termMonths: number | null;
  readonly noteRate: Prisma.Decimal | null;
  readonly propertyLine1: string | null;
  readonly propertyLine2: string | null;
  readonly propertyCity: string | null;
  readonly propertyState: string | null;
  readonly propertyPostalCode: string | null;
}

const OBJECTIVE_FOR: Record<LoanPurpose, ScenarioTerms["objective"]> = {
  PURCHASE: "PURCHASE",
  RATE_TERM_REFINANCE: "RATE_TERM_REFINANCE",
  CASH_OUT_REFINANCE: "CASH_OUT_REFINANCE",
};

const OCCUPANCY_FOR: Record<string, ScenarioTerms["occupancy"]> = {
  primary_residence: "PRIMARY_RESIDENCE",
  second_home: "SECOND_HOME",
  investment: "INVESTMENT",
};

/**
 * The file's terms, as a scenario — or null when it cannot state any.
 *
 * Money crosses here and nowhere else: the legacy columns are Decimal dollars
 * and a scenario is bigint cents. Null is returned rather than a scenario with
 * a hole in it, because the receipt trigger reads the address, the value and
 * the amount to decide whether an application exists, and a scenario missing
 * one of them would be a request nobody made.
 */
export function scenarioTermsFrom(row: LoanFileRow): ScenarioTerms | null {
  const objective = row.purpose ? OBJECTIVE_FOR[row.purpose] : null;
  const occupancy = row.occupancy ? OCCUPANCY_FOR[row.occupancy] : null;
  const address = addressOf(row);
  if (!objective || !occupancy || !address) return null;
  if (row.loanAmount === null || row.valueOrPrice === null || row.termMonths === null) return null;

  return {
    objective,
    occupancy,
    loanAmountCents: toCents(row.loanAmount),
    downPaymentCents: toCents(row.downPayment ?? 0),
    valueEstimateCents: toCents(row.valueOrPrice),
    termMonths: row.termMonths,
    // Basis points, because a rate that can hold a fraction of a basis point
    // is the same rounding argument the money columns already lost.
    noteRateBps: row.noteRate === null ? null : Math.round(Number(row.noteRate) * 100),
    propertyAddress: address,
  };
}

/** `88 Foster Lane, Apt 2, Austin, TX 78745`, or null with no street line. */
function addressOf(row: LoanFileRow): string | null {
  const line1 = row.propertyLine1?.trim();
  if (!line1) return null;
  const parts = [line1, row.propertyLine2?.trim() || null, row.propertyCity?.trim() || null].filter(
    (p): p is string => Boolean(p),
  );
  const tail = [row.propertyState?.trim(), row.propertyPostalCode?.trim()]
    .filter((p) => Boolean(p))
    .join(" ");
  if (tail) parts.push(tail);
  return parts.join(", ");
}

/**
 * Bring the active scenario up to date with the file, if it has moved.
 *
 * A scenario is immutable, so "editing" screen 1 is a NEW scenario that
 * retires the old one — and a PATCH that changed a phone number must not mint
 * one. Every term is compared, and only a real difference proposes. Past
 * DRAFT this is version history rather than an intake event: the receipt is a
 * no-op once it has fired, and TRID does not restart the clock because an
 * amount changed.
 */
export async function syncScenario(
  tx: Db,
  applicationId: string,
  row: LoanFileRow,
): Promise<{ seq: number } | null> {
  const terms = scenarioTermsFrom(row);
  if (!terms) return null;

  const active = await tx.loanScenario.findFirst({
    where: { applicationId, isActive: true },
    select: {
      objective: true,
      occupancy: true,
      loanAmountCents: true,
      downPaymentCents: true,
      valueEstimateCents: true,
      termMonths: true,
      noteRateBps: true,
      propertyAddress: true,
    },
  });

  if (
    active &&
    active.objective === terms.objective &&
    active.occupancy === terms.occupancy &&
    active.loanAmountCents === terms.loanAmountCents &&
    active.downPaymentCents === (terms.downPaymentCents ?? 0n) &&
    active.valueEstimateCents === (terms.valueEstimateCents ?? null) &&
    active.termMonths === terms.termMonths &&
    active.noteRateBps === (terms.noteRateBps ?? null) &&
    active.propertyAddress === (terms.propertyAddress?.trim() || null)
  ) {
    return null;
  }

  const { seq } = await proposeScenario(applicationId, terms, tx);
  return { seq };
}
