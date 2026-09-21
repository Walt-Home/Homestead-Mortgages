/**
 * Run Doug's runtime with our environment vocabulary.
 *
 *   node scripts/run.mjs serve [--watch]     the API, the sweep endpoint and the ops console on SERVICING_PORT
 *   node scripts/run.mjs sweep               one pass of every scheduled job, then exit
 *   node scripts/run.mjs migrate             apply db/migrations through his migrate.sh
 *   node scripts/run.mjs db-setup            create the servicing database if it is absent, then migrate
 *   node scripts/run.mjs seed-demo           the 100-loan transfer batch, the entry demo and the 12-loan partner book
 *
 * His `src/runtime/main.ts` reads DATABASE_URL, PORT and API_TOKEN, which are
 * the names our own API already uses for its own database and port. This
 * script is the one place the two vocabularies meet: it loads the root .env,
 * maps SERVICING_* onto what he reads, and spawns his entrypoint with the
 * flags his Dockerfile uses. Nothing under src/ is edited to know about us.
 *
 *   SERVICING_DATABASE_URL   → DATABASE_URL     required; never our own database, his tables
 *                                               collide with ours by name (loans, parties, …)
 *   SERVICING_PORT           → PORT             default 8090 (our API is 8080)
 *   SERVICING_API_TOKEN      → API_TOKEN        the bearer every /v1 route wants. Unset outside
 *                                               production it is `dev-token`, the value his own
 *                                               README uses locally — his ALLOW_INSECURE_NO_TOKEN
 *                                               starts the server but still refuses /v1, so a
 *                                               known token is the useful default. Production
 *                                               requires one and his config refuses to start
 *                                               without it.
 *   SERVICING_INTEGRATIONS   → INTEGRATIONS     fake (default) or real
 *   SERVICING_ENVIRONMENT    → ENVIRONMENT      nonprod (default) or production
 *   SERVICING_LOG_FORMAT     → LOG_FORMAT       text (default here) or json
 *
 * Anything else his config reads (ANTHROPIC_API_KEY, GOOGLE_OAUTH_*, TAVUS_*,
 * RATE_FEED, FAKE_REVIEWERS, STAFF_BOOTSTRAP_ADMIN_EMAIL) passes through
 * under its own name.
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import pg from "pg";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: resolve(app, "../../.env") });

const [mode = "serve", ...rest] = process.argv.slice(2);
const MODES = ["serve", "sweep", "migrate", "db-setup", "seed-demo", "staff-bootstrap"];
if (!MODES.includes(mode)) {
  console.error(`usage: run.mjs <${MODES.join(" | ")}> [--watch]`);
  process.exit(2);
}

const databaseUrl = process.env.SERVICING_DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "SERVICING_DATABASE_URL is not set. It must name a database of its own — his tables collide with ours by name.\n" +
      "  SERVICING_DATABASE_URL=postgresql://homestead_mortgages:homestead_mortgages@localhost:5433/homestead_servicing",
  );
  process.exit(2);
}

const production = (process.env.SERVICING_ENVIRONMENT ?? "nonprod") === "production";
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  PORT: process.env.SERVICING_PORT ?? "8090",
  INTEGRATIONS: process.env.SERVICING_INTEGRATIONS ?? "fake",
  ENVIRONMENT: process.env.SERVICING_ENVIRONMENT ?? "nonprod",
  LOG_FORMAT: process.env.SERVICING_LOG_FORMAT ?? "text",
  ...(process.env.SERVICING_API_TOKEN
    ? { API_TOKEN: process.env.SERVICING_API_TOKEN }
    : production
      ? {}
      : { API_TOKEN: "dev-token" }),
};

/** `CREATE DATABASE` if the URL's database is absent. Postgres has no IF NOT EXISTS for it. */
async function ensureDatabase(url) {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
      console.error(`created database ${name}`);
    } else {
      console.error(`database ${name} exists`);
    }
  } finally {
    await client.end();
  }
}

function run(hisMode, extraNodeFlags = []) {
  const child = spawn(
    process.execPath,
    [
      ...extraNodeFlags,
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      "src/runtime/main.ts",
      hisMode,
      ...rest.filter((a) => a !== "--watch"),
    ],
    { cwd: app, env, stdio: "inherit" },
  );
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

if (mode === "db-setup") {
  await ensureDatabase(databaseUrl);
  run("migrate");
} else {
  run(mode, mode === "serve" && rest.includes("--watch") ? ["--watch", "--watch-path=src"] : []);
}
