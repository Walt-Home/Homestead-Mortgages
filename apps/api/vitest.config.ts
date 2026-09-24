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
      // The more specific key first: Vite matches string aliases by prefix, so
      // a bare "@hm/shared" listed above this one would rewrite the subpath to
      // a path inside index.ts and fail with ENOTDIR.
      "@hm/shared/portfolio": resolve(packages, "shared/src/portfolio.ts"),
      "@hm/shared/decision-figures": resolve(packages, "shared/src/decision-figures.ts"),
      "@hm/shared": resolve(packages, "shared/src/index.ts"),
      "@hm/partner-book": resolve(packages, "partner-book/src/index.ts"),
      "@hm/refi-review": resolve(packages, "refi-review/src/index.ts"),
      // The kernel's subpaths, at his source; vite reads his `.ts` specifiers as written.
      "@hm/kernel/money": resolve(packages, "kernel/src/kernel/money/index.ts"),
      "@hm/kernel/calendar": resolve(packages, "kernel/src/kernel/calendar/index.ts"),
      "@hm/requirements": resolve(packages, "requirements/src/index.ts"),
      "@hm/connectors": resolve(packages, "connectors/src/index.ts"),
      "@hm/du/test-support": resolve(packages, "du/src/__tests__/support/ungated.ts"),
      "@hm/du": resolve(packages, "du/src/index.ts"),
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
    // The fixtures sleep 900 ms a call so a screen is built against a
    // connector that takes time; a test is not a screen.
    env: { DATABASE_URL: testDatabaseUrl(), FIXTURE_LATENCY_MS: "0" },
    // The suite truncates shared tables between tests, so files cannot run
    // concurrently against one database. That covers files within one run;
    // `support/exclusive.ts` is what covers two runs, which this setting says
    // nothing about and which fails far louder.
    fileParallelism: false,
    globalSetup: ["./src/__tests__/support/exclusive.ts"],
    // These tests exercise a real Postgres rather than a mock, and a single
    // case legitimately spends seconds truncating, seeding and walking a
    // borrower through the doors. Vitest's five-second default is a ceiling
    // the honest path reaches, which makes a passing suite a coin flip and,
    // worse, can cut a test off mid-transaction and leave the schema wrong
    // for every run after it. Time out on a hang, not on a slow machine.
    testTimeout: 30_000,
    // The same argument, applied to the place it was first needed. The hooks
    // are what TRUNCATE every table, so they are the slowest thing here and
    // the first to suffer when the machine is busy — and they kept vitest's
    // ten-second default while the tests got thirty. Five files failed that
    // way in one run, every one of them "Hook timed out in 10000ms" and not
    // one of them a failing assertion, which is the worst shape a flake can
    // take: it reads exactly like a hang in the code under test.
    hookTimeout: 30_000,
  },
});
