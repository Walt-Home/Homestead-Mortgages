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
  REQ_ID,
  type ApplicationState,
} from "@hm/shared";
import { isSeeded, NOT_SEEDED_HERE, PERSONA_STORIES } from "../personas/stories.js";

/** Every line of a story a tester can read on the sign-in page. */
function copy(): { key: string; text: string }[] {
  return [
    ...PERSONA_STORIES.flatMap((s) => [
      { key: s.key, text: `${s.name.first} ${s.name.last}` },
      { key: s.key, text: s.story },
      ...(isSeeded(s) ? [] : [{ key: s.key, text: s.unavailableBecause }]),
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

  it("names no requirement", () => {
    for (const { key, text } of copy()) {
      expect(`${key}: ${text}`).not.toMatch(REQ_ID);
    }
  });

  it("is written in American English", () => {
    for (const { key, text } of copy()) {
      expect(`${key}: ${text}`).not.toMatch(BRITISH);
    }
  });

  it("says something, in one line", () => {
    for (const story of PERSONA_STORIES) {
      expect(story.story.length).toBeGreaterThan(20);
      expect(story.story).not.toContain("\n");
    }
  });
});

describe("the list itself", () => {
  it("has one row per key, and every key is one the database will take", () => {
    const keys = PERSONA_STORIES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    // The same shape as the CHECK in 20260909150000_persona_users.
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
  });

  it("targets states the machine has heard of", () => {
    for (const story of PERSONA_STORIES) {
      if (!isSeeded(story)) continue;
      const target: ApplicationState = story.target;
      expect(APPLICATION_STATES).toContain(target);
    }
  });

  it("gives every deferred row a reason and nothing to walk", () => {
    const deferred = PERSONA_STORIES.filter((s) => !isSeeded(s));
    expect(deferred).toHaveLength(1);
    for (const story of deferred) {
      expect(isSeeded(story)).toBe(false);
      if (!isSeeded(story)) expect(story.unavailableBecause.length).toBeGreaterThan(20);
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
