/**
 * Borrower words no single screen owns, and the home page's own.
 *
 * It started as the sentences two screens had each written out for themselves,
 * and the home page's copy joined them for the same reason from the other
 * direction: those words are read by a card, by a row and by a resolver, and
 * they are settled before any of the three exists.
 *
 * Separate from `states.ts`, which is the state catalog and also the gallery's
 * source: its bodies carry invented figures to illustrate a state, so whether
 * a string there may reach a borrower is a question about that field. Every
 * string here is shipping copy, and `home-copy.test.ts` holds all of them to
 * the five copy rules at once whether or not a state that would render one is
 * reachable today — which makes it a question about the file instead. Some of
 * them are written for branches nothing currently takes, and say so where they
 * sit; being unreachable is not what excuses a string from the rules.
 *
 * The sample-file refusal is the first thing in it because three screens
 * already said it: screen 2, the bank screen and every connector step each
 * wrote a sentence out for the same error code, and the connector's is already
 * a second wording of it — "so it can't be changed" against "so it is
 * read-only". That drift is the argument for the file. All three are here, the
 * two that share a sentence share it in code, and choosing one wording for all
 * three is a copy decision, not this one.
 *
 * Its session-level twin is `PERSONA_READ_ONLY` in `auth.tsx`, beside the
 * session it talks about, and the home page says that sentence rather than one
 * of its own. A refusal aimed at the account rather than at the file is
 * answered where the account is, and a second wording of one refusal is the
 * drift this file exists to end — so there is no session sentence in here to
 * find, and a page that wants one imports it from `auth.tsx`.
 *
 * Three screens say something similar to a sample borrower BEFORE they press
 * anything. Each one names the control it is talking about — nothing to
 * connect, nothing here that can be changed — so each stays on the screen that
 * knows which control that is. `home-copy.test.ts` pins the set to those
 * three, so a fourth screen writing one is a failure rather than a discovery.
 *
 * One of the three stands in for a control that is never rendered: the
 * connector step puts its button behind `!readOnly`, so the sentence is what
 * occupies the space. The bank screen and screen 1 both render their primary
 * control at full contrast, disable it, and print the sentence underneath — a
 * control that explains why it cannot be pressed, which is the shape the
 * connector step's version avoids. Both are named here as outstanding rather
 * than described as though they were fixed, because making either one obey the
 * rule changes what a sample borrower sees and is not this commit's to decide.
 */

import { CLOCK_COPY, timelineClock, timelineDate } from "./ledger.js";
import { entryFor } from "./states.js";
import type { BranchPath, ScreenPath } from "./flow.js";

/** What a person is told when the file they pressed a button on is a sample. */
export const SAMPLE_FILE = "This is a sample file, so it is read-only.";

/**
 * The same refusal where there is somewhere to go with it.
 *
 * Screen 2 is where a tester most often meets this, and it is the one screen
 * whose refusal can point at the thing that would work — a file of their own,
 * which every signed-in person who is not a sample borrower can start.
 */
export const SAMPLE_FILE_START_YOUR_OWN = `${SAMPLE_FILE} Start your own to walk the flow.`;

/**
 * The connector steps' wording of the same refusal, moved and not rewritten.
 *
 * It says the file cannot be CHANGED, which is the true thing about a button
 * that pulls a bank or an employer: the refusal is about the write, not about
 * what the tester may read. Whether that difference earns a second sentence is
 * a question somebody can now ask by reading one file.
 */
export const SAMPLE_FILE_CANNOT_CHANGE =
  "This is a sample file, so it can't be changed. Start your own to try this.";

/* ── The home page ──────────────────────────────────────────────────────── */

