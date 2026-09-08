/**
 * Work only the borrower can personally do.
 *
 * The four-screen flow renders payroll, tax transcripts and document upload
 * as branches rather than steps: they appear only when the engine reports
 * outstanding work that a person has to supply. This is the one statement of
 * which work that is, shared by the web's `branchesFor` and the API's
 * obligations, so the card a borrower sees and the state the ledger records
 * cannot disagree about whether anything is on them.
 */

import type { TransitionReason } from "./application-machine.js";

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
 * transcripts" branch to authorize something the review screen was about to
 * ask them to sign anyway.
 *
 * The source is necessary but not sufficient. Some requirements carry one of
 * these sources and are still not something a branch can change: CRD-009
 * (recent inquiries), INC-005 (commission history) and INC-006 (an employment
 * gap) are judged from the credit report and the income history, and no
 * upload or connection ever satisfies them. Those are findings the decision
 * turns into conditions on a decided file, owned by the borrower — not
 * obligations that hold the file at "needs you" waiting for a document that
 * cannot exist. `branchCanSatisfy` below is the whole of that second half.
 */
export const BORROWER_MUST_ACT = ["borrower_input", "document_upload", "connect_payroll"] as const;

/**
 * The requirements a document branch can actually clear.
 *
 * CRD-008 — a letter explaining a derogatory account — is the only rule whose
 * evaluator reads the file's uploaded documents. CRD-006 carries
 * `document_upload` and reads like a second one, but bankruptcy seasoning is
 * decided from the engine's own derivation: no upload moves it.
 */
export const DOCUMENT_SATISFIABLE: readonly string[] = ["CRD-008"];

/**
 * The requirements a payroll connection can actually clear.
 *
 * INC-002 is the whole list: paystubs, or the asset report standing in for
 * them. The other payroll-screen rules read the income history the connection
 * returns, and connecting again returns the same history.
 */
export const PAYROLL_SATISFIABLE: readonly string[] = ["INC-002"];

/** As much of an outstanding item as the rule needs to judge it. */
export interface BranchCandidate {
  readonly requirementId: string;
  readonly source: string;
}

/**
 * Whether sending the borrower down a branch could change this item's answer.
 *
 * Both callers ask this one question — the web to decide whether to offer a
 * card, the API to decide whether the file is waiting on a person — so a
 * borrower is never shown a branch that leaves the ledger saying they owe
 * nothing, or held at "needs you" with no card to clear it.
 *
 * `payrollLinked` is the difference between "confirm your employer" and asking
 * somebody to connect an employer they already connected: once the payroll
 * snapshot is on the file, a second trip through that screen returns what is
 * already there.
 */
export function branchCanSatisfy(item: BranchCandidate, payrollLinked: boolean): boolean {
  if (!(BORROWER_MUST_ACT as readonly string[]).includes(item.source)) return false;
  if (item.source === "connect_payroll") {
    return !payrollLinked && PAYROLL_SATISFIABLE.includes(item.requirementId);
  }
  return DOCUMENT_SATISFIABLE.includes(item.requirementId);
}

/** The branch a screen's outstanding work sends the borrower to. */
export const BRANCH_FOR_SCREEN = {
  payroll: "payroll",
  irs_transcript: "irs",
  upload_fallback: "documents",
} as const;

export type BranchPath = (typeof BRANCH_FOR_SCREEN)[keyof typeof BRANCH_FOR_SCREEN];

/** The reason the ledger records when a branch is what the borrower owes. */
export const OBLIGATION_REASON = {
  payroll: "payroll_connection_needed",
  irs: "tax_transcript_needed",
  documents: "documents_needed",
} as const satisfies Record<BranchPath, TransitionReason>;
