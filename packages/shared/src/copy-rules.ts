/**
 * The rules every line of borrower-facing copy has to keep, in one place.
 *
 * These regexes were written three times over — once for the state catalog,
 * once for the ledger's words, and once more when the review screen's endings
 * were rewritten — and three copies of a rule is three chances for one of them
 * to be the lenient one. They live in `@hm/shared` rather than in `apps/web`
 * because copy is not only a web concern: the persona stories the API serves
 * to the sign-in page are borrower-visible too, and a rule that lived in the
 * web app could not reach them.
 *
 * Nothing here reads the DOM or a token, so a test in any workspace can import
 * it.
 *
 * Two of these are honesty rules rather than style rules:
 *
 * - `PROMISES` — there is no mailer in this repo. No Resend, no SMTP, nothing,
 *   and no SMS sender either. Copy that says we will email, write, text or
 *   call is a promise no code can keep, and on a page a person can revisit for
 *   weeks it is one they will notice us breaking. "We'll put it here" is fine:
 *   the page is the delivery.
 * - `DELIVERY_TIME` — the same failure with a date instead of a channel. There
 *   is no calendar of federal holidays outside `add_business_days`, and
 *   nothing schedules anything, so "within three business days" commits the
 *   product to a deadline it has no mechanism for.
 *
 * Delete `PROMISES` and `DELIVERY_TIME` when a delivery record exists in the
 * schema, and not before.
 */

/**
 * A channel we cannot use, or a person who will not in fact make contact.
 *
 * `to your (email|inbox)` is the one alternative this did not carry when it
 * lived in `states.test.ts`, and the reason it is here now: the review
 * screen's Loan Estimate ending opened with "Sent to your email, and here it
 * is." for as long as the ending existed, because no test looked at that file.
 * A rule that cannot see the leak it was written for is a rule that will let
 * it back in.
 *
 * The channel alternatives grew again when the rules were first pointed at
 * the screens: `for everything in writing` was screen 2 naming the borrower's
 * email address, `text (me|you)` was an SMS opt-in that defaulted to on, and
 * `come back to you` was the bank screen's manual upload, written directly
 * beneath a comment saying the files are listed and nothing is sent.
 */
export const PROMISES =
  /\b(we'?ll (e-?mail|write|call|post|send)|we will e-?mail|by e-?mail|to your (e-?mail|inbox)|in the (post|mail)|letter (is )?(on its way|in the (post|mail))|get in touch|be in touch|reach out|contact you|come back to you|give you a call|we'?ll tell you|we can tell you|tell you when|let you know|talk to (someone|us)|for (everything|anything) in writing|text (me|you)\b|by (text|sms)|text message)\b/i;

/** A deadline nothing in this repo schedules. */
export const DELIVERY_TIME =
  /\b(within|by|in) (a few|\d+|one|two|three|five|ten) (business |working )?(days?|hours?|weeks?)\b/i;

/** An internal identifier. Nothing in the borrower flow renders one. */
export const REQ_ID = /\b(APP|CRD|INC|AST|UW|CLS)-\d{3}\b/;

/**
 * House style, and not cosmetic: a borrower who connects payroll and is then
 * asked for "payslips" is being asked by two different products.
 *
 * `postcode` and `favour` are here because both were on a screen — a labelled
 * input on the first thing a borrower does, and the one sentence on the bank
 * screen that tells somebody their rent history helped them. The rest are the
 * spellings that would arrive the same way, listed before they do rather than
 * after.
 */
export const BRITISH =
  /\b(payslip|cancelled|colour|behaviour|authoris\w*|instalment|whilst|favour\w*|postcode|licence|cheque|centre|organis\w*|recognis\w*|apologis\w*|neighbour\w*|labour|defence|travelling)\b/i;

/**
 * "11 September" reads as a typo to an American borrower and as correct to
 * everyone who wrote it. Month first.
 */
export const DAY_FIRST =
  /\b\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December)\b/;
