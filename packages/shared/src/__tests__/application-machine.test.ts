/**
 * Properties of the machine, not examples of it.
 *
 * A table of nineteen states is too big to review by reading. These assert the
 * things a reviewer would have to hold in their head all at once — that nothing
 * is unreachable, that nothing is a dead end, that an ending is really an
 * ending — so a future edge can be added without re-deriving all of it.
 */

import { describe, expect, it } from "vitest";
import {
  APPLICATION_EVENTS,
  APPLICATION_STATES,
  IllegalTransition,
  MACHINE,
  OUTCOME_EVENT,
  TERMINAL,
  eventsFrom,
  isTerminal,
  nextState,
  requireNextState,
  TRANSITION_REASONS,
  type ApplicationState,
} from "../application-machine.js";
import { BRANCH_FOR_SCREEN, OBLIGATION_REASON } from "../branches.js";
import { DECISION_OUTCOMES } from "../types/decision.js";
import { RECEIPT_REASON_CODE } from "../trid.js";

const states = APPLICATION_STATES as readonly ApplicationState[];

/** Everything reachable from `start`, following legal edges. */
function reachableFrom(start: ApplicationState): Set<ApplicationState> {
  const seen = new Set<ApplicationState>([start]);
  const queue: ApplicationState[] = [start];
  while (queue.length) {
    const here = queue.shift()!;
    for (const event of eventsFrom(here)) {
      const to = nextState(here, event)!;
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

describe("the table is well formed", () => {
  it("covers every state", () => {
    expect(Object.keys(MACHINE).sort()).toEqual([...states].sort());
  });

  it("only ever lands in a real state", () => {
    for (const from of states) {
      for (const event of eventsFrom(from)) {
        expect(states, `${from} --${event}-->`).toContain(nextState(from, event));
      }
    }
  });

  it("only uses declared events", () => {
    for (const from of states) {
      for (const event of eventsFrom(from)) {
        expect(APPLICATION_EVENTS, from).toContain(event);
      }
    }
  });

  it("never has an edge to itself", () => {
    // A self-edge means a transition that records history without changing
    // anything, which is a state change nobody can see.
    for (const from of states) {
      for (const event of eventsFrom(from)) {
        expect(nextState(from, event), `${from} --${event}-->`).not.toBe(from);
      }
    }
  });
});

describe("nothing is unreachable and nothing is a dead end", () => {
  it("can reach every state from draft", () => {
    // A state nothing can reach is a state nobody has thought through, and it
    // gets discovered by a borrower rather than by us.
    const reached = reachableFrom("draft");
    const orphans = states.filter((s) => !reached.has(s));
    expect(orphans).toEqual([]);
  });

  it("can always get to an ending", () => {
    // No file may be stuck forever in a state with no way out. Every
    // non-terminal state must be able to reach at least one terminal one.
    for (const from of states) {
      if (isTerminal(from)) continue;
      const reached = [...reachableFrom(from)];
      expect(reached.some(isTerminal), `${from} cannot reach any ending`).toBe(true);
    }
  });

  it("lets every live state be stopped by the borrower", () => {
    // Withdrawal is the borrower's own act, and there must be no live state in
    // which the product refuses to hear it. `rescission_pending` counts: that
    // is what rescinding is.
    for (const from of states) {
      if (isTerminal(from) || from === "adverse_action_pending") continue;
      expect(eventsFrom(from), `${from}`).toContain("borrower_withdrew");
    }
  });
});

describe("an ending is an ending", () => {
  it("has no outgoing edges", () => {
    for (const state of TERMINAL) {
      expect(eventsFrom(state), state).toEqual([]);
    }
  });

  it("marks exactly the states with no way out as terminal", () => {
    const stuck = states.filter((s) => eventsFrom(s).length === 0);
    expect([...stuck].sort()).toEqual([...TERMINAL].sort());
  });

  it("reopens nothing — a new attempt is a new application", () => {
    // Un-setting a dated latch would contradict how applicationSignedAt and
    // intentToProceedAt already behave, and every verification would have to be
    // re-run anyway.
    for (const state of TERMINAL) {
      for (const event of APPLICATION_EVENTS) {
        expect(nextState(state, event), `${state} --${event}-->`).toBeUndefined();
      }
    }
  });
});

describe("a decline stays a decline", () => {
  it("leaves adverse_action_pending only by telling the borrower why", () => {
    expect(eventsFrom("adverse_action_pending")).toEqual(["adverse_action_delivered"]);
    expect(nextState("adverse_action_pending", "adverse_action_delivered")).toBe("denied");
  });

  it("has no path from a decline back to any approval", () => {
    // The generalised form of the bug this product already shipped once. Once
    // the decision is made, no sequence of events may produce an approval word.
    const approvals: ApplicationState[] = [
      "approved",
      "conditionally_approved",
      "clear_to_close",
      "closing",
      "funded",
    ];
    const reached = reachableFrom("adverse_action_pending");
    expect(approvals.filter((a) => reached.has(a))).toEqual([]);
  });

  it("routes a lapsed counteroffer to a notice, not to a silent close", () => {
    // Silence on a counteroffer is a decline, and it owes the borrower reasons
    // like any other.
    expect(nextState("counteroffer_outstanding", "counteroffer_lapsed")).toBe(
      "adverse_action_pending",
    );
  });
});

describe("illegal edges throw rather than pretending", () => {
  it("refuses an event the state cannot handle", () => {
    expect(() => requireNextState("draft", "disbursed")).toThrow(IllegalTransition);
  });

  it("names the state and the event, so the error is actionable", () => {
    try {
      requireNextState("funded", "borrower_withdrew");
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as IllegalTransition;
      expect(e.from).toBe("funded");
      expect(e.event).toBe("borrower_withdrew");
      expect(e.message).toContain("funded");
    }
  });

  it("never returns the current state as a way of saying no", () => {
    // `advanceStage` did exactly this, and it reads as success at the call site
    // — so a caller could believe it had cancelled a file that is still running.
    for (const from of states) {
      for (const event of APPLICATION_EVENTS) {
        const to = nextState(from, event);
        if (to !== undefined) expect(to, `${from} --${event}-->`).not.toBe(from);
      }
    }
  });
});

describe("revocation is heard everywhere it can be", () => {
  it("suspends any live state where a pull could still happen", () => {
    // consents.revoked_at is read in seven places and written by nothing today,
    // so this has never been expressible. A revocation must not be refused by
    // the state machine — the earlier design had three states with no edge for
    // it, and because revocation ran in one transaction the throw rolled back
    // the revocation itself.
    const mustHear: ApplicationState[] = [
      "intake_received",
      "in_processing",
      "awaiting_borrower",
      "in_underwriting",
      "counteroffer_outstanding",
      "conditionally_approved",
      "approved",
    ];
    for (const state of mustHear) {
      expect(eventsFrom(state), state).toContain("authorization_revoked");
    }
  });
});

describe("the reasons are a closed set", () => {
  it("is non-empty, unique, and spells the receipt's reason the way the SQL does", () => {
    // reason_code is free text in the database, so the only thing keeping a
    // report's buckets honest is this list and the signature that takes it.
    expect(TRANSITION_REASONS.length).toBeGreaterThan(0);
    expect(new Set(TRANSITION_REASONS).size).toBe(TRANSITION_REASONS.length);
    expect(TRANSITION_REASONS.every((r) => /^[a-z][a-z0-9_]*$/.test(r))).toBe(true);
    expect(TRANSITION_REASONS).toContain(RECEIPT_REASON_CODE);
  });

  it("holds every reason a writer outside this package spells out", () => {
    // The list the API and the seed actually write, kept by hand and in step.
    // A scan of the source can only see the call sites it can parse; this is
    // the other half of the guarantee, and it is the half that catches a
    // reason being renamed here while a writer still spells it the old way.
    for (const reason of [
      "six_pieces_received",
      "bank_connection_needed",
      "bank_already_connected",
      "bank_connected",
      "payroll_connected",
      "transcripts_received",
      "documents_received",
      "application_signed",
      "sanctions_near_match",
      "engine_asked",
      "engine_conditional",
      "engine_ineligible",
      "engine_high_cost",
      "engine_clean",
      "borrower_requested",
      "persona_fixture",
    ]) {
      expect(TRANSITION_REASONS, reason).toContain(reason);
    }
  });

  it("names every reason a branch can be owed for", () => {
    for (const reason of Object.values(OBLIGATION_REASON)) {
      expect(TRANSITION_REASONS).toContain(reason);
    }
  });

  it("gives every branch a reason, and every screen a branch", () => {
    expect(Object.keys(OBLIGATION_REASON).sort()).toEqual(
      [...new Set(Object.values(BRANCH_FOR_SCREEN))].sort(),
    );
  });
});

describe("a hold is a hold", () => {
  /**
   * Every event the API's orchestration writes on its own, without a person
   * deciding anything: the receipt's edge, what follows it, the branches, the
   * screening and the decision. Kept as a literal, the way the reasons are.
   */
  const ORCHESTRATION_EVENTS = [
    "intake_completed",
    "work_began",
    "borrower_owes",
    "borrower_satisfied",
    "third_party_blocked",
    "underwriting_began",
    "decided_conditional",
    "decided_counteroffer",
    "decided_approved",
    "decided_decline",
  ] as const;

  it("names only events the machine has", () => {
    for (const event of ORCHESTRATION_EVENTS) {
      expect(APPLICATION_EVENTS).toContain(event);
    }
  });

  it("leaves exactly two of them legal out of a suspended file", () => {
    // Both are staff edges: somebody may ask a held borrower for something, and
    // somebody may underwrite a held file. Neither is a page load, so the API
    // declines both while the hold stands — see `standing.test.ts`. This list
    // is here so that a new edge out of `suspended` fails a test rather than
    // quietly giving the orchestration a way to end a sanctions hold.
    const legal = ORCHESTRATION_EVENTS.filter((e) => nextState("suspended", e) !== undefined);
    expect([...legal].sort()).toEqual(["borrower_owes", "underwriting_began"]);
  });

  it("is ended by exactly one event, and a person writes it", () => {
    const out = eventsFrom("suspended").filter(
      (e) => nextState("suspended", e) === "in_processing",
    );
    expect(out).toEqual(["third_party_returned"]);
    expect(ORCHESTRATION_EVENTS).not.toContain("third_party_returned");
  });
});

describe("the edge each decided word takes", () => {
  /**
   * `OUTCOME_EVENT` lives beside the machine because it is a claim about
   * edges, so the claim is checked here rather than where it is called. A
   * value that is not a legal event out of `in_underwriting` is a decision the
   * orchestration cannot record; a null that is not deliberate is a decision
   * it silently drops.
   */
  it("gives every decided outcome an event the machine has from in_underwriting", () => {
    const legal = eventsFrom("in_underwriting");
    for (const outcome of DECISION_OUTCOMES) {
      const event = OUTCOME_EVENT[outcome];
      if (event === null) continue;
      expect(legal, outcome).toContain(event);
    }
  });

  it("leaves exactly the two words that decided nothing without one", () => {
    // `pending` has decided nothing, and `referred` has decided nothing
    // either — that is the whole reason the word exists. Mapping either to an
    // edge would move a file nobody has looked at into a decided state.
    const silent = DECISION_OUTCOMES.filter((o) => OUTCOME_EVENT[o] === null);
    expect([...silent].sort()).toEqual(["pending", "referred"]);
  });
});
