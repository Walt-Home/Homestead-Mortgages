/**
 * Where an application stands, in the shape a borrower's screen can render.
 *
 * The ledger is the timeline: every move, in order, with the KIND of actor
 * that caused it and nothing more. `causedBy` is deliberately absent — it
 * carries requirement ids and snapshot ids, and nothing in the borrower flow
 * may render one. `rawLedger` is where those live, behind `?debug=1`.
 *
 * The clocks come from `regulatory_clocks`, which the database opens and
 * tolls. The Loan Estimate's due date is read from the row the receipt wrote,
 * computed by the SQL `add_business_days` in the creditor's zone — one source,
 * so a due date on a screen and a due date in an ops query cannot disagree
 * across a DST boundary.
 *
 * The wire name is `applicationState`, never `application`: `LoanFile.application`
 * already means the engine's TRID receipt, and shadowing it would make two
 * different things share a field name on the same object.
 *
 * The one writer here is `settleAfterIntake`, which decides what follows a
 * receipt. It sits beside the reader because the two answer the same question
 * from opposite ends — where this stands, and what put it there.
 */

import type { ClockKind, PrincipalKind } from "@hm/db";
import { TERMINAL, type ApplicationEvent, type ApplicationState } from "@hm/shared";
import { advanceIfLegal, toDomainState, type Advance } from "./transition.js";
import { servicePrincipal } from "./party.js";
import type { Db } from "./db.js";

export interface StandingLedgerRow {
  readonly seq: number;
  readonly from: ApplicationState | null;
  readonly to: ApplicationState;
  readonly event: ApplicationEvent;
  readonly reasonCode: string | null;
  readonly actorKind: PrincipalKind;
  readonly occurredAt: string;
}

export interface StandingClock {
  readonly kind: ClockKind;
  readonly statuteCitation: string;
  readonly startedAt: string;
  readonly dueAt: string;
  readonly tolledFrom: string | null;
  readonly tollingReason: string | null;
  readonly tolledUntil: string | null;
  readonly satisfiedAt: string | null;
  readonly breachedAt: string | null;
}

export interface ApplicationStandingView {
  readonly id: string;
  readonly status: ApplicationState;
  readonly statusEnteredAt: string;
  readonly terminal: boolean;
  readonly ledger: readonly StandingLedgerRow[];
  readonly clocks: readonly StandingClock[];
  readonly loanEstimate: {
    readonly dueAt: string;
    readonly tolled: boolean;
    readonly tollingReason: string | null;
  } | null;
}

/** Where this file's application stands, or null when it has none. */
export async function applicationStanding(
  db: Db,
  loanFileId: string,
): Promise<ApplicationStandingView | null> {
  const app = await db.application.findUnique({
    where: { loanFileId },
    select: {
      id: true,
      status: true,
      statusEnteredAt: true,
      transitions: {
        orderBy: { seq: "asc" },
        select: {
          seq: true,
          fromState: true,
          toState: true,
          event: true,
          reasonCode: true,
          occurredAt: true,
          actor: { select: { kind: true } },
        },
      },
      clocks: {
        orderBy: { startedAt: "asc" },
        select: {
          kind: true,
          statuteCitation: true,
          startedAt: true,
          dueAt: true,
          tolledFrom: true,
          tollingReason: true,
          tolledUntil: true,
          satisfiedAt: true,
          breachedAt: true,
        },
      },
    },
  });
  if (!app) return null;

  const status = toDomainState(app.status);
  const clocks: StandingClock[] = app.clocks.map((c) => ({
    kind: c.kind,
    statuteCitation: c.statuteCitation,
    startedAt: c.startedAt.toISOString(),
    dueAt: c.dueAt.toISOString(),
    tolledFrom: iso(c.tolledFrom),
    tollingReason: c.tollingReason,
    tolledUntil: iso(c.tolledUntil),
    satisfiedAt: iso(c.satisfiedAt),
    breachedAt: iso(c.breachedAt),
  }));
  const le = clocks.find((c) => c.kind === "TRID_LE_DELIVERY") ?? null;

  return {
    id: app.id,
    status,
    statusEnteredAt: app.statusEnteredAt.toISOString(),
    terminal: TERMINAL.includes(status),
    ledger: app.transitions.map((t) => ({
      seq: t.seq,
      from: t.fromState === null ? null : toDomainState(t.fromState),
      to: toDomainState(t.toState),
      event: t.event as ApplicationEvent,
      reasonCode: t.reasonCode,
      actorKind: t.actor.kind,
      occurredAt: t.occurredAt.toISOString(),
    })),
    clocks,
    loanEstimate: le
      ? {
          dueAt: le.dueAt,
          // A toll is a period with two ends. It is running while the first is
          // set and the second is not.
          tolled: le.tolledFrom !== null && le.tolledUntil === null,
          tollingReason: le.tollingReason,
        }
      : null,
  };
}

