/**
 * The engine reads nothing from a suggestion or an autofill event.
 *
 * Rule 2 (three-valued applicability) and rule 5 (every number from a
 * recorded derivation) both fail the moment a figure the product merely
 * suggested reaches a requirement or a ratio. So the requirements and
 * underwriting packages, the decision service and the refi analyst import
 * nothing from the autofill and read no file event, and `LoanFile` has no
 * suggestions key: a suggestion rides beside the file on the wire, never on
 * it. Read off the sources, so a future import fails here rather than in a
 * decision.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../../../", import.meta.url).pathname;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__" || name === "node_modules" || name === "dist") continue;
      out.push(...sources(path));
    } else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const ENGINE = [
  ...sources(join(ROOT, "packages/requirements/src")),
  ...sources(join(ROOT, "packages/underwriting/src")),
  join(ROOT, "apps/api/src/services/decide.ts"),
  join(ROOT, "apps/api/src/services/refi-analyst.ts"),
];

describe("the engine and the autofill", () => {
  it("never meet", () => {
    for (const path of ENGINE) {
      const text = readFileSync(path, "utf8");
      expect(text, path).not.toMatch(/autofill/i);
      expect(text, path).not.toMatch(/fileEvent\.(findMany|findFirst)/);
      expect(text, path).not.toContain("suggestions");
    }
  });

  it("keeps a suggestion off the loan file", () => {
    const loanFile = readFileSync(join(ROOT, "packages/shared/src/types/loan-file.ts"), "utf8");
    expect(loanFile).not.toMatch(/suggestion/i);
  });
});
