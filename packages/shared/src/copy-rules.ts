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
 * Four of these are honesty rules rather than style rules. Three are listed
 * here; `VENDOR_ACTION` is the other one and argues for itself further down:
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
 * - `RATE_COMMITMENT` — the same failure about a price. There is no lock desk
 *   and no lock record, and every quote the pricing port returns says
 *   `locked: false`, so copy that calls a rate locked or guaranteed is a
 *   commitment nothing behind the screen can honor.
 *
 * Delete `PROMISES` and `DELIVERY_TIME` when a delivery record exists in the
 * schema, and `RATE_COMMITMENT` when a lock does, and not before.
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
 *
 * `someone will …` is the same failure without a channel: screen 1 answered a
 * borrower who disagreed with the county record by saying somebody would check
 * it, and the route behind that writes a `FileEvent`. There is no queue, no
 * assignee and no review surface in this repository, so the person promised
 * there does not exist — which is what puts it under this rule rather than
 * under the connector one below. No deployment switch makes it true.
 *
 * `we will …` is in that same alternation because the first draft of it was
 * not: written as `someone will`, it matched the one sentence that had just
 * been deleted and missed its twin thirteen lines above, where the prompt
 * asking for the correction said "We will check it" about the same absent
 * person. Who is named makes no difference to whether anybody reads it, so the
 * subject is an alternation and the verb list is the trigger. The adverb slot
 * is there because the second twin read "we will just confirm the details
 * later", and one word between the subject and the verb is all it took.
 */
export const PROMISES =
  /\b(we'?ll (e-?mail|write|call|post|send)|we will e-?mail|by e-?mail|to your (e-?mail|inbox)|in the (post|mail)|letter (is )?(on its way|in the (post|mail))|get in touch|be in touch|reach out|contact you|come back to you|give you a call|we'?ll tell you|we can tell you|tell you when|let you know|(?:someone|somebody|a reviewer|we)(?:'?ll| will) (?:just |then |also |soon |later |shortly )?(?:check|review|look|read|confirm|verify)|talk to (someone|us)|for (everything|anything) in writing|text (me|you)\b|by (text|sms)|text message)\b/i;

/** A deadline nothing in this repo schedules. */
export const DELIVERY_TIME =
  /\b(within|by|in) (a few|\d+|one|two|three|five|ten) (business |working )?(days?|hours?|weeks?)\b/i;

/** An internal identifier. Nothing in the borrower flow renders one. */
export const REQ_ID = /\b(APP|CRD|INC|AST|UW|CLS)-\d{3}\b/;

/**
 * A rate this product commits to, on a product that cannot commit to one.
 *
 * The fourth honesty rule, and the one about money rather than about contact.
 * There is no lock desk, no lock record and nothing that enforces an expiry:
 * every quote the pricing port returns sets `locked: false`, and
 * `QUOTED_LOCK_DAYS` names a column of a rate sheet rather than a period
 * anybody has been held to. So a sentence saying a rate is locked, or
 * guaranteed, is a claim no code here can keep — and unlike `PROMISES` it is
 * one a borrower can act on and lose money over, which is why it is a rule
 * rather than a note in a type.
 *
 * It was in a comment on `QuoteBase.locked` before it was here, and the page
 * it was already false on was the first one a borrower sees: the landing
 * hero's sub ended "with lowest rates guaranteed". A rule written where no
 * test reads it is not a rule.
 *
 * Bare "your rate" is deliberately NOT in the alternation. A screen telling
 * somebody what rate their file is quoted at, or a servicing page saying their
 * rate did not change, is describing a rate rather than committing to one, and
 * a rule that could not tell those apart is a rule people turn off.
 */
export const RATE_COMMITMENT =
  /\b(?:rates? (?:are |is )?guaranteed|guarantee\w* (?:the |a |you )?(?:lowest |best |low )?rates?|guaranteed rates?|rate lock\w*|lock\w* (?:in )?(?:your|the|a|this) rate|locked in)\b/i;

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

/**
 * A vendor this deployment may or may not have.
 *
 * Naming one is not by itself a false claim — screen 2's button has to say
 * "Verify your ID with Stripe", because a control that silently navigates to a
 * Stripe domain asking for a government ID looks exactly like the thing people
 * are warned about. It is a claim whose truth depends on `capabilities.mode`,
 * which is what puts it in this file.
 */
export const VENDOR_NAME = /\b(stripe|plaid|experian|equifax|transunion|credit bureaus?)\b/i;

/**
 * A borrower-facing sentence saying an outside party HAS done something.
 *
 * The third honesty rule, and the one with a switch behind it rather than a
 * missing feature: every sentence it matches is true on a deployment whose
 * connector is a vendor and false on one whose connector is a fixture. "A soft
 * pull. This does not affect your score." sat on screen 2 under an animation
 * that ran while `POST /files/:id/credit` answered out of `fixtures/personas`,
 * and "the rest goes straight to the credit bureaus" sat under the SSN field
 * in a repository with no credit adapter in it at all.
 *
 * So this is not a list of words to avoid; it is the list of claims that have
 * to be a function of the mode. The rule the tests hold is about WHERE such a
 * sentence may live — a screen may not carry one as a literal, and
 * `apps/web/src/lib/disclosures.ts` derives them — and, separately, that the
 * fixture wording says what happens instead rather than falling silent.
 *
 * The vocabulary is the trigger, not the rule: a claim phrased in words that
 * are not listed goes unseen, the same way `PROMISES` only knows the channels
 * somebody thought to write down. Add the phrase when the next one turns up.
 *
 * `verify what you earn` is the one that turned up next, and it was on the
 * bank screen — under the button, in the same card whose income figure had
 * just been relabelled BECAUSE the report never verifies income. Assets mode
 * has no income product; whether anything verifies earnings is a question
 * about the adapter, which is what puts it here. The gap before the object is
 * for the sentence as it was actually written — "verify what you have and
 * what you earn" — where the claim about earnings arrives second.
 */
export const VENDOR_ACTION =
  /\b(soft pull|pull(?:ed|ing)? your credit|checking your credit|credit checked|affects? your (?:credit )?score|your score is untouched|your bank is open|signed? in with your bank|verif\w+ (?:[a-z ]{0,20})?(?:what you earn|your (?:income|earnings)|the real (?:one|number)))\b/i;

/** Either half: a sentence whose truth turns on which adapter answered. */
export const VENDOR_CLAIM = new RegExp(`${VENDOR_NAME.source}|${VENDOR_ACTION.source}`, "i");

/**
 * Saying that what is on screen is not the real thing.
 *
 * Its two uses point in opposite directions, which is why it is one regex. A
 * disclosure written for a fixture has to carry one of these — replacing "we
 * pulled your credit" with silence leaves the borrower believing the animation
 * they are watching — and a disclosure written for a production connector must
 * carry none, which is the defect `identityRequiresRedirect` had: it was true
 * of a live Stripe key and gated a banner reading "Stripe's test mode".
 */
export const SANDBOX_CAVEAT =
  /\b(test mode|sandbox|simulated|made[- ]up|sample (?:credit|data|report)|prototype)\b/i;
