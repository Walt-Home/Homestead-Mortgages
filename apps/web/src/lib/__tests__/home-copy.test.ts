/**
 * The words in `home-copy.ts`, against the rules every borrower line keeps.
 *
 * The module exists so that "may this string render?" is a question about the
 * file rather than about the field, and this is the half that makes that true:
 * every export is read here, so a string added without a thought about the
 * five rules fails before it reaches a screen.
 *
 * It reads the module's own exports rather than a list written out by hand. A
 * hand-written list is one somebody adds a string without joining, and the
 * string that skips it is the one nobody checked. Reading the exports is only
 * worth more than a list if nothing can be read and then dropped, which is why
 * `wordsOf` throws at an export it does not know how to open rather than
 * stepping over it: the module is about to hold maps of labels and a function
 * that builds a file's name, and a walk that quietly kept only the top-level
 * strings would check the smallest part of it while claiming to check it all.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRITISH, DAY_FIRST, DELIVERY_TIME, PROMISES, REQ_ID } from "@hm/shared";
import * as copy from "../home-copy.js";
import {
  SAMPLE_FILE,
  SAMPLE_FILE_CANNOT_CHANGE,
  SAMPLE_FILE_START_YOUR_OWN,
} from "../home-copy.js";

/** The arguments a function export is called with, by the name it is exported under. */
type Calls = Record<string, readonly (readonly unknown[])[]>;

/**
 * What makes a function export speak.
 *
 * A function is words only once somebody calls it, so the arguments live here
 * and the walk makes the calls — a label built at render time is still a
 * borrower line, and a file's name is built four different ways depending on
 * what is known about it. A function nobody has written a call for fails.
 * Empty until the module exports one; `fileLabel` is the first.
 */
const CALLED: Calls = {};

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/** Every string reachable from one export, named so a failure says which. */
export function wordsOf(name: string, value: unknown, calls: Calls = CALLED): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") {
    const made = calls[name];
    if (!made) {
      throw new Error(
        `${name} is a function, and no call of it is written down in CALLED — ` +
          `so whatever it returns reaches a screen unchecked.`,
      );
    }
    const call = value as (...args: readonly unknown[]) => unknown;
    return made.flatMap((args, i) => wordsOf(`${name}(${i})`, call(...args), calls));
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => wordsOf(`${name}[${i}]`, item, calls));
  }
  if (plain(value)) {
    return Object.entries(value).flatMap(([key, item]) => wordsOf(`${name}.${key}`, item, calls));
  }
  throw new Error(
    `${name} is ${value === null ? "null" : typeof value}, which this test cannot read ` +
      `words out of. Teach it that shape rather than letting the export skip the rules.`,
  );
}

const COPY = Object.entries(copy).flatMap(([name, value]) => wordsOf(name, value));

describe("every string this module exports", () => {
  it("is a set somebody would notice emptying", () => {
    // A rule applied to nothing passes for the wrong reason.
    expect(COPY.length).toBeGreaterThan(0);
    for (const line of COPY) expect(line.length, line).toBeGreaterThan(0);
  });

  it("names no channel and no person who will make contact", () => {
    for (const line of COPY) expect(line, line).not.toMatch(PROMISES);
  });

  it("promises no delivery time", () => {
    for (const line of COPY) expect(line, line).not.toMatch(DELIVERY_TIME);
  });

  it("renders nothing internal, in American English", () => {
    for (const line of COPY) {
      expect(line, line).not.toMatch(REQ_ID);
      expect(line, line).not.toMatch(BRITISH);
      expect(line, line).not.toMatch(DAY_FIRST);
    }
  });

  it("catches the sentences these rules were written for", () => {
    // Regexes that match nothing would pass every case above.
    expect("We'll email you when it is ready.").toMatch(PROMISES);
    expect("It will be here within three business days.").toMatch(DELIVERY_TIME);
    expect("APP-005 is outstanding.").toMatch(REQ_ID);
    expect("Your authorisation is on file.").toMatch(BRITISH);
    expect("Started 11 September").toMatch(DAY_FIRST);
  });
});

