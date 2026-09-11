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

import { BRANCH_FOR_SCREEN, branchCanSatisfy, type BranchPath, type FlowStage } from "@hm/shared";
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

/**
 * The stage, in the one spelling that crosses the wire.
 *
 * This module used to declare its own uppercase union of the same ten names,
 * which the compiler could not catch because nothing crosses a wire with a
 * type on it. `GET /files/:id` answers the lowercase domain names, and this
 * map had no key for any of them, so the two readers fed from that route both
 * came back empty: the bare `/f/:id` route navigated to `/f/:id/undefined`,
 * and `reachedIndex` returned −1 for every stage a file could actually carry.
 * `GET /files` sent the other spelling, which is what this map was keyed on,
 * so the file list's own lookups hit and its `?? "review"` fallback was never
 * once exercised — one seam, and only one side of it looked broken.
 *
 * The domain spelling is the one `@hm/shared` defines and `LoanFile.stage`
 * carries, so the fix is to stop having a second one.
 */
export type { FlowStage };

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
  property_loan: "property",
  identity: "identity",
  // Borrower details are saved but the credit pull has not run — screen 2 is
  // not finished, so this is not a step forward for the borrower.
  credit: "identity",
  bank: "bank",
  payroll: "review",
  irs_transcript: "review",
  upload_fallback: "review",
  decision: "review",
  persistent_consent: "review",
  complete: "review",
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

/**
 * Which paths render the standing for themselves, so the shell does not.
 *
 * The review screen puts the pill, the line and the history directly above its
 * own heading, and its pre-signature view replaces that line with the one
 * thing no state can say — that a signature is what is missing. The shell used
 * to render the same component 150px higher with the line un-replaced, so a
 * borrower read "Being decided" above "Sign to send it" and could not tell
 * whether their application had been sent.
 *
 * Keyed on the URL path rather than on `ScreenPath`: the three branches map to
 * `review` for the step nav, and none of them renders a standing of its own.
 */
export function screenOwnsStanding(path: string): boolean {
  return path === "review";
}

/* ── Conditional branches ───────────────────────────────────────────────── */

export interface Branch {
  readonly path: BranchPath;
  readonly title: string;
  /** Why this borrower is seeing it, in their words. Never a requirement id. */
  readonly because: string;
}

/**
 * Why each branch is on screen, in the borrower's words. Never a requirement id.
 *
 * Exported, though `branchesFor` below is the only reader in this file: these
 * are the only sentences the product has for what a payroll, transcript or
 * document branch is FOR, and the branch cards are not the only place that has
 * to say it — a file waiting on one has to be told the same thing away from
 * the screen that clears it. A second copy of these three sentences is how the
 * two surfaces come to describe the same outstanding work differently.
 */
export const BRANCH_COPY: Record<BranchPath, Omit<Branch, "path">> = {
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
