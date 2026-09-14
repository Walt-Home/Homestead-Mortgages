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
  ADVERSE_WITHOUT_DATE,
  DENIED_BODY,
  ECOA_ON_HOLD,
  ESTIMATE_ON_HOLD,
  ESTIMATE_PENDING_BODY,
  FUNDED_BODY,
  FUNDED_WITHOUT_HISTORY,
  READ_THE_REASONS,
  SAMPLE_FILE,
  SAMPLE_FILE_CANNOT_CHANGE,
  SAMPLE_FILE_START_YOUR_OWN,
  SEE_WHERE_THIS_STANDS,
  START_BODY,
  fileLabel,
  labelWithStartTime,
  sharedFileLabel,
} from "../home-copy.js";
import { SCREENS } from "../flow.js";
import { ADVERSE_COPY } from "../outcomes.js";
import { CLOCK_COPY } from "../ledger.js";
import { applied } from "../endings.js";
import { entryFor } from "../states.js";

/** The arguments a function export is called with, by the name it is exported under. */
type Calls = Record<string, readonly (readonly unknown[])[]>;

/**
 * What makes a function export speak.
 *
 * A function is words only once somebody calls it, so the arguments live here
 * and the walk makes the calls — a label built at render time is still a
 * borrower line, and a file's name is built four different ways depending on
 * what is known about it. A function nobody has written a call for fails.
 * Empty until the module exports one; `fileLabel` was the first.
 *
 * All four shapes are written out, and so is each of the three purposes: the
 * purpose words are the only place the product says what a cash-out refinance
 * is called, and a shape covered by one purpose leaves the other two unread.
 * The last of those calls is a purpose the map has never heard of, which is
 * what a new column value looks like on the day it ships.
 *
 * The second function names the file that turned out not to be the only one of
 * its kind. It lives on this module rather than beside the resolver that spots
 * the collision for the reason this walk exists: a name assembled a module
 * away from here is the one borrower line on the page that would meet none of
 * the five rules.
 */
const CREATED_AT = "2026-09-07T15:14:00.000Z";

/** The file with nothing to be named by, which is also the one that collides. */
const NAMELESS = {
  purpose: null,
  propertyCity: null,
  propertyState: null,
  createdAt: CREATED_AT,
};

const SHARED = {
  borrowers: [{ firstName: "Maya", lastName: "Okafor" }],
  purpose: "PURCHASE",
  propertyCity: "Austin",
  propertyState: "TX",
  createdAt: CREATED_AT,
};

