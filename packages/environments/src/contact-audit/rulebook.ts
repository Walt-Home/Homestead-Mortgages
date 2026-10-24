/**
 * The rules a model is given, and graded against.
 *
 * An audit of a loan's contact history for two staff errors, as a servicer's
 * quality-control desk audits a contact center: a promise to pay the agent
 * heard and did not record (S-01), and a complaint the agent heard and did
 * not log (S-02). What a recorded promise and a logged complaint get is the
 * contact center's own handling (src/contacts) and the servicing app's
 * spec 4.5 for a complaint; the grader is the twin's labels, so a sentence
 * here that disagrees with them is a task nobody can pass, and the reference
 * policy follows these words through the tools alone and is held to the
 * labels on every generated task. Every list of words below is a constant,
 * written in, so the two cannot drift. Change this text and the
 * environment's version changes with it.
 */

import { COMPLAINT_PHRASES } from "../calls/index.js";
import { COMPLAINT_RESPONSE_DAYS } from "../contacts/index.js";
import { phraseList } from "../call-qa/rulebook.js";

/** An agent acknowledging a complaint on the call: the contact center's three wordings. */
export const ACK_PHRASES: readonly string[] = [
  "document this as a complaint",
  "documenting your complaint",
  "logged this as a formal complaint",
];
/** Where a copied-forward note begins, as the comment log writes it. */
export const NOTE_PREV_MARK = " | PREV: ";
/** Findings beyond the labels a submission may make and still pass. */
export const AUDIT_EXTRA_FINDINGS_CAP = 2;

const q = phraseList;

export const CONTACT_AUDIT_RULEBOOK = `# Contact audit

You audit one loan's contact history over a window, the way a servicer's quality-control desk audits its contact center for staff errors: what an agent heard and wrote down on a call, held against what the servicer's systems recorded and did after it. Report each staff error at its root, and the symptoms it caused. Follow these rules exactly. A rule reads the words it lists and nothing else.

Conventions:
- The task gives the loan, the window (from and to, both days included) and the contact log: every contact dated in the window, oldest first. Each row has its id, its day (on) and time at the property (at, HH:MM), direction, mode (call, ivr, portal, email, sms or letter), who it was with, outcome, purpose, reason, resolution, issue (the matter it belongs to), the agent who handled it (null for none), promise_id (the promise the call recorded, or null), complaint_logged, and transcript (whether the call was recorded).
- The tools read the rest, everything dated in the window: read_notes (the comment log), read_transcript and search_transcripts (the calls as the speech recognizer wrote them: words may be misheard, dropped or [inaudible], and a mono recording labels its speakers "Speaker 1", "Speaker 2" and so on), read_promises (the promise log), read_complaints (the complaint log, which the complaint-handling system keeps) and read_payments (the payments received). calculate does arithmetic; never add amounts in your head.
- A line says a phrase when the phrase's words appear in it in order and next to each other, as whole words, ignoring case, with every character other than a letter, a digit or an apostrophe (hyphens included) read as a space. search_transcripts finds exactly these lines.
- Dates are YYYY-MM-DD and times HH:MM. One contact is after another when its day is later, or its day is the same and its time later.
- A call's note is the comment-log line whose contact is the call's id and whose user is the call's agent. Its own part is the text before the first "${NOTE_PREV_MARK.trim()}" (a collector copying an earlier note forward); the rest is the earlier note's and is not read.

## What the servicer's systems do with a promise and a complaint

A promise to pay: the agent writes it in the call's note (as "PTP $1,234.56 BY 03/28/27") and records it, so the call's row carries its promise_id and the promise log holds it, made on the call's day with its pay-by date and amount. While it is pending the outbound dialer is ceased: no collection attempt from the call through the pay-by date. On the pay-by date the promise is marked kept, or marked broken and the dialer resumed ("PTP BROKEN - CADENCE RESUMED" in the comment log).

A complaint (the servicing app's spec 4.5; an oral complaint is a complaint): the agent acknowledges it on the call (SM_COMPLAINT_ACK_1BD) and logs it, so the call's row has complaint_logged true, the comment log has a CMPL line, and the complaint log holds a case for the call. The case is answered in writing within ${COMPLAINT_RESPONSE_DAYS} calendar days of the call (SM_COMPLAINT_RESOLVE_15): the case's responded_on and response.

## S-01: a promise not tracked

A call made a promise when its note's own part says a dollar amount, the word BY and a date, next to each other in that order. The amount is digits with two decimals, with or without a $ and commas ($1,234.56, $1234.56 or 1,234.56); the date is M/D/YY or M/D/YYYY, with leading zeros or not (03/28/27, 3/28/27 or 03/28/2027), and YY is 20YY. Every such call in the window must have its promise in the promise log: a promise whose contact is the call.

A call that made a promise and has none in the promise log is an S-01 root. Give its promise as the note says it: the amount in dollars and cents, and the pay-by date as YYYY-MM-DD.

Its symptoms:
- dialed_in_window: each outbound collection attempt (direction outbound, mode call, purpose collection) after the root call and on or before the promise's pay-by date. One finding for each, on the attempt's id.
- kept_not_marked: the payments received after the root call's day and on or before the pay-by date add up to at least the promise's amount. The promise was kept, and nothing marks it kept. On the root call's id.
- broken_not_followed_up: otherwise. The promise was broken, and nothing marks it broken or follows it up. On the root call's id.

## S-02: a complaint not logged

A call voiced a complaint when some line of its transcript, whoever said it, says ${q(COMPLAINT_PHRASES)}. Every call that voiced one must be logged: its row's complaint_logged is true.

A call in the window that voiced a complaint and has complaint_logged false is an S-02 root, unless an earlier call in the window on the same issue voiced one and has complaint_logged false too: then it is the borrower raising that root's complaint again, and a symptom of that root.

Its symptoms:
- no_acknowledgment: no line of the root call's transcript says ${q(ACK_PHRASES)}. On the root call's id.
- no_response: the complaint log holds no case for the root call, so nobody answered it in writing. On the root call's id.
- raised_again: each later call in the window on the same issue that voiced a complaint and has complaint_logged false. One finding for each, on that call's id.

## Submitting

Call submit_audit once with findings, every root and every symptom, each once:
- error: "S-01" or "S-02";
- kind: "root", or the symptom's name;
- contact: the contact id the rule puts it on;
- promise: on an S-01 root, {amount, pay_by}; null on every other finding.
How it is graded: a window with no staff error passes with no findings, and any finding fails it. Elsewhere every root must be found, an S-01 root with its promise as the note gives it; a symptom earns part of its root's credit when the root is missed, and beside the root is neither required nor extra; and at most ${AUDIT_EXTRA_FINDINGS_CAP} findings may be ones these rules do not give, a second finding on the same thing among them. A submission that does not fit the schema comes back as an error to correct; a valid one ends the task.
`;
