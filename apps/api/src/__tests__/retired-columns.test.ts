/**
 * The legacy TRID stamp is gone from the table, and nothing may name it again.
 *
 * `loan_files.application_received_at` and `application_six_pieces` were the
 * second opinion of the moment a credit request began: a screen-2 save judged
 * the six pieces for itself and wrote them, while the receipt trigger judged
 * the same six from the pins and wrote a ledger row — and the two disagreed
 * routinely. The readers went one commit at a time; dropping the columns is
 * what makes the disagreement unrepeatable, because a stamp cannot be revived
 * by a caller when it has nowhere to land.
 *
 * Two things are asserted, because either on its own is weak. The database is
 * asked whether the columns are there, which is what catches a migration that
 * was written and never applied. And every workspace's source is read for
 * their names, where only a migration may still carry one: a migration is
 * history, and the one that created a column has to go on saying so.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const migrations = join("packages", "db", "prisma", "migrations");

const LEGACY =
  /applicationReceivedAt|application_received_at|applicationSixPieces|application_six_pieces/;

// Build output and installed packages are copies of, or dependencies on, the
// source; scanning them would report the same fact twice or somebody else's.
const NOT_SOURCE = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);

// Somebody else's source, vendored byte for byte: Doug's kernel and the timer
// registry it reads (packages/kernel/VENDORED_FROM). Eight rows of that
// registry name `application_received_at`, because his origination spec has a
// column by that name and anchors TRID clocks on it. That is his column, not a
// reader of ours, and a vendored tree cannot be edited to say otherwise. The
// package's own src/index.ts is ours and stays scanned.
const VENDORED = [
  join("packages", "kernel", "src", "kernel"),
  join("packages", "kernel", "spec"),
  join("packages", "partner-book", "src", "vendored"),
  // His whole runtime, vendored as an app of its own (apps/servicing/VENDORED_FROM):
  // the same column, in his migrations and his registry, for the same reason.
  join("apps", "servicing", "src"),
  join("apps", "servicing", "db"),
  join("apps", "servicing", "spec"),
  join("apps", "servicing", "docs"),
  join("apps", "servicing", "fixtures"),
];
const TEXT = /\.(tsx?|jsx?|[cm]js|json|sql|prisma|css|html|md|ya?ml)$/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (NOT_SOURCE.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (TEXT.test(name)) out.push(path);
  }
  return out;
}

/** Every source file in the workspaces, repo-relative. */
function scanned(): string[] {
  return ["apps", "packages"]
    .flatMap((workspace) => files(join(repoRoot, workspace)))
    .map((path) => relative(repoRoot, path))
    .filter((path) => !VENDORED.some((tree) => path.startsWith(tree + sep)))
    .sort();
}

// This file names the columns in its own pattern and its own SQL. It is the
// one place outside a migration that has to, so it is named here rather than
// exempted by a comment convention nobody would notice was being used twice.
const self = relative(repoRoot, fileURLToPath(import.meta.url));

/** The ones that still name the retired columns. */
function offenders(): string[] {
  return scanned().filter(
    (path) => path !== self && LEGACY.test(readFileSync(join(repoRoot, path), "utf8")),
  );
}

describe("the legacy receipt columns are retired", () => {
  it("has no such columns on loan_files", async () => {
    const rows = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'loan_files'
         AND column_name IN ('application_received_at', 'application_six_pieces')
    `;
    expect(rows).toEqual([]);
  });

  it("keeps the signature, which is not the receipt", async () => {
    // `application_signed_at` looks like the same kind of column and is not:
    // it records what the borrower did in step 4, and no trigger holds a
    // second opinion of it. A drop that took it too would be silent here
    // without this line.
    const rows = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'loan_files' AND column_name = 'application_signed_at'
    `;
    expect(rows).toHaveLength(1);
  });

  it("is named nowhere in apps or packages except a migration", () => {
    expect(offenders().filter((path) => !path.startsWith(migrations))).toEqual([]);
  });

  it("is reading the tree it thinks it is, and the migrations still say what happened", () => {
    // A scan that walks nothing, or a pattern that matches nothing, passes for
    // the wrong reason. Both migrations have to keep naming the columns: one
    // created them and one dropped them, and history is the whole point of a
    // migration.
    const all = scanned();
    expect(all).toContain(self);
    expect(all).toContain(join("packages", "db", "prisma", "schema.prisma"));
    expect(all).toContain(join("apps", "api", "src", "services", "repository.ts"));
    expect(all).toContain(join("apps", "web", "src", "lib", "flow.ts"));
    expect(all).toContain(join("packages", "shared", "src", "application-machine.ts"));
    // The vendored tree is skipped and nothing beside it is: the package's own
    // file is read, his registry is not.
    expect(all).toContain(join("packages", "kernel", "src", "index.ts"));
    expect(all).not.toContain(join("packages", "kernel", "spec", "registry", "timers.json"));
    expect(all).not.toContain(join("packages", "kernel", "src", "kernel", "timers", "registry.ts"));
    expect(all).toContain(join("apps", "servicing", "scripts", "run.mjs"));
    expect(all).not.toContain(join("apps", "servicing", "src", "runtime", "main.ts"));

    expect(offenders()).toEqual([
      join(migrations, "20260901150045_initial_schema", "migration.sql"),
      join(migrations, "20260909170000_retire_legacy_receipt", "migration.sql"),
    ]);
  });
});
