/**
 * The rules the state copy has to keep.
 *
 * Two of these are honesty rules rather than style rules, and they are the
 * reason this file exists at all. The product has been wrong in both
 * directions before: a rejected borrower was once told their ID was being
 * reviewed, and the prototype banner claimed things that were not true.
 */

import { describe, expect, it } from "vitest";
import { APPLICATION_STATES, BRITISH, DAY_FIRST, PROMISES, REQ_ID } from "@hm/shared";
import { ALL_STATES, STATE_GROUPS } from "../states.js";

describe("every state is written out", () => {
  it("covers the application and loan lifecycles", () => {
    // A number rather than a range, so adding a state without writing its copy
    // is a failing test rather than a gap nobody notices.
    expect(ALL_STATES).toHaveLength(34);
  });

  it("gives each one a heading, a body and a meaning", () => {
    for (const s of ALL_STATES) {
      expect(s.heading.length, s.id).toBeGreaterThan(0);
      expect(s.body.length, s.id).toBeGreaterThan(40);
      expect(s.meaning.length, s.id).toBeGreaterThan(20);
    }
  });

  it("uses each id exactly once", () => {
    const ids = ALL_STATES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("no copy promises something the system cannot do", () => {
  // The regex lives in `@hm/shared`, with the reason it exists. It was written
  // out here, again in `ledger.test.ts`, and once more for the review screen's
  // endings — and three copies of one rule is three chances for one of them to
  // be the lenient one.
  for (const s of ALL_STATES) {
    // The action label is checked too. The first version of this test read only
    // the heading and the body, and three real leaks were sitting in copy it
    // never looked at — including an action reading "Talk to someone", which is
    // the most direct promise of a channel in the whole file.
    it(`${s.id} does not promise a delivery`, () => {
      expect(`${s.heading} ${s.body} ${s.action ?? ""}`).not.toMatch(PROMISES);
    });
  }

  it("catches the idioms, not just the verbs", () => {
    // The original regex named email/write/call/post/send and every real leak
    // was an idiom instead, so the test written to stop exactly this caught
    // none of them. These are the phrasings that actually appeared.
    for (const leak of [
      "we'll get in touch when it's worth your time",
      "we'll tell you when you could",
      "Talk to someone",
      "we can tell you where you stand",
    ]) {
      expect(leak).toMatch(PROMISES);
    }
  });
});

describe("no requirement ids reach a borrower", () => {
  // The borrower flow renders no requirement id, anywhere. `meaning` is the
  // gallery's own annotation and may name them; the heading, body and action
  // may not.
  for (const s of ALL_STATES) {
    it(`${s.id} speaks in plain language`, () => {
      expect(`${s.heading} ${s.body} ${s.action ?? ""}`).not.toMatch(REQ_ID);
    });
  }
});

describe("colour is reserved for outcomes", () => {
  it("leaves the in-progress states neutral", () => {
    // Painting every state would make the three that matter stop reading as
    // different. A file that is merely being worked on is distinguished by its
    // words.
    const byId = Object.fromEntries(ALL_STATES.map((s) => [s.id, s]));
    for (const id of ["draft", "intake_received", "in_processing", "in_underwriting", "closing"]) {
      expect(byId[id]?.tone, id).toBe("neutral");
    }
  });

  it("never renders a decline as anything but danger", () => {
    const byId = Object.fromEntries(ALL_STATES.map((s) => [s.id, s]));
    expect(byId["adverse_action_pending"]?.tone).toBe("danger");
    expect(byId["denied"]?.tone).toBe("danger");
  });

  it("never renders an unresolved state as ok", () => {
    // The generalised form of the bug this product has already had once:
    // "we could not compute this" must never wear the same badge as
    // "we computed it and you passed".
    const byId = Object.fromEntries(ALL_STATES.map((s) => [s.id, s]));
    for (const id of ["awaiting_borrower", "suspended", "contested", "monitoring_failed"]) {
      expect(byId[id]?.tone, id).not.toBe("ok");
    }
  });
});

describe("groups", () => {
  it("puts every state in exactly one group", () => {
    const counted = STATE_GROUPS.reduce((n, g) => n + g.states.length, 0);
    expect(counted).toBe(ALL_STATES.length);
  });

  it("explains what each group is for", () => {
    for (const g of STATE_GROUPS) expect(g.note.length, g.id).toBeGreaterThan(30);
  });
});

describe("American English, in copy a borrower reads", () => {
  for (const s of ALL_STATES) {
    it(`${s.id} uses American spellings`, () => {
      expect(`${s.heading} ${s.body} ${s.pill} ${s.action ?? ""}`).not.toMatch(BRITISH);
    });
  }

  it("writes dates the way a US mortgage does", () => {
    for (const s of ALL_STATES) {
      expect(`${s.heading} ${s.body}`, s.id).not.toMatch(DAY_FIRST);
    }
  });
});

describe("the endings stay distinguishable", () => {
  // docs/states.md calls these "the ones under constant pressure to collapse",
  // and reading them next to each other is the whole reason the gallery exists.
  // Two endings that share a heading or a pill have already collapsed.
  const terminal = ALL_STATES.filter((s) => s.terminal);

  it("has more than one ending to keep apart", () => {
    expect(terminal.length).toBeGreaterThan(5);
  });

  it("gives each ending its own heading", () => {
    const headings = terminal.map((s) => s.heading.toLowerCase());
    expect(new Set(headings).size).toBe(headings.length);
  });

  it("gives each ending its own pill", () => {
    const pills = terminal.map((s) => s.pill.toLowerCase());
    expect(new Set(pills).size).toBe(pills.length);
  });
});

describe("the worked example holds together", () => {
  // The figures are invented, and the gallery says so. But they are read as one
  // story, top to bottom, which is what the gallery is for — so a rate that
  // appears once in a chain that is 5.99% everywhere else reads as a mistake
  // rather than as an illustration.
  const everything = ALL_STATES.map((s) => `${s.heading} ${s.body}`).join(" ");

  it("uses one rate chain", () => {
    const rates = [...everything.matchAll(/(\d\.\d{2,3})%/g)].map((m) => m[1] ?? "");
    const allowed = new Set(["6.875", "5.99"]);
    expect([...new Set(rates)].filter((r) => !allowed.has(r))).toEqual([]);
  });
});

describe("the copy keeps up with the machine", () => {
  // packages/shared/src/application-machine.ts is the authority on which states
  // exist. A state added there and not here renders as a blank card; a state
  // here that the machine has never heard of is copy for something that cannot
  // happen. Both are silent without this test.
  const written = new Set(ALL_STATES.map((s) => s.id));

  for (const state of APPLICATION_STATES) {
    it(`${state} has words`, () => {
      expect(written.has(state), `${state} is in the machine with no copy`).toBe(true);
    });
  }

  it("has no copy for a state the machine cannot reach", () => {
    // The loan, opportunity and pre-application entries are deliberately not
    // application states, so they are excluded by prefix rather than by a list
    // somebody has to remember to update.
    const machineStates = new Set<string>(APPLICATION_STATES);
    const orphans = ALL_STATES.map((s) => s.id).filter(
      (id) =>
        !machineStates.has(id) &&
        !id.startsWith("loan_") &&
        !id.startsWith("opportunity_") &&
        !["quoted", "contested", "monitoring_failed"].includes(id),
    );
    expect(orphans).toEqual([]);
  });
});
