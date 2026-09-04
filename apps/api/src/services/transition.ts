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
 */

import { prisma } from "@hm/db";
import type { Prisma } from "@hm/db";
import {
  APPLICATION_STATES,
  requireNextState,
  type ApplicationEvent,
  type ApplicationState,
} from "@hm/shared";
import { AppError } from "../middleware/error-handler.js";

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
  readonly reasonCode?: string;
  /** The decision run, delivered notice or failed retrieval behind it. */
  readonly causedBy?: string;
  /**
   * When it happened in the world, if that is not now. A backdated correction
   * is a new row with an earlier `occurredAt` and a later `recordedAt`.
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
export async function transition(input: TransitionInput): Promise<TransitionResult> {
  const { applicationId, event, actorPrincipalId, reasonCode, causedBy, occurredAt, expectedFrom } =
    input;

  const current = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { status: true, statusSeq: true },
  });
  if (!current) throw new AppError(404, "Application not found", "NOT_FOUND");

  const from = toDomain(current.status);
  if (expectedFrom && expectedFrom !== from) throw new TransitionConflict(applicationId, from);

  // Throws if the machine has no edge. Deliberately before the transaction: an
  // illegal move should cost nothing and roll nothing back.
  const to = requireNextState(from, event);
  const seq = current.statusSeq + 1;
  const when = occurredAt ?? new Date();

  try {
    return await prisma.$transaction(async (tx) => {
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
    });
  } catch (err) {
    // Two racing writers both pass the update and collide on (application_id,
    // seq). Postgres tells us; the caller should hear it as a conflict rather
    // than as an internal error.
    if (isUniqueViolation(err)) {
      const now = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { status: true },
      });
      throw new TransitionConflict(applicationId, now ? toDomain(now.status) : from);
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as Prisma.PrismaClientKnownRequestError;
  return e?.code === "P2002";
}

/** The states, in the database's spelling. For a queue query or a report. */
export const DB_STATES = APPLICATION_STATES.map(toDb);
