/**
 * The shared procedure, exercised without either aggregate that uses it.
 *
 * `transition.test.ts` proves what a move does to an application, against the
 * database that enforces half of it. What is here is the part that only came
 * into existence when one procedure started serving two objects: a conflict
 * raised about a DIFFERENT object is not this call's news, the descriptor is a
 * description rather than a second copy of the procedure, and the sentence
 * saying who calls the raw mover names a population the tree agrees with.
 *
 * Nothing below reads a table. The spec is a handful of functions over an
 * object in memory, and `ownsTransaction` is identity against the global
 * client, so a mover handed anything else never opens a transaction. The file
 * still runs under this directory's setup like every other file here, which
 * wants a reachable database before any of it starts — so the subject needs
 * no Postgres and running it does.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  makeMover,
  TransitionConflict,
  type AggregateSpec,
} from "../services/aggregate-transition.js";
import type { Db } from "../services/db.js";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Anything that is not the global client. The mover opens no transaction on it. */
const notTheGlobalClient = {} as Db;

type State = "imported_unclaimed" | "active" | "paid_off";
type Event = "borrower_claimed" | "payoff_posted";

/**
 * A loan-shaped machine, small enough to read. Keyed loosely on purpose: the
 * mover is about to hand it a state from somebody else's vocabulary, and the
 * honest answer to "what edge does `in_underwriting` have" is that there is no
 * such state here at all.
 */
const EDGES: Record<string, Partial<Record<Event, State>> | undefined> = {
  imported_unclaimed: { borrower_claimed: "active", payoff_posted: "paid_off" },
  active: { payoff_posted: "paid_off" },
  paid_off: {},
};

interface Row {
  status: State;
  statusSeq: number;
  statusEnteredAt: Date;
}

/** The ledger rows a run actually appended. */
function loanSpec(row: Row, hooks: { onLedger?: () => void } = {}) {
  const written: string[] = [];
  const spec: AggregateSpec<State, Event> = {
    name: "loan",
    read: async () => ({ ...row }),
    write: async (_db, a) => {
      if (row.status !== a.from || row.statusSeq !== a.seq - 1) return 0;
      row.status = a.to;
      row.statusSeq = a.seq;
      row.statusEnteredAt = a.when;
      return 1;
    },
    ledger: async (_db, r) => {
      // Recorded before the hook can throw. A caller that swallows a foreign
      // conflict as a skip re-enters and appends a SECOND row, so the count is
      // what tells the two apart; recording after the throw makes this list
      // empty on every path and the assertion below vacuous.
      written.push(r.event);
      hooks.onLedger?.();
    },
    repeatSince: async () => false,
    nextState: (from, event) => EDGES[from]?.[event],
    requireNextState: (from, event) => {
      const to = EDGES[from]?.[event];
      if (to === undefined) throw new Error(`no edge ${from} --${event}-->`);
      return to;
    },
  };
  return { spec, written };
}

const unclaimed = (): Row => ({
  status: "imported_unclaimed",
  statusSeq: 0,
  statusEnteredAt: new Date(),
});

describe("a conflict raised about another object", () => {
  /**
   * The hazard one class serving many rows creates. A spec hook moves
   * something else in the same transaction — a disposal, a claim settling an
   * application, a sibling loan — and its 409 arrives in this mover's catch.
   * Reading that state as this row's finds no edge out of a state this row has
   * never been in, and the caller is handed a skip: a real lost update,
   * swallowed, named after somebody else's state.
   */
  function claimingLoan1While(elsewhere: TransitionConflict) {
    const { spec, written } = loanSpec(unclaimed(), {
      onLedger: () => {
        throw elsewhere;
      },
    });
    return {
      move: makeMover(spec).advanceIfLegal(
        { id: "LOAN-1", event: "borrower_claimed", actorPrincipalId: "p" },
        notTheGlobalClient,
      ),
      written,
    };
  }

  it("leaves this mover when it is about the other aggregate", async () => {
    const elsewhere = new TransitionConflict("application", "APP-1", "in_underwriting");
    const { move, written } = claimingLoan1While(elsewhere);

    await expect(move).rejects.toBe(elsewhere);
    expect(written).toEqual(["borrower_claimed"]);
  });

  it("leaves this mover when it is about another loan", async () => {
    // The kind matches and the row does not, which is the half a discriminator
    // keyed on the kind alone cannot see. `paid_off` is a real state in this
    // machine with no `borrower_claimed` edge out of it, so that version
    // answers here with a skip — reporting LOAN-1 as paid off, which it never
    // was, while the caller's move on LOAN-2 is lost without a word.
    const elsewhere = new TransitionConflict("loan", "LOAN-2", "paid_off");
    const { move, written } = claimingLoan1While(elsewhere);

    await expect(move).rejects.toBe(elsewhere);
    expect(written).toEqual(["borrower_claimed"]);
  });

  it("is still a skip when the conflict is this call's own", async () => {
    // Somebody paid the loan off between this caller's read and its write, so
    // the conditional update matches nothing and the mover raises its own
    // 409. `borrower_claimed` has no edge from where the row landed, which is
    // the case the skip exists for; the discriminator must not turn it into a
    // refusal the caller has to handle.
    const row = unclaimed();
    const { spec } = loanSpec(row);
    const overtaken: AggregateSpec<State, Event> = {
      ...spec,
      write: async () => {
        row.status = "paid_off";
        row.statusSeq += 1;
        return 0;
      },
    };

    await expect(
      makeMover(overtaken).advanceIfLegal(
        { id: "LOAN-1", event: "borrower_claimed", actorPrincipalId: "p" },
        notTheGlobalClient,
      ),
    ).resolves.toEqual({ skipped: "no_edge", from: "paid_off" });
  });
});

