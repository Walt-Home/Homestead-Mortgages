/**
 * The rule under the five sentences, rather than the five sentences.
 *
 * Asserting the new wording would pin today's copy and catch nothing
 * tomorrow. What went wrong was structural: a claim about what an outside
 * party did was written as a constant, in a component, on a deployment where
 * no outside party was involved. So the rules held here are about the SHAPE of
 * every disclosure, and they read the module's exports rather than a list
 * somebody remembered to extend — a new function in `disclosures.ts` is
 * covered by all five the moment it exists.
 *
 *   1. A fixture says nothing a vendor would have had to do.
 *   2. A production connector carries no test-mode caveat. This is the defect
 *      `identityRequiresRedirect` had, one step along from the five.
 *   3. A claim that varies with the deployment is not a constant.
 *   4. Every string keeps the copy rules the catalogs keep.
 *   5. Where the vendor wording asserts an action, the fixture wording says
 *      what happens instead rather than going quiet under the same animation.
 *
 * What this cannot see is said plainly in `copy-rules.ts`: `VENDOR_ACTION` is
 * a vocabulary, and a claim phrased in words nobody has written down yet
 * passes every rule below.
 */

import { describe, expect, it } from "vitest";
import {
  BRITISH,
  DAY_FIRST,
  DELIVERY_TIME,
  PROMISES,
  REQ_ID,
  SANDBOX_CAVEAT,
  VENDOR_ACTION,
  VENDOR_CLAIM,
} from "@hm/shared";
import * as disclosures from "../disclosures.js";
import type { ConnectorMode } from "../disclosures.js";

const MODES: readonly ConnectorMode[] = ["fixture", "sandbox", "production"];

/** Every string an export can produce, in a stable order across modes. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  // `null` is a disclosure deciding there is nothing to say, and it has to
  // keep its position: the rules below pair a fixture string with the
  // production string at the same index.
  return [""];
}

interface Entry {
  readonly name: string;
  /** Mode → the strings that export produces, index-aligned across modes. */
  readonly byMode: Record<ConnectorMode, string[]>;
}

/**
 * The catalog, read off the module.
 *
 * A one-argument export is a function of the mode and is called with each.
 * Anything taking more arguments is a helper rather than a disclosure —
 * `modeOf` is the only one today — and is skipped.
 */
const ENTRIES: Entry[] = Object.entries(disclosures).flatMap(([name, value]) => {
  if (typeof value === "function") {
    if (value.length > 1) return [];
    const call = value as (...args: readonly ConnectorMode[]) => unknown;
    const say = (mode: ConnectorMode) => stringsOf(value.length === 0 ? call() : call(mode));
    return [
      {
        name: `${name}()`,
        byMode: {
          fixture: say("fixture"),
          sandbox: say("sandbox"),
          production: say("production"),
        },
      },
    ];
  }
  const fixed = stringsOf(value);
  return [{ name, byMode: { fixture: fixed, sandbox: fixed, production: fixed } }];
});

const at = (entry: Entry, mode: ConnectorMode, i: number) => entry.byMode[mode][i] ?? "";
const indexes = (entry: Entry) => entry.byMode.production.map((_, i) => i);

/** Names every offender, so a failure reads as the sentence that broke it. */
function offenders(check: (entry: Entry, i: number) => string | null): string[] {
  return ENTRIES.flatMap((entry) =>
    indexes(entry).flatMap((i) => {
      const said = check(entry, i);
      return said === null ? [] : [`${entry.name}[${i}] ${said}`];
    }),
  );
}

describe("the module is actually read", () => {
  it("found the disclosures, so an empty catalog cannot pass everything", () => {
    expect(ENTRIES.length).toBeGreaterThanOrEqual(6);
    expect(ENTRIES.flatMap((e) => e.byMode.production).join(" ")).toMatch(VENDOR_CLAIM);
  });
});

