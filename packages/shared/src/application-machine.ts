/**
 * The application lifecycle, as a data structure.
 *
 * Nineteen states and the events that move between them. This file is PURE —
 * no database, no clock, no I/O — so every legal and illegal edge is testable
 * without Postgres, and so the machine can be read in one sitting by somebody
 * deciding whether a new state belongs in it.
 *
 * Three properties it is built to have, each pinned by a test rather than by
 * good intentions:
 *
 * 1. **An unknown edge throws.** `MACHINE[from][event]` returning undefined is
 *    an error, never a silent no-op. The prototype's `advanceStage` returned
 *    the current stage when asked to move backward, which reads as success at
 *    the call site — so a caller could believe it had cancelled a file that is
 *    still running.
 *
 * 2. **Terminal means terminal.** A state in `TERMINAL` has no outgoing edges,
 *    and the test asserts the table agrees. Reopening is a NEW application, not
 *    a transition — un-setting a dated latch would contradict how
 *    `applicationSignedAt` already behaves, and every verification would have
 *    to be re-run anyway.
 *
 * 3. **Every state is reachable from `draft`.** A state nothing can reach is a
 *    state nobody has thought through, and it will be discovered by a borrower
 *    rather than by us.
 *
 * The vocabulary is deliberately the same as `apps/web/src/lib/states.ts`,
 * which holds the words a borrower reads for each of these. A state added here
 * and not there renders as a blank card; a test in the web app catches that.
 */

import type { DecisionOutcome } from "./types/decision.js";

/** Every state an application can be in. Ordered roughly as a file travels. */
export const APPLICATION_STATES = [
  "draft",
  "intake_received",
  "in_processing",
  "awaiting_borrower",
  "suspended",
  "in_underwriting",
  "counteroffer_outstanding",
  "conditionally_approved",
  "approved",
  "clear_to_close",
  "closing",
  "rescission_pending",
  "funded",
  "adverse_action_pending",
  "denied",
  "incomplete_closed",
  "withdrawn",
  "canceled",
  "expired",
] as const;

export type ApplicationState = (typeof APPLICATION_STATES)[number];

/**
 * Ends. No outgoing edges, and the test enforces that against the table.
 *
 * `denied` is here and `adverse_action_pending` is not: a decline is not final
 * until the borrower has been told why, which is the whole reason those are two
 * states rather than one.
 */
export const TERMINAL: readonly ApplicationState[] = [
  "funded",
  "denied",
  "incomplete_closed",
  "withdrawn",
  "canceled",
  "expired",
];

/**
 * What can happen to an application.
 *
 * Named for the event in the world, not for the state it produces — because
 * one event can legitimately land in different places depending on where the
 * file already is, and naming an event after its destination hides that.
 */
export const APPLICATION_EVENTS = [
  "started",
  "intake_completed",
  "work_began",
  "borrower_owes",
  "borrower_satisfied",
  "third_party_blocked",
  "third_party_returned",
  "underwriting_began",
  "decided_counteroffer",
  "decided_conditional",
  "decided_approved",
  "conditions_cleared",
  "disclosures_complete",
  "closing_began",
  "rescission_began",
  "disbursed",
  "decided_decline",
  "adverse_action_delivered",
  "counteroffer_accepted",
  "counteroffer_lapsed",
  "response_window_lapsed",
  "borrower_withdrew",
  "ops_canceled",
  "draft_abandoned",
  "authorization_revoked",
] as const;

export type ApplicationEvent = (typeof APPLICATION_EVENTS)[number];

/**
 * Why a move was made, as a closed set.
 *
 * `application_transitions.reason_code` is free text in the database, so the
 * closed set lives here and the transition service's signature enforces it. A
 * report groups by these; a spelling that is not in the list is a compile
 * error rather than a bucket of one. The receipt's own reason is first, in
 * the spelling the SQL writes.
 */
export const TRANSITION_REASONS = [
  "six_pieces_received",
  "bank_connection_needed",
  "bank_already_connected",
  "bank_connected",
  "payroll_connection_needed",
  "tax_transcript_needed",
  "documents_needed",
  "payroll_connected",
  "transcripts_received",
  "documents_received",
  "application_signed",
  "sanctions_near_match",
  "engine_asked",
  "engine_conditional",
  "engine_ineligible",
  "engine_high_cost",
  "engine_clean",
  "borrower_requested",
  "persona_fixture",
] as const;

export type TransitionReason = (typeof TRANSITION_REASONS)[number];

/**
 * The legal edges.
 *
 * A mapped type over every state, so adding one to `ApplicationState` without
 * wiring its outgoing edges is a TypeScript error rather than a hole discovered
 * at runtime. Terminal states map to an empty object, which is the table saying
 * so out loud rather than by omission.
 */
type Edges = {
  readonly [S in ApplicationState]: Partial<Record<ApplicationEvent, ApplicationState>>;
};

