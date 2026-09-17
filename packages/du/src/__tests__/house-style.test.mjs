/**
 * The house rules, over the DU generator and the files it writes.
 *
 * Two of them are easy to break in a file this size and invisible in review:
 * American English, and comments that explain themselves to a reader who has
 * only this repository. A comment citing a design, a plan or a commit number
 * points at something nobody can open from here, so it reads as an explanation
 * and carries none.
 *
 * This file is the one place those words are allowed to appear, because it is
 * the file that names them — so it excludes itself from its own scan.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Written by hand, so American English is on us. */
const HAND_WRITTEN = [
  "scripts/build-du.mjs",
  "packages/du/src/index.ts",
  "packages/du/src/identity.ts",
  "packages/du/src/institution.ts",
  "packages/du/src/originator.ts",
  "packages/du/src/writer.ts",
  "packages/du/src/document.ts",
  "packages/du/src/labels.ts",
  "packages/du/src/values.ts",
  "packages/du/src/emit.ts",
  "packages/du/src/assemble/index.ts",
  "packages/du/src/assemble/load.ts",
  "packages/du/src/assemble/assets.ts",
  "packages/du/src/assemble/collateral.ts",
  "packages/du/src/assemble/employment.ts",
  "packages/du/src/assemble/liabilities.ts",
  "packages/du/src/assemble/loan.ts",
  "packages/du/src/assemble/parties.ts",
  "packages/du/src/assemble/relationships.ts",
  "packages/du/src/assemble/verifications.ts",
  "packages/du/src/preflight/index.ts",
  "packages/du/src/preflight/agreement.ts",
  "packages/du/src/preflight/cardinality.ts",
  "packages/du/src/preflight/conditionality.ts",
  "packages/du/src/preflight/enumerations.ts",
  "packages/du/src/preflight/format.ts",
  "packages/du/src/preflight/graph.ts",
  "packages/du/src/preflight/matching.ts",
  "packages/du/src/preflight/paths.ts",
  "packages/du/src/preflight/report.ts",
  "packages/du/src/preflight/tree.ts",
  "packages/du/src/__tests__/build-du.test.mjs",
  "packages/du/src/__tests__/generated.test.ts",
  "packages/du/src/__tests__/identity.test.ts",
  "packages/du/src/__tests__/institution.test.ts",
  "packages/du/src/__tests__/preflight.test.mjs",
  "packages/du/src/__tests__/round-trip.test.mjs",
  "packages/du/src/__tests__/verifications.test.ts",
  "packages/du/src/__tests__/support/sample-reader.mjs",
  "packages/du/src/__tests__/support/ungated.ts",
];

/**
 * The generated tables too, for citations only.
 *
 * Their headers are written here and their contents are not: a member name is
 * MISMO's spelling and must survive verbatim, so `PROJECT_ANALYSIS` and
 * `SalesContractAnalysisDescription` are not ours to correct. The inventory of
 * what no table holds is the same arrangement in a different directory: its
 * header is ours and its rows are element paths.
 */
const GENERATED = [
  "packages/du/src/generated/cardinality.ts",
  "packages/du/src/generated/conditionality.ts",
  "packages/du/src/generated/enums.ts",
  "packages/du/src/generated/lengths.ts",
  "packages/du/src/generated/order.ts",
  "packages/du-schema/du-not-round-tripped.txt",
];

const BRITISH =
  /\b(modelling|labelled|behaviour|colour|organis(e|ed|ing|ation)|authoris(e|ed|ing|ation)|licence|analys(e|ed|ing)|normalis(e|ed|ing)|serialis(e|ed|ing)|initialis(e|ed|ing)|whilst|centre|recognis(e|ed|ing)|cancelled)\b/i;

/**
 * A citation of something outside the repository.
 *
 * `section N` is deliberately not here: the URLA's own sections are numbered,
 * and TAB_DISAGREEMENTS has to say which one renumbered.
 */
const CITATION = /(\bcommit\s+\d|§|\bthe design\b|\bthe plan\b|\bthe reviewer\b|\bthe critic\b)/i;

function linesOf(relative) {
  return readFileSync(resolve(ROOT, relative), "utf8")
    .split("\n")
    .map((text, index) => ({ where: `${relative}:${index + 1}`, text }));
}

describe("house style", () => {
  it.each(HAND_WRITTEN)("%s is in American English", (relative) => {
    const offenders = linesOf(relative)
      .filter((line) => BRITISH.test(line.text))
      .map((line) => `${line.where} ${line.text.trim()}`);
    expect(offenders).toEqual([]);
  });

  it.each([...HAND_WRITTEN, ...GENERATED])(
    "%s explains itself without citing anything outside this repository",
    (relative) => {
      const offenders = linesOf(relative)
        .filter((line) => CITATION.test(line.text))
        .map((line) => `${line.where} ${line.text.trim()}`);
      expect(offenders).toEqual([]);
    },
  );
});