/**
 * The rest of this file is the signed-in home page's own words.
 *
 * It says one thing about a person's application and then says what they can
 * do about it, in nineteen states. Sixteen of those already have a heading in
 * the state catalog and the page uses it, so almost nothing here is a heading:
 * what is here is the BODY under each of them, the label on the one control,
 * and the sentence that stands in where there is no control at all. Those
 * three are the parts no catalog can write, because they are claims about what
 * this page does rather than about what the state means.
 *
 * They are here rather than inline in the page for the reason the module
 * exists: a sentence written into JSX meets none of the five rules, and this
 * page is the one a person comes back to for weeks. It is also the surface the
 * repo now points at whenever it says the answer will be here — which is a
 * promise made in `states.ts`, in `ledger.ts` and on the review screen, and
 * kept only if the page that is supposed to carry it says the right thing.
 */

/* ── A file still being filled in ───────────────────────────────────────── */

/**
 * A draft the borrower walked away from.
 *
 * What it does NOT say is that nothing has been looked up yet. A draft can
 * already carry an authorization, an identity check and a credit pull — the
 * grant and the intake are separate transitions and both are reachable while
 * the application is still a draft — so "starting again costs you nothing" is
 * the reassurance this page exists to stop.
 */
export const DRAFT_BODY = "You started this and stopped partway. Everything you entered is saved.";

/** What a control that resumes a half-filled file promises: the file, not a step. */
export const PICK_BACK_UP = "Pick this back up";

/* ── A file with us ─────────────────────────────────────────────────────── */

export const INTAKE_BODY =
  "Your application is in. We're working out what we can confirm on our own and what still needs to come from you.";

export const PROCESSING_BODY =
  "This is with us. We're confirming what we can from what you've already connected, and there's nothing for you to do while that runs.";

/**
 * The sentence that stands where a control would be.
 *
 * Silence in the place a button usually sits reads as an omission, and the
 * states that have no control are the states where a person most wants to know
 * that is deliberate. It is a claim about this moment, which is why it is one
 * sentence and not a promise about what happens next.
 */
export const NOTHING_WAITING = "Nothing is waiting on you.";

/**
 * A file stopped on a check of ours, naming no actor.
 *
 * There is no reviewer, no queue and no assignment behind a screening hold —
 * so a sentence saying somebody is looking at it would be the same falsehood
 * the catalog's "a named actor holds the file" already is. What is true is
 * that the check is ours, that nothing the borrower sends moves it, and that
 * the answer lands here. Nothing lifts this hold today, which is the part the
 * product owes rather than the copy.
 */
export const SUSPENDED_BODY =
  "This one is stopped on a check we run on every application. Finishing it is ours, not yours — nothing you send moves it along — and the answer will be here on this page.";

/* ── A file waiting on the borrower ─────────────────────────────────────── */

/**
 * Why the bank connection cannot be worked around.
 *
 * The three branches have their reasons written in `flow.ts`, beside the cards
 * that offer them. The bank is a step rather than a branch, so it has none,
 * and a file sitting at "connect your bank" with no reason under it is the one
 * outstanding obligation the product could not explain.
 */
export const OWED_BANK_BODY =
  "Your bank connection is what most of the checks read from, and nothing else can stand in for it.";

/** For a reason code nothing has words for: send them where the list is. */
export const OWED_UNKNOWN_BODY = "Open your application to see what's outstanding.";

export const CONNECT_YOUR_BANK = "Connect your bank";
export const SEND_TRANSCRIPTS = "Send your tax transcripts";
export const SEND_DOCUMENTS = "Send your documents";
export const OPEN_IT = "Open it";

/* ── A file at the signature, and past it ───────────────────────────────── */

export const UNSIGNED_BODY =
  "We have everything we need to send this. Read it over, sign, and it goes in.";

export const READ_AND_SIGN = "Read it and sign";

/**
 * A signed file whose decision row says something the machine never applied.
 *
 * The lead above it is one sentence for the whole of `in_underwriting`,
 * because the lead is a claim about who holds the file and that does not
 * change with the word the engine returned. The body is where the difference
 * goes, and on this branch there is no difference to report: a decision that
 * was recorded and refused an edge decided nothing.
 */
export const WITH_US_BODY =
  "Your application is in and it is with us. Nothing is needed from you right now, and the answer will be here on this page.";

