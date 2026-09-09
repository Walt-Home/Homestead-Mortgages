/**
 * The loan lifecycle, as a data structure.
 *
 * Eleven states on an object that is not the application. A Loan is a mortgage
 * that exists in the world: it outlives the application that made it, and it
 * may have had no application at all. This file is PURE — no database, no
 * clock, no I/O — for the same reason `application-machine.ts` is: every legal
 * and illegal edge is testable without Postgres, and the whole machine can be
 * read in one sitting by somebody deciding whether a new state belongs in it.
 *
 * Two things differ from the application machine, and both are the shape of
 * the object rather than a preference:
 *
 * 1. **Two birth states, not one.** An application always starts at `draft`. A
 *    loan starts either at `pending_boarding`, because we funded it, or at
 *    `imported_unclaimed`, because a servicer told us about a mortgage that was
 *    never ours. Neither is reachable from the other, so "reachable from the
 *    start" is a property of the two together.
 *
 * 2. **Five terminal states rather than six**, and one of them —
 *    `refinanced_internally` — is kept apart from `paid_off` deliberately.
 *    Both mean the balance is gone; only one of them means we are the reason,
 *    and that distinction is the one attributable chain this product exists to
 *    produce. Collapsing them would make the monitoring loop unmeasurable.
 *
 * Three absences are decisions. docs/states.md records the first two, because
 * both are about what a state would mean; the third is decided here, because it
 * is about which events the table has:
 *
 * - **No state for integration depth.** Deep link, then API, then acting as the
 *   subservicer is a connection detail. It belongs on the servicer row, so that
 *   becoming the servicer is a configuration change rather than a migration.
 * - **No delinquency state.** Delinquency is an attribute of the newest
 *   servicing observation, and so is every other figure that moves month to
 *   month.
 * - **No event for a record vanishing from the feed.** Absence is an
 *   observation, not knowledge of what happened — it could be a payoff, a
 *   servicing sale, or a bad export. `paid_off` and `transferred_out` are both
 *   terminal and both wrong to guess at, and none of the eleven states means
 *   "the servicer stopped telling us about this".
 *
 * The vocabulary is deliberately the same as the `loan_*` entries in
 * `apps/web/src/lib/states.ts`, which hold the words a borrower reads for each
 * of these.
 */

/** Every state a loan can be in. Ordered roughly as a mortgage travels. */
export const LOAN_STATES = [
  "pending_boarding",
  "boarding",
  "imported_unclaimed",
  "active",
  "monitoring_only",
  "in_servicing_transfer",
  "paid_off",
  "refinanced_internally",
  "transferred_out",
  "charged_off",
  "matured",
] as const;

export type LoanState = (typeof LOAN_STATES)[number];

/**
 * Where a loan can begin, and nowhere else.
 *
 * `pending_boarding` is a mortgage we funded. `imported_unclaimed` is one a
 * servicer sent us, attached to a person who has never signed in. Nothing
 * reaches either from the other, which is why the machine has no single root
 * and why reachability is asserted from both.
 */
export const LOAN_BIRTH_STATES: readonly LoanState[] = ["pending_boarding", "imported_unclaimed"];

/**
 * Ends. No outgoing edges, and the test enforces that against the table.
 *
 * A mortgage that ended did not end provisionally: the lien is released, the
 * loss is booked, or the servicing is somebody else's. Anything that comes
 * after is a different mortgage with its own row.
 */
export const LOAN_TERMINAL: readonly LoanState[] = [
  "paid_off",
  "refinanced_internally",
  "transferred_out",
  "charged_off",
  "matured",
];

/**
 * What can happen to a loan.
 *
 * Named for what happened in the world rather than for the state it produces,
 * because the state a loan is in does not always say what put it there:
 * `boarded_to_third_party` and `borrower_claimed` both end at
 * `monitoring_only`, and afterwards only the event tells a mortgage we funded
 * and boarded elsewhere from a stranger's mortgage somebody signed in and
 * claimed.
 *
 * The transfer pair is the same rule read from the other end. One announcement
 * — a servicing transfer has settled — is two names here because the direction
 * it settled in is the fact worth keeping, so
 * `transfer_completed_inbound` and `transfer_completed_outbound` are recorded
 * as two distinguishable things rather than as one event whose meaning a reader
 * has to reconstruct from where the loan landed.
 */
export const LOAN_EVENTS = [
  "boarding_file_sent",
  "servicer_acknowledged",
  "boarded_to_third_party",
  "borrower_claimed",
  "transfer_announced",
  "transfer_completed_inbound",
  "transfer_completed_outbound",
  "payoff_posted",
  "refinanced_by_us",
  "charge_off_posted",
  "term_completed",
] as const;

export type LoanEvent = (typeof LOAN_EVENTS)[number];

