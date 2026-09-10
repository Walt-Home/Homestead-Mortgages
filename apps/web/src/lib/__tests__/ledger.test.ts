/**
 * The ledger's words, held to the same rules as the state catalog.
 *
 * The timeline is generated from rows the database writes, so a row nobody
 * wrote copy for renders as a blank line in the middle of somebody's history.
 * That is the failure this file exists to stop, and it is the one that arrives
 * silently: adding an event to the machine is a one-line change in
 * `@hm/shared`, and nothing else complains.
 */

import { describe, expect, it } from "vitest";
import {
  APPLICATION_EVENTS,
  APPLICATION_STATES,
  BRITISH,
  DELIVERY_TIME,
  PROMISES,
  REQ_ID,
  TRANSITION_REASONS,
} from "@hm/shared";
import {
  CLOCK_COPY,
  EVENT_WORDS,
  REASON_WORDS,
  actorWords,
  calendarDate,
  hasWordsFor,
  timelineDate,
  wordsFor,
} from "../ledger.js";
import { entryFor } from "../states.js";

/** Every distinct string a borrower could read out of this module. */
const COPY = uniq([
  ...APPLICATION_EVENTS.flatMap((event) =>
    APPLICATION_STATES.map((to) => wordsFor(event, null, to)),
  ),
  ...TRANSITION_REASONS.flatMap((reason) =>
    APPLICATION_STATES.map((to) => wordsFor("borrower_owes", reason, to)),
  ),
  CLOCK_COPY.loanEstimateDue("September 9, 2026"),
  CLOCK_COPY.loanEstimateOnHold,
  CLOCK_COPY.adverseActionDue("September 26, 2026"),
  CLOCK_COPY.adverseActionOnHold,
]);

function uniq(lines: readonly string[]): string[] {
  return [...new Set(lines)];
}

/**
 * The moves this product has written borrower words for, listed here and not
 * read off the module under test.
 *
 * Asserting through `wordsFor` alone proves nothing: the fallback answers
 * every event with the destination state's heading, so both maps could be
 * emptied and every "reads as something" case would stay green. The list is
 * duplicated deliberately — deleting a line from `EVENT_WORDS` has to turn
 * this file red, and only a second copy of the expectation can do that.
 */
const EVENTS_WITH_WORDS = [
  "intake_completed",
  "borrower_satisfied",
  "work_began",
  "underwriting_began",
  "decided_conditional",
  "decided_counteroffer",
  "decided_decline",
  "decided_approved",
  "third_party_blocked",
  "borrower_withdrew",
  "disclosures_complete",
  "closing_began",
  "disbursed",
] as const;

/** The reasons that name the specific thing, rather than "something". */
const REASONS_WITH_WORDS = [
  "bank_connection_needed",
  "payroll_connection_needed",
  "tax_transcript_needed",
  "documents_needed",
  "bank_connected",
  "payroll_connected",
  "transcripts_received",
  "documents_received",
  "application_signed",
] as const;