/**
 * The counteroffer's control, naming a decision and never the terms.
 *
 * Nothing outside the persona seed proposes lender-origin terms, so every
 * borrower who reaches this state has none — and the review screen says so.
 * A label reading "See the terms" would make in words the promise the
 * figure-free rule was written to stop making in numbers.
 */
export const READ_THE_DECISION = "Read the decision";

/* ── A file that has been decided ───────────────────────────────────────── */

export const CONDITIONS_BODY =
  "The loan is approved. A short list of items has to be settled before it can close, and that list isn't on this page yet.";

/**
 * What an approved file says while the read that decides its control is out.
 *
 * Both defaults are wrong for somebody: guess "your move" and a borrower who
 * has already told us to proceed watches a button appear and vanish; guess
 * "ours" and a borrower who has not reads that nothing is needed, directly
 * over the one control the product has for saying otherwise. So the card says
 * the part that is true either way and leaves the action area empty for the
 * length of one fetch — and for good on a file that will not project, which is
 * the same absence and is not a better reason to guess.
 */
export const APPROVED_BODY = "Your application is approved.";

export const ESTIMATE_READY_BODY =
  "Your Loan Estimate is ready. Read it before you decide anything.";

export const READ_YOUR_ESTIMATE = "Read your Loan Estimate";

/** An approved file whose review screen will not in fact render an estimate. */
export const ESTIMATE_PENDING_BODY =
  "Your application is approved. The estimate itself is still being worked out on our side, and it will be here when it is.";

export const CLEAR_TO_CLOSE_BODY =
  "Everything we needed is in and checked. What's left is the closing itself.";

export const CLOSING_BODY = "This one is at closing. Nothing more is asked of you here.";

/**
 * A right announced with no control behind it, said plainly.
 *
 * No route writes a withdrawal from any state, so the cancel this sentence
 * describes cannot be offered. Saying the right exists and then printing a
 * button that does nothing would be worse; saying neither would be worse
 * still. This card is written and never rendered — nothing enters the state —
 * and that is what makes the shape acceptable rather than the words.
 */
export const RESCISSION_BODY =
  "You signed, and for a short window you can still cancel without giving a reason. There is no way to do that from this page yet.";

/**
 * A funded loan, with no loan to show.
 *
 * Nothing creates a loan record when the money moves, so there is no amount,
 * no rate, no payment and no servicer to put here. The history below the card
 * is the whole of what an ending gets, and it is better than a badge on a
 * blank page.
 */
export const FUNDED_BODY = "Your mortgage is funded. The record of how it got here is below.";

/**
 * The same ending on a card that has nothing under it.
 *
 * The sentence above ends on a claim about layout, which is true only while
 * the history is actually drawn — and the card draws it off the file's own
 * read, so it is missing for the length of that fetch and missing for good on
 * a file that will not project. The fix is the one the adverse-action body
 * gets: supply the sentence that is true without the thing it points at,
 * rather than trim the one that points at it. What is left is the whole of the
 * ending anyway. The money moved.
 */
export const FUNDED_WITHOUT_HISTORY = "Your mortgage is funded.";

/**
 * The adverse-action body for a file whose ECOA clock somehow is not there.
 *
 * The shipping sentence ends by pointing at the due date above it, which is
 * true wherever the clock renders and false wherever it does not. The fix is
 * to supply the referent rather than to trim a regulated string, so the clock
 * renders above the body and this stands in only if the row is missing. It
 * says the same thing about what is owed, in its own words and with its own
 * ending — a cut of the other sentence would drop either the half about the
 * explanation or the terminal punctuation.
 *
 * That ending names what is being waited on. The approved card two hundred
 * lines up ends "it will be here when it is", which works there because the
 * estimate is the subject of its own sentence; here the subject is the
 * explanation, and it is the writing of it that is outstanding.
 *
 * The branch is unreachable: the database opens the clock on every entry to
 * the state. It is written as defense, and it is tested by meaning against the
 * sentence it stands in for rather than by characters, so the regulated string
 * stays a single string.
 */
