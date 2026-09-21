/**
 * Run his tests as his: `node --test` with type stripping, on node:test and
 * node:assert, one Postgres database per file cloned from a migrated template
 * (src/infra/db/test-db.ts). Two things are ours:
 *
 * - **The database.** His harness reads TEST_DATABASE_URL and names every
 *   clone after it. This sets it from SERVICING_TEST_DATABASE_URL, or derives
 *   it from our own test database URL with the name swapped to
 *   `supermortgage_test`, so his clones land beside ours on the same server
 *   and never on ours. The probe database his 35.11 wants is derived the same
 *   way. The user needs CREATEDB, which the compose container's does.
 * - **No browser.** Seven of his suites build his Next.js apps and drive them
 *   under Chromium. Those apps are not here — ours is apps/web — so the files
 *   that take `acquireBrowserLock` are left out. Everything else runs,
 *   database-backed suites included; a suite that cannot reach Postgres skips
 *   unless REQUIRE_DB=1, exactly as his does.
 *
 * Anything after `--` goes to node --test (`--test-shard=1/4`,
 * `--test-name-pattern`, …).
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { testDatabaseUrl } from "../../../scripts/test-database-url.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(app, "../../.env") });

/**
 * `supermortgage_test`, not `hm_servicing_test`: his harness derives every
 * clone's name from this one and its own self-test asserts the base is
 * `supermortgage`. It is his database on our server, and the name says so.
 */
function servicingTestDatabaseUrl() {
  if (process.env.SERVICING_TEST_DATABASE_URL) return process.env.SERVICING_TEST_DATABASE_URL;
  const ours = new URL(testDatabaseUrl());
  ours.pathname = "/supermortgage_test";
  return ours.toString();
}

/**
 * His 35.11 drops, creates and migrates a probe database by this name to
 * post every tool at over HTTP; without one those three tests fail. Beside
 * the test database, on the same server, unless a caller names another.
 */
function probeDatabaseUrl() {
  if (process.env.PROBE_DATABASE_URL) return process.env.PROBE_DATABASE_URL;
  const u = new URL(servicingTestDatabaseUrl());
  u.pathname = "/supermortgage_probe";
  return u.toString();
}

function testFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...testFiles(path));
    else if (name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

const all = testFiles(join(app, "src"));
const browser = all.filter((f) => readFileSync(f, "utf8").includes("acquireBrowserLock"));
const files = all.filter((f) => !browser.includes(f)).map((f) => relative(app, f));

const argv = process.argv.slice(2).filter((a) => a !== "--");
// A test file named on the command line runs alone: `npm run test:servicing -- src/runtime/demo-clock.test.ts`.
const named = argv.filter((a) => a.endsWith(".test.ts"));
const passthrough = argv.filter((a) => !a.endsWith(".test.ts"));
const selected = named.length ? named : files;
console.error(
  `servicing tests: ${selected.length} of ${files.length} files (${browser.length} browser suites left out) on ${servicingTestDatabaseUrl().replace(/:[^:@/]+@/, ":***@")}`,
);

const child = spawn(
  process.execPath,
  [
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    "--test",
    ...passthrough,
    ...selected,
  ],
  {
    cwd: app,
    env: {
      ...process.env,
      TEST_DATABASE_URL: servicingTestDatabaseUrl(),
      PROBE_DATABASE_URL: probeDatabaseUrl(),
      // His tests spawn node on his .ts tools (23.6 runs tools/build-du.mjs,
      // which imports a .ts file). On Node 22.18 type stripping is on by
      // default; below it the flag has to travel with the environment.
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
      ]
        .filter(Boolean)
        .join(" "),
    },
    stdio: "inherit",
  },
);
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
