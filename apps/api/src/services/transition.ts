/**
 * The only thing that moves an application.
 *
 * Every state change goes through here, and every one writes a ledger row in
 * the same transaction as the column it changes. Three database triggers make
 * that structural rather than a convention — a status change that does not
 * advance the sequence is refused, and a transaction that moves a file without
 * explaining why fails at COMMIT. See the migration.
 *
 * Concurrency is a unique index on `(application_id, seq)` plus a conditional
 * update. Two writers racing is an insert conflict or a zero-row update, never
 * a lost write: whoever goes second is told the file moved under them and given
 * the state it is actually in, rather than silently overwriting a decision.
 *
 * This replaces `advanceStage`, whose failure mode was the opposite: asked to
 * do something it would not do, it returned the current stage, which reads as
 * success at the call site.
 *
 * A caller that has already opened a transaction passes it as the last
 * argument, and the move commits with the caller's other writes or not at all.
 * A conflict thrown inside that transaction aborts the whole of it — which is
 * correct: a route's write and the transition it implies are one act.
 */

import { prisma } from "@hm/db";
import type { Prisma } from "@hm/db";
import {
  APPLICATION_STATES,
  nextState,
  requireNextState,
  type ApplicationEvent,
  type ApplicationState,
  type TransitionReason,
} from "@hm/shared";
import { AppError } from "../middleware/error-handler.js";
import { ownsTransaction, type Db } from "./db.js";

/** `draft` -> `DRAFT`. A test asserts the two vocabularies agree. */
const toDb = (s: ApplicationState) => s.toUpperCase() as Uppercase<ApplicationState>;
const toDomain = (s: string) => s.toLowerCase() as ApplicationState;

/** Raised when the file moved between reading it and writing it. */
export class TransitionConflict extends AppError {
  constructor(
    readonly applicationId: string,
    readonly actualState: ApplicationState,
  ) {
    super(
      409,
      `This application is now ${actualState}. Reload and decide again.`,
      "TRANSITION_CONFLICT",
    );
    this.name = "TransitionConflict";
  }
}

export interface TransitionInput {
  readonly applicationId: string;
  readonly event: ApplicationEvent;
  /** The principal causing it. An AI reviewer resolves to a model version. */
  readonly actorPrincipalId: string;
  /** A code from a closed set. What an ops report groups by. */
  readonly reasonCode?: TransitionReason;
  /** The decision run, delivered notice or failed retrieval behind it. */
  readonly causedBy?: string;
  /**
   * When it happened in the world, if that is not now. Never earlier than one
   * millisecond after the file entered its current state: the column has to
   * move for the database to accept the change, and the ledger row carries
   * the same instant so the two never disagree.
   */
  readonly occurredAt?: Date;
  /**
   * The state the caller believed the file was in. Supply it whenever the
   * decision was made against something read earlier — it turns a lost update
   * into a 409.
   */
  readonly expectedFrom?: ApplicationState;
}

export interface TransitionResult {
  readonly from: ApplicationState;
  readonly to: ApplicationState;
  readonly seq: number;
}

/**
 * Move an application, or refuse and say why.
 *
 * Throws `IllegalTransition` when the machine has no such edge — never a
 * no-op, never the current state dressed as success — and `TransitionConflict`
 * when somebody else moved it first.
 */
