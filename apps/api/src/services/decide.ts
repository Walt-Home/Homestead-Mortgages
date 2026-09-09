/**
 * Recording a decision, and letting it move the application.
 *
 * Two acts that must not be confused. Recording is append-only and always
 * happens: a decision is a computation that occurred, and the row is the
 * evidence it did. Applying is the state change, and it happens only when the
 * machine has an edge for it — a decision computed on a file that is waiting
 * on the borrower is a real decision that changes nothing, and the file event
 * says so rather than the ledger inventing a move.
 *
 * The one rule this file exists to keep: a decision the engine could not fully
 * compute must never wear a decided word. That rule is no longer enforced
 * here. `refer` now has its own outcome — `referred` — and `OUTCOME_EVENT` in
 * `@hm/shared` maps it to no edge at all, so the file stays in underwriting by
 * the same mechanism that keeps `pending` there. The guard this file used to
 * carry read the RECOMMENDATION because the outcome could not be trusted; the
 * outcome can be trusted now, and one rule in one place is the point.
 */

import type { Prisma } from "@hm/db";
import { OUTCOME_EVENT } from "@hm/shared";
import type { Decision, DecisionOutcome, LoanFile, TransitionReason } from "@hm/shared";
import { advanceIfLegal, moved, toDomainState, type TransitionResult } from "./transition.js";
import { servicePrincipal } from "./party.js";
import { reconcileObligations } from "./obligations.js";
import { recordEvent } from "./repository.js";
import type { Db } from "./db.js";

const REASON_FOR_OUTCOME: Record<DecisionOutcome, TransitionReason | undefined> = {
  pending: undefined,
  referred: undefined,
  approved_with_conditions: "engine_conditional",
  counteroffer: "engine_ineligible",
  denied: "engine_high_cost",
  clear_to_close: "engine_clean",
};

/**
 * Write the decision and the conditions it carries.
 *
 * Conditions are replaced wholesale on each run; a condition the borrower has
 * already cleared must not reappear, so cleared rows survive.
 */
export async function recordDecision(
  tx: Db,
  loanFileId: string,
  decision: Decision,
): Promise<{ decisionId: string }> {
  const row = await tx.decision.create({
    data: {
      loanFileId,
      outcome: decision.outcome,
      computedAt: new Date(decision.computedAt),
      ausEngine: decision.aus!.engine,
      ausEngineVersion: decision.aus!.engineVersion,
      ausCasefileId: decision.aus!.casefileId,
      ausRecommendation: decision.aus!.recommendation,
      ausFindings: decision.aus!.findings as unknown as Prisma.InputJsonValue,
      ratios: decision.ratios as unknown as Prisma.InputJsonValue,
      reserves: decision.reserves as unknown as Prisma.InputJsonValue,
      compliance: decision.compliance as unknown as Prisma.InputJsonValue,
      pricing: decision.pricing as unknown as Prisma.InputJsonValue,
      derivations: decision.derivations as unknown as Prisma.InputJsonValue,
      adverseActionReasons: [...(decision.adverseActionReasons ?? [])],
    },
    select: { id: true },
  });

  await tx.loanCondition.deleteMany({ where: { loanFileId, status: "open" } });
  const cleared = await tx.loanCondition.findMany({
    where: { loanFileId },
    select: { requirementId: true },
  });
  const clearedIds = new Set(cleared.map((c) => c.requirementId));
  const fresh = decision.conditions.filter((c) => !clearedIds.has(c.requirementId));
  if (fresh.length) {
    await tx.loanCondition.createMany({
      data: fresh.map((c) => ({
        loanFileId,
        requirementId: c.requirementId,
        description: c.description,
        status: c.status,
        owner: c.owner,
        issuedAt: new Date(c.issuedAt),
        documentIds: [...c.documentIds],
      })),
    });
  }

  return { decisionId: row.id };
}

/**
 * Let a recorded decision move the application, if it may.
 *
 * In order: the file goes into underwriting because somebody asked the engine;
 * then the outcome takes its edge, if the outcome has one and the machine has
 * it from where the file now is; then whatever the borrower still owes is
 * reconciled, so a file that could not be decided says "needs you" rather than
 * sitting silently in review.
 *
 * A SUSPENDED file is left where it is. The machine offers `underwriting_began`
 * from `suspended` because a person can decide to underwrite a held file, but a
 * page load is not that person: the hold ends with `third_party_returned` and
 * nothing else.
 */
export async function decideApplication(
  tx: Db,
  args: {
    applicationId: string;
    loanFileId: string;
    decision: Decision;
    decisionId: string;
    file: LoanFile;
  },
): Promise<{ moved: TransitionResult[]; notApplied: boolean }> {
  const { applicationId, loanFileId, decision, decisionId, file } = args;
  const causedBy = `decision:${decisionId}`;
  const movedRows: TransitionResult[] = [];

  const row = await tx.application.findUnique({
    where: { id: applicationId },
    select: { status: true },
  });
  if (!row) return { moved: [], notApplied: false };
  if (toDomainState(row.status) === "suspended") {
    await recordEvent(
      loanFileId,
      "application_unchanged",
      "system",
      { event: "underwriting_began", from: "suspended", outcome: decision.outcome },
      undefined,
      tx,
    );
    return { moved: [], notApplied: false };
  }

  const began = await advanceIfLegal(
    {
      applicationId,
      event: "underwriting_began",
      actorPrincipalId: await servicePrincipal(tx, "application_flow"),
      reasonCode: "engine_asked",
      causedBy,
    },
    tx,
  );
  if (moved(began)) movedRows.push(began);

  const event = OUTCOME_EVENT[decision.outcome];

  let notApplied = false;
  if (event === null) {
    // `pending` and `referred`. Nothing was decided, so nothing moves — and
    // the file's own events say the engine ran and reached no verdict, rather
    // than the ledger implying it was never asked.
    await recordEvent(
      loanFileId,
      "application_unchanged",
      "system",
      { outcome: decision.outcome, recommendation: decision.aus?.recommendation ?? null },
      undefined,
      tx,
    );
  } else {
    const decided = await advanceIfLegal(
      {
        applicationId,
        event,
        actorPrincipalId: await servicePrincipal(tx, "shadow_aus"),
        reasonCode: REASON_FOR_OUTCOME[decision.outcome],
        causedBy,
      },
      tx,
    );
    if (moved(decided)) {
      movedRows.push(decided);
    } else {
      // Either the same outcome arriving twice, or a decided state with no
      // edge to this one — `conditionally_approved` can be declined but not
      // re-approved. Recorded, not forced.
      notApplied = true;
      await recordEvent(
        loanFileId,
        "decision_not_applied",
        "system",
        { outcome: decision.outcome, state: decided.from },
        undefined,
        tx,
      );
    }
  }

  const owed = await reconcileObligations(tx, { applicationId, file, causedBy });
  if (moved(owed)) movedRows.push(owed);

  return { moved: movedRows, notApplied };
}
