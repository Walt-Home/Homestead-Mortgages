import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// Prisma 7 moved the migration connection URL out of schema.prisma into this
// config. The repo keeps one .env at the monorepo root, and the Prisma CLI runs
// with cwd = packages/db, so load it relative to this file.
const dir = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(dir, "../../.env") });

// Only migrate / db push / studio need the URL. `prisma generate` does not, and
// it runs in CI with no DATABASE_URL — so the datasource is set only when the
// variable is actually present, rather than throwing on its absence.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: path.join(dir, "prisma", "schema.prisma"),
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
});