/**
 * Why a move was made, as a closed set.
 *
 * `loan_transitions.reason_code` will be a nullable text column, exactly as
 * `application_transitions.reason_code` already is, so the closed set lives
 * here and the mover's signature is what will enforce it — the same arrangement
 * `TRANSITION_REASONS` has for applications, and for the same reason: a report
 * groups by these, and a spelling that is not in the list should be a compile
 * error rather than a bucket of one.
 *
 * It is short because it names only the moves this product has a writer for. A
 * loan we funded moving through boarding has no reason code yet because nothing
 * writes that move yet, and a reason nobody writes is a bucket that can only
 * ever be empty.
 */
export const LOAN_TRANSITION_REASONS = [
  // Every move implied by a servicing extract: a payoff posted, a charge-off,
  // a term completed, a servicing transfer announced or resolved.
  "servicer_reported",
  // The one loan move a person causes: they proved who they were and the
  // mortgage became theirs to watch.
  "claim_confirmed",
  // A prior mortgage retired by one we originated. The only reason that may
  // accompany `refinanced_by_us`.
  "internal_refinance_funded",
] as const;

export type LoanTransitionReason = (typeof LOAN_TRANSITION_REASONS)[number];

/**
 * The legal edges.
 *
 * A mapped type over every state, so adding one to `LoanState` without wiring
 * its outgoing edges is a TypeScript error rather than a hole a borrower finds.
 * Terminal states map to an empty object, which is the table saying so out loud
 * rather than by omission.
 */
type LoanEdges = {
  readonly [S in LoanState]: Partial<Record<LoanEvent, LoanState>>;
};

export const LOAN_MACHINE = {
  pending_boarding: {
    boarding_file_sent: "boarding",
  },

  boarding: {
    servicer_acknowledged: "active",
    // Boarded somewhere that is not us. We keep the relationship and the rate
    // watch; we do not keep the servicing.
    boarded_to_third_party: "monitoring_only",
  },

  imported_unclaimed: {
    // The only non-terminal way out, and the only one a person takes. What is
    // on the other side is `monitoring_only`, never `active`: a mortgage
    // somebody else services does not become ours because its borrower signed
    // in.
    borrower_claimed: "monitoring_only",
    // A mortgage can end before anyone claims it, and then it can never be
    // claimed — every terminal state is final, and the claim asks for this one.
    payoff_posted: "paid_off",
    charge_off_posted: "charged_off",
    term_completed: "matured",
  },

  active: {
    transfer_announced: "in_servicing_transfer",
    payoff_posted: "paid_off",
    refinanced_by_us: "refinanced_internally",
    charge_off_posted: "charged_off",
    term_completed: "matured",
  },

  monitoring_only: {
    transfer_announced: "in_servicing_transfer",
    payoff_posted: "paid_off",
    refinanced_by_us: "refinanced_internally",
    charge_off_posted: "charged_off",
    term_completed: "matured",
  },

  in_servicing_transfer: {
    // The same announcement resolving two ways, which is why the transfer is a
    // state rather than a flag: in the window between the two, a payment can be
    // misdirected and the borrower's error-resolution rights follow the loan.
    transfer_completed_inbound: "active",
    transfer_completed_outbound: "transferred_out",
  },

  paid_off: {},
  refinanced_internally: {},
  transferred_out: {},
  charged_off: {},
  matured: {},
} as const satisfies LoanEdges;

/**
 * The six copy ids the claim flow renders.
 *
 * Not loan states, and deliberately not in `LoanState`: a claim is something a
 * person does about a loan, and every one of these describes the person's side
 * of it while the loan stays exactly where it was. They live beside the machine
 * anyway, so that the copy for them can be cross-checked the way the copy for
 * `APPLICATION_STATES` already is — against a list, rather than against a name
 * prefix, which is a check that passes for a state nobody has written words for.
 */
export const CLAIM_STATES: readonly string[] = [
  "claim_landing",
  "claim_offered",
  "claim_identity_pending",
  "claim_unopenable",
  "claim_declined",
  "claim_erased",
];

/** Thrown when a caller asks for an edge the machine does not have. */
export class IllegalLoanTransition extends Error {
  constructor(
    readonly from: LoanState,
    readonly event: LoanEvent,
  ) {
    super(`A loan in ${from} cannot handle ${event}.`);
    this.name = "IllegalLoanTransition";
  }
}

/** Where `event` takes a loan in `from`, or undefined if it cannot. */
export function nextLoanState(from: LoanState, event: LoanEvent): LoanState | undefined {
  return (LOAN_MACHINE[from] as Partial<Record<LoanEvent, LoanState>>)[event];
}

/** Where `event` takes a loan in `from`. Throws rather than returning `from`. */
export function requireNextLoanState(from: LoanState, event: LoanEvent): LoanState {
  const to = nextLoanState(from, event);
  if (!to) throw new IllegalLoanTransition(from, event);
  return to;
}

export function isTerminalLoan(state: LoanState): boolean {
  return LOAN_TERMINAL.includes(state);
}
