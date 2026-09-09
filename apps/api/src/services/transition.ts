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
import type { ApplicationPartyRole, Prisma } from "@hm/db";
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

/**
 * `draft` -> `DRAFT`, and back. A test asserts the two vocabularies agree.
 *
 * Exported because every reader of `applications.status` needs the domain
 * spelling and a second conversion written somewhere else is a second place
 * for the two vocabularies to drift.
 */
export const toDbState = (s: ApplicationState) => s.toUpperCase() as Uppercase<ApplicationState>;
export const toDomainState = (s: string) => s.toLowerCase() as ApplicationState;

/**
 * The roles whose holder is a person asking for this credit.
 *
 * A non-borrowing spouse or a guarantor is on the application without the
 * request being theirs, so ending it is not theirs either. The same list is a
 * literal in the trigger that refuses it at the database, which is why this is
 * exported: a test reads the function's source and holds the two together.
 */
export const BORROWING_ROLES: ApplicationPartyRole[] = [
  "PRIMARY_BORROWER",
  "CO_BORROWER",
  "NON_OCCUPANT_CO_BORROWER",
];

/**
 * Raised when the file moved between reading it and writing it.
 *
 * `retryable` says whether the caller still has a usable transaction. A
 * conditional update that matched nothing wrote nothing and left everything
 * around it intact, so the same event can simply be asked again from wherever
 * the file has landed. A collision on `(application_id, seq)` cannot: Postgres
 * has already aborted the transaction the insert was in, and every statement
 * after it would fail. Only the first kind may be retried, and confusing the
 * two would turn one 409 into three.
 */