export const ADVERSE_WITHOUT_DATE =
  "This is a decision about the loan you asked for, not a delay. You are owed a written explanation naming the specific reasons, and it will be here when it is written.";

/**
 * A closed file, said once, whichever decision row is newest.
 *
 * The control beside it moves — it names the reasons when the machine took the
 * word and names the destination when it did not — but the body does not. What
 * this says is what the record holds, which is true of a declined file whether
 * or not the review screen will print the reasons today, and a second version
 * of it would be new wording on the one surface that owes a regulator a
 * reading before it changes.
 */
export const DENIED_BODY =
  "The decision stands and this application is closed. The written reasons are the record of why.";

/**
 * A control that names its destination and nothing the destination holds.
 *
 * That is the whole of why one label works on three different cards. The
 * approved file with a short list left has conditions no surface renders, and
 * either declined file whose recorded word the machine refused has reasons the
 * review screen will not print. What that screen always renders is where the
 * file stands, so a label promising only that is honored on all three — and a
 * reader who trims this to the case that mentions reasons takes the control
 * off the approved card with it.
 */
export const SEE_WHERE_THIS_STANDS = "See where this stands";

/* ── A file that stopped without a decision ─────────────────────────────── */

/**
 * A file closed for going quiet, and the one reassurance that is true.
 *
 * The catalog's own body for this state is where the credit clause comes from.
 * Every other version of "starting again costs you nothing" is gone from this
 * page: a lapsed file can carry a pull, and a sentence saying otherwise is the
 * reassurance a person would later find out was wrong.
 */
export const INCOMPLETE_BODY =
  "We closed this because it went quiet, not because of anything we found, and it is not recorded as a denial. The credit check we already ran stays on your credit file, the way any credit check does.";

export const WITHDRAWN_BODY =
  "This one is closed because you asked us to close it. Nothing further is happening on it.";

export const CANCELED_BODY =
  "We closed this application on our side. Nothing further is happening on it.";

export const EXPIRED_BODY =
  "You started this one and it sat long enough that we closed it. Nothing was decided on it, and you can start a new one whenever you like.";

export const START_A_NEW_APPLICATION = "Start a new application";

/* ── A file with no application behind it ───────────────────────────────── */

/**
 * The one card whose heading is its own sentence.
 *
 * `NO_APPLICATION` is what the standing row says on such a file, on this page
 * and on the two surfaces that already had one, and printing it as the heading
 * as well would put the same six words twice on one card in two sizes. So the
 * heading is this, and the constant stays where the other readers put it.
 */
export const NO_APPLICATION_LEAD =
  "This file was started before we kept a record of where it stands";

export const NO_APPLICATION_BODY =
  "There is nothing to report on where this one stands, but you can still open it.";

export const OPEN_THIS_FILE = "Open this file";

/* ── A state this page has never heard of ───────────────────────────────── */

/**
 * The heading on a card the resolver has no words for.
 *
 * Nineteen states are written out above, one by one, and a status outside them
 * is a state somebody added to the machine without writing the card for it.
 * The resolver has to be total, so the card still renders, and this is the
 * least a heading can say and still be true.
 */
export const UNKNOWN_STANDING_LEAD = "Your application";

/**
 * The body under it, which must not borrow the one for a file with no
 * application at all.
 *
 * Those are opposite claims. A file with no application has nothing recorded
 * about where it stands; a file in a state this page has no words for has a
 * status written down and read successfully. Saying "there is nothing to
 * report on where this one stands" over the second is the page denying a
 * regulated record exists because it is the page that is behind, and it is the
 * error this whole module is arranged to prevent.
 *
 * So it says the true thing — the standing is recorded, this surface is the
 * part that has not caught up — and offers the same way in.
 */
export const UNKNOWN_STANDING_BODY =
  "Where this one stands is recorded, and this page doesn't have the words for it yet. Open the file and you'll see it.";

/* ── The page, when it is not about one file ────────────────────────────── */