/** The ledger with its causes. For the debug surface, and nowhere else. */
export interface RawLedgerRow extends StandingLedgerRow {
  readonly causedBy: string | null;
  readonly actorPrincipalId: string;
  readonly actorSubject: string;
  readonly recordedAt: string;
}

export async function rawLedger(db: Db, loanFileId: string): Promise<readonly RawLedgerRow[]> {
  const app = await db.application.findUnique({
    where: { loanFileId },
    select: {
      transitions: {
        orderBy: { seq: "asc" },
        select: {
          seq: true,
          fromState: true,
          toState: true,
          event: true,
          reasonCode: true,
          causedBy: true,
          occurredAt: true,
          recordedAt: true,
          actorPrincipalId: true,
          actor: { select: { kind: true, subject: true } },
        },
      },
    },
  });
  if (!app) return [];
  return app.transitions.map((t) => ({
    seq: t.seq,
    from: t.fromState === null ? null : toDomainState(t.fromState),
    to: toDomainState(t.toState),
    event: t.event as ApplicationEvent,
    reasonCode: t.reasonCode,
    actorKind: t.actor.kind,
    occurredAt: t.occurredAt.toISOString(),
    causedBy: t.causedBy,
    actorPrincipalId: t.actorPrincipalId,
    actorSubject: t.actor.subject,
    recordedAt: t.recordedAt.toISOString(),
  }));
}

/**
 * What follows an intake, decided once.
 *
 * The receipt is a database trigger, so the moment an application exists is
 * not a line in any route — it is a side effect of the pin or the scenario
 * that completed it. Something still has to say what happens next, and the
 * honest answer is almost always "the borrower owes us their bank": the file
 * has just become an application and nothing has been connected. Writing that
 * edge here, in the same transaction as the act that fired the receipt, is
 * what makes "Needs you" appear the moment screen 2 completes rather than at
 * the next page load.
 *
 * A file that somehow already holds a bank snapshot is not owed anything, so
 * work begins instead. Screen 3 comes after screen 2 and no route can reach a
 * pull before the consent, so that branch is unreachable in the four-screen
 * flow — it is here for a file whose receipt fires late, which a revisit of
 * screen 1 or a renewed signature can still do.
 *
 * Called after a save that may have stamped the receipt. Null when it did not:
 * an application already past intake has been settled, and re-settling it
 * would write the borrower's obligations twice.
 */
export async function settleAfterIntake(
  tx: Db,
  args: { applicationId: string; loanFileId: string; causedBy: string },
): Promise<Advance | null> {
  const row = await tx.application.findUnique({
    where: { id: args.applicationId },
    select: { status: true },
  });
  if (!row || toDomainState(row.status) !== "intake_received") return null;

  const bank = await tx.connectorSnapshot.findFirst({
    where: { loanFileId: args.loanFileId, kind: "bank" },
    select: { id: true },
  });

  return advanceIfLegal(
    {
      applicationId: args.applicationId,
      event: bank ? "work_began" : "borrower_owes",
      actorPrincipalId: await servicePrincipal(tx, "application_flow"),
      reasonCode: bank ? "bank_already_connected" : "bank_connection_needed",
      causedBy: args.causedBy,
    },
    tx,
  );
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
