/**
 * Where the tests' database lives.
 *
 * One definition, imported by both `scripts/setup-test-db.mjs` and
 * `apps/api/vitest.config.ts`, because the setup step and the test run
 * disagreeing about which database they mean is a failure that looks like a
 * missing table and costs an afternoon.
 *
 * It is deliberately NOT the development database. `resetDatabase()` truncates
 * every table between tests, and a developer who ran `npm test` expecting it
 * to be read-only should not lose the file they were half way through.
 */

/**
 * Derive the test database URL from `DATABASE_URL` by suffixing the database
 * name, unless `TEST_DATABASE_URL` names one outright.
 */
export function testDatabaseUrl(env = process.env) {
  if (env.TEST_DATABASE_URL) return env.TEST_DATABASE_URL;

  const base = env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "Neither TEST_DATABASE_URL nor DATABASE_URL is set. The tests need a real " +
        "Postgres: `docker compose up -d postgres`, then `npm run db:test:setup`.",
    );
  }

  const url = new URL(base);
  // pathname is "/dbname"; an empty one means the URL names no database at all.
  const name = url.pathname.replace(/^\//, "");
  if (!name) throw new Error(`DATABASE_URL names no database: ${base}`);
  url.pathname = `/${name}_test`;
  return url.toString();
}

/** The same URL pointed at the `postgres` maintenance database, for CREATE DATABASE. */
export function maintenanceUrl(testUrl) {
  const url = new URL(testUrl);
  url.pathname = "/postgres";
  return url.toString();
}

/** The database name inside a connection string. */
export function databaseName(url) {
  return new URL(url).pathname.replace(/^\//, "");
}