/**
 * The first thing a person sees when they have never applied.
 *
 * The page becomes the start rather than shrinking into an empty version of
 * itself, and it does not re-pitch: they have already signed in. The body is
 * the delivery contract said up front, and it is one of the few places the
 * promise is provably true — stopping and coming back is exactly what the four
 * screens support.
 */
export const START_LEAD = "Let's start your application.";

export const START_BODY =
  "Four steps — the property, you, your bank, and a review. You can stop anywhere and pick it back up here.";

export const START_NOW = "Start now";

/** The same offer for somebody who already has a file, under the sections. */
export const START_ANOTHER = "Start another application";

/**
 * One faint line while the list is read.
 *
 * Not the named-step progress component: that earns its keep across a
 * twenty-second handoff to a bank, and spending it on a list read would be the
 * same dishonesty in the other direction. No skeleton card either — a claim
 * about a regulated record cannot be drawn while the record is still coming.
 */
export const FINDING_WHERE_YOU_STAND = "Finding where you stand…";

/**
 * A failed list read, which is never the empty state.
 *
 * "You have no applications" is a claim about a regulated record, and a
 * network error is not evidence for it.
 */
export const UNREAD_LEAD = "We couldn't load your applications just now.";

export const UNREAD_BODY = "This is a problem on our side, not with anything you sent.";

export const TRY_AGAIN = "Try again";

/* ── The sections and the record ────────────────────────────────────────── */

export const OTHER_APPLICATIONS = "Your other applications";

/**
 * Ended files get their own heading rather than the live list.
 *
 * Mixing a withdrawn file in among the open ones is how one word came to mean
 * five different situations in the first place.
 */
export const CLOSED_FILES = "Closed";

export const SAMPLE_BORROWERS = "Sample borrowers";

export const RECENT_MOVES = "What's been happening";

export const SEE_EVERYTHING = "See everything that has happened";

/* ── The clocks, where this page says what the review screen cannot ─────── */

/**
 * The adverse-action clock's on-hold half, taken and not rewritten.
 *
 * Both surfaces that carry the ECOA date say the same thing about why it is
 * not running, and the sentence that says it is the one already shipping on
 * the review screen. It is named here because this page reads it under its own
 * rule — the clock renders ABOVE the body, to supply the referent the
 * regulated adverse-action sentence ends by pointing at — and a page that
 * quietly reached into the clock catalog for one of its two halves would leave
 * that rule somewhere nobody looking at the copy can see it.
 */
export const ECOA_ON_HOLD = CLOCK_COPY.adverseActionOnHold;

/**
 * The Loan Estimate clock once its date is behind the file, with no date.
 *
 * The estimate's two shipping halves ship together, by their own contract:
 * the date alone promises a delivery nothing can make, and the reason alone
 * hides a deadline somebody is entitled to. That contract is why this is a
 * third sentence rather than half of the pair — and it is needed because the
 * clock opens already on hold, so a date that has passed was never a deadline
 * running down. On a screen read once, a stale date was a wart. On a page
 * built to be read again every week, it is a lie, and dropping it loses
 * nothing true.
 */
export const ESTIMATE_ON_HOLD =
  "Your Loan Estimate is on hold: we don't yet have a way to deliver it, and it will be here when we do.";

/**
 * The control that goes to the recorded reasons, taken off the state catalog.
 *
 * The catalog carries these three words on `adverse_action_pending`, and this
 * page reads them there and on `denied`, where the destination and the payload
 * are the same. Typing them out again would put one button's words in two
 * files with nothing holding them together, and a reword of the catalog entry
 * would leave the gallery and the card naming the same control differently.
 * Asserted rather than defaulted: a fallback string would be that second copy,
 * and a catalog that has lost the entry should stop the page rather than paint
 * an empty button on a declined file.
 */
export const READ_THE_REASONS = entryFor("adverse_action_pending")!.action!;

/* ── What a sample borrower is offered instead of a control ─────────────── */

