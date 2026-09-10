/**
 * One mover, for every aggregate whose status is a state machine.
 *
 * An application and a loan are different objects with different states, but
 * the way a state change is MADE is not different: read the row, ask the
 * machine for the edge, write the column conditionally on what was read, and
 * write the ledger row in the same transaction as the column. Every guarantee
 * in that sentence is a property of the procedure rather than of applications,
 * so it is written once here and each aggregate supplies a descriptor saying
 * which tables it reads and which machine it obeys.
 *
 * What a descriptor may not supply is a variation on the procedure. The
 * conditional update is the concurrency control, the ledger row goes with the
 * column, an illegal edge throws rather than returning the current state
 * dressed as success, and a concurrent repeat is re-aimed only at the state
 * the caller actually read. A second copy of any of those, written for the
 * second aggregate, is a second place for them to drift apart — and the
 * property they carry is that a decision is never silently overwritten.
 *
 * The two rules that genuinely belong to one aggregate are descriptor FIELDS
 * rather than branches: `survivesAHold` and `actorGuard`. Expressed as `if`
 * statements they would sit on the loan path forever, dead, until somebody
 * reading the loan path concluded that loans have holds and withdrawals too.
 */

import { prisma } from "@hm/db";
import type { Prisma } from "@hm/db";
import { AppError } from "../middleware/error-handler.js";
import { ownsTransaction, type Db } from "./db.js";

/**
 * Raised when the row moved between reading it and writing it.
 *
 * `retryable` says whether the caller still has a usable transaction. A
 * conditional update that matched nothing wrote nothing and left everything
 * around it intact, so the same event can simply be asked again from wherever
 * the row has landed. A collision on the sequence cannot: Postgres has already
 * aborted the transaction the insert was in, and every statement after it
 * would fail. Only the first kind may be retried, and confusing the two would
 * turn one 409 into three.
 */
export class TransitionConflict<S extends string = string> extends AppError {
  constructor(
    readonly aggregate: string,
    readonly id: string,
    readonly actualState: S,
    readonly retryable: boolean = true,
  ) {
    super(
      409,
      `This ${aggregate} is now ${actualState}. Reload and decide again.`,
      "TRANSITION_CONFLICT",
    );
    this.name = "TransitionConflict";
  }
}

/** The row the ledger is asked to append. `when` is the instant the column got. */
export interface LedgerRow<S extends string, E extends string> {
  readonly id: string;
  readonly seq: number;
  readonly from: S;
  readonly to: S;
  readonly event: E;
  readonly actorPrincipalId: string;
  readonly reasonCode: string | null;
  readonly causedBy: string | null;
  readonly when: Date;
}

/**
 * What one aggregate has to say about itself for the mover to move it.
 *
 * Its name, the tables it keeps its state and its history in, the machine it
 * obeys, and the two refusals that belong to a single aggregate. What it may
 * not supply is a variation on the order the procedure runs in or on the
 * guarantees it carries, which is the line that keeps this from becoming two
 * movers wearing one name.
 */
export interface AggregateSpec<S extends string, E extends string> {
  /** What the aggregate is called, in a sentence a person reads. */
  readonly name: "application" | "loan";
  readonly read: (
    db: Db,
    id: string,
  ) => Promise<{ status: S; statusSeq: number; statusEnteredAt: Date } | null>;
  /** Conditional on `from` and `seq - 1`. Answers how many rows it matched. */
  readonly write: (
    db: Db,
    a: { id: string; from: S; to: S; seq: number; when: Date },
  ) => Promise<number>;
  readonly ledger: (db: Db, row: LedgerRow<S, E>) => Promise<void>;
  /** Whether this event already landed after `seq`. What tells a repeat from a race. */
  readonly repeatSince: (db: Db, id: string, seq: number, event: E) => Promise<boolean>;
  readonly nextState: (from: S, event: E) => S | undefined;
  readonly requireNextState: (from: S, event: E) => S;
  /** The held state and the events that may still be taken from it, if it has one. */
  readonly survivesAHold?: { readonly state: S; readonly events: readonly E[] };
  /** A refusal that must fire before any write, if this aggregate has one. */
  readonly actorGuard?: (db: Db, id: string, event: E, actorPrincipalId: string) => Promise<void>;
}