describe("a disclosure is a function of the deployment", () => {
  it("claims nothing on behalf of a vendor where there is no vendor", () => {
    expect(
      offenders((entry, i) => {
        const text = at(entry, "fixture", i);
        return VENDOR_CLAIM.test(text) ? JSON.stringify(text) : null;
      }),
    ).toEqual([]);
  });

  it("puts no test-mode caveat on a production connector", () => {
    expect(
      offenders((entry, i) => {
        const text = at(entry, "production", i);
        return SANDBOX_CAVEAT.test(text) ? JSON.stringify(text) : null;
      }),
    ).toEqual([]);
  });

  it("writes no vendor claim as a constant", () => {
    expect(
      offenders((entry, i) => {
        const vendor = MODES.map((m) => at(entry, m, i)).find((t) => VENDOR_CLAIM.test(t));
        if (vendor === undefined) return null;
        return at(entry, "fixture", i) === vendor ? JSON.stringify(vendor) : null;
      }),
    ).toEqual([]);
  });

  /**
   * Silence is the failure this one is about. Screen 2's animation runs on
   * every deployment, and deleting "A soft pull. This does not affect your
   * score." would have left three labeled steps ticking past with nothing
   * under them — which reads as work being done just as well as the false
   * sentence did.
   *
   * Only where the vendor wording asserts an ACTION. Naming a vendor is not
   * one: screen 2's button says "Verify your ID with Stripe" precisely so
   * nobody is surprised by the domain they land on, and its fixture wording is
   * a plain instruction with nothing to caveat.
   */
  it("says what happens instead, where the vendor wording said what happened", () => {
    expect(
      offenders((entry, i) => {
        if (!VENDOR_ACTION.test(at(entry, "production", i))) return null;
        const fixture = at(entry, "fixture", i);
        if (fixture === "") return null;
        return SANDBOX_CAVEAT.test(fixture) ? null : JSON.stringify(fixture);
      }),
    ).toEqual([]);
  });
});

describe("the disclosures keep the rules the catalogs keep", () => {
  const every = (rule: RegExp) =>
    offenders((entry, i) => {
      const said = MODES.map((m) => at(entry, m, i)).filter((t) => rule.test(t));
      return said.length ? JSON.stringify(said[0]) : null;
    });

  it("promises no channel this product has", () => expect(every(PROMISES)).toEqual([]));
  it("promises no date nothing schedules", () => expect(every(DELIVERY_TIME)).toEqual([]));
  it("is written in American English", () => expect(every(BRITISH)).toEqual([]));
  it("writes the month before the day", () => expect(every(DAY_FIRST)).toEqual([]));
  it("puts no requirement id in a sentence", () => expect(every(REQ_ID)).toEqual([]));
});

/**
 * Two sentences on one screen that have to agree, and did not.
 *
 * The confirmation stopped naming a reviewer and the prompt above it kept one
 * — "We will check it" — because the rule that caught the first was written
 * around the exact words of the first. Both are in this module now, so a
 * rewrite of either is read by the same five rules; this asserts the pair
 * exists rather than pinning what it says.
 */
describe("a property correction is answered the same way twice", () => {
  it("promises no reader in either half", () => {
    for (const said of [
      disclosures.PROPERTY_CORRECTION_PROMPT,
      disclosures.PROPERTY_CORRECTION_RECORDED,
    ]) {
      expect(said, said).not.toMatch(PROMISES);
    }
  });
});

describe("who says the rent was paid on time", () => {
  /**
   * The months are the fixture's on a fixture deployment, and the sentence
   * tells a borrower they count in their favor either way. Only the subject of
   * it can carry that difference; the rest is true of whatever report produced
   * the number.
   */
  it("is a different party in each mode, and a caveated one off a fixture", () => {
    const said = MODES.map((m) => disclosures.rentHistorySource(m));
    expect(new Set(said).size).toBe(3);
    expect(disclosures.rentHistorySource("fixture")).toMatch(SANDBOX_CAVEAT);
    expect(disclosures.rentHistorySource("production")).not.toMatch(SANDBOX_CAVEAT);
  });
});

describe("what a screen assumes before the server has answered", () => {
  it("reads an absent mode as a fixture, so nothing is claimed by default", () => {
    expect(disclosures.modeOf(null, "credit")).toBe("fixture");
    expect(disclosures.modeOf(undefined, "bank")).toBe("fixture");
    expect(disclosures.modeOf({}, "identity")).toBe("fixture");
    expect(disclosures.modeOf({ identity: "sandbox" }, "identity")).toBe("sandbox");
  });
});

/**
 * The rules catch what they were written for. Each of these is a sentence the
 * product actually shipped.
 */
describe("the rules catch what they were written for", () => {
  it("reads the five as the failures they were", () => {
    expect("the rest goes straight to the credit bureaus").toMatch(VENDOR_CLAIM);
    expect("A soft pull. This does not affect your score.").toMatch(VENDOR_ACTION);
    expect("Soft pull, so your score is untouched.").toMatch(VENDOR_ACTION);
    expect("Your bank is open in a secure window.").toMatch(VENDOR_ACTION);
    expect("Thanks — we have your correction and someone will check it.").toMatch(PROMISES);
    // Its twin in the prompt above it, which the first draft of the rule read
    // straight past: the subject changed and the missing person did not.
    expect("Tell us what is off. We will check it — you do not need to wait.").toMatch(PROMISES);
    expect("It does not stop your application — we will just confirm the details later.").toMatch(
      PROMISES,
    );
  });

  it("reads the sixth: a live key under a banner that says test mode", () => {
    expect("This check runs in Stripe's test mode.").toMatch(SANDBOX_CAVEAT);
  });
});
