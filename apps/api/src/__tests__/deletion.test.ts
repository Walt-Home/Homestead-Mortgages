/**
 * Deletion has to actually delete.
 *
 * The privacy page tells a person their data is removed "for good — there is
 * no archive and no undo." That sentence is a promise, and the thing that
 * makes it true is the cascade: every child of a loan file, and every loan
 * file of a user, has onDelete: Cascade. If somebody adds a table without one,
 * a delete starts leaving orphans behind and the page becomes a lie.
 *
 * This reads the schema rather than the database, so it fails at review time
 * instead of after a stranger has asked to be forgotten.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schema = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../packages/db/prisma/schema.prisma"),
  "utf8",
);

describe("deletion cascades", () => {
  it("removes every child of a loan file", () => {
    const relations = [...schema.matchAll(/^\s*loanFile\s+LoanFile.*$/gm)].map((m) => m[0]);
    // If this drops to zero the regex has rotted, not the schema.
    expect(relations.length).toBeGreaterThan(8);
    const notCascading = relations.filter((r) => !r.includes("onDelete: Cascade"));
    expect(notCascading).toEqual([]);
  });

  it("removes every loan file of a deleted user", () => {
    const relation = /user\s+User\?\s+@relation\([^)]*\)/.exec(schema)?.[0] ?? "";
    expect(relation).toContain("onDelete: Cascade");
  });

  it("keeps borrowers tied to the file, so they go with it", () => {
    // Borrower holds the date of birth and the SSN last four — the two things
    // a person most plausibly wants gone.
    const borrower = schema.slice(schema.indexOf("model Borrower"));
    expect(borrower.slice(0, borrower.indexOf("@@map"))).toContain("onDelete: Cascade");
  });
});