describe("every row a borrower can be shown has words", () => {
  for (const event of EVENTS_WITH_WORDS) {
    it(`${event} says what happened, not where the file landed`, () => {
      expect(hasWordsFor(event, null)).toBe(true);
      // The state's heading is the fallback, so a move whose copy was deleted
      // still renders — as the state it landed in, which is not what happened.
      expect(wordsFor(event, null, "in_processing")).not.toBe(entryFor("in_processing")!.heading);
    });
  }

  for (const reason of REASONS_WITH_WORDS) {
    it(`${reason} names the thing, not the state`, () => {
      expect(hasWordsFor("borrower_owes", reason)).toBe(true);
      expect(wordsFor("borrower_owes", reason, "awaiting_borrower")).not.toBe(
        entryFor("awaiting_borrower")!.heading,
      );
    });
  }

  it("writes copy only for moves the machine can actually make", () => {
    // A reason spelled wrong here is copy that never renders and never fails.
    for (const key of Object.keys(EVENT_WORDS)) expect(APPLICATION_EVENTS).toContain(key);
    for (const key of Object.keys(REASON_WORDS)) expect(TRANSITION_REASONS).toContain(key);
  });

  it("leaves no row blank, whether or not it has words of its own", () => {
    for (const event of APPLICATION_EVENTS) {
      const words = wordsFor(event, null, "in_processing");
      expect(words.length, event).toBeGreaterThan(3);
      // The event name itself is never the answer.
      expect(words, event).not.toContain("_");
    }
    for (const reason of TRANSITION_REASONS) {
      const words = wordsFor("borrower_owes", reason, "awaiting_borrower");
      expect(words.length, reason).toBeGreaterThan(3);
      expect(words, reason).not.toContain("_");
    }
  });

  it("names the specific thing that is owed, not just that something is", () => {
    // "Something needed from you" over a file waiting on a bank connection is
    // the timeline knowing less than the ledger does.
    expect(wordsFor("borrower_owes", "bank_connection_needed", "awaiting_borrower")).toBe(
      "Something needed from you: connect your bank",
    );
    expect(wordsFor("borrower_satisfied", "payroll_connected", "in_processing")).toBe(
      "You confirmed your employer",
    );
  });

  it("falls back to where the file went", () => {
    // `ops_canceled` has no words of its own; the state it lands in does.
    expect(wordsFor("ops_canceled", null, "canceled")).toBe("We closed this application");
  });
});

describe("who did it", () => {
  it("calls the borrower You and the machinery Automatic", () => {
    expect(actorWords("BORROWER")).toBe("You");
    expect(actorWords("SERVICE")).toBe("Automatic");
    // A staff or partner principal is a person here, and saying "Automatic"
    // about one would misname who acted.
    expect(actorWords("STAFF")).toBe("Supermortgage");
    expect(actorWords("AI_AGENT")).toBe("Supermortgage");
  });
});

describe("no copy promises something the system cannot do", () => {
  it("names no channel", () => {
    for (const line of COPY) expect(line, line).not.toMatch(PROMISES);
  });

  it("promises no delivery time either", () => {
    for (const line of COPY) expect(line, line).not.toMatch(DELIVERY_TIME);
  });

  it("catches the phrasing it is written to catch", () => {
    // A test whose regex matches nothing passes for the wrong reason.
    expect("Your Loan Estimate will follow within three business days").toMatch(DELIVERY_TIME);
    expect("we will be in touch about next steps").toMatch(PROMISES);
  });
});

describe("nothing internal reaches a borrower", () => {
  it("renders no requirement id", () => {
    for (const line of COPY) expect(line, line).not.toMatch(REQ_ID);
  });

  it("uses American spellings", () => {
    for (const line of COPY) expect(line, line).not.toMatch(BRITISH);
  });
});

describe("dates", () => {
  it("writes them the way a US mortgage does", () => {
    // "11 September" reads as a typo to an American borrower and as correct to
    // everyone who wrote it. Month first.
    expect(timelineDate("2026-09-11T16:00:00.000Z")).toBe("September 11, 2026");
  });

  it("writes a calendar date in the same words", () => {
    // A date of birth off an identity document. Screen 2 printed it raw.
    expect(calendarDate("1985-03-12")).toBe("March 12, 1985");
  });

  it("does not move a calendar date into a time zone it never had", () => {
    // There is no instant on a birthday, so there is nothing to convert:
    // reading it as UTC midnight and rendering it in the creditor's zone
    // prints the day before, for every date in the first hours of a day.
    expect(calendarDate("2000-01-01")).toBe("January 1, 2000");
    expect(calendarDate("1999-12-31")).toBe("December 31, 1999");
    expect(calendarDate("2026-07-04")).toBe("July 4, 2026");
  });

  it("hands back anything that is not a calendar date", () => {
    // Better a vendor's own string than the words "Invalid Date" where a
    // borrower expects their birthday.
    expect(calendarDate("")).toBe("");
    expect(calendarDate("12/03/1985")).toBe("12/03/1985");
  });
});
