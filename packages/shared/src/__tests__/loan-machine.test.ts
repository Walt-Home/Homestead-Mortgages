/**
 * Properties of the loan machine, not examples of it.
 *
 * Eleven states with two beginnings and five endings is more than a reviewer
 * can hold in their head while reading a table, so the things that would have
 * to be re-derived by hand — that nothing is unreachable, that nothing is a
 * dead end, that an ending is really an ending — are asserted instead.
 *
 * Two of these read files rather than imports, and deliberately. The words a
 * borrower sees live in the web app and the meanings live in docs/states.md,
 * and neither can be imported into this package without pointing a dependency
 * the wrong way. A state added to the machine and not to those, or given words
 * that disagree about whether it is an ending, is silent without this.
 *
 * One agreement that belongs with those two is not here and cannot be yet: the
 * eleven names against the Postgres `LoanState` enum. That type does not exist
 * until the migration that creates `loans`, so the comparison lands beside that
 * migration's own tests, in the shape `transition.test.ts` already uses to hold
 * `ApplicationState` against `APPLICATION_STATES`.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAIM_STATES,
  IllegalLoanTransition,
  LOAN_BIRTH_STATES,
  LOAN_EVENTS,
  LOAN_MACHINE,
  LOAN_STATES,
  LOAN_TERMINAL,
  LOAN_TRANSITION_REASONS,
  isTerminalLoan,
  nextLoanState,
  requireNextLoanState,
  type LoanEvent,
  type LoanState,
} from "../loan-machine.js";

const states = LOAN_STATES as readonly LoanState[];

/**
 * Every legal move, written out once, in the order a mortgage travels them.
 *
 * Everything else in this file asserts a property, and a property survives an
 * edge going missing whenever a second state still carries the same event: drop
 * `payoff_posted` from `imported_unclaimed` and every count, every walk and
 * every landing check still passes, because `active` and `monitoring_only` have
 * it too. This list is the census that does not survive it. It fails on an edge
 * removed and on an edge added, so the table cannot change shape without the
 * change appearing here, next to a reader.
 */
const EVERY_EDGE = [
  "pending_boarding --boarding_file_sent--> boarding",
  "boarding --servicer_acknowledged--> active",
  "boarding --boarded_to_third_party--> monitoring_only",
  "imported_unclaimed --borrower_claimed--> monitoring_only",
  "imported_unclaimed --payoff_posted--> paid_off",
  "imported_unclaimed --charge_off_posted--> charged_off",
  "imported_unclaimed --term_completed--> matured",
  "active --transfer_announced--> in_servicing_transfer",
  "active --payoff_posted--> paid_off",
  "active --refinanced_by_us--> refinanced_internally",
  "active --charge_off_posted--> charged_off",
  "active --term_completed--> matured",
  "monitoring_only --transfer_announced--> in_servicing_transfer",
  "monitoring_only --payoff_posted--> paid_off",
  "monitoring_only --refinanced_by_us--> refinanced_internally",
  "monitoring_only --charge_off_posted--> charged_off",
  "monitoring_only --term_completed--> matured",
  "in_servicing_transfer --transfer_completed_inbound--> active",
  "in_servicing_transfer --transfer_completed_outbound--> transferred_out",
];

const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

/** Every event the table has an edge for, out of `state`. */
function eventsFrom(state: LoanState): LoanEvent[] {
  return Object.keys(LOAN_MACHINE[state]) as LoanEvent[];
}

