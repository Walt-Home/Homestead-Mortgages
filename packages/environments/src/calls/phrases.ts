/**
 * The words the call rubric listens for, and how a line is read for them.
 *
 * A QA reviewer works from a checklist of statements: the disclosures a call
 * must carry and the things an agent must never say. A rule here reads them
 * as phrases, so a grader and a reviewer reading the same transcript reach
 * the same finding. Where the servicing app already lists the words, the list
 * is its own, restated with the line it comes from, and a test holds each to
 * that line:
 *
 *   - the threat words are `THREAT_WORDS` (apps/servicing/src/app/tools/section11.ts:57),
 *     the 11.3 guardrail "no threats (§1006.18(c))";
 *   - the options are `RETENTION_OPTIONS` and `DISPOSITION_OPTIONS`
 *     (section11.ts:54-55), the loss-mitigation options the servicing app
 *     names;
 *   - the mini-Miranda and the bankruptcy disclaimer are the words §1006.18(e)
 *     and the 11.4 modified notices use.
 *
 * The rest are ours, each a design choice that says so: the recording notice,
 * the AI disclosure (11.1 design item 1: "I'm an automated assistant for
 * Supermortgage…"), the servicemember protections, collection language, a
 * credit misstatement, a complaint, and an offer of modification terms.
 */

/** Lower case, punctuation and hyphens to spaces, curly apostrophes straight, spaces collapsed. */
export function normalizeLine(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether the line says the phrase: its words, in order and next to each other, as whole words. */
export function says(line: string, phrase: string): boolean {
  return ` ${normalizeLine(line)} `.includes(` ${normalizeLine(phrase)} `);
}

export const saysAny = (line: string, phrases: readonly string[]): boolean =>
  phrases.some((p) => says(line, p));

/** The servicing app's threat words, as its 11.3 guardrail reads them (section11.ts:57). */
export const THREAT_WORDS =
  /\b(we will (sue|foreclose (tomorrow|next week))|arrest|garnish|legal action will)\b/i;
/** The same words as phrases, for a reader: `THREAT_WORDS` matches a normalized line exactly when one of these is said. */
export const THREAT_PHRASES: readonly string[] = [
  "we will sue",
  "we will foreclose tomorrow",
  "we will foreclose next week",
  "arrest",
  "garnish",
  "legal action will",
];
/** A threat: the servicing app's words, on the line with its punctuation read as spaces. */
export const threatens = (line: string): boolean => THREAT_WORDS.test(normalizeLine(line));

/** The recording notice an agent gives on an outbound call (ours: the contact center's three wordings). */
export const RECORDING_PHRASES: readonly string[] = [
  "call is being recorded",
  "call is recorded",
  "call may be recorded",
];

/** An AI voice says what it is (11.1 design item 1). */
export const AI_DISCLOSURE_PHRASES: readonly string[] = ["automated assistant"];
/** How many of an AI call's first agent lines the disclosure must be among: the greeting, the introduction, and one more. */
export const AI_DISCLOSURE_WITHIN_LINES = 3;

/** The mini-Miranda (§1006.18(e)): said by every wording the contact center uses. */
export const MINI_MIRANDA_PHRASES: readonly string[] = ["attempt to collect a debt"];
/** The bankruptcy disclaimer, which takes the mini-Miranda's place during a case. */
export const BK_DISCLAIMER_PHRASES: readonly string[] = [
  "not an attempt to collect a debt",
  "informational purposes only",
  "informational only",
];

/** The script an active-duty servicemember's call carries (11.1, "SCRA active duty"; ours: the act named in full). */
export const MILITARY_PHRASES: readonly string[] = ["servicemembers civil relief act"];

/** Collection language: a demand or a request for payment (ours). During a bankruptcy case it is an act to collect. */
export const COLLECTION_PHRASES: readonly string[] = [
  "need to bring the account current",
  "need you to bring the account current",
  "set up a payment",
  "make that payment",
  "able to make a payment",
  "expect the full payment",
  "need the full payment",
  "you owe",
];

/** Telling a borrower the delinquency will not reach their credit (ours). */
export const CREDIT_MISSTATEMENT_PHRASES: readonly string[] = [
  "won't hurt your credit",
  "will not hurt your credit",
  "won't affect your credit",
  "will not affect your credit",
  "doesn't affect your credit",
  "won't show up on your credit",
  "won't show on your credit",
];

/** A complaint, in the caller's words (ours: the contact center's complaints, by their telling words). */
export const COMPLAINT_PHRASES: readonly string[] = [
  "file a complaint",
  "written up as a complaint",
  "want this escalated",
  "unhappy with",
  "frustrated with",
  "upset with",
];

/** An offer to change a modification's terms on the call: rate, payment, term or balance (ours). */
export const NEGOTIATION_PHRASES: readonly string[] = [
  "lower your rate",
  "drop your rate",
  "reduce your rate",
  "lower your payment",
  "reduce your payment",
  "extend your term",
  "extend the term",
  "add the past due amount to the end",
  "forgive part of the balance",
];

/** The loss-mitigation options, by the servicing app's names (section11.ts:54-55), and the words that name each on a call. */
export const OPTIONS = [
  "repayment_plan",
  "payment_deferral",
  "forbearance",
  "modification",
  "short_sale",
  "mortgage_release",
] as const;
export type OptionName = (typeof OPTIONS)[number];
export const OPTION_PHRASES: Readonly<Record<OptionName, readonly string[]>> = {
  repayment_plan: ["repayment plan"],
  payment_deferral: ["payment deferral", "deferral"],
  forbearance: ["forbearance"],
  modification: ["modification"],
  short_sale: ["short sale"],
  mortgage_release: ["mortgage release", "deed in lieu"],
};

/** A note's claim of the account's status (ours: as a collector writes it, "ACCT CURRENT"), which the record must bear out. */
export const NOTE_CURRENT_PHRASES: readonly string[] = ["acct current", "account current"];
export const NOTE_PAST_DUE_PHRASES: readonly string[] = ["acct past due", "account past due"];
