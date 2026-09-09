/**
 * The words for each way the review screen can end.
 *
 * A catalog, like `states.ts`: copy and nothing else. No color, no class, no
 * requirement id, and no figure — the figures come from the file, and a number
 * written down here would be a number nobody derived.
 *
 * It exists because the endings were inline in `ReviewPage.tsx`, where the
 * copy rules could not see them, and three of them made promises the product
 * cannot keep: "Sent to your email", "we will be in touch", "within three
 * business days". There is no mailer in this repo and nothing schedules
 * anything. `outcomes.test.ts` runs `PROMISES`, `DELIVERY_TIME`, `REQ_ID` and
 * `BRITISH` from `@hm/shared` over every string below.
 *
 * The two clock sentences a borrower reads — when the Loan Estimate is due and
 * that the date is on hold — are NOT here. They live in `ledger.ts`'s
 * `CLOCK_COPY`, which the timeline above every ending already renders, and one
 * sentence with two sources is one sentence that will drift.
 */

/**
 * The ending for `referred`: the engine could not compute an input it needed.
 *
 * This is the ending the outcome union was split to make sayable. Before
 * `referred` existed, a file whose pricing tests were blocked rendered "Your
 * Loan Estimate" with figures beside it, because the ratios it needed had
 * computed perfectly well — the ones that had NOT computed were the four
 * compliance tests, and nothing on the screen knew that. It says what is true:
 * the part that is missing is ours, not theirs.
 */
export const REFERRED_COPY = {
  headline: "We're reviewing this ourselves.",
  body: "Some of what goes into a Loan Estimate is ours to work out rather than yours — the pricing tests need figures we don't have yet. Nothing is needed from you right now. The answer will be here on this page.",
} as const;

/**
 * The ending for `denied`.
 *
 * Every figure block is deliberately absent. A declined borrower reading a
 * monthly payment and a debt-to-income ratio under a "Decision made" pill is
 * the same collapse as a refer wearing an approval, and the intent button —
 * "Yes, proceed" — has nothing left to proceed with.
 *
 * The due date for the written reasons is not repeated here: the ECOA clock
 * sits in the timeline directly above this, from the row the database opened.
 */
export const ADVERSE_COPY = {
  headline: "We can't approve this",
  body: "This is a decision about the loan you asked for, not a delay. You are owed a written explanation naming the specific reasons, and the date it is due is above.",
  reasonsLead: "Here are the reasons as we recorded them.",
  noReasons: "The reasons are being written down, and they will be here with the notice.",
} as const;

/**
 * The ending for `counteroffer`: creditworthy, wrong loan.
 *
 * The terms come from the application's active scenario, and the ending
 * renders them only when its origin is not `BORROWER`. "Here's one we can do"
 * with the borrower's own numbers under it would be the counteroffer collapsed
 * back into the application.
 *
 * Which is why `termsLead` is its own line rather than a sentence in the body.
 * Every counteroffer this product can produce has a `BORROWER` scenario and
 * therefore no terms to print, so a body promising them printed "Here are the
 * terms we can do instead." directly above "The alternative is being worked
 * out". The body now says only what is true with nothing to show; the promise
 * renders inside the block that keeps it.
 *
 * The reasons are the same bargain in the other direction: the body tells the
 * borrower they are owed them, so the ending renders the ones the engine
 * recorded, exactly as the adverse ending does.
 */
export const COUNTEROFFER_COPY = {
  headline: "Not that loan — but here's one we can do",
  body: "We can't do the loan the way you asked for it. Nothing is settled by this, and if you'd rather not, you are still owed the reasons we couldn't do it your way.",
  termsLead: "Here are the terms we can do instead.",
  loanAmount: "Loan amount",
  downPayment: "You bring to closing",
  propertyValue: "Property value",
  noTerms: "The alternative is being worked out, and it will be here when it is.",
  reasonsLead: "Here are the reasons we couldn't do it your way, as we recorded them.",
  noReasons: "The reasons are being written down, and they will be here on this page.",
} as const;

/** The three endings that were already here, with the promises taken out. */
export const ENDING_COPY = {
  estimateLead: "Here it is. Read it before you decide anything.",
  branchesNote:
    "Nothing here is urgent — your application is already in, and we'll finish our side once these are done.",
  oursLead: "Your application is in, and there is nothing left for you to do.",
  intentRecorded: "You told us to proceed. Nothing else is needed from you right now.",
} as const;

/**
 * The line beside the pill on the review screen BEFORE the signature.
 *
 * The only place a screen overrides the state's own words, and it is here
 * because no state can name what this view is asking for. The bank screen
 * posts the decision before it navigates here, so a file arriving at the
 * signature is `in_underwriting` and its heading is "Being decided" — a file
 * that still owes a branch is `awaiting_borrower` and names the branch. Either
 * one denies the signature the button underneath is asking for. The signature
 * is not a branch and not an obligation the ledger carries, so the state
 * cannot learn about it; the view that asks for it says so itself.
 */
export const SIGN_LEAD = "Sign to send it";