export const MACHINE = {
  draft: {
    intake_completed: "intake_received",
    borrower_withdrew: "withdrawn",
    ops_canceled: "canceled",
    // A draft that never became an application. No notice is owed, because
    // nothing was applied for — which is why this is not `incomplete_closed`.
    draft_abandoned: "expired",
  },

  intake_received: {
    work_began: "in_processing",
    borrower_owes: "awaiting_borrower",
    third_party_blocked: "suspended",
    underwriting_began: "in_underwriting",
    authorization_revoked: "suspended",
    borrower_withdrew: "withdrawn",
    ops_canceled: "canceled",
  },

  in_processing: {
    borrower_owes: "awaiting_borrower",
    third_party_blocked: "suspended",
    underwriting_began: "in_underwriting",
    authorization_revoked: "suspended",
    borrower_withdrew: "withdrawn",
    ops_canceled: "canceled",
  },

  awaiting_borrower: {
    borrower_satisfied: "in_processing",
    third_party_blocked: "suspended",
    // Reg B: we asked, the window ran out, and nobody decided anything. This is
    // reported differently from a denial and from a withdrawal.
    response_window_lapsed: "incomplete_closed",
    authorization_revoked: "suspended",
    borrower_withdrew: "withdrawn",
    ops_canceled: "canceled",
  },

  suspended: {
    third_party_returned: "in_processing",
    borrower_owes: "awaiting_borrower",
    underwriting_began: "in_underwriting",
    response_window_lapsed: "incomplete_closed",
    borrower_withdrew: "withdrawn",
    ops_canceled: "canceled",
  },

  in_underwriting: {
    decided_counteroffer: "counteroffer_outstanding",
    decided_conditional: "conditionally_approved",
    decided_approved: "approved",
    decided_decline: "adverse_action_pending",
    // More evidence wanted before a decision can be made.
    borrower_owes: "awaiting_borrower",
    third_party_blocked: "suspended",
    authorization_revoked: "suspended",
    borrower_withdrew: "withdrawn",
    ops_canceled: "canceled",
  },

  counteroffer_outstanding: {
    counteroffer_accepted: "in_underwriting",
    // Silence is a decline, and it owes the borrower a notice like any other.
    counteroffer_lapsed: "adverse_action_pending",
    decided_decline: "adverse_action_pending",
    authorization_revoked: "suspended",
    borrower_withdrew: "withdrawn",
    ops_canceled: "canceled",
  },

  conditionally_approved: {
    conditions_cleared: "approved",
    borrower_owes: "awaiting_borrower",
    third_party_blocked: "suspended",
    decided_decline: "adverse_action_pending",
    authorization_revoked: "suspended",
    borrower_withdrew: "withdrawn",
    ops_canceled: "canceled",
  },

  approved: {
    disclosures_complete: "clear_to_close",
    // An approval can still come apart — an appraisal, a title problem, a
    // re-pull before closing.
    decided_decline: "adverse_action_pending",
    third_party_blocked: "suspended",
    authorization_revoked: "suspended",
    borrower_withdrew: "withdrawn",
    ops_canceled: "canceled",
  },

  clear_to_close: {
    closing_began: "closing",
    third_party_blocked: "suspended",
    borrower_withdrew: "withdrawn",
    ops_canceled: "canceled",
  },

  closing: {
    // Refinances, HELOCs and second liens on a primary residence. A
    // purchase-money mortgage has no rescission right and funds directly.
    rescission_began: "rescission_pending",
    disbursed: "funded",
    borrower_withdrew: "withdrawn",
    ops_canceled: "canceled",
  },

  rescission_pending: {
    disbursed: "funded",
    // Rescinding is the borrower's act, and it is the one place the product
    // hands them a power over us.
    borrower_withdrew: "withdrawn",
  },

  adverse_action_pending: {
    // The only way out is telling them why. There is deliberately no edge from
    // here to any approval word.
    adverse_action_delivered: "denied",
  },

  funded: {},
  denied: {},
  incomplete_closed: {},
  withdrawn: {},
  canceled: {},
  expired: {},
} as const satisfies Edges;

/**
 * The edge each outcome takes out of underwriting, or null for the two that
 * take none.
 *
 * `pending` has decided nothing. `referred` has decided nothing EITHER, and
 * that is the whole reason it exists: the engine could not compute an input it
 * needed, so there is no verdict to record and the file stays where a person
 * can pick it up. Mapping it to `decided_conditional` would put a file nobody
 * has looked at into "Approved with conditions" — the collapse the outcome
 * union was split to prevent.
 *
 * `clear_to_close` takes the file to the STATE `approved`, not to the state of
 * the same name: clear-to-close means the disclosures are delivered and their
 * waiting period has run, and no delivery record exists in this product.
 *
 * It lives beside the machine rather than beside the engine because it is a
 * statement about edges, and a test asserts every non-null value here is legal
 * from `in_underwriting`.
 */
export const OUTCOME_EVENT: Record<DecisionOutcome, ApplicationEvent | null> = {
  pending: null,
  referred: null,
  approved_with_conditions: "decided_conditional",
  counteroffer: "decided_counteroffer",
  denied: "decided_decline",
  clear_to_close: "decided_approved",
};

/** Thrown when a caller asks for an edge the machine does not have. */
export class IllegalTransition extends Error {
  constructor(
    readonly from: ApplicationState,
    readonly event: ApplicationEvent,
  ) {
    super(`An application in ${from} cannot handle ${event}.`);
    this.name = "IllegalTransition";
  }
}

/** Where `event` takes a file in `from`, or undefined if it cannot. */
export function nextState(
  from: ApplicationState,
  event: ApplicationEvent,
): ApplicationState | undefined {
  return (MACHINE[from] as Partial<Record<ApplicationEvent, ApplicationState>>)[event];
}

/** Where `event` takes a file in `from`. Throws rather than returning `from`. */
export function requireNextState(
  from: ApplicationState,
  event: ApplicationEvent,
): ApplicationState {
  const to = nextState(from, event);
  if (!to) throw new IllegalTransition(from, event);
  return to;
}

export function isTerminal(state: ApplicationState): boolean {
  return TERMINAL.includes(state);
}

/** Every event the machine will accept for a state, for a work queue or a UI. */
export function eventsFrom(state: ApplicationState): ApplicationEvent[] {
  return Object.keys(MACHINE[state]) as ApplicationEvent[];
}