const CALLED: Calls = {
  // A shared file with a borrower on it, and one without — the second is the
  // fallback to the ordinary name, which is the branch a demo file with no
  // borrower row would take. One borrower and not two: the joint name is the
  // same string with a second one joined into it, so a second call would add
  // no rule coverage and would weigh the label side of the split below.
  sharedFileLabel: [[SHARED], [{ ...SHARED, borrowers: [] }], [{ ...SHARED, propertyCity: null }]],
  fileLabel: [
    [
      {
        purpose: "PURCHASE",
        propertyCity: "Austin",
        propertyState: "TX",
        createdAt: CREATED_AT,
      },
    ],
    [
      {
        purpose: "RATE_TERM_REFINANCE",
        propertyCity: null,
        propertyState: null,
        createdAt: CREATED_AT,
      },
    ],
    [
      {
        purpose: "CASH_OUT_REFINANCE",
        propertyCity: "Austin",
        propertyState: "TX",
        createdAt: CREATED_AT,
      },
    ],
    [
      {
        purpose: null,
        propertyCity: "Austin",
        propertyState: "TX",
        createdAt: CREATED_AT,
      },
    ],
    [NAMELESS],
    [
      {
        purpose: "REVERSE_MORTGAGE",
        propertyCity: null,
        propertyState: null,
        createdAt: CREATED_AT,
      },
    ],
  ],
  // The name a file gets when it turns out not to be the only one of its kind,
  // which is the one borrower line on this page that is assembled rather than
  // written. Built off the shape that collides — no purpose, no place — so the
  // call here is the collision itself rather than an illustration of one.
  labelWithStartTime: [[fileLabel(NAMELESS), NAMELESS.createdAt]],
};

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

  it("points at the rest of the card only from the line that has a twin", () => {
    // A sentence saying something is above it or below it is a claim about
    // layout, and the card can be made to break it: the history block and the
    // clocks are drawn off the file's own read, so both are absent for the
    // length of that fetch and absent for good on a file that will not
    // project. Every line that makes such a claim therefore needs a second
    // line for the card that is not holding the thing. Two exist and this is
    // the list of them, so a third written without its twin fails here rather
    // than on somebody's screen.
    const locative = COPY.filter((line) => /\b(above|below)\b/.test(line));
    expect(locative).toEqual([FUNDED_BODY]);
    expect(ADVERSE_COPY.body).toMatch(/\babove\b/);
    expect(ADVERSE_WITHOUT_DATE).not.toMatch(/\b(above|below)\b/);
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
    // The quiet labels and the purpose words are both maps, and between them
    // they are a third of what this module says. Reading only the top level
    // would apply five rules to the file's longest half and none to them.
    expect(wordsOf("labels", { review: "See where this file stands" })).toEqual([
      "See where this file stands",
    ]);
    expect(wordsOf("nested", { a: { b: ["one", "two"] } })).toEqual(["one", "two"]);
    expect(COPY).toContain(copy.QUIET_LABELS.review);
    expect(COPY).toContain(copy.PURPOSE_WORDS.CASH_OUT_REFINANCE);
  });

  it("refuses an export it cannot open, rather than stepping over it", () => {
    // A filter drops; this throws. The string nobody checked is the one that
    // was skipped silently, so there is no silent case. The function probe is
    // a name CALLED does not carry, which is what the next function export
    // looks like on the day somebody adds it.
    expect(() => wordsOf("count", 4)).toThrow(/cannot read/);
    expect(() => wordsOf("missing", null)).toThrow(/cannot read/);
    expect(() => wordsOf("nextLabel", () => "Purchase")).toThrow(/CALLED/);
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

describe("the sentence that counts the steps", () => {
  /** The step words, in the order the sentence lists them. */
  const listed = (body: string): readonly string[] =>
    body
      .slice(body.indexOf("—") + 1, body.indexOf("."))
      .split(/,\s*(?:and\s+)?/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

  it("names as many steps as there are screens", () => {
    // It said "Four steps — the property, you, your bank, and a review" for a
    // week after the declarations screen landed, three inches above a stepper
    // reading "Step 1 of 5". Nothing could see it, because the only assertion
    // on this string was that the home page contained it.
    expect(START_BODY.startsWith("Five steps")).toBe(true);
    expect(listed(START_BODY)).toHaveLength(SCREENS.length);
  });

  it("names them in the order the borrower walks them", () => {
    // A count that matches while the words describe a different flow is the
    // half of this that a number alone cannot hold.
    expect(listed(START_BODY)).toEqual([
      "the property",
      "you",
      "a few questions",
      "your bank",
      "a review",
    ]);
    // And the middle one is the screen's own label, so the sentence and the
    // stepper cannot call the same step two things.
    expect(START_BODY).toContain(SCREENS[2].label.toLowerCase());
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
 * and everything else still is. The line it was written for is the on-hold
 * clock sentence, which ships on the adverse-action surface and is taken from
 * there rather than retyped for exactly the reason this rule exists.
 *
 * It is read off every import, including the ones that bring in a type rather
 * than a word. That is harmlessly wide: the excuse is worked out per line, so
 * a module nothing is borrowed FROM is excused for nothing.
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

/**
 * The lines the rule below is about: the ones that make a claim.
 *
 * A sentence written twice is two authors promising something slightly
 * different about one situation, and that is the drift this module was made to
 * end. A control label is two or three words — "Try again", "Open it",
 * "Connect your bank" — and it recurs because English is short, not because
 * anybody copied it: the bank screen's own heading is those three words, and a
 * failed identity check offers its own retry. Forbidding that would make this
 * a ban on short English rather than a rule about copy, and the label would
 * have to be worded around the test.
 *
 * So the rule reads the sentences, and every line still meets the five copy
 * rules above whatever shape it is.
 *
 * One line falls on the label side that reads like a claim: the heading on a
 * file with no application, which is a sentence with no period because it is a
 * heading. It is left there rather than special-cased — a predicate with an
 * exception in it is one somebody adds a second exception to.
 */
const sentence = (line: string) => /[.!?…]$/.test(line);

const SENTENCES = COPY.filter(sentence);
const LABELS = COPY.filter((line) => !sentence(line));

describe("one home for each of these sentences", () => {
  it("leaves no second copy of one written out in another file", () => {
    // This is the failure the module was made to end, and it had already
    // happened three ways round: two screens answering one error code with one
    // sentence each, and a third answering it with different words. Extracting
    // the strings does nothing on its own — the next screen to need one types
    // it out — so the rule is that the sentence appears in one file.
    expect(secondCopies(SENTENCES, FILES, BORROWED_FROM, OWN_SOURCE)).toEqual([]);
  });

  it("is asking it of most of what this module says", () => {
    // The split is the one way past the rule, so it is pinned. There are more
    // labels than sentences and there always will be — a card is one body and
    // one button — but the sentences are nearly all of the WORDS, which is the
    // measure that matters: a module whose bodies had quietly become labels
    // would pass the rule above by having nothing left to check.
    expect(SENTENCES.join("").length).toBeGreaterThan(3 * LABELS.join("").length);
    expect(SENTENCES).toContain(SAMPLE_FILE);
    expect(SENTENCES).toContain(copy.SUSPENDED_BODY);
    expect(LABELS).toContain(copy.TRY_AGAIN);

    // The two written for branches nothing currently takes are in here like
    // any other line. A string is checked because of where it lives, not
    // because somebody has worked out whether a borrower can reach it.
    expect(SENTENCES).toContain(copy.ADVERSE_WITHOUT_DATE);
    expect(SENTENCES).toContain(copy.RESCISSION_BODY);
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
    // One sentence is borrowed and it comes from the clock catalog; one label
    // is borrowed and it comes from the state catalog. The flow module is here
    // for a type, which excuses it for nothing, because no line in this module
    // came from it.
    expect([...BORROWED_FROM].sort()).toEqual(["lib/flow.ts", "lib/ledger.ts", "lib/states.ts"]);
    expect(
      specifiersOf('export { A } from "./ledger.js";\nimport { B } from "@hm/shared";'),
    ).toEqual(["lib/ledger.ts"]);
  });
});

describe("the two clock sentences this page has to say for itself", () => {
  it("gives the adverse-action date its own reason, and takes it from the clocks", () => {
    // It used to read "on hold for the same reason", whose referent was the
    // Loan Estimate pair one line above it — a pair that correctly stops
    // rendering on a file where a decision is already behind the borrower,
    // which is the only file this sentence is ever shown on. It carries the
    // reason now, and this page shows the same sentence the review screen
    // does rather than a second one.
    expect(ECOA_ON_HOLD).toBe(CLOCK_COPY.adverseActionOnHold);
    expect(ECOA_ON_HOLD).toContain("deliver");
    expect(ECOA_ON_HOLD).not.toContain("the same reason");
  });

  it("drops the estimate's date once the date is behind the file", () => {
    // The clock opens already on hold and nothing ever starts it, so a date
    // that has passed was never a deadline counting down. On a screen read
    // once a stale date was survivable; on a page somebody checks every week
    // it is the product repeating a deadline it missed and did not have.
    expect(ESTIMATE_ON_HOLD).not.toMatch(/\d/);
    expect(ESTIMATE_ON_HOLD).toContain("deliver");
  });
});

describe("the adverse-action body for a file with no clock row", () => {
  it("says what the shipping sentence says, without forking it", () => {
    // Pinned by meaning rather than by characters. A prefix pin would make
    // this a cut of a regulated string, and cutting it anywhere produces
    // either a sentence with no ending or one that has dropped the half about
    // the explanation somebody is owed.
    const owed = "written explanation naming the specific reasons";
    expect(ADVERSE_WITHOUT_DATE).toContain(owed);
    expect(ADVERSE_COPY.body).toContain(owed);
    expect(ADVERSE_WITHOUT_DATE).not.toBe(ADVERSE_COPY.body);
    expect(ADVERSE_WITHOUT_DATE).not.toContain("above");
  });

  it("ends on a clause that names what is being waited on", () => {
    // The approved card ends "it will be here when it is", where the estimate
    // is the subject of its own sentence and carries the clause. Reusing that
    // ending here leaves "it is" with nothing to complete it, on the one
    // string in this module a regulator reads. What is outstanding here is the
    // writing of the explanation, so the sentence says so.
    expect(ADVERSE_WITHOUT_DATE).toMatch(/it will be here when it is written\.$/);
    expect(ADVERSE_WITHOUT_DATE).not.toMatch(/when it is\.$/);
    expect(ESTIMATE_PENDING_BODY).toMatch(/when it is\.$/);
  });
});

describe("the ending whose record is under it, and the same one without", () => {
  it("says the whole of the ending without pointing at anything", () => {
    // The card draws the history off the file's own read, so the sentence
    // naming it is true only once that read is back — and never on a file that
    // will not project. Trimming the shipping line would cost the one thing an
    // ending gets on a product with no loan record to show, so the second line
    // is the one that survives without it, and the money having moved is all
    // of it.
    const funded = "Your mortgage is funded.";
    expect(FUNDED_BODY.startsWith(funded)).toBe(true);
    expect(FUNDED_WITHOUT_HISTORY).toBe(funded);
    expect(FUNDED_BODY).not.toBe(FUNDED_WITHOUT_HISTORY);
  });
});

describe("the closed file, with its reasons and without them", () => {
  const decided = { status: "denied", terminal: true };
  const overwritten = { status: "in_underwriting", terminal: false };

  it("claims the reasons exist only where the control may name them", () => {
    // The control on this card is already split: it names the reasons when the
    // machine took the word and names the destination when it did not. The
    // body was not, so a file whose newest decision row says something else
    // read "the written reasons are the record of why" over a button that had
    // been demoted precisely because they are not what the review screen will
    // print. Both halves split on one gate now, and this is the pin.
    const claimsThePayload = (line: string) => /reasons are the record/.test(line);

    expect(applied("denied", decided)).toBe(true);
    expect(applied("denied", overwritten)).toBe(false);

    expect(claimsThePayload(DENIED_BODY)).toBe(true);
    expect(READ_THE_REASONS).toContain("reasons");

    expect(SEE_WHERE_THIS_STANDS.toLowerCase()).not.toContain("reason");
  });

  it("shares its regulated opening with the sentence it stands in for", () => {
    // All but the closing clause of ADVERSE_WITHOUT_DATE is ADVERSE_COPY.body
    // verbatim; only the ending moves, because the shipping one points at a
    // date that is not on screen when this one renders. A rule that compares
    // whole strings cannot see an overlap that is most of two strings, so the
    // overlap is pinned here — editing the regulated opening without editing
    // this one would leave two versions of a regulated claim in the product.
    const opening = (line: string) => line.slice(0, line.lastIndexOf(", and "));
    expect(opening(ADVERSE_WITHOUT_DATE)).toBe(opening(ADVERSE_COPY.body));
    expect(opening(ADVERSE_WITHOUT_DATE).length).toBeGreaterThan(60);
    expect(ADVERSE_COPY.body).toContain("You are owed");
  });
});

describe("the labels this page takes rather than writes", () => {
  it("reads the reasons control off the state catalog", () => {
    // The catalog carries this label on the state the page reads it for, and
    // the gallery renders it there. Two files holding one button's words is
    // how they come to disagree, so it is taken and not retyped — and the
    // second assertion is what makes that true rather than coincidental.
    expect(READ_THE_REASONS).toBe(entryFor("adverse_action_pending")?.action);
    expect(OWN_SOURCE).not.toContain(`"${READ_THE_REASONS}"`);
  });

  it("gives the fallback control a destination and no payload", () => {
    // It stands in on three cards and the payloads are different on each:
    // conditions no surface renders, and reasons the review screen will not
    // print on either declined file. The one thing that screen always has is
    // where the file stands, so the label names that and nothing else.
    for (const payload of ["reason", "term", "estimate", "list", "notice", "document"]) {
      expect(SEE_WHERE_THIS_STANDS.toLowerCase(), payload).not.toContain(payload);
    }
  });
});

/**
 * A joint application is two people, and the list says so.
 *
 * This named the file after `borrowers[0]` while the wire only ever sent one
 * of them, so the read and the shape agreed by accident. A file can carry four
 * now, and naming one of the two people on a joint application after whichever
 * of them sorts first is the list deciding whose file it is — on the one
 * surface where the reader is looking for exactly that.
 */
describe("what somebody else's file is called", () => {
  const shared = {
    purpose: "PURCHASE",
    propertyCity: "Austin",
    propertyState: "TX",
    createdAt: CREATED_AT,
  };

  it("names the one person on it", () => {
    expect(
      sharedFileLabel({ ...shared, borrowers: [{ firstName: "Maya", lastName: "Okafor" }] }),
    ).toBe("Maya Okafor — Austin, TX");
  });

  it("names both people on a joint one", () => {
    expect(
      sharedFileLabel({
        ...shared,
        borrowers: [
          { firstName: "Maya", lastName: "Okafor" },
          { firstName: "Theo", lastName: "Okafor" },
        ],
      }),
    ).toBe("Maya Okafor and Theo Okafor — Austin, TX");
  });

  it("reads as a list once there are more than two", () => {
    // The schema carries four and the append route allocates up to it, so this
    // is a reachable file and not a hypothetical one. "A and B and C" is not a
    // sentence anybody writes, and the names are the whole of the label.
    expect(
      sharedFileLabel({
        ...shared,
        borrowers: [
          { firstName: "Maya", lastName: "Okafor" },
          { firstName: "Theo", lastName: "Okafor" },
          { firstName: "Sam", lastName: "Okafor" },
        ],
      }),
    ).toBe("Maya Okafor, Theo Okafor and Sam Okafor — Austin, TX");
  });

  it("reads as a list at the ceiling of four", () => {
    expect(
      sharedFileLabel({
        ...shared,
        borrowers: [
          { firstName: "Maya", lastName: "Okafor" },
          { firstName: "Theo", lastName: "Okafor" },
          { firstName: "Sam", lastName: "Okafor" },
          { firstName: "Kenji", lastName: "Okafor" },
        ],
      }),
    ).toBe("Maya Okafor, Theo Okafor, Sam Okafor and Kenji Okafor — Austin, TX");
  });

  it("takes them in the order the row sends them, which is document order", () => {
    // The API sorts a file's borrowers by `borrower_ordinal`, so the applicant
    // is first. Sorting or reordering here would be this module holding a
    // second opinion about who Borrower 1 is.
    expect(
      sharedFileLabel({
        ...shared,
        borrowers: [
          { firstName: "Theo", lastName: "Okafor" },
          { firstName: "Maya", lastName: "Okafor" },
        ],
      }),
    ).toBe("Theo Okafor and Maya Okafor — Austin, TX");
  });

  it("falls back to the ordinary name when nobody is on it yet", () => {
    expect(sharedFileLabel({ ...shared, borrowers: [] })).toBe(fileLabel(shared));
  });
});

describe("what one file is called", () => {
  const row = {
    purpose: null as string | null,
    propertyCity: null as string | null,
    propertyState: null as string | null,
    createdAt: CREATED_AT,
  };

  it("names the purpose and the place when it has both", () => {
    expect(
      fileLabel({ ...row, purpose: "PURCHASE", propertyCity: "Austin", propertyState: "TX" }),
    ).toBe("Purchase in Austin, TX");
  });

  it("falls back through the place to the day it was started", () => {
    expect(fileLabel({ ...row, purpose: "RATE_TERM_REFINANCE" })).toBe(
      "Refinance, started September 7, 2026",
    );
    expect(fileLabel({ ...row, propertyCity: "Austin", propertyState: "TX" })).toBe(
      "Started September 7, 2026 in Austin, TX",
    );
    expect(fileLabel(row)).toBe("Started September 7, 2026");
  });

  it("still names a file that knows nothing about itself", () => {
    // The draft this page offers to pick back up is exactly the file with no
    // purpose and no address, and two of them rendering as one row is what
    // this function exists for.
    expect(fileLabel(row).length).toBeGreaterThan(0);
    expect(fileLabel({ ...row, purpose: "REVERSE_MORTGAGE" })).toBe(fileLabel(row));
  });

  it("gives two drafts started the same day with no address one name", () => {
    // The collision this function cannot resolve, asserted rather than
    // described as though something here already handled it: the fallback is
    // the day, not the time, and a function handed one row cannot know a
    // second row is about to render beside it. Spotting the collision belongs
    // to whoever renders the group; the words it is broken with are below.
    const morning = { ...row, createdAt: "2026-09-07T13:00:00.000Z" };
    const evening = { ...row, createdAt: "2026-09-07T22:00:00.000Z" };
    expect(fileLabel(morning)).toBe(fileLabel(evening));
    expect(fileLabel(morning)).not.toMatch(/\d\s*[:.]\s*\d|\bAM\b|\bPM\b/);
  });

  it("breaks that collision with the time, in the same words and the same zone", () => {
    // The second half of the same job, and it is here rather than beside the
    // resolver that spots the collision because a name assembled there would
    // be the one borrower line on that page no rule above ever reads.
    const morning = { ...row, createdAt: "2026-09-07T13:00:00.000Z" };
    const evening = { ...row, createdAt: "2026-09-07T22:00:00.000Z" };
    const named = (file: typeof row) => labelWithStartTime(fileLabel(file), file.createdAt);

    expect(named(morning)).not.toBe(named(evening));
    expect(named(morning).startsWith(fileLabel(morning))).toBe(true);
    expect(named(morning)).toMatch(/\d\s?[AP]M$/);

    // Same zone as the day it follows, or the two halves of one name would
    // disagree about which day the file was started on.
    const here = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      // Matched rather than compared: the separator before the meridiem is a
      // plain space on some builds of ICU and a narrow no-break space on
      // others, and which one this ran on is not what the test is about.
      const late = { ...row, createdAt: "2026-09-08T00:14:00.000Z" };
      expect(named(late)).toMatch(/^Started September 7, 2026, 8:14\s?PM$/);
    } finally {
      if (here === undefined) delete process.env.TZ;
      else process.env.TZ = here;
    }
  });

  it("reads the day in the creditor's zone, so two dates on a row agree", () => {
    // Late evening in New York is already the next day everywhere east of it.
    // A name read in the reader's own zone would date a file to the day after
    // the ledger says it was started, on the one row the ledger is beside.
    //
    // Read from Tokyo, for the reason the ledger's own zone test is: a machine
    // already sitting in New York cannot tell a zone that was pinned from one
    // that was never passed.
    const here = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    try {
      expect(fileLabel({ ...row, createdAt: "2026-09-08T00:14:00.000Z" })).toBe(
        "Started September 7, 2026",
      );
    } finally {
      if (here === undefined) delete process.env.TZ;
      else process.env.TZ = here;
    }
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

  it("is one screen standing the sentence in for a control and two disabling one", () => {
    // The header calls this roll, and calling it wrong is easy: the split is
    // two lines apart in each file and the bank screen reads at a glance like
    // the connector step. It does what screen 1 does. Reading the roll off the
    // source is what keeps the margin true the next time one of the three is
    // rewritten, and the margin is the only record of which are outstanding.
    const text = (name: string) => FILES.find((f) => f.name === name)!.text;
    const disabledOnReadOnly = /disabled=\{[^}]*\breadOnly\b[^}]*\}/;

    // The gate on the connect control itself, not just a mention of the flag
    // somewhere in the file — the same component suppresses "Pull again" the
    // same way, and matching that would let the connect button lose its gate
    // without this noticing.
    expect(text("components/ConnectorStep.tsx")).toContain(
      "!connected && !props.blocked && !props.readOnly",
    );
    expect(text("components/ConnectorStep.tsx")).not.toMatch(disabledOnReadOnly);
    expect(text("pages/BankPage.tsx")).toMatch(disabledOnReadOnly);
    expect(text("pages/PropertyLoanPage.tsx")).toMatch(disabledOnReadOnly);
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
