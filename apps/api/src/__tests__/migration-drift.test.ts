/**
 * The migrations and the schema describe the same database, or the next
 * migration is not the one somebody wrote.
 *
 * `prisma migrate dev` diffs the models against whatever the development
 * database actually holds and writes the difference. So anything the migration
 * files say that the models do not — a column default, an index name — is not
 * an inconsistency that sits there being harmless. It is a pending ALTER, and
 * the next person to add an unrelated table gets it folded silently into their
 * migration, on tables they never touched, under a name that says otherwise.
 *
 * This is the third kind of generated-artifact staleness the repo guards:
 * `requirements:verify` and `brand:verify` are the other two, and both run
 * without a database. This one cannot, which is why it lives with the suite
 * that already talks to a real Postgres and mocks nothing.
 */

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("the schema and the migrations agree", () => {
  it("has nothing left for the next migration to discover", () => {
    // Against the DATABASE the migrations built rather than against the
    // migration files, because that is what `prisma migrate dev` compares and
    // therefore what decides the contents of the next migration. The test
    // database is the one the suite runs on, brought up to date by
    // `npm run db:test:setup`.
    const diff = spawnSync(
      join(repoRoot, "node_modules", ".bin", "prisma"),
      [
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        join("prisma", "schema.prisma"),
        "--script",
        "--exit-code",
      ],
      // The inherited DATABASE_URL is the test database's: vitest.config.ts
      // sets it before any test file loads, and `prisma.config.ts` calls
      // dotenv, which does not override a variable that is already set.
      { cwd: join(repoRoot, "packages", "db"), encoding: "utf8" },
    );

    // Prisma's own convention: empty is 0, a real difference is 2, and
    // anything else is the CLI failing rather than the schema disagreeing.
    expect(diff.stderr, "prisma migrate diff could not run").not.toMatch(/^Error/m);
    expect(diff.status, `the schema and the migrations differ:\n${diff.stdout}`).toBe(0);
  });
});
