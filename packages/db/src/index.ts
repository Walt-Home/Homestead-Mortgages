import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// The driver adapter reads the connection string when the client is
// constructed, so a bare `tsx script.ts` that never loaded the root .env would
// construct an unusable client. In Cloud Run the variable is already set from
// Secret Manager and this is a no-op.
if (!process.env.DATABASE_URL) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  loadEnv({ path: path.join(dir, "../../../.env") });
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

/**
 * The explicit `: PrismaClient` annotation is load-bearing, not decoration.
 *
 * Without it TypeScript infers a type that mentions `$Extensions.DefaultArgs`,
 * and it cannot name that symbol in this package's emitted `.d.ts`. With
 * `skipLibCheck` on, the broken declaration does not error — it silently
 * degrades to `any` for every consumer, so `prisma.loanFile.findUnique()`
 * returns `any` and the repository's callbacks become implicit-any. That
 * surfaces as `TS7006` in apps/api on a COLD build only, because a warm
 * `packages/db/dist` from a previous good build masks it.
 *
 * It cost a red container build to find. The annotation makes the emitted
 * declaration `export declare const prisma: PrismaClient;` — nameable, stable,
 * and the same warm or cold.
 */
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export { PrismaClient };
export * from "@prisma/client";
