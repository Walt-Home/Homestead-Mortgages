/**
 * The tests talk to a real Postgres.
 *
 * They used to mock `@hm/db`, which meant every guarantee that lives in the
 * database was invisible to CI: the cascades `deletion.test.ts` reads out of
 * the schema text, the uniqueness constraints, the defaults, and the fact that
 * `assertFileAccess` is reading the columns it thinks it is. A mock proves the
 * code calls Prisma the way the test author imagined. It proves nothing about
 * the database, which is where this product keeps its promises.
 *
 * The database is `<dev database>_test`, never the development one — see
 * `scripts/test-database-url.mjs`. Create it with `npm run db:test:setup`.
 */

import { prisma } from "@hm/db";

/**
 * Tables the reset must not touch.
 *
 * Prisma owns the first. The second is a catalog rather than test state: the
 * migration that created `loan_products` seeded the one product this system
 * quotes, every loan file points at it, and truncating it turns every file a
 * test creates into a foreign key violation naming a constraint the test has
 * nothing to do with.
 */
const PRESERVED = new Set(["_prisma_migrations", "loan_products"]);

let tables: string[] | null = null;

async function tableNames(): Promise<string[]> {
  if (tables) return tables;
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  tables = rows.map((r) => r.tablename).filter((t) => !PRESERVED.has(t));
  return tables;
}

/**
 * Fail with something a person can act on.
 *
 * The default Prisma connection error names a host and a port and leaves the
 * reader to work out that they were supposed to run a container and a setup
 * script. Two commands is a cheaper thing to print than an afternoon.
 */
export async function assertDatabaseReachable(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (cause) {
    throw new Error(
      `Cannot reach the test database at ${redact(process.env.DATABASE_URL)}.\n\n` +
        "  docker compose up -d postgres\n" +
        "  npm run db:test:setup\n\n" +
        "These tests deliberately do not mock the database.",
      { cause },
    );
  }

  if ((await tableNames()).length === 0) {
    throw new Error(
      `The test database ${redact(process.env.DATABASE_URL)} has no tables. ` +
        "Run `npm run db:test:setup` — it also picks up any new migration.",
    );
  }
}

/** Empty every table. Called before each test so order cannot matter. */
export async function resetDatabase(): Promise<void> {
  const names = await tableNames();
  if (names.length === 0) return;
  const list = names.map((t) => `"public"."${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

function redact(url: string | undefined): string {
  if (!url) return "(DATABASE_URL unset)";
  try {
    const u = new URL(url);
    u.password = "";
    return u.toString();
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}
