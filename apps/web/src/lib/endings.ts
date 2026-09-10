/**
 * Which ending the review screen renders, as a pure function.
 *
 * It used to be three inline conditions in `ReviewPage.tsx`, and they asked
 * only about the RATIOS: a payment and a debt-to-income ratio that computed
 * meant "Your Loan Estimate", whatever the engine had concluded and whatever
 * state the application was in. That is wrong in both directions at once. A
 * refer computes its ratios perfectly well — the four compliance tests are
 * what block — so a file nobody had decided rendered an estimate; and a
 * counteroffer, a decline and a funded loan all compute ratios too, so every
 * one of them rendered the same estimate under a pill that said otherwise.
 *
 * So this reads the outcome and the application's state, not the arithmetic.
 * The order below is the content:
 *
 * 1. **The two decided words that are not approvals**, each with its own
 *    ending, and only when the application actually took that edge. A
 *    declined borrower reading a monthly payment is the failure this whole
 *    function exists to stop, and a borrower we have declined must not then be
 *    asked for a paystub — but a decision ROW is not by itself evidence that
 *    anything was decided (see `APPLIED_ON`).
 * 2. **An application that has ended, moved past a decision, or is held, reads
 *    as its state** — heading and timeline, nothing else — whether or not a
 *    signature was ever recorded. A withdrawn file must not be asked to sign,
 *    a funded one must not be offered a Loan Estimate, and a file on a
 *    screening hold must not be asked to do anything at all.
 * 3. **Nothing else renders before the signature.** The pre-signature view is
 *    how a file gets signed, so an ending that beat it would make signing
 *    unreachable — a decision is computed on the bank screen, before the
 *    signature, and every unsigned file has one.
 * 4. **Then work the borrower can still finish.** A referral has decided
 *    nothing, and the ledger has already put a file with outstanding work into
 *    `awaiting_borrower`, so the header pill reads "Needs you" — an ending
 *    saying "Nothing is needed from you right now" beneath it, with no cards
 *    and no way to finish, is the copy contradicting the pill beside it.
 * 5. **Then `referred`**, which must never render as an estimate: "we could
 *    not compute this" is not a decision, and the ratios it needed computed
 *    perfectly well.
 * 6. **An estimate only for the two outcomes that are approvals**, and only
 *    while the state is still pre-approval.
 * 7. **"There is nothing left for you to do" last**, for a file where that is
 *    genuinely true.
 */

import type { DecisionOutcome } from "@hm/shared";

export type Ending =
  "referred" | "adverse" | "counteroffer" | "state" | "branches" | "estimate" | "ours";

/**
 * States at or past a decision, where a Loan Estimate block would be behind
 * the file rather than ahead of it, plus the held state. Terminal states are
 * handled separately — this is the list of live states that are nonetheless
 * done deciding or stopped.
 *
 * The state `approved` is deliberately NOT here, though it sounds like it
 * belongs. A `clear_to_close` outcome lands the application on `approved`, and
 * that borrower is owed exactly two things: the estimate, and the control that
 * records their intent to proceed — the only one in the product. Listing
 * `approved` here made the best possible outcome render as a pill and a Done
 * button, and left APP-007 with no control on any screen. The states past it
 * are the ones where the estimate really is behind the file.
 *
 * `suspended` is here because a hold is a hold: the file is stopped on
 * somebody else's answer, and the timeline is the honest landing page for it.
 */
const PAST_DECIDING = ["clear_to_close", "closing", "rescission_pending", "funded", "suspended"];

/**
 * Whether a decision is behind this file rather than ahead of it.
 *
 * The ending cascade asks this to decide that a file reads as its state, and
 * the timeline asks it about the Loan Estimate: an estimate is the offer a
 * borrower is still deciding on, so the date it is due by means something
 * only while there is still something to decide. On a funded loan, a
 * withdrawn file and a denial it is a deadline for a document that will never
 * be owed, printed under a pill that already said so.
 *
 * Terminal states are included, and `suspended` arrives through the list
 * above: a file stopped on somebody else's answer is not counting down.
 */
export function pastDeciding(
  state: { readonly status: string; readonly terminal: boolean } | null | undefined,
): boolean {
  return Boolean(state && (state.terminal || PAST_DECIDING.includes(state.status)));
}

/**
 * The states each decided word lands on when the machine applies it.
 *
 * A decision is RECORDED whether or not there was an edge for it — a file in
 * `awaiting_borrower` can be neither declined nor counter-offered, and the
 * ledger writes `decision_not_applied` — so the word on the row is not
 * evidence that anything was decided. Reading the word alone put "Not that
 * loan — but here's one we can do" under a pill reading "Needs you", for an
 * application that had never been counter-offered.
 *
 * A file with no application at all has nothing to check against, so there the
 * outcome is all there is.
 */
const APPLIED_ON: Partial<Record<DecisionOutcome, readonly string[]>> = {
  denied: ["adverse_action_pending", "denied"],
  counteroffer: ["counteroffer_outstanding"],
};

export interface EndingInput {
  /** `loan_files.application_signed_at` is set. */
  readonly signed: boolean;
  readonly outcome: DecisionOutcome | null;
  /** The application's own state, or null for a file that has none. */
  readonly state?: { readonly status: string; readonly terminal: boolean } | null;
  readonly ratios?: {
    readonly housingPitia: number | null;
    readonly dtiBack: number | null;
  } | null;
  /** What the borrower can still do from here, from `branchesFor`. */
  readonly branches: readonly unknown[];
}

/** Null means "no ending yet" — the pre-signature view renders instead. */
export function endingFor({
  signed,
  outcome,
  state = null,
  ratios = null,
  branches,
}: EndingInput): Ending | null {
  const applied = (word: DecisionOutcome) =>
    outcome === word && (!state || (APPLIED_ON[word] ?? []).includes(state.status));

  // Ahead of the state check, because `denied` is itself a terminal state:
  // reading it as "an application that has ended" would render the pill and
  // nothing else, and the reasons we recorded would never reach a screen.
  if (applied("denied")) return "adverse";
  if (applied("counteroffer")) return "counteroffer";
  if (pastDeciding(state)) return "state";
  if (!signed) return null;
  if (branches.length > 0) return "branches";
  if (outcome === "referred") return "referred";
  const canEstimate = ratios?.housingPitia != null && ratios.dtiBack != null;
  const approved = outcome === "approved_with_conditions" || outcome === "clear_to_close";
  if (canEstimate && approved) return "estimate";
  return "ours";
}

/**
 * The terms the counteroffer ending is allowed to print, or null.
 *
 * The application's active scenario is whatever it is currently being decided
 * against, and on a file the borrower walked that is the loan they typed in on
 * screen 1: `proposeScenario` defaults `origin` to `BORROWER`. The one writer
 * that passes anything else is the persona seed, which proposes Tom Nguyen's
 * counteroffer at seq 2 — so this is the path that prints his terms, not a
 * branch nothing takes. Rendering it unconditionally put
 * "Not that loan — but here's one we can do" directly above the borrower's own
 * loan amount and down payment, which is the counteroffer collapsed back into
 * the application. Anything not `BORROWER` is a set of terms somebody on our
 * side proposed, and only those are an alternative.
 */
export function proposedTerms<T extends { readonly origin: string }>(
  scenario: T | null | undefined,
): T | null {
  return scenario && scenario.origin !== "BORROWER" ? scenario : null;
}