export async function transition(
  input: TransitionInput,
  db: Db = prisma,
): Promise<TransitionResult> {
  const { applicationId, event, actorPrincipalId, reasonCode, causedBy, occurredAt, expectedFrom } =
    input;

  const current = await db.application.findUnique({
    where: { id: applicationId },
    select: { status: true, statusSeq: true, statusEnteredAt: true },
  });
  if (!current) throw new AppError(404, "Application not found", "NOT_FOUND");

  const from = toDomain(current.status);
  if (expectedFrom && expectedFrom !== from) throw new TransitionConflict(applicationId, from);

  // Throws if the machine has no edge. Deliberately before any write: an
  // illegal move should cost nothing and roll nothing back.
  const to = requireNextState(from, event);

  // Withdrawing is the borrower's act. The database refuses any other actor;
  // this is the same refusal a millisecond earlier, with a code a caller can
  // read, and it costs nothing when it fires.
  if (event === "borrower_withdrew") {
    const actor = await db.principal.findUnique({
      where: { id: actorPrincipalId },
      select: { kind: true },
    });
    if (actor?.kind !== "BORROWER") {
      throw new AppError(
        403,
        "Only the borrower can withdraw an application.",
        "ACTOR_NOT_PERMITTED",
      );
    }
  }

  const seq = current.statusSeq + 1;
  // Strictly later than the current stamp, whatever the clock says. The
  // receipt trigger does the same with GREATEST: a move in the same request
  // as the receipt can otherwise land on the same millisecond, and a status
  // change whose stamp did not move is refused by the database.
  const floor = current.statusEnteredAt.getTime() + 1;
  const when = new Date(Math.max((occurredAt ?? new Date()).getTime(), floor));

  const move = async (tx: Db): Promise<TransitionResult> => {
    // The WHERE is the concurrency control. If another writer moved the file
    // between the read above and this update, it matches nothing.
    const { count } = await tx.application.updateMany({
      where: { id: applicationId, status: current.status, statusSeq: current.statusSeq },
      data: { status: toDb(to), statusSeq: seq, statusEnteredAt: when },
    });
    if (count !== 1) {
      const now = await tx.application.findUnique({
        where: { id: applicationId },
        select: { status: true },
      });
      throw new TransitionConflict(applicationId, now ? toDomain(now.status) : from);
    }

    await tx.applicationTransition.create({
      data: {
        applicationId,
        seq,
        fromState: toDb(from),
        toState: toDb(to),
        event,
        actorPrincipalId,
        reasonCode: reasonCode ?? null,
        causedBy: causedBy ?? null,
        occurredAt: when,
      },
    });

    return { from, to, seq };
  };

  try {
    return ownsTransaction(db) ? await prisma.$transaction(move) : await move(db);
  } catch (err) {
    // Two racing writers both pass the update and collide on (application_id,
    // seq). Postgres tells us; the caller should hear it as a conflict rather
    // than as an internal error. Inside a caller's transaction the collision
    // has already aborted it, so there is nothing left to read the truth
    // from, and the state this call read is the best answer available.
    if (isUniqueViolation(err)) {
      const now = ownsTransaction(db)
        ? await prisma.application.findUnique({
            where: { id: applicationId },
            select: { status: true },
          })
        : null;
      throw new TransitionConflict(applicationId, now ? toDomain(now.status) : from);
    }
    throw err;
  }
}

export type Advance =
  TransitionResult | { readonly skipped: "no_edge"; readonly from: ApplicationState };

/**
 * Move an application if the machine allows it, and say so if it does not.
 *
 * The routes call this and never `transition()` directly. A screen is
 * revisited, a decision is recomputed, a bank is re-linked — the same event
 * arrives more than once, and the machine has no self-edges, so the second
 * arrival has no edge to take. That is a skip, not an error: nothing is
 * written and the caller learns where the file is. What it still throws is a
 * conflict — somebody else moved the file under this call — and the actor
 * refusal, because those are not repeats.
 */
export async function advanceIfLegal(
  input: Omit<TransitionInput, "expectedFrom">,
  db: Db = prisma,
): Promise<Advance> {
  const current = await db.application.findUnique({
    where: { id: input.applicationId },
    select: { status: true },
  });
  if (!current) throw new AppError(404, "Application not found", "NOT_FOUND");
  const from = toDomain(current.status);
  if (nextState(from, input.event) === undefined) return { skipped: "no_edge", from };
  return transition({ ...input, expectedFrom: from }, db);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as Prisma.PrismaClientKnownRequestError;
  return e?.code === "P2002";
}

/** The states, in the database's spelling. For a queue query or a report. */
export const DB_STATES = APPLICATION_STATES.map(toDb);