/**
 * A navigation control, demoted to a link naming what the destination shows.
 *
 * Not a permission fix — every one of these destinations is a GET a tester may
 * read. It is a framing fix: "Connect your bank" on a sample borrower's file
 * asks somebody to do that borrower's task, and the screen behind it would
 * refuse the write anyway. Keyed on the destination rather than on the state,
 * because the audience this is for is the team looking at eight sample
 * borrowers side by side, and the same generic sentence nineteen times over is
 * exactly what makes those eight rows unreadable.
 *
 * `/f/new/property` is absent on purpose: starting an application is the one
 * control here the server genuinely refuses, so it is removed rather than
 * demoted.
 */
export const QUIET_LABELS: Record<ScreenPath | BranchPath, string> = {
  review: "See where this file stands",
  bank: "See this borrower's bank screen",
  payroll: "See this borrower's employer screen",
  irs: "See this borrower's tax-transcript screen",
  documents: "See this borrower's documents screen",
  property: "See this borrower's property screen",
  identity: "See this borrower's details screen",
};

/** The review screen's quiet label where the control it replaced named the reasons. */
export const QUIET_REASONS = "See the reasons";

/* ── Telling one file from another ──────────────────────────────────────── */

/**
 * The loan's purpose in borrower words, off the raw column.
 *
 * The API sends the enum untranslated and writes no copy, which is the right
 * split — so the three words are here, and they are the only place the product
 * says what a `RATE_TERM_REFINANCE` is.
 */
export const PURPOSE_WORDS: Record<string, string> = {
  PURCHASE: "Purchase",
  RATE_TERM_REFINANCE: "Refinance",
  CASH_OUT_REFINANCE: "Cash-out refinance",
};

/**
 * What one file is called, from whatever is known about it.
 *
 * The purpose and the address are both null until screen 1 is saved, and a
 * draft abandoned partway through screen 1 is precisely the file this page
 * offers to pick back up — so a name built from those alone degrades to
 * nothing, and two such drafts render as two identical rows. The start date is
 * the fallback because it is the one thing every file has, and it is the same
 * `timelineDate` the ledger prints — year and all — so a file's name and the
 * record beside it can never disagree about which day it is.
 *
 * It takes the fields rather than the row so that this module, which is words,
 * does not depend on the page that reads them.
 *
 * Two drafts started the same day with no address still collide here: this
 * returns the day and not the time, so both come back with one name. Resolving
 * that belongs to whoever renders a group and can see the collision; a
 * function handed one row cannot know there is one. A person still cannot name
 * their own file at all, so whatever is done about it there will be a
 * machine's answer to a human question.
 */
export function fileLabel(row: {
  readonly purpose: string | null;
  readonly propertyCity: string | null;
  readonly propertyState: string | null;
  readonly createdAt: string;
}): string {
  const purpose = row.purpose ? PURPOSE_WORDS[row.purpose] : undefined;
  const place =
    row.propertyCity && row.propertyState ? `${row.propertyCity}, ${row.propertyState}` : null;
  const day = timelineDate(row.createdAt);

  if (purpose && place) return `${purpose} in ${place}`;
  if (purpose) return `${purpose}, started ${day}`;
  if (place) return `Started ${day} in ${place}`;
  return `Started ${day}`;
}

/**
 * The same name again, for a file that turned out not to be the only one.
 *
 * It is here rather than beside the caller that spots the collision for the
 * reason the module exists: a string built in a page or a resolver meets none
 * of the five rules, and a name a borrower reads off a list is a borrower line
 * whether it was typed out or assembled. The label is passed in rather than
 * rebuilt, so a file's two names can only ever differ by the clause this adds.
 *
 * Same zone as the day it follows, because the two halves are one moment: a
 * name reading "Started September 7, 2026, 11:14 PM" with the date in the
 * creditor's zone and the time in the browser's would name a day the file was
 * not started on.
 */
export function labelWithStartTime(label: string, createdAt: string): string {
  return `${label}, ${timelineClock(createdAt)}`;
}
