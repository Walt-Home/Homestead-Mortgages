/**
 * The persona stories are borrower-facing copy, and they sit outside the web.
 *
 * They render on the sign-in page to anyone who loads staging, which makes
 * them the only lines of borrower copy the API serves — so the rules every
 * other line keeps are applied here rather than in `apps/web`, which is why
 * `copy-rules.ts` lives in `@hm/shared`. Without this, "we'll be in touch",
 * "within three business days" or a requirement id could reach a page through
 * the one door no copy test was watching.
 *
 * The rest is the seed's contract, asserted before the seed exists: an address
 * the fixture property adapter cannot describe would open screen 1 with no
 * property card, and a key the database's shape CHECK refuses would fail the
 * deploy rather than the build.
 */

import { describe, expect, it } from "vitest";
import { ADDRESS_BOOK } from "@hm/connectors";
import {
  APPLICATION_STATES,
  BRITISH,
  DELIVERY_TIME,
  PROMISES,
  RATE_COMMITMENT,
  REQ_ID,
  VENDOR_CLAIM,
  type ApplicationState,
} from "@hm/shared";
import { NORTHLIGHT, sampleBook } from "@hm/partner-book";
import {
  isImported,
  isSeeded,
  NOT_SEEDED_HERE,
  PERSONA_KEY_SHAPE,
  PERSONA_STORIES,
} from "../personas/stories.js";

/** The second rows: a co-borrower, with `on` the story they are listed under. */
const CO_BORROWERS = PERSONA_STORIES.flatMap((s) =>
  isSeeded(s) && s.coBorrower ? [{ ...s.coBorrower, on: s }] : [],
);

/** Every line of a story a tester can read on the sign-in page. */
function copy(): { key: string; text: string }[] {
  return [
    ...PERSONA_STORIES.flatMap((s) => [
      { key: s.key, text: `${s.name.first} ${s.name.last}` },
      { key: s.key, text: s.story },
    ]),
    ...CO_BORROWERS.flatMap((c) => [
      { key: c.key, text: `${c.name.first} ${c.name.last}` },
      { key: c.key, text: c.story },
    ]),
    // Not attached to any one story — the listing hands it to whichever rows
    // the seed has not written — but it renders in the same place.
    { key: "not_seeded", text: NOT_SEEDED_HERE },
  ];
}

describe("what a persona row says", () => {
  it("promises nothing this repo cannot do", () => {
    for (const { key, text } of copy()) {
      expect(`${key}: ${text}`).not.toMatch(PROMISES);
    }
  });

  it("names no deadline", () => {
    for (const { key, text } of copy()) {
      expect(`${key}: ${text}`).not.toMatch(DELIVERY_TIME);
    }
  });

  /**
   * A story is written once and read on every deployment, so a sentence saying
   * a bureau or a bank did something is true on one and false on the next.
   * `borrower-copy.test.ts` holds the web app to this and cannot reach here.
   */
  it("claims nothing on behalf of a vendor", () => {
    for (const { key, text } of copy()) {
      expect(`${key}: ${text}`).not.toMatch(VENDOR_CLAIM);
    }
  });

  it("names no requirement", () => {
    for (const { key, text } of copy()) {
      expect(`${key}: ${text}`).not.toMatch(REQ_ID);
    }
  });

  /**
   * A story is read by somebody deciding whether to sign in as a sample
   * borrower, and a line saying their rate is locked would be false about a
   * product with no lock desk in it. The same rule the screens keep.
   */
  it("commits to no rate", () => {
    for (const { key, text } of copy()) {
      expect(`${key}: ${text}`).not.toMatch(RATE_COMMITMENT);
    }
  });

  it("is written in American English", () => {
    for (const { key, text } of copy()) {
      expect(`${key}: ${text}`).not.toMatch(BRITISH);
    }
  });

  it("says something, in one line", () => {
    for (const { key, story } of [...PERSONA_STORIES, ...CO_BORROWERS]) {
      expect(story.length, key).toBeGreaterThan(20);
      expect(story, key).not.toContain("\n");
    }
  });
});

describe("the list itself", () => {
  it("has one row per key, and every key is one the database will take", () => {
    const keys = [...PERSONA_STORIES.map((s) => s.key), ...CO_BORROWERS.map((c) => c.key)];
    expect(new Set(keys).size).toBe(keys.length);
    // The same shape as the CHECK, last widened in
    // 20260917100000_a_co_borrower_has_a_sign_in_of_their_own.
    for (const key of keys) expect(key).toMatch(PERSONA_KEY_SHAPE);
  });

  it("keys a co-borrower's row to the story they are on", () => {
    // The listing finds the story from the key alone, and the colon is the
    // one character a story's own key can never contain.
    expect(CO_BORROWERS.length).toBeGreaterThan(0);
    for (const c of CO_BORROWERS) {
      expect(c.key.startsWith(`${c.on.key}:`), c.key).toBe(true);
      expect(c.key).not.toBe(c.on.key);
    }
  });

  it("targets states the machine has heard of", () => {
    for (const story of PERSONA_STORIES) {
      if (!isSeeded(story)) continue;
      const target: ApplicationState = story.target;
      expect(APPLICATION_STATES).toContain(target);
    }
  });

  it("stands the imported row on a loan the sample book carries, and walks it nowhere", () => {
    const imported = PERSONA_STORIES.filter(isImported);
    expect(imported).toHaveLength(1);
    const numbers = sampleBook().loans.map((l) => l.servicer_loan_number);
    for (const story of imported) {
      expect(isSeeded(story)).toBe(false);
      expect(story.loan.servicerSlug).toBe(NORTHLIGHT.slug);
      expect(numbers).toContain(story.loan.servicerLoanNumber);
    }
  });

  it("buys a house the fixture property adapter can describe", () => {
    // Anything outside the address book falls back to manual entry with no
    // property card, so a persona would open on a screen 1 that cannot say
    // anything about its own house.
    for (const story of PERSONA_STORIES) {
      if (!isSeeded(story)) continue;
      const { address } = story.terms;
      // Every line, because the fixture matches the whole address and throws
      // on anything it does not recognize.
      expect(ADDRESS_BOOK).toContainEqual(address);
    }
  });

  it("asks for a real loan, and a purchase that adds up", () => {
    for (const story of PERSONA_STORIES) {
      if (!isSeeded(story)) continue;
      const { loanAmount, downPayment, valueOrPrice, purpose } = story.terms;
      expect(loanAmount).toBeGreaterThan(0);
      // A purchase has to add up: the down payment plus the loan is the price.
      // Tom's add up too — what makes him a counteroffer is the ratio between
      // them, not a gap in the arithmetic.
      if (purpose === "purchase") expect(loanAmount + downPayment).toBe(valueOrPrice);
    }
  });
});
