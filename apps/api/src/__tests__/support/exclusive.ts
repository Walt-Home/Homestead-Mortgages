/**
 * One test run at a time against the shared database.
 *
 * `setup.ts` truncates every table before each test so that order cannot
 * matter. That is right within a run and catastrophic across two: a second
 * `npm test` truncates the tables the first one is midway through using, and
 * both suites fail in ways that read like real bugs. Measured rather than
 * feared — two concurrent runs of this suite produced 235 and 226 failures out
 * of 511, and three single-test failures earlier the same day turned out to be
 * the mild version, a lone TRUNCATE landing inside one test's window while two
 * runs briefly overlapped at their edges.
 *
 * `fileParallelism: false` already stops files inside ONE run from colliding.
 * Nothing stopped two runs, and two runs is ordinary: a developer with a watch
 * process and a terminal, an agent running the gate while somebody else does,
 * two CI jobs on one database.
 *
 * So a run takes a Postgres advisory lock and holds it until it exits. The
 * second run WAITS rather than failing, because queuing is what somebody who
 * typed `npm test` twice actually wants, and it says so rather than appearing
 * to hang. The lock is session-scoped, so a run that crashes or is killed
 * releases it when its connection closes — there is nothing to clean up and no
 * stale-lock state to reason about.
 */

import pg from "pg";
import { testDatabaseUrl } from "../../../../../scripts/test-database-url.mjs";

/**
 * The lock this suite takes, chosen once and written down.
 *
 * Any constant works as long as nothing else in this database picks the same
 * one; advisory locks share a namespace across the whole cluster, so the value
 * is arbitrary but the collision is not. Nothing else in this repo takes an
 * advisory lock — `grep pg_advisory` — and a future one should read this
 * comment before choosing.
 */
const SUITE_LOCK = 4_120_260_911;

let client: pg.Client | undefined;

export async function setup(): Promise<void> {
  client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();

  const { rows } = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS locked",
    [SUITE_LOCK],
  );

  if (!rows[0]?.locked) {
    // Said out loud, because the alternative is a suite that looks hung. The
    // wait is usually seconds and is always shorter than the failures it
    // replaces.
    console.log(
      "\nAnother run of this suite holds the test database. Waiting for it to finish —\n" +
        "they cannot share one, because each truncates every table between tests.\n",
    );
    await client.query("SELECT pg_advisory_lock($1)", [SUITE_LOCK]);
  }
}

export async function teardown(): Promise<void> {
  // Unlocking explicitly is tidiness rather than necessity — ending the
  // connection would drop it anyway. It matters only for a runner that reuses
  // the process, which is why it is here and why it does not throw.
  await client?.query("SELECT pg_advisory_unlock($1)", [SUITE_LOCK]).catch(() => undefined);
  await client?.end().catch(() => undefined);
  client = undefined;
}
