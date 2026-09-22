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

export const READINESS = "What a refinance would need from you";
/** The platform's item codes, as words: `credit_authorization` → "credit authorization". */
export const readinessItem = (item: string) => item.replace(/_/g, " ");
export const readinessStatus = (status: string) =>
  status === "present"
    ? "we have it"
    : status === "missing"
      ? "still needed"
      : status.replace(/_/g, " ");
