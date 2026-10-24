/**
 * The rules a model is given, and graded against.
 *
 * This is the call rubric (src/calls) as a QA reviewer's form: the servicing
 * app's collections spec (11.1's decision record, guardrails and evaluation
 * suite), the pre-dial checks its `preDialChecks` computes, and the two
 * checks of its conversation harness that carry over to a call. The grader
 * is the rubric's functions, so a sentence here that disagrees with them is
 * a task nobody can pass; the reference policy follows these words through
 * the tools alone and is held to the grader on every generated task. Every
 * list of words below is the rubric's own constant, written in, so the two
 * cannot drift. Change this text and the environment's version changes with
 * it.
 */

import {
  AI_DISCLOSURE_PHRASES,
  AI_DISCLOSURE_WITHIN_LINES,
  AUTOMATIC_FAILS,
  BK_DISCLAIMER_PHRASES,
  CALL_CAP,
  CALL_CAP_DAYS,
  CALL_TEMPLATES,
  COLLECTION_PHRASES,
  COMPLAINT_PHRASES,
  CREDIT_MISSTATEMENT_PHRASES,
  LANDLINE_AI_CAP,
  LANDLINE_AI_DAYS,
  MILITARY_PHRASES,
  MINI_MIRANDA_PHRASES,
  NEGOTIATION_PHRASES,
  NOTE_CURRENT_PHRASES,
  NOTE_PAST_DUE_PHRASES,
  OPTIONS,
  OPTION_PHRASES,
  PREV_MARK,
  RECORDING_PHRASES,
  THREAT_PHRASES,
  VOICE_WINDOW,
} from "../calls/index.js";

