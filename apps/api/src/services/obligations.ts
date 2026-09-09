/**
 * What is genuinely on the borrower, and the ledger row that says so.
 *
 * This is the server-side twin of the web's `branchesFor`. Both ask the same
 * question of the same engine output through the same shared rule, because the
 * failure they exist to prevent is the two disagreeing: a file parked at
 * "Needs you" with no card to clear it, or a card offered on a file whose
 * ledger says nothing is owed.
 *
 * The rule is narrower than "outstanding work a borrower owns". An engine
 * finding a person cannot act on — a recent inquiry, a commission history that
 * is only nine months long, a gap in employment — is a CONDITION on a decided
 * file, owned by the borrower and explained to them, not an obligation that
 * holds the application at "Needs you" waiting for a document that cannot
 * exist. `branchCanSatisfy` in `@hm/shared` is where that line is drawn, and
 * drawing it in one place is what keeps the card and the state in step.
 */

import { actorFor, outstanding } from "@hm/requirements";
import {
  BRANCH_FOR_SCREEN,
  OBLIGATION_REASON,
  branchCanSatisfy,
  type BranchPath,
  type LoanFile,
  type TransitionReason,
} from "@hm/shared";
import { servicePrincipal } from "./party.js";
import { recordEvent } from "./repository.js";
import { advanceIfLegal, toDomainState, type Advance } from "./transition.js";
import type { Db } from "./db.js";

export interface Obligation {
  readonly branch: BranchPath;
  readonly reason: TransitionReason;
  /** Server-side only. A requirement id must never reach the borrower. */
  readonly requirementIds: readonly string[];
}

/**
 * The branches this file is actually waiting on the borrower for, in screen
 * order.
 *
 * `applies === true` and not `!== false`: "we might still ask" is not a reason
 * to make somebody log into their payroll provider, for the same reason
 * applicability is three-valued everywhere else.
 */
export function borrowerObligations(file: LoanFile): readonly Obligation[] {
  const payrollLinked = file.payroll !== null;
  const live = outstanding(file).filter(
    (a) =>
      a.applies === true &&
      actorFor(a.requirement) === "borrower" &&
      branchCanSatisfy(
        { requirementId: a.requirement.id, source: a.requirement.source },
        payrollLinked,
      ),
  );

  const obligations: Obligation[] = [];
  for (const [screen, branch] of Object.entries(BRANCH_FOR_SCREEN) as [string, BranchPath][]) {
    const ids = live.filter((a) => a.requirement.screen === screen).map((a) => a.requirement.id);
    if (ids.length > 0) {
      obligations.push({ branch, reason: OBLIGATION_REASON[branch], requirementIds: ids });
    }
  }
  return obligations;
}

/**
 * What this file is waiting on the borrower for, as one reason and its cause.
 *
 * The bank comes first and is not a branch. `settleAfterIntake` asks the same
 * question of the same projection the moment an application is received, and
 * for a while it was the only thing that knew about it: the reconciler saw
 * only branches, so the FIRST unrelated borrower act — a document, a
 * signature — cleared `bank_connection_needed` and nothing ever wrote it
 * again. The file read "We're working on it. Nothing is needed from you right
 * now" and went to underwriting with no bank on it, which is a borrower being
 * told something false about their own application.
 *
 * The requirement ids ride in `causedBy`, which the borrower's view of the
 * ledger deliberately does not carry.
 */
function owedNow(
  file: LoanFile,
  causedBy: string,
): { readonly reason: TransitionReason; readonly causedBy: string } | null {
  if (file.assets === null) return { reason: "bank_connection_needed", causedBy };
  const first = borrowerObligations(file)[0];
  if (!first) return null;
  return {
    reason: first.reason,
    causedBy: `${causedBy} requires:${first.requirementIds.join(",")}`,
  };
}

/**
 * Record that the ball is in the borrower's court, if it is.
 *
 * The ONE writer of `borrower_owes` after a borrower act or a decision that
 * could not be made. Nothing owed means nothing written: an application
 * already saying "we're working on it" must not be nudged into "needs you" by
 * a page load.
 *
 * A SUSPENDED file is left where it is, and the file's own events say so. The
 * machine allows `borrower_owes` from there because a member of staff can
 * legitimately ask a held file's borrower for something, but a near match on a
 * sanctions list is not lifted by ordinary activity and must not be lifted by
 * this. Only `third_party_returned` ends that hold, and nothing in this slice
 * writes it. `advanceIfLegal` refuses the edge as well; recording it here is
 * what puts the refusal in the history a person reads.
 */
export async function reconcileObligations(
  tx: Db,
  args: { applicationId: string; file: LoanFile; causedBy: string },
): Promise<Advance | null> {
  const row = await tx.application.findUnique({
    where: { id: args.applicationId },
    select: { status: true },
  });
  if (!row) return null;
  const from = toDomainState(row.status);
  const owed = owedNow(args.file, args.causedBy);

  if (from === "suspended") {
    // Only when there was something to refuse. A held file that owes nothing
    // is a file this would have left alone anyway, and an event saying a move
    // was declined when no move was going to be made says nothing true.
    if (owed) {
      await recordEvent(
        args.file.id,
        "application_unchanged",
        "system",
        { event: "borrower_owes", reason: owed.reason, from },
        undefined,
        tx,
      );
    }
    return { skipped: "held", from };
  }

  if (!owed) return null;

  return advanceIfLegal(
    {
      applicationId: args.applicationId,
      event: "borrower_owes",
      actorPrincipalId: await servicePrincipal(tx, "application_flow"),
      reasonCode: owed.reason,
      causedBy: owed.causedBy,
    },
    tx,
  );
}
