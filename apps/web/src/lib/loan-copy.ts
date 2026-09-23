/**
 * The words on a mortgage, settled before the card and the page that read them.
 *
 * Two things they keep apart, because the data does. What the servicer's
 * tape said is a fact with a date on it and is introduced as theirs; what the
 * platform concluded is a reading of those facts against the market and is
 * introduced as ours. A verdict is said in four sentences, one per word the
 * engine has, and the engine's reasons reach the page only as the platform's
 * own words for them — never as its codes, which name things like universes
 * and deltas that a person did not ask about.
 *
 * Nothing here promises a channel, a deadline or a rate: `loan-copy.test.ts`
 * holds every string to the copy rules, and the `borrower-copy` suite reads
 * the screens that render them.
 */

import { loanEntry } from "./loan.js";
import type { ObservedStatus, ReviewVerdict } from "./loan.js";

export const YOUR_MORTGAGE = "Your mortgage";
export const YOUR_MORTGAGES = "Your mortgages";
export const SEE_THIS_MORTGAGE = "See this mortgage";
export const BACK_TO_YOUR_MORTGAGES = "Back to your mortgages";

/** A read that failed, or a mortgage that is not this person's. */
export const MORTGAGE_UNREAD_LEAD = "We couldn't read this mortgage just now.";
export const MORTGAGE_UNREAD_BODY =
  "Nothing about it has changed. It just didn't come through, and trying again is safe.";
export const NOT_YOUR_MORTGAGE_LEAD = "There's no mortgage of yours here.";
export const NOT_YOUR_MORTGAGE_BODY =
  "Either the link is wrong or this one isn't attached to your account. The ones that are, are on your home page.";

/**
 * The heading, by state.
 *
 * The catalog's own heading for every state but one: an unconfirmed mortgage
 * names the servicer that shared it, because "Grander shared this with us"
 * is the gallery's sample and the servicer on the tape is not always Grander.
 */
export function mortgageLead(state: string, servicer: string | null): string {
  if (state === "imported_unclaimed")
    return `${servicer ?? "Your servicer"} shared this mortgage with us`;
  return loanEntry(state)?.heading ?? YOUR_MORTGAGE;
}

/** The sentence under the heading. What is here, whose it is, and what that means for now. */
export function mortgageBody(state: string, servicer: string | null): string {
  const who = servicer ?? "your servicer";
  switch (state) {
    case "imported_unclaimed":
      return `${who} handles your payments. Until you confirm this mortgage is yours, what's here is what ${who} told us and nothing more — we haven't looked you up anywhere, and we can't.`;
    case "monitoring_only":
      return `${who} handles your payments, not us. We compare this mortgage against the market, and this page says where that stands.`;
    case "active":
      return `${who} collects your payment. This page is your mortgage as we hold it, and what we're watching on it.`;
    default:
      return `Serviced by ${who}. This page is the record as we hold it.`;
  }
}

/* ── What the servicer told us ─────────────────────────────────────────── */

export const fromYourServicer = (servicer: string | null, asOf: string | null) =>
  asOf
    ? `What ${servicer ?? "your servicer"} told us, as of ${asOf}`
    : `What ${servicer ?? "your servicer"} told us`;
export const NO_TAPE_YET = "Your servicer hasn't told us anything about this mortgage yet.";

export const BALANCE = "Balance";
export const RATE = "Rate";
export const NEXT_PAYMENT_DUE = "Next payment due";
export const MONTHLY_PAYMENT = "Monthly payment";
export const IN_ESCROW = "Held in escrow";
export const STANDING = "Standing";

/** The tape's status word, and how far behind when it is behind. */
export function standingWords(status: ObservedStatus, delinquencyDays: number | null): string {
  switch (status) {
    case "CURRENT":
      return "Current";
    case "DELINQUENT":
      return delinquencyDays && delinquencyDays > 0
        ? `${delinquencyDays} days past due`
        : "Past due";
    case "PAID_OFF":
      return "Paid off";
    case "CHARGED_OFF":
      return "Charged off";
    case "MATURED":
      return "Term ended";
    case "TRANSFERRED":
      return "Transferred";
  }
}