describe("the walk that decides what those rules are applied to", () => {
  it("reaches a string inside a map, and inside a map inside a map", () => {
    // The next things in this module are a map of quiet labels and a map of
    // purpose words. Reading only the top level would apply five rules to the
    // file's shortest half.
    expect(wordsOf("labels", { review: "See where this file stands" })).toEqual([
      "See where this file stands",
    ]);
    expect(wordsOf("nested", { a: { b: ["one", "two"] } })).toEqual(["one", "two"]);
  });

  it("refuses an export it cannot open, rather than stepping over it", () => {
    // A filter drops; this throws. The string nobody checked is the one that
    // was skipped silently, so there is no silent case.
    expect(() => wordsOf("count", 4)).toThrow(/cannot read/);
    expect(() => wordsOf("missing", null)).toThrow(/cannot read/);
    expect(() => wordsOf("fileLabel", () => "Purchase")).toThrow(/CALLED/);
  });

  it("takes a function at the words a call of it actually makes", () => {
    // How `fileLabel` joins: the calls covering the four shapes a file can be
    // named by go into CALLED, the walk makes them, and every label that comes
    // back is held to the five rules like any other string.
    const fileLabel = (purpose: string, city: string | null) =>
      city ? `${purpose} in ${city}` : purpose;
    const calls = {
      fileLabel: [
        ["Purchase", "Austin, TX"],
        ["Refinance", null],
      ],
    };
    expect(wordsOf("fileLabel", fileLabel, calls)).toEqual(["Purchase in Austin, TX", "Refinance"]);
  });
});

describe("the sample-file refusal", () => {
  it("is one sentence, and the longer one is that sentence plus a way on", () => {
    // Two screens wrote it out, one of them with the extra clause. Building
    // the longer string from the shorter is what stops the two drifting into
    // telling a tester two different things about the same refusal.
    expect(SAMPLE_FILE).toBe("This is a sample file, so it is read-only.");
    expect(SAMPLE_FILE_START_YOUR_OWN.startsWith(SAMPLE_FILE)).toBe(true);
    expect(SAMPLE_FILE_START_YOUR_OWN).toContain("Start your own");
  });

  it("says file, not account — the session refusal is the one that says account", () => {
    // They arrive from the same button and are not the same refusal: a sample
    // file refuses everybody, and a sample session is refused on every file
    // including its own.
    for (const line of [SAMPLE_FILE, SAMPLE_FILE_START_YOUR_OWN, SAMPLE_FILE_CANNOT_CHANGE]) {
      expect(line, line).toContain("sample file");
      expect(line, line).not.toContain("account");
    }
  });
});

/**
 * Files the rules below read. `__tests__` is skipped, because a test quoting a
 * string it is asserting on is not a second copy of it.
 */
const SRC = new URL("../..", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : sourceFiles(path);
    return path.endsWith(".tsx") || path.endsWith(".ts") ? [path] : [];
  });
}

const HOME_COPY = "lib/home-copy.ts";
const THIS_TEST = "lib/__tests__/home-copy.test.ts";

const SOURCES = sourceFiles(SRC).map((path) => ({
  name: path.slice(SRC.length),
  text: readFileSync(path, "utf8"),
}));

const FILES = SOURCES.filter((f) => f.name !== HOME_COPY);
const OWN_SOURCE = SOURCES.find((f) => f.name === HOME_COPY)!.text;

/** The modules under `apps/web/src` a piece of source takes names out of. */
export function specifiersOf(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+"([^"]+)"/g)]
    .map((match) => match[1]!)
    .filter((spec) => spec.startsWith("."))
    .map((spec) => join("lib", spec).replace(/\.js$/, ".ts"));
}

/**
 * The modules this one takes its words out of, rather than writing them.
 *
 * A string that arrives here through a re-export is already in exactly one
 * place — the module it came from — so that module is not a second copy of it
 * and everything else still is. Empty today. The first line to need it is the
 * on-hold clock sentence, which ships on the adverse-action surface and is
 * re-exported rather than retyped for exactly the reason this rule exists.
 */
const BORROWED_FROM = new Set(specifiersOf(OWN_SOURCE));

/**
 * Every place one of these lines is written out that is not its home.
 *
 * A line this module declares is exempt nowhere: it is written here, and a
 * second copy of it anywhere is the drift. A line this module only re-exports
 * is written somewhere else on purpose, and that somewhere is the module it is
 * re-exported from — which is why both conditions have to hold to excuse a
 * file, and why excusing one does not excuse it for the other lines.
 */
