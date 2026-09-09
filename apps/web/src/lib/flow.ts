/**
 * The four screens, and the machinery for keeping ten server stages behind them.
 *
 * The engine still tracks ten stages and 77 requirements. The borrower sees
 * four steps. This module is the whole of that translation, and it is the only
 * place in the web app that knows both vocabularies.
 *
 * Two rules it exists to enforce:
 *
 * 1. **Payroll, IRS and document upload are not steps.** They are branches,
 *    entered only when the engine says something specific failed to resolve
 *    from the bank connection. A borrower who does not trigger one must never
 *    learn it exists — so they are absent from `SCREENS`, absent from the nav,
 *    and absent from the "step N of 4" count.
 *
 * 2. **Nothing here renders a requirement id.** The engine's `screen` and
 *    `actor` fields decide which branch is needed; the ids, counts, severities
 *    and statements stay server-side, where they are useful, and out of the
 *    borrower's face, where they are not.
 */

import { BRANCH_FOR_SCREEN, branchCanSatisfy, type BranchPath } from "@hm/shared";
import type { Assessment } from "./api.js";

/**
 * Paths that exist but are never steps.
 *
 * Re-exported from `@hm/shared` rather than restated here: the API records an
 * obligation against the same three names, and a second copy of the list is a
 * second place for a screen to be added to one side and not the other.
 * `ScreenPath` deliberately excludes them so that anything typed as a step —
 * the stepper, the progress count — cannot accidentally accept one.
 */
export type { BranchPath };

export type FlowStage =
  | "PROPERTY_LOAN"
  | "IDENTITY"
  | "CREDIT"
  | "BANK"
  | "PAYROLL"
  | "IRS_TRANSCRIPT"
  | "UPLOAD_FALLBACK"
  | "DECISION"
  | "PERSISTENT_CONSENT"
  | "COMPLETE";

/** The four steps, and nothing else. */
export const SCREENS = [
  { path: "property", label: "Property" },
  { path: "identity", label: "About you" },
  { path: "bank", label: "Your bank" },
  { path: "review", label: "Review" },
] as const;

export type ScreenPath = (typeof SCREENS)[number]["path"];

/**
 * Where a stage resumes to.
 *
 * The three branch stages resume to `review` rather than to themselves: a
 * borrower coming back tomorrow should land on the screen that tells them
 * where they stand, and be routed into a branch from there only if one is
 * still outstanding. Resuming straight into an IRS transcript screen is how a
 * conditional branch turns back into a step.
 */
export const STAGE_TO_SCREEN: Record<FlowStage, ScreenPath> = {
  PROPERTY_LOAN: "property",
  IDENTITY: "identity",
  // Borrower details are saved but the credit pull has not run — screen 2 is
  // not finished, so this is not a step forward for the borrower.
  CREDIT: "identity",
  BANK: "bank",
  PAYROLL: "review",
  IRS_TRANSCRIPT: "review",
  UPLOAD_FALLBACK: "review",
  DECISION: "review",
  PERSISTENT_CONSENT: "review",
  COMPLETE: "review",
};

/**
 * Where a file goes when the person behind it will not project.
 *
 * Screen 2 is the only screen that writes identity facts, so it is the only
 * one that can repair a file whose facts have gone unusable. Every other
 * screen reads the file and would render nothing.
 */
export const REPAIR_SCREEN: ScreenPath = "identity";

/** How far the borrower has actually got, as a step index. */
export function reachedIndex(stage: FlowStage | undefined): number {
  if (!stage) return 0;
  const path = STAGE_TO_SCREEN[stage];
  return SCREENS.findIndex((s) => s.path === path);
}

export function screenIndex(path: string): number {
  return SCREENS.findIndex((s) => s.path === path);
}

/* ── Conditional branches ───────────────────────────────────────────────── */

export interface Branch {
  readonly path: BranchPath;
  readonly title: string;
  /** Why this borrower is seeing it, in their words. Never a requirement id. */
  readonly because: string;
}

/** Why each branch is on screen, in the borrower's words. Never a requirement id. */
const BRANCH_COPY: Record<BranchPath, { readonly title: string; readonly because: string }> = {
  payroll: {
    title: "Confirm your employer",
    because: "We could not confirm your employment from your bank activity alone.",
  },
  irs: {
    title: "Your tax transcripts",
    because:
      "Some of your income needs a tax return to verify — self-employment and rental income usually do.",
  },
  documents: {
    title: "A few documents",
    because: "A small number of things could not be retrieved and need to come from you.",
  },
};

/**
 * Which branches this file actually needs, decided by the engine.
 *
 * This is the one place the requirements assessment still drives the borrower
 * UI, and it is exactly the use the rebuild keeps: the engine knows what did
 * not resolve, and that knowledge picks a branch. What it no longer does is
 * render itself — the caller gets at most three plain-English reasons, not a
 * list of outstanding requirement ids.
 *
 * `actor === "borrower"` matters. Plenty of payroll-screen requirements are
 * the lender's own work; sending a borrower to connect their employer because
 * an underwriter has something to do would be a branch triggered by the wrong
 * person's to-do list.
 *
 * `applicabilityKnown` matters for the same reason applicability is
 * three-valued everywhere else: "we might still need this" is not a reason to
 * make somebody log into their payroll provider.
 *
 * `branchCanSatisfy` is the rest of it, and it lives in `@hm/shared` because
 * the API asks the identical question when it records what the borrower owes.
 * A card offered here that the API does not count as an obligation — or the
 * reverse — is a file sitting at "Needs you" with nothing on screen to clear
 * it. `payrollLinked` is why the connection screen stops being offered once
 * the payroll snapshot is on the file: going back returns the same history.
 */
export function branchesFor(assessment: Assessment | undefined, payrollLinked: boolean): Branch[] {
  if (!assessment) return [];
  const live = assessment.outstanding.filter(
    (o) =>
      o.actor === "borrower" &&
      o.applicabilityKnown &&
      branchCanSatisfy({ requirementId: o.id, source: o.source }, payrollLinked),
  );
  // Screen order, off the shared map, so this list and the server's
  // obligations cannot disagree about which screens are branches at all. The
  // copy is the only part of a branch this file still owns.
  return (Object.entries(BRANCH_FOR_SCREEN) as [string, BranchPath][])
    .filter(([screen]) => live.some((o) => o.screen === screen))
    .map(([, path]) => ({ path, ...BRANCH_COPY[path] }));
}

/** Is the debug surface on? `?debug=1`, and nothing else turns it on. */
export function debugEnabled(search: string): boolean {
  return new URLSearchParams(search).get("debug") === "1";
}
