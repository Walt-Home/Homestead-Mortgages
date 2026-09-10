/**
 * The only thing that moves a loan.
 *
 * Everything about how a state change is MADE lives in
 * `aggregate-transition.ts`, because an application is not the only object in
 * this product whose status is a state machine. What is here is everything
 * that is about loans: the two vocabularies, the tables the state and the
 * history live in, and the machine.
 *
 * The database enforces the same guarantees for a loan that it enforces for an
 * application — a status change advances the sequence, a move with no ledger
 * row fails at COMMIT, an ending is final, the ledger is append-only — and two
 * more that only a loan needs. A loan is born in one of exactly two states,
 * because a mortgage either came from an application of ours or arrived from a
 * servicer, and every later state is a move somebody caused. And its ledger may
 * never name a principal that belongs to a party.
 *
 * That second one is why `actorPrincipalId` here is always a SERVICE, STAFF or
 * PARTNER principal and never a BORROWER one — `borrower_claimed` included, the
 * one loan move a person makes. Loans outlive their parties by design, so a
 * ledger row naming a borrower's own principal is a RESTRICT edge pointing at a
 * principal that account deletion is about to cascade away: a two-party
 * mortgage that survives one borrower closing their account would make that
 * account undeletable. The person is recorded where the schema already records
 * them, in `loan_parties`.
 */

import {
  nextLoanState,
  requireNextLoanState,
  type LoanEvent,
  type LoanState,
  type LoanTransitionReason,
} from "@hm/shared";
import {
  makeMover,
  type AggregateSpec,
  type MoveInput,
  type MoveResult,
  type Skipped as MoveSkipped,
} from "./aggregate-transition.js";
import { type Db } from "./db.js";

/**
 * `imported_unclaimed` -> `IMPORTED_UNCLAIMED`, and back. A test asserts the
 * two vocabularies agree, in both directions, so neither side can gain or
 * rename a state alone.
 *
 * Exported because every reader of `loans.status` needs the domain spelling,
 * and a second conversion written somewhere else is a second place for the two
 * vocabularies to drift.
 */
export const toDbLoanState = (s: LoanState) => s.toUpperCase() as Uppercase<LoanState>;
export const toDomainLoanState = (s: string) => s.toLowerCase() as LoanState;

/**
 * Which tables a loan keeps its state and its history in.
 *
 * It supplies neither of the two fields that belong to a single aggregate. A
 * loan has no hold — nothing about a mortgage waits on a person the way a file
 * in `suspended` does — and no actor refusal, because the one refusal about who
 * may cause a loan move is structural and lives in the database, where a writer
 * that has not read this file still meets it.
 */
const LOAN_SPEC: AggregateSpec<LoanState, LoanEvent> = {
  name: "loan",

  read: async (db, id) => {
    const row = await db.loan.findUnique({
      where: { id },
      select: { status: true, statusSeq: true, statusEnteredAt: true },
    });
    return row === null
      ? null
      : {
          status: toDomainLoanState(row.status),
          statusSeq: row.statusSeq,
          statusEnteredAt: row.statusEnteredAt,
        };
  },

  write: async (db, a) => {
    const { count } = await db.loan.updateMany({
      where: { id: a.id, status: toDbLoanState(a.from), statusSeq: a.seq - 1 },
      data: { status: toDbLoanState(a.to), statusSeq: a.seq, statusEnteredAt: a.when },
    });
    return count;
  },

  ledger: async (db, row) => {
    await db.loanTransition.create({
      data: {
        loanId: row.id,
        seq: row.seq,
        fromState: toDbLoanState(row.from),
        toState: toDbLoanState(row.to),
        event: row.event,
        actorPrincipalId: row.actorPrincipalId,
        reasonCode: row.reasonCode,
        causedBy: row.causedBy,
        occurredAt: row.when,
      },
    });
  },

  repeatSince: async (db, id, seq, event) =>
    (await db.loanTransition.findFirst({
      where: { loanId: id, seq: { gt: seq }, event },
      select: { seq: true },
    })) !== null,

  nextState: nextLoanState,
  requireNextState: requireNextLoanState,
};

/**
 * What a caller says to move a loan.
 *
 * The mover's own input takes any string as a reason; this narrows it to the
 * closed set, so a spelling that is not in the list is a compile error rather
 * than a bucket of one in the report that groups by it.
 */
export type LoanMoveInput = Omit<MoveInput<LoanState, LoanEvent>, "reasonCode"> & {
  readonly reasonCode?: LoanTransitionReason;
};

export type LoanMoveResult = MoveResult<LoanState>;
export type LoanSkipped = MoveSkipped<LoanState>;
export type LoanAdvance = LoanMoveResult | LoanSkipped;

const loan = makeMover<LoanState, LoanEvent>(LOAN_SPEC);

/**
 * Move a loan, or refuse and say why.
 *
 * Throws `IllegalLoanTransition` when the machine has no such edge — never a
 * no-op, never the current state dressed as success — and `TransitionConflict`
 * when somebody else moved it first.
 */
export const moveLoan: (input: LoanMoveInput, db?: Db) => Promise<LoanMoveResult> = loan.transition;

/**
 * Move a loan if the machine allows it, and say so if it does not.
 *
 * Routes and the importer call this and never `moveLoan` directly, and on this
 * aggregate that is what buys idempotency for free: a servicing extract re-sends
 * the same record every month, and an event with no edge from the state the
 * loan is already in answers `{ skipped: "no_edge" }` and writes nothing.
 */
export const moveLoanIfLegal: (
  input: Omit<LoanMoveInput, "expectedFrom">,
  db?: Db,
) => Promise<LoanAdvance> = loan.advanceIfLegal;