/** Everything reachable from `start`, following legal edges. */
function reachableFrom(start: LoanState): Set<LoanState> {
  const seen = new Set<LoanState>([start]);
  const queue: LoanState[] = [start];
  while (queue.length) {
    const here = queue.shift()!;
    for (const event of eventsFrom(here)) {
      const to = nextLoanState(here, event)!;
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

describe("the table is well formed", () => {
  it("has these nineteen edges and no others", () => {
    // The one assertion here that a missing edge cannot slip past. A serviced
    // loan losing `refinanced_by_us` is the case worth naming: nothing else in
    // this file notices, and what it costs is the only chain that says we were
    // the reason a mortgage ended.
    const edges = states.flatMap((from) =>
      eventsFrom(from).map((event) => `${from} --${event}--> ${nextLoanState(from, event)}`),
    );
    expect(edges.sort()).toEqual([...EVERY_EDGE].sort());
  });

  it("has eleven states, and covers every one of them", () => {
    expect(states).toHaveLength(11);
    expect(new Set(states).size).toBe(11);
    expect(Object.keys(LOAN_MACHINE).sort()).toEqual([...states].sort());
  });

  it("only ever lands in a real state", () => {
    for (const from of states) {
      for (const event of eventsFrom(from)) {
        expect(states, `${from} --${event}-->`).toContain(nextLoanState(from, event));
      }
    }
  });

  it("only uses declared events, and declares none it never uses", () => {
    const used = new Set(states.flatMap(eventsFrom));
    for (const event of used) expect(LOAN_EVENTS).toContain(event);
    // An event with no edge anywhere is an event nothing can record, which
    // reads at a call site as a move the machine will accept.
    expect([...LOAN_EVENTS].filter((e) => !used.has(e))).toEqual([]);
  });

  it("gives every event exactly one destination", () => {
    // The doc comment on LOAN_EVENTS rests on this: an event name says where a
    // loan lands, so a ledger that records both the event and the state it
    // moved to can never have the two disagree. An event with two destinations
    // would make those two independent facts about one move, and no move in
    // this machine is like that.
    for (const event of LOAN_EVENTS) {
      const landings = new Set(
        states
          .filter((from) => eventsFrom(from).includes(event))
          .map((from) => nextLoanState(from, event)),
      );
      expect([...landings], `${event} does not land in exactly one state`).toHaveLength(1);
    }
  });

  it("lets two different events land in one state, which is why events are named for the world", () => {
    // The other half of the same comment, and the reason an event name is not
    // redundant with the state it produces. A loan sitting in `monitoring_only`
    // is either one we funded and boarded elsewhere or a stranger's mortgage
    // somebody claimed, and the status alone cannot tell those apart.
    expect(nextLoanState("boarding", "boarded_to_third_party")).toBe("monitoring_only");
    expect(nextLoanState("imported_unclaimed", "borrower_claimed")).toBe("monitoring_only");
  });

  it("never has an edge to itself", () => {
    // A self-edge records history without changing anything, which is a state
    // change nobody can see.
    for (const from of states) {
      for (const event of eventsFrom(from)) {
        expect(nextLoanState(from, event), `${from} --${event}-->`).not.toBe(from);
      }
    }
  });
});

describe("a loan has two beginnings", () => {
  it("names exactly two, and both are real states", () => {
    expect(LOAN_BIRTH_STATES).toHaveLength(2);
    expect([...LOAN_BIRTH_STATES].sort()).toEqual(["imported_unclaimed", "pending_boarding"]);
    for (const state of LOAN_BIRTH_STATES) expect(states).toContain(state);
  });

  it("reaches every state from one of them", () => {
    // A state nothing can reach is a state nobody has thought through, and it
    // gets discovered by a borrower rather than by us. There is no single root
    // here — a mortgage we funded and a mortgage a servicer told us about start
    // in different places — so the union is what has to cover the table.
    const reached = new Set(LOAN_BIRTH_STATES.flatMap((s) => [...reachableFrom(s)]));
    expect(states.filter((s) => !reached.has(s))).toEqual([]);
  });

  it("lets neither beginning be reached from anywhere", () => {
    // Both are births. An edge back into one would mean a claimed mortgage
    // could become unclaimed again, which is what single use rests on.
    for (const from of states) {
      for (const event of eventsFrom(from)) {
        expect(LOAN_BIRTH_STATES, `${from} --${event}-->`).not.toContain(
          nextLoanState(from, event),
        );
      }
    }
  });

  it("gives an unclaimed mortgage exactly one way out that is not an ending", () => {
    const alive = eventsFrom("imported_unclaimed").filter(
      (e) => !isTerminalLoan(nextLoanState("imported_unclaimed", e)!),
    );
    expect(alive).toEqual(["borrower_claimed"]);
    // Never `active`: a mortgage somebody else services does not become ours
    // because its borrower signed in.
    expect(nextLoanState("imported_unclaimed", "borrower_claimed")).toBe("monitoring_only");
  });
});

describe("an ending is an ending", () => {
  it("names exactly five", () => {
    expect(LOAN_TERMINAL).toHaveLength(5);
    for (const state of LOAN_TERMINAL) expect(states).toContain(state);
  });

  it("gives each of them an empty edge map in the table", () => {
    // Asserted against the table rather than assumed from the list, because the
    // list is what `isTerminalLoan` reads and the table is what the mover reads.
    for (const state of LOAN_TERMINAL) {
      expect(LOAN_MACHINE[state], state).toEqual({});
      expect(eventsFrom(state), state).toEqual([]);
    }
  });

  it("marks exactly the states with no way out as terminal", () => {
    const stuck = states.filter((s) => eventsFrom(s).length === 0);
    expect([...stuck].sort()).toEqual([...LOAN_TERMINAL].sort());
  });

  it("reopens nothing, for any event at all", () => {
    for (const state of LOAN_TERMINAL) {
      for (const event of LOAN_EVENTS) {
        expect(nextLoanState(state, event), `${state} --${event}-->`).toBeUndefined();
      }
    }
  });

  it("can always get to one", () => {
    // No mortgage may be stuck forever in a state with no way out.
    for (const from of states) {
      if (isTerminalLoan(from)) continue;
      const reached = [...reachableFrom(from)];
      expect(reached.some(isTerminalLoan), `${from} cannot reach any ending`).toBe(true);
    }
  });

  it("keeps our own refinance apart from every other payoff", () => {
    // Both mean the balance is gone; only one of them means we are the reason,
    // and that is the chain the monitoring loop is measured by.
    expect(nextLoanState("monitoring_only", "refinanced_by_us")).toBe("refinanced_internally");
    expect(nextLoanState("monitoring_only", "payoff_posted")).toBe("paid_off");
    expect(LOAN_TERMINAL).toContain("refinanced_internally");
    expect(LOAN_TERMINAL).toContain("paid_off");
  });
});

describe("illegal edges throw rather than pretending", () => {
  it("refuses an event the state cannot handle", () => {
    expect(() => requireNextLoanState("pending_boarding", "payoff_posted")).toThrow(
      IllegalLoanTransition,
    );
  });

  it("names the state and the event, so the error is actionable", () => {
    try {
      requireNextLoanState("paid_off", "borrower_claimed");
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as IllegalLoanTransition;
      expect(e.from).toBe("paid_off");
      expect(e.event).toBe("borrower_claimed");
      expect(e.message).toContain("paid_off");
    }
  });

  it("throws on every edge the table does not have", () => {
    for (const from of states) {
      for (const event of LOAN_EVENTS) {
        if (nextLoanState(from, event) !== undefined) continue;
        expect(() => requireNextLoanState(from, event), `${from} --${event}-->`).toThrow(
          IllegalLoanTransition,
        );
      }
    }
  });

  it("never returns the current state as a way of saying no", () => {
    // `advanceStage` did exactly this, and it reads as success at the call site
    // — so a caller could believe it had moved a mortgage that has not moved.
    for (const from of states) {
      for (const event of LOAN_EVENTS) {
        const to = nextLoanState(from, event);
        if (to !== undefined) expect(to, `${from} --${event}-->`).not.toBe(from);
      }
    }
  });
});

describe("the reasons are a closed set", () => {
  it("is non-empty, unique, and spelled the way a reason_code is", () => {
    expect(LOAN_TRANSITION_REASONS.length).toBeGreaterThan(0);
    expect(new Set(LOAN_TRANSITION_REASONS).size).toBe(LOAN_TRANSITION_REASONS.length);
    expect(LOAN_TRANSITION_REASONS.every((r) => /^[a-z][a-z0-9_]*$/.test(r))).toBe(true);
  });
});

describe("the claim's copy ids", () => {
  it("names six, all distinct, none of them a loan state", () => {
    // A claim is something a person does about a loan, and the loan stays where
    // it was throughout. An id in both lists would mean one of those is wrong.
    expect(CLAIM_STATES).toHaveLength(6);
    expect(new Set(CLAIM_STATES).size).toBe(6);
    for (const id of CLAIM_STATES) {
      expect(id).toMatch(/^claim_[a-z_]+$/);
      expect(states as readonly string[]).not.toContain(id);
    }
  });
});

describe("the machine, the model and the copy agree", () => {
  /**
   * docs/states.md is the model for what a state means. Its loan table is
   * eleven backticked names, five of them marked terminal.
   */
  const modeled = (() => {
    const doc = repoFile("docs/states.md");
    const section = doc.slice(doc.indexOf("## Loan lifecycle"));
    const table = section.slice(0, section.indexOf("\n---"));
    return table
      .split("\n")
      .filter((line) => /^\|\s*`/.test(line))
      .map((line) => ({
        id: /`([a-z_]+)`/.exec(line)![1]!,
        terminal: line.includes("_(terminal)_"),
      }));
  })();

  /**
   * `apps/web/src/lib/states.ts` holds the words a borrower reads, one entry
   * per `loan_*` id, each declaring whether it is an ending.
   */
  const written = (() => {
    const src = repoFile("apps/web/src/lib/states.ts");
    // Each chunk runs from one entry's id to the next one's, so the `terminal`
    // it contains is that entry's own.
    return src
      .split(/\bid:\s*"/)
      .slice(1)
      .map((chunk) => ({
        id: chunk.slice(0, chunk.indexOf('"')),
        terminal: /terminal:\s*true/.test(chunk),
      }))
      .filter((e) => e.id.startsWith("loan_"))
      .map((e) => ({ id: e.id.replace(/^loan_/, ""), terminal: e.terminal }));
  })();

  it("finds eleven loan states written down in each", () => {
    expect(modeled).toHaveLength(11);
    expect(written).toHaveLength(11);
  });

  it("has the same eleven names as docs/states.md", () => {
    expect(modeled.map((s) => s.id).sort()).toEqual([...states].sort());
  });

  it("has the same eleven names as the copy", () => {
    // A state in the machine with no copy renders as a blank card; a `loan_*`
    // entry the machine has never heard of is copy for something that cannot
    // happen.
    expect(written.map((s) => s.id).sort()).toEqual([...states].sort());
  });

  it("agrees with both about which five are endings", () => {
    const ends = [...LOAN_TERMINAL].sort();
    expect(
      modeled
        .filter((s) => s.terminal)
        .map((s) => s.id)
        .sort(),
    ).toEqual(ends);
    expect(
      written
        .filter((s) => s.terminal)
        .map((s) => s.id)
        .sort(),
    ).toEqual(ends);
  });
});
