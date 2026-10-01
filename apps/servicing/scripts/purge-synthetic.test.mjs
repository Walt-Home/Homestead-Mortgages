/**
 * purge-synthetic against the state staging is in: the seed, ten days of sweeps
 * over it, a person's uploads on top (one under the seed's own parties), and
 * the sweeps again. What it must do is remove every seed loan and everything
 * raised over them; what it must never do is change a row that belongs to an
 * uploaded loan. The second is checked byte for byte.
 *
 * A database of its own beside the servicing test database (it is created,
 * migrated and dropped here). Skips when Postgres is unreachable, unless
 * REQUIRE_DB=1, as his suites do.
 *
 *   node --test scripts/purge-synthetic.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import pg from "pg";
import { testDatabaseUrl } from "../../../scripts/test-database-url.mjs";
import { purgeSynthetic } from "./purge-synthetic.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(app, "../../.env") });

const url = new URL(process.env.SERVICING_TEST_DATABASE_URL ?? testDatabaseUrl());
url.pathname = "/purge_synthetic_test";
const admin = new URL(url);
admin.pathname = "/postgres";

// coalesce: the books' loans have no transferor number, and NOT (NULL OR …) would drop them from both sides.
const REAL = `(coalesce(l.transferor_loan_number, '') LIKE 'RX-%' OR coalesce(l.servicer_loan_number, '') LIKE 'RANL-%' OR coalesce(l.servicer_loan_number, '') LIKE 'RBNL-%')`;

function step(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd: app,
    env: {
      ...process.env,
      SERVICING_DATABASE_URL: url.toString(),
      DATABASE_URL: url.toString(),
      ENVIRONMENT: "nonprod",
      INTEGRATIONS: "fake",
      LOG_FORMAT: "text",
      API_TOKEN: "dev-token",
      ...extraEnv,
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(`${args.join(" ")} exited ${r.status}\n${(r.stderr || r.stdout).slice(-4000)}`);
  return r.stdout + r.stderr;
}
const strip = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];

let client;
let skip = false;

/** Every loan-scoped table's rows that belong to an uploaded loan: a count and a hash of their contents. */
async function realRows() {
  const tables = (
    await client.query(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND c.column_name = 'loan_id' AND t.table_type = 'BASE TABLE' ORDER BY 1`)
  ).rows.map((r) => r.table_name);
  const out = {};
  for (const t of tables) {
    const r =
      await client.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS h
      FROM (SELECT md5(to_jsonb(x)::text) AS h FROM "${t}" x WHERE x.loan_id::text IN (SELECT l.id::text FROM loans l WHERE ${REAL})) s`);
    if (r.rows[0].n > 0) out[t] = `${r.rows[0].n} ${r.rows[0].h}`;
  }
  return out;
}

async function allCounts() {
  const r =
    await client.query(`SELECT c.relname AS t, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text AS n
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' ORDER BY 1`);
  return Object.fromEntries(r.rows.map((x) => [x.t, x.n]));
}

before(async () => {
  const a = new pg.Client({ connectionString: admin.toString() });
  try {
    await a.connect();
  } catch (e) {
    if (process.env.REQUIRE_DB === "1") throw e;
    skip = true;
    return;
  }
  await a.query(`DROP DATABASE IF EXISTS purge_synthetic_test WITH (FORCE)`);
  await a.query(`CREATE DATABASE purge_synthetic_test`);
  await a.end();
  step(["scripts/run.mjs", "migrate"]);
  step(["scripts/run.mjs", "seed-demo"]);
  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  // Ten days on, as staging's demo clock has been moved: the seed's clocks breach and raise escalations.
  const ahead = async (days) => {
    const off = days * 86_400_000;
    await client.query(
      `INSERT INTO demo_clock (advance_id, step, steps, kind, offset_ms, demo_now, real_now, actor)
      VALUES (gen_random_uuid(), 1, 1, 'target', $1::bigint, now() + make_interval(secs => $1::bigint / 1000.0), now(), 'test:purge-synthetic')`,
      [off],
    );
    step(["scripts/run.mjs", "sweep"]);
  };
  await ahead(10);
  step([...strip, "scripts/purge-synthetic.fixture.mjs"]);
  await ahead(14);
});