export class TransitionConflict extends AppError {
  constructor(
    readonly applicationId: string,
    readonly actualState: ApplicationState,
    readonly retryable: boolean = true,
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

  const from = toDomainState(current.status);
  if (expectedFrom && expectedFrom !== from) throw new TransitionConflict(applicationId, from);

  // Throws if the machine has no edge. Deliberately before any write: an
  // illegal move should cost nothing and roll nothing back.
  const to = requireNextState(from, event);

  // Withdrawing is the borrower's act, and it is this application's borrower's
  // act. The database refuses everything below; this is the same refusal a
  // millisecond earlier, with a code a caller can read, and it costs nothing
  // when it fires. It asks all three questions the trigger asks, because a
  // check that stops one refusal short leaves the rest to surface as a raw
  // database error, which reaches a person as an internal one.
  if (event === "borrower_withdrew") {
    const actor = await db.principal.findUnique({
      where: { id: actorPrincipalId },
      select: { kind: true, partyId: true },
    });
    const theirs =
      actor?.kind === "BORROWER" &&
      actor.partyId !== null &&
      (await db.applicationParty.findFirst({
        where: { applicationId, partyId: actor.partyId, role: { in: BORROWING_ROLES } },
        select: { id: true },
      })) !== null;
    if (!theirs) {
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
      data: { status: toDbState(to), statusSeq: seq, statusEnteredAt: when },
    });
    if (count !== 1) {
      const now = await tx.application.findUnique({
        where: { id: applicationId },
        select: { status: true },
      });
      throw new TransitionConflict(applicationId, now ? toDomainState(now.status) : from);
    }

    await tx.applicationTransition.create({
      data: {
        applicationId,
        seq,
        fromState: toDbState(from),
        toState: toDbState(to),
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
      throw new TransitionConflict(applicationId, now ? toDomainState(now.status) : from, false);
    }
    throw err;
  }
}

/**
 * A move that was not made, and why.
 *
 * `no_edge` is the machine declining: the file is somewhere this event does
 * not apply from, which covers both "already there" and "never applies here".
 * `held` is the orchestration declining while the machine would have allowed
 * it — a sanctions hold, which only a person can lift.
 */
export interface Skipped {
  readonly skipped: "no_edge" | "held";
  readonly from: ApplicationState;
}

export type Advance = TransitionResult | Skipped;

/** Whether an advance actually wrote a row. */
export function moved(advance: Advance | null): advance is TransitionResult {
  return advance !== null && !("skipped" in advance);
}

/** How many times a concurrent repeat may be re-aimed before it is a conflict. */
const RETRIES = 2;

/**
 * The events that may still be taken out of `suspended`.
 *
 * A hold ends when a PERSON ends it. `third_party_returned` is the screening
 * coming back clean, and the three endings are somebody deciding the request
 * is over. Everything else the machine offers from `suspended` —
 * `borrower_owes` and `underwriting_began`, both legal because a member of
 * staff may take them — is refused here.
 */
const SURVIVES_A_HOLD: readonly ApplicationEvent[] = [
  "third_party_returned",
  "borrower_withdrew",
  "ops_canceled",
  "response_window_lapsed",
];

/**
 * Move an application if the machine allows it, and say so if it does not.
 *
 * The routes call this and never `transition()` directly. A screen is
 * revisited, a decision is recomputed, a bank is re-linked — the same event
 * arrives more than once, and the machine has no self-edges, so the second
 * arrival has no edge to take. That is a skip, not an error: nothing is
 * written and the caller learns where the file is. What it still throws is
 * the actor refusal, and a conflict where somebody else moved the file
 * somewhere this event can still be taken from.
 *
 * A SUSPENDED file only takes the events in `SURVIVES_A_HOLD`. Every caller
 * checks the hold on its own read too, and says so in the file's events; this
 * is the check that cannot be raced past or forgotten, because it happens on
 * the read the write is conditioned on.
 *
 * A repeat that arrives CONCURRENTLY is the same repeat. The review screen and
 * the bank screen both ask for a decision, so two callers reach the same edge
 * at once: one writes it and the other finds the row already moved. Reading
 * that as a 409 would hand a borrower "this application is now in_underwriting,
 * reload and decide again" for an event whose whole effect had just happened.
 * So a conflict whose landing state no longer offers the edge is a skip, the
 * same as if the two calls had arrived a second apart.
 *
 * And when the file comes back to the state this caller read, the repeat is
 * asked again from there rather than refused. That is the ordinary case for
 * every branch, not an exotic one: a borrower act satisfies the file and the
 * reconciliation immediately owes them the next thing, so a file somebody is
 * attaching two documents to at once returns to `awaiting_borrower` — where
 * `borrower_satisfied` is legal again — before the second writer's update
 * lands. Answering that with a 409 rolled the whole of the second request
 * back, and the document it had just recorded went with it. Asking again
 * writes exactly the rows the two calls would have written a second apart.
 *
 * Back to that state and NOWHERE ELSE. Every caller decides on its own read —
 * a sanctions hold is checked once, at the top, and then the event is handed
 * over — so aiming the event at whatever state the file happens to have landed
 * in would take an edge nobody validated. `borrower_owes` and
 * `underwriting_began` are both legal out of `suspended`, because a member of
 * staff may take them; an upload racing a screening is not that member of
 * staff, and re-aiming would have ended a hold on their behalf with no
 * `third_party_returned` on the ledger.
 *
 * Only for the same event, and only from the same state: those two together
 * are the whole of the distinction. Somebody else doing something ELSE while
 * this caller was deciding is a lost update, and a lost update is what a 409
 * is for — a decision made against a state that no longer holds must not be
 * quietly re-aimed at the new one. So the ledger is asked what moved the file:
 * a row carrying this caller's own event means their act arrived twice, and
 * anything else means somebody else acted and they need to hear it.
 */
export async function advanceIfLegal(
  input: Omit<TransitionInput, "expectedFrom">,
  db: Db = prisma,
): Promise<Advance> {
  const current = await db.application.findUnique({
    where: { id: input.applicationId },
    select: { status: true, statusSeq: true },
  });
  if (!current) throw new AppError(404, "Application not found", "NOT_FOUND");

  const readAt = current.statusSeq;
  const from = toDomainState(current.status);
  // The hold is enforced HERE, in the function that reads the state
  // immediately before writing it, and not only in each caller's own earlier
  // read. A screening that commits between a caller's check and this one would
  // otherwise lift the hold on the caller's behalf — `borrower_owes` and
  // `underwriting_began` are both legal edges out of `suspended` — with no
  // `third_party_returned` on the ledger and nobody having decided anything.
  // A caller that forgets to check at all gets the same answer.
  if (from === "suspended" && !SURVIVES_A_HOLD.includes(input.event)) {
    return { skipped: "held", from };
  }
  if (nextState(from, input.event) === undefined) return { skipped: "no_edge", from };

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transition({ ...input, expectedFrom: from }, db);
    } catch (err) {
      if (!(err instanceof TransitionConflict)) throw err;
      if (nextState(err.actualState, input.event) === undefined) {
        return { skipped: "no_edge", from: err.actualState };
      }
      // The file is somewhere the caller never looked at. The edge exists
      // there, which is exactly why this must not take it: a hold, an ending
      // or a decision arrived in the meantime and the caller's own checks ran
      // against a state that no longer holds.
      if (err.actualState !== from) throw err;
      // A collision on the sequence has already aborted the caller's
      // transaction, so asking again inside it would only produce a second,
      // less honest error. A zero-row update wrote nothing and left everything
      // around it intact.
      if (!err.retryable || attempt >= RETRIES) throw err;
      const repeat = await db.applicationTransition.findFirst({
        where: { applicationId: input.applicationId, seq: { gt: readAt }, event: input.event },
        select: { seq: true },
      });
      if (!repeat) throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as Prisma.PrismaClientKnownRequestError;
  return e?.code === "P2002";
}

/** The states, in the database's spelling. For a queue query or a report. */
export const DB_STATES = APPLICATION_STATES.map(toDbState);
