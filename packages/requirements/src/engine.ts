/**
 * The requirement engine: given a loan file, what applies, what is done, and
 * what can be worked on right now.
 *
 * Three questions, kept separate on purpose:
 *
 *   applies?    conditions.ts   — is this requirement about this borrower?
 *   satisfied?  satisfaction.ts — is the evidence here?
 *   unblocked?  graph.ts        — can it even be worked on yet?
 *
 * A borrower is only ever shown the intersection: applicable, unsatisfied and
 * unblocked. Everything else is either not their problem or not their problem
 * *yet*, and showing it is how a 77-row compliance sheet turns into a form
 * nobody finishes.
 */

import type { LoanFile } from "@hm/shared";
import type { FailureSeverity, Requirement, RequirementSource, ScreenId } from "./types.js";
import { type Applicability, evaluateCondition } from "./conditions.js";
import { evaluateSatisfaction, type Satisfaction } from "./satisfaction.js";
import { allRequirements, dependencies, transitiveDependencies } from "./graph.js";

/**
 * Who has to do something about a requirement.
 *
 * The borrower's list was 21 items long and 11 of them were things no borrower
 * can act on — "Loan Estimate delivered", "Homeownership counseling list
 * delivered", "OFAC / SDN screening cleared". Showing those to a person as
 * work they owe is not a small cosmetic problem: it buries the two things they
 * could actually do, and it makes the product look broken to somebody who
 * reads the list and looks for the button.
 *
 * This is derived from `source` rather than stored, so a new row in Drew's
 * sheet is classified the moment it lands.
 */
export type Actor = "borrower" | "lender";

export function actorFor(requirement: Requirement): Actor {
  switch (requirement.source) {
    case "borrower_input":
    case "connect_credit":
    case "connect_bank":
    case "connect_payroll":
    case "connect_irs":
    case "esign":
    case "document_upload":
      return "borrower";
    // `third_party_order` is something the lender orders; `derived` is the
    // engine's own arithmetic. Neither has a button a borrower could press.
    case "third_party_order":
    case "derived":
      return "lender";
  }
}

export interface Assessment {
  readonly requirement: Requirement;
  readonly applies: Applicability;
  readonly satisfaction: Satisfaction;
  /**
   * Requirements this one waits on that are not themselves satisfied. Empty
   * means it can be worked on now.
   */
  readonly blockedBy: readonly string[];
}

/** Triage order. Regulatory exposure outranks everything, then saleability. */
const SEVERITY_RANK: Record<FailureSeverity, number> = {
  regulatory_violation: 0,
  repurchase_unsaleable: 1,
  financial_loss: 2,
  rework_delay: 3,
};

/** Outstanding work the BORROWER can act on, in the order it should be worked. */
export function outstandingForBorrower(file: LoanFile): readonly Assessment[] {
  return outstanding(file).filter((a) => actorFor(a.requirement) === "borrower");
}

/** Outstanding work that is the lender's or the engine's, not the borrower's. */
export function outstandingForLender(file: LoanFile): readonly Assessment[] {
  return outstanding(file).filter((a) => actorFor(a.requirement) === "lender");
}

export function assessAll(file: LoanFile): readonly Assessment[] {
  const satisfactions = new Map<string, Satisfaction>();
  const applicabilities = new Map<string, Applicability>();

  for (const requirement of allRequirements()) {
    applicabilities.set(requirement.id, evaluateCondition(requirement.condition, file));
    satisfactions.set(requirement.id, evaluateSatisfaction(requirement, file));
  }

  return allRequirements().map((requirement) => {
    const blockedBy = dependencies(requirement.id).filter((dep) => {
      // A dependency that does not apply to this borrower cannot block.
      if (applicabilities.get(dep) === false) return false;
      return satisfactions.get(dep)?.status !== "satisfied";
    });
    return {
      requirement,
      applies: applicabilities.get(requirement.id) ?? null,
      satisfaction: satisfactions.get(requirement.id) ?? { status: "blocked", waitingFor: "unknown" },
      blockedBy,
    };
  });
}

/**
 * Everything that applies, is not satisfied, and is not waiting on something
 * else — in the order it should be worked.
 *
 * Requirements whose applicability is still `null` are INCLUDED. We do not yet
 * know they are needed, but we do not know they are not, and a decision screen
 * that omits them would be claiming a completeness it has not earned.
 */