export interface MoveInput<S extends string, E extends string> {
  readonly id: string;
  readonly event: E;
  /** The principal causing it. An AI reviewer resolves to a model version. */
  readonly actorPrincipalId: string;
  /** A code from the aggregate's closed set. What an ops report groups by. */
  readonly reasonCode?: string;
  /** The decision run, delivered notice or failed retrieval behind it. */
  readonly causedBy?: string;
  /**
   * When it happened in the world, if that is not now. Never earlier than one
   * millisecond after the row entered its current state: the column has to
   * move for the database to accept the change, and the ledger row carries the
   * same instant so the two never disagree.
   */
  readonly occurredAt?: Date;
  /**
   * The state the caller believed the row was in. Supply it whenever the
   * decision was made against something read earlier — it turns a lost update
   * into a 409.
   */
  readonly expectedFrom?: S;
}

export interface MoveResult<S extends string> {
  readonly from: S;
  readonly to: S;
  readonly seq: number;
}

/**
 * A move that was not made, and why.
 *
 * `no_edge` is the machine declining: the row is somewhere this event does not
 * apply from, which covers both "already there" and "never applies here".
 * `held` is the orchestration declining while the machine would have allowed
 * it — a hold, which only a person can lift.
 */
export interface Skipped<S extends string> {
  readonly skipped: "no_edge" | "held";
  readonly from: S;
}

/** How many times a concurrent repeat may be re-aimed before it is a conflict. */
const RETRIES = 2;

/**
 * Bind the procedure to one aggregate.
 *
 * Returns the two functions every caller uses: `transition`, which moves the
 * row or says why it will not, and `advanceIfLegal`, which is the one routes
 * and importers call because it treats a repeat as the nothing it is.
 */