/* ── What we're watching ───────────────────────────────────────────────── */

export const WATCHING = "What we're watching";

export const notWired = (servicer: string | null) =>
  `We're not connected to ${servicer ?? "your servicer"} for this, so what's above is all we hold.`;
export const NOT_HELD = "There's nothing to watch on this one yet.";
export const UNREACHABLE =
  "We couldn't reach the servicing platform just now, so there's nothing new to show. What's above still stands.";
export const NOT_REVIEWED_YET = "This mortgage hasn't been compared against the market yet.";

/**
 * The verdict, in a sentence and a reason. One per word the engine has, so a
 * word it adds is a compile error here rather than a blank on the page.
 */
export const VERDICT: Readonly<
  Record<ReviewVerdict, { readonly lead: string; readonly body: string }>
> = {
  candidate: {
    lead: "A refinance might be worth a look",
    body: "Worked out from this mortgage's own numbers and a current rate sheet. It's an estimate, not an offer, and part of any monthly difference is the term starting over.",
  },
  watching: {
    lead: "Nothing worth your time today",
    body: "We keep comparing this mortgage against the market, and today the numbers don't move it. This page changes when they do.",
  },
  not_now: {
    lead: "Not the moment",
    body: "A refinance doesn't add up for you right now. This page changes when that changes.",
  },
  excluded: {
    lead: "Not one we can look at right now",
    body: "Something about this mortgage keeps it out of the comparison for now.",
  },
};

/** The platform's own reading, shown under ours once ours exists. */
export const PLATFORM_SAYS = "What the servicing platform says";
export const reviewedOn = (day: string) => `Reviewed ${day}`;
/** For a loan we are watching: the sheet rate it would take. */
export const watchRateLine = (rate: string) =>
  `For this to be worth a look, the rate on the sheet would need to reach ${rate}.`;
export const SAME_TERM_PAYMENT = "Keeping your remaining term instead";

export const WHY = "Why";
export const checkedOn = (day: string) => `Checked ${day}`;
export const readLiveAt = (when: string) => `Read from the servicing platform ${when}`;

export const RATE_NOW = "Your rate";
export const RATE_THEN = "What a refinance might get";
export const PAYMENT_NOW = "Principal and interest now";
export const PAYMENT_THEN = "Principal and interest then";
export const DIFFERENCE_EACH_MONTH = "Difference each month";
export const openUntil = (day: string) => `Open until ${day}`;
export const about = (figure: string) => `about ${figure}`;

/* ── The offer ─────────────────────────────────────────────────────────── */

export const OFFER_LEAD = "A refinance is worth a look";
export const OFFER_BODY =
  "Worked out from this mortgage's own numbers and a current rate sheet. It's an estimate and not a commitment: the rate you'd actually get is quoted when you apply, and part of any monthly difference is the term starting over.";
export const OFFER_OPEN_ON_HOME = "There's a refinance worth a look on this mortgage.";
export const offerOpenUntil = (day: string) => `This stands until ${day}.`;
export const IN_PLAIN_WORDS = "In plain words";
export const NEW_LOAN_AMOUNT = "New loan amount";
export const NEW_TERM = "New term";
export const yearsWords = (months: number) =>
  months % 12 === 0 ? `${months / 12} years` : `${months} months`;

export const YES_LOOK = "Yes, let's look";
export const NOT_NOW = "Not now";
export const NEVER_ASK = "Don't ask again";
export const YES_LEAD = "One thing first";
export const YES_BODY =
  "Your servicer's records tell us about the house and the loan, and nothing about your income. Tell us your monthly income before taxes and we'll take it from there — you'll land on the next screen with the property already filled in.";
