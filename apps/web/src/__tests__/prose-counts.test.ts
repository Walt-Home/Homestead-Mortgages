/**
 * The numbers the repo's front matter states, against the things they count.
 *
 * Four documents tell a new reader how many screens a borrower walks and how
 * many requirements the engine evaluates, and both numbers are the kind that
 * is true on the day it is written and silently false a commit later. When the
 * declarations screen landed, `CLAUDE.md` was rewritten and the other three
 * were not: `README.md` still opened on "four screens" and "77 requirements",
 * `docs/architecture.md` said 77 in three places while claiming 83 in a fourth,
 * and both status tables still listed four screens. Nothing could see any of
 * it, because prose is not compiled.
 *
 * So the counts are read off the things themselves — `SCREENS`, `FLOW_STAGES`
 * and the sheet — and the documents are held to them. History is left alone on
 * purpose: "rebuilt from nine screens to four" is a true sentence about the
 * past, and a rule that banned it would be a rule people turned off. What is
 * checked is the shape a stale count actually takes.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLOW_STAGES } from "@hm/shared";
import { SCREENS } from "../lib/flow.js";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const doc = (name: string) => readFileSync(ROOT + name, "utf8");

/** Every document a reader meets before they meet the code. */
const DOCS = ["README.md", "CLAUDE.md", "docs/architecture.md", "docs/states.md"] as const;

/** The sheet is the source of truth for WHAT must be satisfied, so it is the count. */
const REQUIREMENT_ROWS = doc("data/v1-build.csv")
  .split("\n")
  .filter((line) => /^[A-Z]+-\d+,/.test(line)).length;

describe("the requirement count, wherever a document states one", () => {
  it("is the number of rows on the sheet", () => {
    // Guards the guard: a regex that matched nothing would pass every
    // assertion below while the documents said anything they liked.
    expect(REQUIREMENT_ROWS).toBeGreaterThan(50);

    for (const name of DOCS) {
      // A parenthesized count is about one screen — the flow diagram notes
      // that persistent consent carries none — and only a bare one is a claim
      // about the registry as a whole.
      const stated = [...doc(name).matchAll(/(.)(\d+)\s+requirements\b/g)]
        .filter((m) => m[1] !== "(")
        .map((m) => Number(m[2]));
      for (const n of stated) expect(n, `${name} says ${n} requirements`).toBe(REQUIREMENT_ROWS);
    }
  });

  it("is the number of rows the sheet is said to have", () => {
    for (const name of DOCS) {
      const stated = [...doc(name).matchAll(/v1-build\.csv`?,?\s*(\d+)\s+rows/g)].map((m) =>
        Number(m[1]),
      );
      for (const n of stated) expect(n, `${name} says ${n} rows`).toBe(REQUIREMENT_ROWS);
    }
  });
});

describe("the flow a document draws", () => {
  it("names every screen the borrower actually walks", () => {
    // The heading and the arrow diagram are the two places a reader learns
    // the flow, and a screen missing from them is a screen they will not know
    // to look for. Keyed on the labels rather than on a count, because the
    // stale README had the right shape and the wrong contents.
    for (const name of ["README.md", "CLAUDE.md"] as const) {
      const text = doc(name);
      for (const screen of SCREENS) {
        expect(text, `${name} omits ${screen.label}`).toContain(screen.label);
      }
    }
  });

  /**
   * The ways a document says how many screens a BORROWER walks.
   *
   * Written out rather than derived from the word "screens", and the reason is
   * that two different counts are true at once: the borrower walks five and the
   * sheet has ten, and both appear in the same paragraph of `README.md`. A rule
   * that read every number before "screens" would fail on the sheet's count
   * being right, which is the fastest way to get a rule turned off. History is
   * left alone for the same reason — "rebuilt from nine screens to four" is a
   * true sentence about the past and matches none of these.
   */
  const CLAIMS = [
    /borrower sees (\w+) screens/gi,
    /(\w+) borrower screens/gi,
    /`FlowStage`, (\w+) screens/gi,
    /application in (\w+) screens/gi,
    /(?:flow is|behind) (\w+) screens/gi,
  ];

  it("states the borrower screen count that `SCREENS` has", () => {
    const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
    const current = WORDS[SCREENS.length];
    expect(current).toBeDefined();

    // `index.html` is in the set because its meta description is the one of
    // these a stranger reads — it is what a link preview and a search result
    // show, and it said "a mortgage application in four screens" for as long
    // as the documents did.
    const surfaces = [...DOCS, "apps/web/index.html"];
    let matched = 0;
    for (const name of surfaces) {
      const text = doc(name);
      for (const pattern of CLAIMS) {
        for (const m of text.matchAll(pattern)) {
          const word = (m[1] ?? "").toLowerCase();
          if (!WORDS.includes(word)) continue;
          matched += 1;
          expect(word, `${name}: "${m[0]}"`).toBe(current);
        }
      }
    }
    // A pattern list that matches nothing asserts nothing, which is how the
    // first version of this passed against a meta description saying four.
    expect(matched).toBeGreaterThanOrEqual(surfaces.length);
  });
});

describe("the stage count `docs/states.md` puts in its own table", () => {
  it("is the length of `FLOW_STAGES`", () => {
    // The table row reads "Postgres enum `FlowStage` | 11, ordered". It was
    // written when there were ten, and the file CLAUDE.md points at for
    // anything that looks like a status is the worst place for a stale one.
    const row = doc("docs/states.md")
      .split("\n")
      .find((line) => line.includes("`loan_files.stage`"));
    expect(row).toBeDefined();
    expect(row).toContain(`| ${FLOW_STAGES.length}, ordered`);
  });
});
