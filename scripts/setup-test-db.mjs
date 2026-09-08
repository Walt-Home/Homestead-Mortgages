/**
 * Create the test database and bring it up to the current migrations.
 *
 * Run once after `docker compose up -d postgres`, and again after any new
 * migration. CI runs it on every build, which is the point: the guarantees
 * this project relies on — cascade behaviour, uniqueness, defaults — live in
 * the database, and a test suite that mocks the database cannot see any of
 * them. See docs/decisions.md, "Tests run against a real Postgres".
 *
 * `prisma migrate deploy` applies what is PENDING and stops there: a
 * migration it has already recorded is never looked at again, even when the
 * file on disk has since changed. That is the right behaviour for production,
 * where an applied migration is history, and the wrong one for a test
 * database, where an applied migration is whatever the slice under review
 * looked like the last time someone ran this. Editing an unpushed migration
 * is the normal case while it is being reviewed, and the failure is silent:
 * "No pending migrations to apply", a green suite, and a schema that is not
 * the one in the diff. So before deploying, every recorded migration is
 * checked against the file it came from, and any drift rebuilds the database
 * from nothing. A test database holds nothing worth keeping.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import pg from "pg";
import { databaseName, maintenanceUrl, testDatabaseUrl } from "./test-database-url.mjs";

loadEnv();

const url = testDatabaseUrl();
const name = databaseName(url);
const migrationsDir = new URL("../packages/db/prisma/migrations/", import.meta.url);

// The name comes from our own connection string, not from user input, and an
// identifier cannot be parameterised — so quote it rather than interpolate.
const quoted = `"${name.replace(/"/g, '""')}"`;

/**
 * Prisma records a migration as the SHA-256 of its `migration.sql`, hex
 * encoded, and compares nothing after that. Recomputing it here is what lets
 * this script see the edit that `migrate deploy` will not.
 */
function checksumOnDisk(migrationName) {
  const file = new URL(`${migrationName}/migration.sql`, migrationsDir);
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Why the recorded history cannot be trusted, or null when it can. One reason
 * is enough; the fix is the same for all of them.
 */
async function driftReason() {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const { rows: table } = await db.query("SELECT to_regclass('_prisma_migrations') AS name");
    // No history table means nothing has been applied; deploy will start from
    // the beginning on its own.
    if (table[0].name === null) return null;

    const { rows } = await db.query(
      "SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at",
    );
    for (const row of rows) {
      if (row.rolled_back_at !== null || row.finished_at === null) {
        return `migration ${row.migration_name} is recorded as failed or rolled back`;
      }
      const onDisk = checksumOnDisk(row.migration_name);
      if (onDisk === null) {
        return `migration ${row.migration_name} was applied but no longer exists on disk`;
      }
      if (onDisk !== row.checksum) {
        return `migration ${row.migration_name} changed after it was applied (recorded ${row.checksum.slice(0, 8)}, on disk ${onDisk.slice(0, 8)})`;
      }
    }
    return null;
  } finally {
    await db.end();
  }
}

const admin = new pg.Client({ connectionString: maintenanceUrl(url) });
await admin.connect();
try {
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (rowCount === 0) {
    await admin.query(`CREATE DATABASE ${quoted}`);
    console.log(`created database ${name}`);
  } else {
    const reason = await driftReason();
    if (reason === null) {
      console.log(`database ${name} already exists`);
    } else {
      // FORCE closes a suite that is still attached; a test database is never
      // worth waiting for, and it is the only thing that could be connected.
      await admin.query(`DROP DATABASE ${quoted} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${quoted}`);
      console.log(`rebuilt database ${name}: ${reason}`);
    }
  }
} finally {
  await admin.end();
}

// Prisma 7 reads the migration URL from `prisma.config.ts`, which it resolves
// from the working directory — so this runs in packages/db, exactly as
// `npm run db:migrate` does. That config calls dotenv, which does not override
// a variable that is already set, so DATABASE_URL here wins over the root .env.
execFileSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: new URL("../packages/db/", import.meta.url),
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: url },
});
