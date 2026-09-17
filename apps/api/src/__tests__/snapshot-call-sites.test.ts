/**
 * Every place a connector snapshot is written, counted by CI rather than by a
 * person.
 *
 * `recordSnapshot` takes the party a report is about as a required argument,
 * and the database refuses a person-keyed row that names nobody. Both of those
 * catch a call site once it runs. Neither answers the question that actually
 * gets asked when the subject rule changes — "did we find them all" — because
 * the answer to that has so far been a number somebody counted once and wrote
 * in a document, and a document cannot tell that a tenth route landed.
 *
 * So the register below is the count, and this test is what keeps it true. A
 * new call site anywhere under `apps` or `packages` fails here until it is
 * written down, which is the moment to decide whose report it is.
 *
 * It counts LINES that name the call, not calls: two on one line register as
 * one, and a comment or a string naming it registers as one of them. That is
 * the blunt end of the instrument, and it errs toward making somebody look —
 * which is the direction this test exists to err in.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Assembled rather than written out, so the scanner does not count itself and
 * this file does not have to appear in its own register.
 */
const CALL = `recordSnapshot${"("}`;

/** Where it is called, and how many times. */
const REGISTER: Record<string, number> = {
  // The routes. Four person-keyed pulls, and property.ts's four are the
  // address-keyed lookups that screen 1 runs before anybody has authorized
  // anything — three name nobody, the lien search names the owner.
  "apps/api/src/routes/application.ts": 1,
  "apps/api/src/routes/connectors.ts": 4,
  "apps/api/src/routes/property.ts": 4,
  "apps/api/src/services/screening.ts": 1,
  // The sample borrowers walk the same pulls the routes do, and the sample
  // household's co-borrower pulls their own transcripts on their own signature.
  "apps/api/src/scripts/seed-personas.ts": 7,
  // Tests that write a snapshot to have one to read back.
  "apps/api/src/__tests__/employment-income.test.ts": 2,
  "apps/api/src/__tests__/income-identity.test.ts": 1,
  "apps/api/src/__tests__/join.test.ts": 1,
  "apps/api/src/__tests__/re-pull.test.ts": 1,
  "apps/api/src/__tests__/snapshot-subject.test.ts": 5,
  "apps/api/src/__tests__/standing.test.ts": 2,
};

const SKIP = new Set(["node_modules", "dist", ".git", ".turbo", "coverage"]);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Call sites only — the declaration itself is not one. */
function callsIn(file: string): number {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes(CALL) && !line.includes(`function ${CALL}`)).length;
}

function scan(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const top of ["apps", "packages"]) {
    for (const file of sourceFiles(join(repoRoot, top))) {
      const n = callsIn(file);
      if (n) counts[relative(repoRoot, file)] = n;
    }
  }
  return counts;
}

describe("the snapshot call sites", () => {
  it("are the ones written down, and no others", () => {
    expect(scan()).toEqual(REGISTER);
  });

  it("is looking at real source, not at an empty tree", () => {
    // The failure this would otherwise hide: a scanner whose walk broke agrees
    // with an empty register and reports nothing wrong forever.
    expect(Object.keys(REGISTER).length).toBeGreaterThan(5);
    expect(callsIn(join(repoRoot, "apps/api/src/services/repository.ts"))).toBe(0);
    expect(sourceFiles(join(repoRoot, "packages")).length).toBeGreaterThan(50);
  });
});
