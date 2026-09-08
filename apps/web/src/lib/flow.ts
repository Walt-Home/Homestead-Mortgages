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

import type { Assessment } from "./api.js";

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
 * Paths that exist but are never steps.
 *
 * `ScreenPath` deliberately excludes these so that anything typed as a step —
 * the stepper, the progress count — cannot accidentally accept one.
 */
export type BranchPath = "payroll" | "irs" | "documents";

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

/**
 * Sources that represent work only the borrower can personally do.
 *
 * This is the distinction that turns three screens into three rarely-seen
 * branches. `connect_irs` is a pull we make ourselves, and `esign` is covered
 * by the single signature on the review screen — neither is a reason to send
 * somebody somewhere. What is left genuinely needs a person: typing an
 * explanation, attaching a document, or authenticating with their payroll
 * provider.
 *
 * Getting this wrong in the safe-looking direction is what produced the bug
 * this rule exists to fix. INC-008 (the 4506-C) is `esign` and `universal`, so
 * treating any outstanding IRS-screen item as a branch trigger sent *every*
 * borrower — including a clean W-2 file with nothing wrong — down a "tax
 * transcripts" branch to authorise something the review screen was about to
 * ask them to sign anyway.
 */
const BORROWER_MUST_ACT: readonly string[] = [
  "borrower_input",
  "document_upload",
  "connect_payroll",
];

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
 */
export function branchesFor(assessment: Assessment | undefined): Branch[] {
  if (!assessment) return [];
  const live = assessment.outstanding.filter(
    (o) => o.actor === "borrower" && o.applicabilityKnown && BORROWER_MUST_ACT.includes(o.source),
  );
  const needs = (screen: string) => live.some((o) => o.screen === screen);

  const branches: Branch[] = [];
  if (needs("payroll")) {
    branches.push({
      path: "payroll",
      title: "Confirm your employer",
      because: "We could not confirm your employment from your bank activity alone.",
    });
  }
  if (needs("irs_transcript")) {
    branches.push({
      path: "irs",
      title: "Your tax transcripts",
      because:
        "Some of your income needs a tax return to verify — self-employment and rental income usually do.",
    });
  }
  if (needs("upload_fallback")) {
    branches.push({
      path: "documents",
      title: "A few documents",
      because: "A small number of things could not be retrieved and need to come from you.",
    });
  }
  return branches;
}

/** Is the debug surface on? `?debug=1`, and nothing else turns it on. */
export function debugEnabled(search: string): boolean {
  return new URLSearchParams(search).get("debug") === "1";
}
