import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { testDatabaseUrl } from "../../scripts/test-database-url.mjs";

const packages = resolve(import.meta.dirname, "../../packages");

// `@hm/db` builds its Prisma client at import time from DATABASE_URL, so the
// test database has to be named before any test file loads — hence `env` here
// rather than a setup file. The root .env is loaded first because that is
// where a developer's DATABASE_URL lives.
loadEnv({ path: resolve(import.meta.dirname, "../../.env") });

export default defineConfig({
  resolve: {
    alias: {
      "@hm/shared": resolve(packages, "shared/src/index.ts"),
      "@hm/requirements": resolve(packages, "requirements/src/index.ts"),
      "@hm/connectors": resolve(packages, "connectors/src/index.ts"),
      // The more specific key first: Vite matches string aliases by prefix.
      "@hm/underwriting/test-support": resolve(
        packages,
        "underwriting/src/__tests__/support/in-memory-file.ts",
      ),
      "@hm/underwriting": resolve(packages, "underwriting/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/__tests__/support/setup.ts"],
    env: { DATABASE_URL: testDatabaseUrl() },
    // The suite truncates shared tables between tests, so files cannot run
    // concurrently against one database.
    fileParallelism: false,
  },
});