after(async () => {
  await client?.end();
});

test("the scenario is staging's: seed loans with escalations, and uploaded loans with their own", async (t) => {
  if (skip) return t.skip("no Postgres");
  const r = await client.query(`SELECT
      (SELECT count(*)::int FROM loans l WHERE ${REAL}) AS real,
      (SELECT count(*)::int FROM loans l WHERE NOT ${REAL}) AS seed,
      (SELECT count(*)::int FROM escalations e JOIN loans l ON l.id = e.loan_id WHERE NOT ${REAL}) AS seed_escalations,
      (SELECT count(*)::int FROM timers x JOIN loans l ON l.id = x.loan_id WHERE ${REAL}) AS real_timers`);
  const s = r.rows[0];
  assert.equal(s.real, 124, "100 boarded or staged by the batch, 12 and 12 by the books");
  assert.equal(s.seed, 112);
  assert.ok(s.seed_escalations > 0, "the sweep raised escalations over the seed");
  assert.ok(s.real_timers > 0, "the uploaded loans carry clocks of their own");
});

test("the plan changes nothing", async (t) => {
  if (skip) return t.skip("no Postgres");
  const before = await allCounts();
  const plan = await purgeSynthetic(client, { apply: false, log: () => undefined });
  assert.equal(plan.applied, false);
  assert.ok(plan.total > 0);
  assert.deepEqual(await allCounts(), before);
});

test("apply removes every seed loan and leaves every uploaded loan's rows exactly as they were", async (t) => {
  if (skip) return t.skip("no Postgres");
  const real = await realRows();
  const r = await purgeSynthetic(client, { apply: true, log: () => undefined });
  assert.equal(r.applied, true);
  assert.deepEqual(await realRows(), real);

  const left = (
    await client.query(`SELECT
      (SELECT count(*)::int FROM loans l WHERE NOT ${REAL}) AS seed_loans,
      (SELECT count(*)::int FROM transfer_batches WHERE synthetic) AS seed_batches,
      (SELECT count(*)::int FROM partner_book_imports WHERE actor_id LIKE '%seed-demo%') AS seed_imports,
      (SELECT count(*)::int FROM escalations e WHERE e.loan_id IS NOT NULL AND e.loan_id NOT IN (SELECT id FROM loans)) AS orphan_escalations,
      (SELECT count(*)::int FROM entity_records WHERE updated_by LIKE '%seed-demo%') AS seed_config,
      (SELECT count(*)::int FROM partner_users) AS partner_users`)
  ).rows[0];
  assert.deepEqual(left, {
    seed_loans: 0,
    seed_batches: 0,
    seed_imports: 0,
    orphan_escalations: 0,
    seed_config: 0,
    partner_users: 0,
  });

  // The synthetic parties an upload stands on stay, and are the ones reported.
  const kept = (
    await client.query(`SELECT id::text FROM parties WHERE synthetic ORDER BY 1`)
  ).rows.map((x) => x.id);
  assert.deepEqual(r.kept.map((p) => p.id).sort(), kept);
  const names = r.kept.map((p) => p.legal_name);
  for (const n of ["Supermortgage", "Northline Mortgage Servicing LLC", "Partner Bank (FAKE demo)"])
    assert.ok(names.includes(n), `${n} is kept`);
});

test("a second run finds nothing, and the runtime sweeps the purged database", async (t) => {
  if (skip) return t.skip("no Postgres");
  const again = await purgeSynthetic(client, { apply: true, log: () => undefined });
  assert.equal(again.total, 0);
  const out = step(["scripts/run.mjs", "sweep"]);
  assert.match(out, /"outcome":"completed"|outcome.*completed/);
});

test("refuses production", async (t) => {
  if (skip) return t.skip("no Postgres");
  const was = process.env.ENVIRONMENT;
  process.env.ENVIRONMENT = "production";
  try {
    await assert.rejects(
      purgeSynthetic(client, { apply: false, log: () => undefined }),
      /refusing to run with ENVIRONMENT=production/,
    );
  } finally {
    if (was === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = was;
  }
});
