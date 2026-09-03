/**
 * Create the test database and bring it up to the current migrations.
 *
 * Run once after `docker compose up -d postgres`, and again after any new
 * migration. CI runs it on every build, which is the point: the guarantees
 * this project relies on — cascade behaviour, uniqueness, defaults — live in
 * the database, and a test suite that mocks the database cannot see any of
 * them. See docs/decisions.md, "Tests run against a real Postgres".
 */

import { execFileSync } from "node:child_process";
import { config as loadEnv } from "dotenv";
import pg from "pg";
import { databaseName, maintenanceUrl, testDatabaseUrl } from "./test-database-url.mjs";

loadEnv();

const url = testDatabaseUrl();
const name = databaseName(url);

const admin = new pg.Client({ connectionString: maintenanceUrl(url) });
await admin.connect();
try {
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (rowCount === 0) {
    // The name comes from our own connection string, not from user input, and
    // an identifier cannot be parameterised — so quote it rather than interpolate.
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    console.log(`created database ${name}`);
  } else {
    console.log(`database ${name} already exists`);
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
