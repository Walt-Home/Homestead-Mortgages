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

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export { PrismaClient };
export * from "@prisma/client";
