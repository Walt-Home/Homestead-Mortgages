/**
 * The ledger, in borrower words.
 *
 * `application_transitions` is written for an examiner: an event name, a
 * reason code from a closed set, the id of the principal that caused it. None
 * of that belongs on a borrower's screen — an event name is jargon, a reason
 * code is jargon with an underscore in it, and a principal id is an internal
 * identifier. This module is the whole translation, and it is the reason a
 * timeline can be rendered from the ledger at all.
 *
 * Two rules, both tested:
 *
 * 1. **Every event and every reason has words.** A row nobody wrote copy for
 *    would render as a blank line in the middle of somebody's history, so the
 *    fallback is the destination state's own heading, which always exists.
 *
 * 2. **No promise, no delivery time, no requirement id, no British spelling.**
 *    The same rules `states.test.ts` holds the state catalog to. There is
 *    still no mailer and no calendar of federal holidays; copy that implies
 *    either is copy the product cannot keep.
 */

import { CREDITOR_TIME_ZONE } from "@hm/shared";
import { entryFor } from "./states.js";

/**
 * What a file made before applications existed says instead of a pill.
 *
 * One sentence, in one place, because two components render it — the header
 * and the file list — and a copy that drifts in one of them is a legacy file
 * quietly claiming a state nobody recorded.
 */
export const NO_APPLICATION = "No application on record";

/**
 * What a move means to the person it happened to.
 *
 * The reason code narrows the event where it changes the sentence — "you sent
 * what we needed" is true of every `borrower_satisfied`, but "you connected
 * your bank" is what actually happened, and the vaguer sentence reads as
 * though we lost track.
 *
 * Exported so the test can hold the keys to the machine's own vocabulary: a
 * reason spelled wrong here is copy that never renders, and `wordsFor` cannot
 * say so because it falls back for anything it does not recognize.
 */
export const REASON_WORDS: Record<string, string> = {
  bank_connection_needed: "Something needed from you: connect your bank",
  payroll_connection_needed: "Something needed from you: confirm your employer",
  tax_transcript_needed: "Something needed from you: your tax transcripts",
  documents_needed: "Something needed from you: a few documents",
  bank_connected: "You connected your bank",
  payroll_connected: "You confirmed your employer",
  transcripts_received: "Your transcripts came in",
  documents_received: "You sent a document",
  application_signed: "You signed",
};

/** The moves that have words of their own. Exported for the same reason. */
export const EVENT_WORDS: Record<string, string> = {
  intake_completed: "Application received",
  borrower_satisfied: "You sent what we needed",
  work_began: "We started on it",
  underwriting_began: "Sent for a decision",
  decided_conditional: "Approved with conditions",
  decided_counteroffer: "A different loan offered",
  decided_decline: "Not approvable as asked",
  decided_approved: "Approved",
  third_party_blocked: "Paused while someone else checks something",
  borrower_withdrew: "Withdrawn at your request",
  disclosures_complete: "Disclosures done",
  closing_began: "Closing",
  disbursed: "Funded",
};

/**
 * One line of the timeline.
 *
 * `to` is the destination state, and it is what makes the fallback honest:
 * every state in the machine has a heading in the catalog, so an event
 * nobody has written words for still reads as where the file went.
 */
export function wordsFor(event: string, reasonCode: string | null, to: string): string {
  const byReason = reasonCode ? REASON_WORDS[reasonCode] : undefined;
  return byReason ?? EVENT_WORDS[event] ?? entryFor(to)?.heading ?? "Your application moved on";
}

/**
 * Whether a row has words of its own, or is reading the state's heading.
 *
 * The fallback is what keeps a blank line out of somebody's history, and it is
 * also what makes "every move we wrote copy for still has copy" impossible to
 * ask through `wordsFor` alone — every answer is a sentence whether the copy
 * was written or deleted. This is the question a test needs.
 */
export function hasWordsFor(event: string, reasonCode: string | null): boolean {
  if (reasonCode && REASON_WORDS[reasonCode]) return true;
  return Boolean(EVENT_WORDS[event]);
}

/**
 * Who caused it, in three words the product can stand behind.
 *
 * A borrower principal is the person reading the page. A service principal is
 * the product acting on its own — a receipt stamped by the database, an
 * obligation worked out from the engine — and calling that "Supermortgage"
 * would imply somebody looked at it. Everything else is a person here.
 */
export function actorWords(kind: string): "You" | "Supermortgage" | "Automatic" {
  if (kind === "BORROWER") return "You";
  if (kind === "SERVICE") return "Automatic";
  return "Supermortgage";
}

/**
 * The clocks, in words.
 *
 * A tolled clock is a date that is recorded and not running. Saying only the
 * date would promise a delivery this repo has no way to make; saying only "on
 * hold" would hide a deadline a person is entitled to know about. Both lines,
 * always together.
 */
export const CLOCK_COPY = {
  loanEstimateDue: (date: string) => `Your Loan Estimate is due by ${date}.`,
  loanEstimateOnHold:
    "That date is recorded but on hold: we don't yet have a way to deliver it, and it will be here when we do.",
  adverseActionDue: (date: string) => `Written reasons are due by ${date}.`,
  adverseActionOnHold: "That date is on hold for the same reason.",
} as const;

/**
 * Month first, in the creditor's zone.
 *
 * The zone is not cosmetic. `add_business_days` computes a deadline as the
 * instant before local midnight in `America/New_York`, so a Loan Estimate due
 * at the end of September 9 is 03:59:59.999Z on September 10 — and a browser
 * left to its own zone would print the tenth for a deadline that is the ninth.
 * The date a screen shows and the date the law counts have to be one date.
 */
export function timelineDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: CREDITOR_TIME_ZONE,
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The same month-first words for a date that is not an instant.
 *
 * A date of birth off an identity document is `1985-03-12` and nothing more —
 * there is no time and no place on it, so there is no zone to convert from.
 * `timelineDate` would read it as UTC midnight and print the eleventh, which
 * is somebody's birthday moved a day to render it. Anything that is not a
 * plain calendar date comes back untouched rather than as "Invalid Date".
 */
export function calendarDate(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