/** A list of phrases as the rulebook writes it: "a", or one of "a", "b" or "c". */
export const phraseList = (xs: readonly string[]): string => {
  const quoted = xs.map((x) => `"${x}"`);
  return quoted.length === 1
    ? quoted[0]!
    : `one of ${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
};
const q = phraseList;

export const CALL_QA_RULEBOOK = `# Call QA

You review one recorded servicing call the way the servicer's QA desk does, against the call rubric below: every item the call fails, with the line it fails on; whether the call fails outright; whether the agent's note matches the loan's record; and the loss-mitigation options the agent named. Follow these rules exactly. A rule reads the words it lists and nothing else: a line that means the same thing in other words is not a finding.

Conventions:
- The task gives the call's row (call), the transcript (each line with its number, its time into the recording, the channel's label and the recognizer's text), the loan's record at the end of the call's day (record), the facts the dialer held when it dialed (pre_dial; null for an inbound call), and the agent's note (note; null when the call left none).
- An agent line is a transcript line whose speaker is "Agent". A caller line is one whose speaker is "Customer". Lines labeled "IVR" (the phone menu) and "" (the recorder's own markup) are neither. The words are the recognizer's: read them as written.
- A line says a phrase when the phrase's words appear in it in order and next to each other, as whole words, ignoring case, with every character other than a letter, a digit or an apostrophe (hyphens included) read as a space. search_transcript finds exactly these lines.
- A dollar amount is a $ followed by digits, with or without commas and cents.
- Instants are ISO 8601 in UTC. Use local_time for an instant's time in a zone and minutes_between for how far apart two instants are; never do clock arithmetic in your head. "Within N days before dial_at" means 0 ≤ minutes_between(t, dial_at) < N × 1440. Use record_on for the record on any day but the call's.
- A finding is an item and a line: the line it is on, or null where the rule says null. List every finding once.

## Who was told what

identity: when call.identity_verified is not true, every agent line that says a dollar amount is a finding on its line. An automatic fail.

## Disclosures

ai_disclosure: when call.voice is "ai", one of the first ${AI_DISCLOSURE_WITHIN_LINES} agent lines must say ${q(AI_DISCLOSURE_PHRASES)}. Otherwise ai_disclosure, line null.

recording_disclosure: when call.direction is "outbound" and call.outcome is "conversation", some agent line must say ${q(RECORDING_PHRASES)}. Otherwise recording_disclosure, line null.

collection_disclosure: when call.outcome is "conversation" and call.with is not "attorney", one disclosure is due:
- the bankruptcy disclaimer, when the record shows a bankruptcy case: record.bankruptcy is not null, and it is not a Chapter 13 case with a discharged_on on or before the call's day. Some agent line must say ${q(BK_DISCLAIMER_PHRASES)}.
- otherwise the mini-Miranda, when call.debt_collector is true or record.past_due is not null. Some agent line must say ${q(MINI_MIRANDA_PHRASES)} and not say "not an attempt to collect a debt".
When the one due is missing: collection_disclosure, line null.

## Before the call

On an outbound call, read pre_dial. Each of these is a finding with line null:
- predial_consent: mode is "ai_voice", line_type is not "landline", and tcpa_voice_consent_active is false.
- predial_line_type: mode is "ai_voice", line_type is "landline", written_consent is false, and ${LANDLINE_AI_CAP} or more of ai_voice_attempts_at are within ${LANDLINE_AI_DAYS} days before dial_at.
- predial_time_zone: in some zone of time_zones, the local time of dial_at is not after ${VOICE_WINDOW.after} or is after ${VOICE_WINDOW.through} (${VOICE_WINDOW.after} itself is outside the window, ${VOICE_WINDOW.through} inside). One finding, however many zones.
- predial_regf_count: take the number of counted_call_attempts_at within ${CALL_CAP_DAYS} days before dial_at, plus one for this call. The cap is ${CALL_CAP.debt_collector} when fdcpa_debt_collector is true; otherwise ${CALL_CAP.MA} when state is "MA", and ${CALL_CAP.policy} elsewhere. The finding when the number is over the cap.
- predial_cease: cease_active or written_cease is true.
- predial_bankruptcy: bk_active is true.
- predial_attorney: attorney_represented is true.

## The loan's flags

military: when call.servicemember_active_duty is true, call.outcome is "conversation" and call.with is "borrower" or "co_borrower", some agent line must say ${q(MILITARY_PHRASES)}. Otherwise military, line null.

## What is never said

Each is a finding on every line that says it:
- threat: an agent line that says ${q(THREAT_PHRASES)}.
- negotiation: an agent line that says ${q(NEGOTIATION_PHRASES)}.
- voicemail: when call.outcome is "voicemail_left" and pre_dial.voicemails_to_number_7d is 1 or more, every agent line.
- bankruptcy_collection: when the record shows a bankruptcy case (as for the disclaimer above, whatever the outcome), an agent line that says ${q(COLLECTION_PHRASES)}. An automatic fail.
- credit_misstatement: an agent line that says ${q(CREDIT_MISSTATEMENT_PHRASES)}. An automatic fail.
- complaint_not_logged: when call.complaint_logged is false, a caller line that says ${q(COMPLAINT_PHRASES)}. An automatic fail.

## Figures

Every figure an agent says needs a source. A figure is a run of digits: "$1,234.56" is the runs 1, 234 and 56; "March 5th" is 5; "6.375 percent" is 6 and 375; "1-800-555-0187" is 1, 800, 555 and 0187. The sources are:
- every run of digits in every caller line;
- every value in the record, as runs of digits: each string as written ("$1,234.56" gives 1, 234 and 56; "0012345678" gives 0012345678; "6.375" gives 6 and 375), each number by its digits; and for a date written YYYY-MM-DD, also the year, the year's last two digits, and the month and the day without a leading zero (2026-09-05 gives 2026, 09, 05, 26, 9 and 5). Keys, true, false and null give nothing.
A run on an agent line with no source is a finding on that line: wrong_amount when the run is part of a dollar amount on the line (an automatic fail), provenance when it is not. A line can carry both.

verbatim: an agent line that is one of these copy-library templates, word for word, is a finding on its line. Word for word means equal ignoring case, quotation marks and apostrophes, *emphasis* marks, the spacing between words, and the punctuation at the end; a {{token}} stands for any words. The templates:
${CALL_TEMPLATES.map((t) => `- ${t.key}: "${t.text}"`).join("\n")}

## Fails outright

fails_outright is true exactly when some finding is ${AUTOMATIC_FAILS.slice(0, -1).join(", ")} or ${AUTOMATIC_FAILS[AUTOMATIC_FAILS.length - 1]}.

## The note

note is null when the task's note is null. Otherwise split note.text at the first "${PREV_MARK}": the part before it is the agent's own note, read against the record of the call's day; the part after it, when there is one, is an earlier note copied forward, read against the record of note.copied_from.on (record_on). In each part:
- every number must be in its record. A dollar amount ("$1,234.56", "$1234.56", "1,234.56" or "1234.56": digits with two decimals) is found when some amount in the record has the same dollars and cents, ignoring its sign. A date written M/D/YY or M/D/YYYY, with leading zeros or not, is found when some YYYY-MM-DD date in the record has the same month and day, and the same year when the note gives one (YY is 20YY). A rate ("6.375%" or "6.375 percent") is found when some value under a key ending in _pct is the same number. Any other number is found when it is the same number as some number in the record, some string of digits alone (the loan number, a ZIP code, the last four digits of a taxpayer number), or the year of some date.
- a status must agree: a part that says ${q(NOTE_CURRENT_PHRASES)} contradicts a record whose past_due is not null, written CURRENT; a part that says ${q(NOTE_PAST_DUE_PHRASES)} contradicts a record whose past_due is null, written PAST DUE.
matches is true when nothing contradicts its record. contradictions lists every number not found, as the note writes it, and every status that contradicts, in the order they appear, the own part first; [] when the note matches.

## The options told

options_told: for each loss-mitigation option an agent line names, the first agent line that names it. ${OPTIONS.map((o) => `${o} is named by ${q(OPTION_PHRASES[o])}`).join("; ")}.

## Submitting

Call submit_review once with:
- findings: every finding, each {item, line};
- fails_outright;
- note: {matches, contradictions}, or null;
- options_told: each {option, line}; [] when none was named.
A submission that does not fit the schema, or does not hang together (a line on an item that takes none, none on an item that takes one, a fails_outright the findings disagree with, a matches the contradictions disagree with), comes back as an error to correct; a valid one ends the task.
`;