export function outstanding(file: LoanFile): readonly Assessment[] {
  return assessAll(file)
    .filter((a) => a.applies !== false)
    .filter((a) => a.satisfaction.status !== "satisfied")
    .filter((a) => a.blockedBy.length === 0)
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.requirement.failureSeverity] - SEVERITY_RANK[b.requirement.failureSeverity] ||
        a.requirement.screenOrdinal - b.requirement.screenOrdinal ||
        a.requirement.id.localeCompare(b.requirement.id),
    );
}

/** Outstanding work grouped by the screen that collects it. */
export function outstandingByScreen(file: LoanFile): ReadonlyMap<ScreenId, readonly Assessment[]> {
  const grouped = new Map<ScreenId, Assessment[]>();
  for (const a of outstanding(file)) {
    const list = grouped.get(a.requirement.screen);
    if (list) list.push(a);
    else grouped.set(a.requirement.screen, [a]);
  }
  return grouped;
}

/**
 * Which connectors would clear the most outstanding work.
 *
 * This is what makes screens 3–6 worth showing in the order they are shown:
 * the bank connection carries 13 requirements and nothing else comes close,
 * which is why Drew put it fourth and called it the one that matters.
 */
export function connectorLeverage(file: LoanFile): readonly {
  source: RequirementSource;
  outstandingCount: number;
}[] {
  const counts = new Map<RequirementSource, number>();
  for (const a of outstanding(file)) {
    counts.set(a.requirement.source, (counts.get(a.requirement.source) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, outstandingCount]) => ({ source, outstandingCount }))
    .sort((a, b) => b.outstandingCount - a.outstandingCount);
}

export interface Progress {
  readonly applicable: number;
  readonly satisfied: number;
  readonly outstanding: number;
  readonly blocked: number;
  /** Applicability not yet knowable — the honest "we might still ask" count. */
  readonly undetermined: number;
  /** Of `outstanding`, the part the borrower can actually act on. */
  readonly borrowerOutstanding: number;
  /** Of `outstanding`, the part that is the lender's or the engine's. */
  readonly lenderOutstanding: number;
}

export function progress(file: LoanFile): Progress {
  const all = assessAll(file);

  // Only requirements that DEFINITELY apply are counted as satisfied.
  //
  // This is not a rounding choice, it is the difference between an honest
  // progress number and a dishonest one. Several evaluators are vacuously
  // satisfied against empty data — "0 investment income sources with a
  // two-year history" is trivially true before any income exists. Counting
  // those while their applicability is still unknown inflates the number
  // early, and then DEFLATES it the moment payroll returns and they resolve
  // to inapplicable. A borrower watching that sees their progress go
  // backwards for connecting an account, which is the precise experience this
  // product exists to eliminate.
  //
  // Caught by the end-to-end test in apps/api: satisfied went 23 → 21 across
  // the payroll connection, on five income requirements at once.
  const applies = all.filter((a) => a.applies === true);

  return {
    applicable: applies.length,
    satisfied: applies.filter((a) => a.satisfaction.status === "satisfied").length,
    outstanding: applies.filter(
      (a) => a.satisfaction.status !== "satisfied" && a.blockedBy.length === 0,
    ).length,
    blocked: applies.filter((a) => a.satisfaction.status !== "satisfied" && a.blockedBy.length > 0)
      .length,
    undetermined: all.filter((a) => a.applies === null).length,
    // Split out so the borrower's list and the borrower's count are computed
    // from the same predicate. They were not, and the number disagreed with
    // the list beneath it.
    borrowerOutstanding: applies.filter(
      (a) =>
        a.satisfaction.status !== "satisfied" &&
        a.blockedBy.length === 0 &&
        actorFor(a.requirement) === "borrower",
    ).length,
    lenderOutstanding: applies.filter(
      (a) =>
        a.satisfaction.status !== "satisfied" &&
        a.blockedBy.length === 0 &&
        actorFor(a.requirement) === "lender",
    ).length,
  };
}

/**
 * Why is this requirement not done? Answered in the terms a person uses.
 * Walks the dependency chain so "waiting on UW-002" becomes the actual root.
 */
export function explainBlock(file: LoanFile, requirementId: string): readonly string[] {
  const all = new Map(assessAll(file).map((a) => [a.requirement.id, a]));
  const target = all.get(requirementId);
  if (!target) return [];
  if (target.blockedBy.length === 0) return [];

  const roots: string[] = [];
  for (const dep of transitiveDependencies(requirementId)) {
    const a = all.get(dep);
    if (!a || a.applies === false) continue;
    if (a.satisfaction.status === "satisfied") continue;
    if (a.blockedBy.length === 0) roots.push(`${a.requirement.id} — ${a.requirement.statement}`);
  }
  return roots;
}
