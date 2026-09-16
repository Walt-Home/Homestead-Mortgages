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
 *
 * The procedure itself lives in `aggregate-transition.ts`, because an
 * application is not the only object in this product whose status is a state
 * machine. What stays here is everything that is about applications: the two
 * vocabularies, whose ending this is, which events survive a hold, and the
 * signatures every caller already uses.
 */

import { prisma } from "@hm/db";
import type { ApplicationPartyRole } from "@hm/db";
import {
  APPLICATION_STATES,
  nextState,
  requireNextState,
  type ApplicationEvent,
  type ApplicationState,
  type TransitionReason,
} from "@hm/shared";
import { AppError } from "../middleware/error-handler.js";
import {
  makeMover,
  TransitionConflict,
  type AggregateSpec,
  type MoveResult,
  type Skipped as MoveSkipped,
} from "./aggregate-transition.js";
import { type Db } from "./db.js";

export { TransitionConflict };

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
 * A non-borrowing spouse is on the application without the request being
 * theirs, so ending it is not theirs either. The same list is a literal in the
 * trigger that refuses it at the database, which is why this is exported: a
 * test reads the function's source and holds the two together.
 */
export const BORROWING_ROLES: ApplicationPartyRole[] = [
  "PRIMARY_BORROWER",
  "CO_BORROWER",
  "NON_OCCUPANT_CO_BORROWER",
];

/**
 * The events that may still be taken out of `suspended`.
 *
 * A hold ends when a PERSON ends it. `third_party_returned` is the screening
 * coming back clean, and the three endings are somebody deciding the request
 * is over. Everything else the machine offers from `suspended` —
 * `borrower_owes` and `underwriting_began`, both legal because a member of
 * staff may take them — is refused by the mover.
 */
const SURVIVES_A_HOLD: readonly ApplicationEvent[] = [
  "third_party_returned",
  "borrower_withdrew",
  "ops_canceled",
  "response_window_lapsed",
];

/**
 * Withdrawing is the borrower's act, and it is this application's borrower's
 * act. The database refuses everything below; this is the same refusal a
 * millisecond earlier, with a code a caller can read, and it costs nothing
 * when it fires. It asks all three questions the trigger asks, because a check
 * that stops one refusal short leaves the rest to surface as a raw database
 * error, which reaches a person as an internal one.
 */
async function assertWhoseEndingThisIs(
  db: Db,
  applicationId: string,
  event: ApplicationEvent,
  actorPrincipalId: string,
): Promise<void> {
  if (event !== "borrower_withdrew") return;

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

/**
 * Which tables an application keeps its state and its history in.
 *
 * The two vocabularies are converted here and nowhere the mover can see, so
 * the procedure never learns that one aggregate spells its states in capitals.
 */
const APPLICATION_SPEC: AggregateSpec<ApplicationState, ApplicationEvent> = {
  name: "application",

  read: async (db, id) => {
    const row = await db.application.findUnique({
      where: { id },
      select: { status: true, statusSeq: true, statusEnteredAt: true },
    });
    return row === null
      ? null
      : {
          status: toDomainState(row.status),
          statusSeq: row.statusSeq,
          statusEnteredAt: row.statusEnteredAt,
        };
  },

  write: async (db, a) => {
    const { count } = await db.application.updateMany({
      where: { id: a.id, status: toDbState(a.from), statusSeq: a.seq - 1 },
      data: { status: toDbState(a.to), statusSeq: a.seq, statusEnteredAt: a.when },
    });
    return count;
  },

  ledger: async (db, row) => {
    await db.applicationTransition.create({
      data: {
        applicationId: row.id,
        seq: row.seq,
        fromState: toDbState(row.from),
        toState: toDbState(row.to),
        event: row.event,
        actorPrincipalId: row.actorPrincipalId,
        reasonCode: row.reasonCode,
        causedBy: row.causedBy,
        occurredAt: row.when,
      },
    });
  },

  repeatSince: async (db, id, seq, event) =>
    (await db.applicationTransition.findFirst({
      where: { applicationId: id, seq: { gt: seq }, event },
      select: { seq: true },
    })) !== null,

  nextState,
  requireNextState,
  survivesAHold: { state: "suspended", events: SURVIVES_A_HOLD },
  actorGuard: assertWhoseEndingThisIs,
};

const application = makeMover<ApplicationState, ApplicationEvent>(APPLICATION_SPEC);

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

export type TransitionResult = MoveResult<ApplicationState>;

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
  const { applicationId, ...rest } = input;
  return application.transition({ id: applicationId, ...rest }, db);
}

export type Skipped = MoveSkipped<ApplicationState>;

export type Advance = TransitionResult | Skipped;

/** Whether an advance actually wrote a row. */
export function moved(advance: Advance | null): advance is TransitionResult {
  return advance !== null && !("skipped" in advance);
}

/**
 * Move an application if the machine allows it, and say so if it does not.
 *
 * The routes call this and never `transition()` directly. A screen is
 * revisited, a decision is recomputed, a bank is re-linked — the same event
 * arrives more than once, and the machine has no self-edges, so the second
 * arrival has no edge to take. That is a skip, not an error.
 *
 * A SUSPENDED file only takes the events in `SURVIVES_A_HOLD`. Every caller
 * checks the hold on its own read too, and says so in the file's events; the
 * mover's own check is the one that cannot be raced past or forgotten.
 *
 * The concurrent-repeat rule matters most on this aggregate, and it is the
 * ordinary case rather than an exotic one: a borrower act satisfies the file
 * and the reconciliation immediately owes them the next thing, so a file
 * somebody is attaching two documents to at once returns to
 * `awaiting_borrower` — where `borrower_satisfied` is legal again — before the
 * second writer's update lands.
 */
export async function advanceIfLegal(
  input: Omit<TransitionInput, "expectedFrom">,
  db: Db = prisma,
): Promise<Advance> {
  const { applicationId, ...rest } = input;
  return application.advanceIfLegal({ id: applicationId, ...rest }, db);
}

/** The states, in the database's spelling. For a queue query or a report. */
export const DB_STATES = APPLICATION_STATES.map(toDbState);