describe("the descriptor", () => {
  /**
   * Every field, and the four things a field is allowed to be. A tenth field
   * is a TypeScript error here until somebody says which of the four it is,
   * and a step in the procedure is none of them — which is the whole of the
   * boundary between one mover with two descriptors and two movers sharing a
   * name.
   */
  const WHAT_EACH_FIELD_IS: Record<
    keyof AggregateSpec<string, string>,
    "name" | "table" | "machine" | "refusal"
  > = {
    name: "name",
    read: "table",
    write: "table",
    ledger: "table",
    repeatSince: "table",
    nextState: "machine",
    requireNextState: "machine",
    survivesAHold: "refusal",
    actorGuard: "refusal",
  };

  /**
   * The interface as it is actually written, not as this file remembers it —
   * each field with whether the declaration makes it optional.
   */
  function declaredFields(): { field: string; optional: boolean }[] {
    const source = readFileSync(join(src, "services", "aggregate-transition.ts"), "utf8");
    const start = source.indexOf("export interface AggregateSpec");
    expect(start, "AggregateSpec is no longer declared where this test looks").toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("\n}", start));
    return [...block.matchAll(/^ {2}readonly (\w+)(\??):/gm)].map((m) => ({
      field: m[1] ?? "",
      optional: m[2] === "?",
    }));
  }

  it("declares the fields this test has classified, and no others", () => {
    const declared = declaredFields().map((f) => f.field);
    expect(declared.sort()).toEqual(Object.keys(WHAT_EACH_FIELD_IS).sort());
  });

  it("makes optional exactly the refusals, and they are the two that belong to one aggregate", () => {
    // The two refusals are the two fields an aggregate may decline to supply,
    // and that is the same sentence read from the source rather than from the
    // table above: a loan holds neither, so a third optional field is a third
    // rule the loan path would carry without either aggregate saying so.
    const optional = declaredFields()
      .filter((f) => f.optional)
      .map((f) => f.field)
      .sort();
    const refusals = Object.entries(WHAT_EACH_FIELD_IS)
      .filter(([, role]) => role === "refusal")
      .map(([field]) => field)
      .sort();
    expect(optional).toEqual(refusals);
    expect(optional).toEqual(["actorGuard", "survivesAHold"]);
  });
});

describe("who calls the raw mover directly", () => {
  /**
   * `advanceIfLegal` says routes and importers use it and never `transition`,
   * and names the persona seed as the caller that does. That sentence is only
   * worth reading if the tree agrees with it, so the tree is asked.
   */
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === "__tests__") continue;
      if (statSync(path).isDirectory()) out.push(...sources(path));
      else if (/\.[cm]?ts$/.test(name)) out.push(path);
    }
    return out;
  }

  /** Files importing the bare `transition` binding out of the application mover. */
  function directCallers(): string[] {
    const found: string[] = [];
    for (const file of sources(src)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*transition\.js"/g)) {
        const bindings = (match[1] ?? "")
          .split(",")
          .map((binding) => binding.trim().split(/\s+as\s+/)[0]);
        if (bindings.includes("transition")) found.push(relative(src, file));
      }
    }
    return found.sort();
  }

  it("is the persona seed, and nothing that serves a request", () => {
    expect(directCallers()).toEqual([join("scripts", "seed-personas.ts")]);
  });

  it("is reading the source it thinks it is", () => {
    // A scan that matched nothing would pass the assertion above by being
    // empty rather than by being right, and so would one pointed at a
    // directory with no routes in it.
    const files = sources(src).map((file) => relative(src, file));
    expect(files).toContain(join("services", "standing.ts"));
    expect(files).toContain(join("routes", "application.ts"));
    expect(files.some((f) => f.startsWith("__tests__"))).toBe(false);
  });
});