export function makeMover<S extends string, E extends string>(spec: AggregateSpec<S, E>) {
  const noun = spec.name;
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const notFound = () => new AppError(404, `${Noun} not found`, "NOT_FOUND");

  /**
   * Move it, or refuse and say why.
   *
   * Throws whatever the machine throws when it has no such edge — never a
   * no-op, never the current state dressed as success — and
   * `TransitionConflict` when somebody else moved it first.
   */
  async function transition(input: MoveInput<S, E>, db: Db = prisma): Promise<MoveResult<S>> {
    const { id, event, actorPrincipalId, reasonCode, causedBy, occurredAt, expectedFrom } = input;

    const current = await spec.read(db, id);
    if (!current) throw notFound();

    const from = current.status;
    if (expectedFrom && expectedFrom !== from) throw new TransitionConflict(noun, id, from);

    // Throws if the machine has no edge. Deliberately before any write: an
    // illegal move should cost nothing and roll nothing back.
    const to = spec.requireNextState(from, event);

    // Whatever this aggregate refuses on the strength of who is asking. It
    // runs here, before the write, so the refusal costs nothing when it fires
    // and reaches the caller as a code rather than as a raw database error.
    await spec.actorGuard?.(db, id, event, actorPrincipalId);

    const seq = current.statusSeq + 1;
    // Strictly later than the current stamp, whatever the clock says. Two
    // writes in one request can otherwise land on the same millisecond, and a
    // status change whose stamp did not move is refused by the database.
    const floor = current.statusEnteredAt.getTime() + 1;
    const when = new Date(Math.max((occurredAt ?? new Date()).getTime(), floor));

    const move = async (tx: Db): Promise<MoveResult<S>> => {
      // The conditional write is the concurrency control. If another writer
      // moved the row between the read above and this update, it matches
      // nothing.
      const count = await spec.write(tx, { id, from, to, seq, when });
      if (count !== 1) {
        const now = await spec.read(tx, id);
        throw new TransitionConflict(noun, id, now ? now.status : from);
      }

      await spec.ledger(tx, {
        id,
        seq,
        from,
        to,
        event,
        actorPrincipalId,
        reasonCode: reasonCode ?? null,
        causedBy: causedBy ?? null,
        when,
      });

      return { from, to, seq };
    };

    try {
      return ownsTransaction(db) ? await prisma.$transaction(move) : await move(db);
    } catch (err) {
      // Two racing writers both pass the update and collide on the sequence.
      // Postgres tells us; the caller should hear it as a conflict rather than
      // as an internal error. Inside a caller's transaction the collision has
      // already aborted it, so there is nothing left to read the truth from,
      // and the state this call read is the best answer available.
      if (isUniqueViolation(err)) {
        const now = ownsTransaction(db) ? await spec.read(db, id) : null;
        throw new TransitionConflict(noun, id, now ? now.status : from, false);
      }
      throw err;
    }
  }

  /**
   * Move it if the machine allows it, and say so if it does not.
   *
   * Routes and importers use this and never `transition` directly. The
   * persona seed is the one caller that does, where a skipped edge would
   * leave a fixture quietly in a state its story does not claim. The same
   * event arrives more than once — a screen is revisited, a decision is
   * recomputed, a record is re-sent — and no machine here has self-edges, so
   * the second arrival has no edge to take. That is a skip, not an error:
   * nothing is written and the caller learns where the row is. What it still
   * throws is the actor refusal, and a conflict where somebody else moved the
   * row somewhere this event can still be taken from.
   *
   * A held row only takes the events that end the hold. Callers check the hold
   * on their own read too, and say so; this is the check that cannot be raced
   * past or forgotten, because it happens on the read the write is conditioned
   * on.
   *
   * A repeat that arrives CONCURRENTLY is the same repeat. Two callers reach
   * the same edge at once: one writes it and the other finds the row already
   * moved. Reading that as a 409 would refuse an event whose whole effect had
   * just happened. So a conflict whose landing state no longer offers the edge
   * is a skip, the same as if the two calls had arrived a second apart.
   *
   * And when the row comes back to the state this caller read, the repeat is
   * asked again from there rather than refused. Answering that with a 409
   * rolled the whole of the second request back, and whatever it had just
   * recorded went with it. Asking again writes exactly the rows the two calls
   * would have written a second apart.
   *
   * Back to that state and NOWHERE ELSE. Every caller decides on its own read,
   * so aiming the event at whatever state the row happens to have landed in
   * would take an edge nobody validated — ending a hold on somebody's behalf,
   * with nothing on the ledger to say who decided it. Only for the same event,
   * and only from the same state: those two together are the whole of the
   * distinction. Somebody else doing something ELSE while this caller was
   * deciding is a lost update, and a lost update is what a 409 is for. So the
   * ledger is asked what moved the row: a row carrying this caller's own event
   * means their act arrived twice, and anything else means somebody else acted
   * and they need to hear it.
   */
  async function advanceIfLegal(
    input: Omit<MoveInput<S, E>, "expectedFrom">,
    db: Db = prisma,
  ): Promise<MoveResult<S> | Skipped<S>> {
    const current = await spec.read(db, input.id);
    if (!current) throw notFound();

    const readAt = current.statusSeq;
    const from = current.status;
    // The hold is enforced HERE, in the function that reads the state
    // immediately before writing it, and not only in each caller's own earlier
    // read. Something that commits between a caller's check and this one would
    // otherwise lift the hold on the caller's behalf, with nobody having
    // decided anything. A caller that forgets to check at all gets the same
    // answer.
    const hold = spec.survivesAHold;
    if (hold && from === hold.state && !hold.events.includes(input.event)) {
      return { skipped: "held", from };
    }
    if (spec.nextState(from, input.event) === undefined) return { skipped: "no_edge", from };

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await transition({ ...input, expectedFrom: from }, db);
      } catch (err) {
        if (!(err instanceof TransitionConflict)) throw err;
        // One class serves every aggregate and every row of it, so a conflict
        // about anything other than the row this call is moving is somebody
        // else's news. Every conflict this call raises names this row; one
        // that arrives from a spec hook moving something else — the other
        // aggregate, or a second row of this one — does not. Reading it as
        // this call's answer asks the machine for an edge out of a state this
        // row has never been in, gets "none", and hands the caller a skip
        // named after the other object's state, with the lost update on that
        // object gone.
        if (err.aggregate !== noun || err.id !== input.id) throw err;
        const actualState = err.actualState as S;
        if (spec.nextState(actualState, input.event) === undefined) {
          return { skipped: "no_edge", from: actualState };
        }
        // The row is somewhere the caller never looked at. The edge exists
        // there, which is exactly why this must not take it: a hold, an ending
        // or a decision arrived in the meantime and the caller's own checks
        // ran against a state that no longer holds.
        if (actualState !== from) throw err;
        // A collision on the sequence has already aborted the caller's
        // transaction, so asking again inside it would only produce a second,
        // less honest error. A zero-row update wrote nothing and left
        // everything around it intact.
        if (!err.retryable || attempt >= RETRIES) throw err;
        if (!(await spec.repeatSince(db, input.id, readAt, input.event))) throw err;
      }
    }
  }

  return { transition, advanceIfLegal };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as Prisma.PrismaClientKnownRequestError;
  return e?.code === "P2002";
}