function secondCopies(
  lines: readonly string[],
  files: readonly { readonly name: string; readonly text: string }[],
  borrowedFrom: ReadonlySet<string>,
  ownSource: string,
): string[] {
  return lines.flatMap((line) => {
    const borrowed = !ownSource.includes(line);
    return files
      .filter((f) => !(borrowed && borrowedFrom.has(f.name)) && f.text.includes(line))
      .map((f) => `${f.name}: ${line}`);
  });
}

describe("one home for each of these sentences", () => {
  it("leaves no second copy of one written out in another file", () => {
    // This is the failure the module was made to end, and it had already
    // happened three ways round: two screens answering one error code with one
    // sentence each, and a third answering it with different words. Extracting
    // the strings does nothing on its own — the next screen to need one types
    // it out — so the rule is that the sentence appears in one file.
    expect(secondCopies(COPY, FILES, BORROWED_FROM, OWN_SOURCE)).toEqual([]);
  });

  it("is a rule that can see a copy when there is one", () => {
    // The search is a plain substring over the sources it collected, and both
    // halves can rot: a glob that matched nothing would pass this suite.
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.some((f) => f.text.includes("This is a sample account"))).toBe(true);
  });

  it("excuses the module a borrowed line was borrowed from, and nothing else", () => {
    // Without this the rule cannot be obeyed by a line it does not own: the
    // only ways past it would be to retype the sentence, which is the thing
    // forbidden, or to move it off the module that ships it, which is editing
    // a regulated string to satisfy a test.
    const files = [
      { name: "lib/ledger.ts", text: 'const a = "borrowed line";\nconst b = "own line";' },
      { name: "pages/Some.tsx", text: 'const c = "borrowed line";\nconst d = "own line";' },
    ];
    const borrowedFrom = new Set(["lib/ledger.ts"]);

    expect(
      secondCopies(["borrowed line"], files, borrowedFrom, 'export { X } from "./ledger.js";'),
    ).toEqual(["pages/Some.tsx: borrowed line"]);

    // Declared here, so the module it would otherwise be borrowed from is an
    // offender like any other file.
    expect(secondCopies(["own line"], files, borrowedFrom, 'export const Y = "own line";')).toEqual(
      ["lib/ledger.ts: own line", "pages/Some.tsx: own line"],
    );
  });

  it("reads that excuse off this module's own imports", () => {
    // Nothing is borrowed yet, which is also how a set built wrong would look.
    expect([...BORROWED_FROM]).toEqual([]);
    expect(
      specifiersOf('export { A } from "./ledger.js";\nimport { B } from "@hm/shared";'),
    ).toEqual(["lib/ledger.ts"]);
  });
});

describe("the sample-file sentences this module did not take", () => {
  it("is the three screens that stand a sentence in for a control", () => {
    // Not refusals: each names the control it is talking about. Two of them
    // replace a control the screen chose not to render; screen 1 still renders
    // a disabled one, which the module header names rather than hides. The set
    // is pinned because that header claims it is three — a fourth screen
    // writing one of these has either found a fourth control or started the
    // drift again.
    const own = FILES.filter((f) => f.text.includes("This is a sample file")).map((f) => f.name);
    expect(own.sort()).toEqual([
      "components/ConnectorStep.tsx",
      "pages/BankPage.tsx",
      "pages/PropertyLoanPage.tsx",
    ]);
  });
});

describe("the margins of this module", () => {
  it("point at nothing a reader of this repo cannot open", () => {
    // A comment naming a section of a document that is not in the tree is a
    // reference nobody can follow and nobody can keep true. Say the thing.
    // Built from a code point so this rule does not fail on its own source.
    const pointer = new RegExp(`${String.fromCharCode(0xa7)}\\s*\\d|\\bsection\\s+\\d`, "i");
    for (const name of [HOME_COPY, THIS_TEST]) {
      expect(readFileSync(join(SRC, name), "utf8"), name).not.toMatch(pointer);
    }
    expect(`as ${String.fromCharCode(0xa7)}7 says`).toMatch(pointer);
  });
});