export const MONTHLY_INCOME = "Monthly income before taxes";
export const START_THE_REFINANCE = "Start the refinance";
export const NEVER_CONFIRM_LEAD = "Stop asking about a refinance on this mortgage?";
export const NEVER_CONFIRM_BODY =
  "We'll keep watching it for you and we'll stop suggesting a refinance. You can still start one yourself any time.";
export const YES_STOP_ASKING = "Yes, stop asking";
export const KEEP_ASKING = "Keep asking";
export const ANSWERING = "Saving your answer…";
export const OFFER_CLOSED =
  "This offer isn't open any more. What's below is what we're watching now.";

/** The card after an answer: what was said, and what happens next. */
export function offerAnswered(
  status: "engaged" | "declined" | "opted_out" | "expired",
  day: string | null,
): { readonly lead: string; readonly body: string } {
  switch (status) {
    case "engaged":
      return {
        lead: "You started a refinance from this offer",
        body: "It's an application of its own, and it picks up where you left it.",
      };
    case "declined":
      return {
        lead: day ? `You said not now on ${day}` : "You said not now",
        body: "We'll keep watching this mortgage and won't raise a refinance again for about three months.",
      };
    case "opted_out":
      return {
        lead: "You asked us not to suggest a refinance on this mortgage",
        body: "We still watch it for you. You can start a refinance yourself any time.",
      };
    case "expired":
      return {
        lead: day ? `An offer here stood until ${day}` : "An earlier offer here has lapsed",
        body: "The numbers it was built on have moved on. If a refinance is worth a look again, this page will say so.",
      };
  }
}
export const CONTINUE_THAT_APPLICATION = "Pick up that application";

/* ── Readiness ─────────────────────────────────────────────────────────── */

export const OUR_READINESS = "If you say yes, we'd still need";
export const OUR_READINESS_BODY =
  "Everything about the house and the loan is already filled in from your servicer's records. What's left is about you.";
/** Our five screens, in the words the flow uses for them, and what each still asks. */
export const SCREEN_READINESS: Readonly<Record<string, string>> = {
  property: "The property — filled in from your servicer's records",
  identity: "About you — who you are, and your OK to check your credit",
  declarations: "A few questions — the ones every application asks",
  bank: "Your bank — so income and savings come from your accounts, not a form",
  review: "Review — one signature",
};
export const WE_HAVE_IT = "we have it";
export const STILL_NEEDED = "still needed";
export const NOT_CHECKED_HERE = "Not checked here";
export const NOT_CHECKED_BODY =
  "A servicing platform would also look at these. We don't, yet — they'd come up as the application does.";
export const UNMAPPED_WORDS: Readonly<Record<string, string>> = {
  contact_details: "how to reach you",
  account_activation: "whether your account is active",
  value_freshness: "how recent the home's value is",
  insurance: "homeowner's insurance",
};

export const READINESS = "What a refinance would need from you";
/** The platform's item codes, as words: `credit_authorization` → "credit authorization". */
export const readinessItem = (item: string) => item.replace(/_/g, " ");
export const readinessStatus = (status: string) =>
  status === "present"
    ? "we have it"
    : status === "missing"
      ? "still needed"
      : status.replace(/_/g, " ");

/* ── The claim ─────────────────────────────────────────────────────────── */

/**
 * The page a servicer's claim link opens. What a stranger with the link is
 * told is what the servicer's notice already said — the servicer and the
 * town — and nothing that names anyone or numbers anything. Taking it needs
 * the same sign-in as everything else, and never an email match.
 */
export const MORTGAGE_CLAIM = {
  title: "A mortgage was shared with you",
  body: (servicer: string | null, city: string | null, state: string | null) => {
    const where = [city, state].filter(Boolean).join(", ");
    return `${servicer ?? "Your servicer"} shared a mortgage${where ? ` on a home in ${where}` : ""} with us, and this link is how the person it belongs to confirms it's theirs.`;
  },
  yours:
    "Confirming it puts the mortgage in your account and starts a rate watch on it. Nothing about you is looked up until you do, and nothing here is a credit request.",
  thisIsMine: "Yes, this is mine — continue",
} as const;
