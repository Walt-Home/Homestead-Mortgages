/**
 * The rules the state copy has to keep.
 *
 * Two of these are honesty rules rather than style rules, and they are the
 * reason this file exists at all. The product has been wrong in both
 * directions before: a rejected borrower was once told their ID was being
 * reviewed, and the prototype banner claimed things that were not true.
 */

import { describe, expect, it } from "vitest";
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
  /**
   * There is no mailer in this repo — no Resend yet, no SMTP, nothing. Copy
   * that says we will email, write or call is a promise no code can keep, and
   * on a status page a person can revisit for weeks it is a promise they will
   * notice us breaking. "We'll put it here" is fine: the page is the delivery.
   *
   * Delete this test when a delivery record exists in the schema, and not
   * before.
   */
  const PROMISES =
    /\b(we'll (e-?mail|write|call|post|send)|by e-?mail|in the (post|mail)|letter (is )?(on its way|in the (post|mail))|we will e-?mail)\b/i;

  for (const s of ALL_STATES) {
    it(`${s.id} does not promise a delivery`, () => {
      expect(`${s.heading} ${s.body}`).not.toMatch(PROMISES);
    });
  }
});

describe("no requirement ids reach a borrower", () => {
  // The borrower flow renders no requirement id, anywhere. `meaning` is the
  // gallery's own annotation and may name them; the heading, body and action
  // may not.
  const REQ_ID = /\b(APP|CRD|INC|AST|UW|CLS)-\d{3}\b/;

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
