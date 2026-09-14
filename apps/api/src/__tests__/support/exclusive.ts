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
 *
 * **Queuing is the fallback, not the goal. To run two suites at once, give them
 * two databases.** `TEST_DATABASE_URL` names one outright, `npm run
 * db:test:setup` creates it and applies every migration — measured at 3.6
 * seconds from nothing — and the two runs then never meet:
 *
 *     TEST_DATABASE_URL=postgresql://…@localhost:5433/hm_mine \
 *       npm run db:test:setup && npm test
 *
 * That works because a Postgres advisory lock is scoped to its DATABASE, not to
 * the cluster. Worth stating because the opposite is the intuitive guess and it
 * would make the whole arrangement pointless: `pg_locks` shows two rows with
 * this same `objid` under different `database` oids, both held, neither
 * blocking the other. So the key below needs no per-database component — the
 * database is already in the identity of the lock.
 */

import pg from "pg";
import { databaseName, testDatabaseUrl } from "../../../../../scripts/test-database-url.mjs";

/**
 * The lock this suite takes, chosen once and written down.
 *
 * Any constant works as long as nothing else in this database picks the same
 * one; advisory locks share a namespace across the whole cluster, so the value
 * is arbitrary but the collision is not. One other thing in this repo takes an
 * advisory lock — `grep pg_advisory` — and it cannot collide with this: the DU
 * writer holds an application's identity space while it looks a row up, in the
 * TWO-integer key space, which Postgres keeps separate from the single-bigint
 * one this uses. A future lock should read this comment before choosing.
 */
const SUITE_LOCK = 4_120_260_911;

let client: pg.Client | undefined;

/**
 * The same connection string pointed at a fresh database, with the password
 * taken out.
 *
 * The suggestion below is worth printing and the password is not: this runs in
 * CI too, where the string comes from a secret and the output is kept. Whoever
 * reads the line knows their own password, so redacting it costs the hint
 * nothing.
 */
function suggestion(url: string): string {
  const suggested = new URL(url);
  if (suggested.password) suggested.password = "PASSWORD";
  suggested.pathname = "/hm_mine";
  return suggested.toString();
}

export async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  client = new pg.Client({ connectionString: url });
  await client.connect();

  const { rows } = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1) AS locked",
    [SUITE_LOCK],
  );

  if (!rows[0]?.locked) {
    // Said out loud, because the alternative is a suite that looks hung. The
    // wait is usually seconds and is always shorter than the failures it
    // replaces — and the way out of it is named here rather than left to be
    // rediscovered, because whoever is reading this line is the person it
    // would help.
    console.log(
      `\nAnother run of this suite holds ${databaseName(url)}. Waiting for it to finish —\n` +
        "they cannot share one, because each truncates every table between tests.\n" +
        "To run both at once, give this one its own:\n" +
        `  TEST_DATABASE_URL=${suggestion(url)} npm run db:test:setup && npm test\n`,
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
