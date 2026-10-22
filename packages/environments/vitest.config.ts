import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const packages = resolve(import.meta.dirname, "..");

export default defineConfig({
  resolve: {
    // The worktree's own packages, not whichever dist node_modules resolves
    // to — the same aliases every other package carries. The kernel's
    // subpaths point at the vendored source, which vite reads as written.
    alias: {
      "@hm/kernel/money": resolve(packages, "kernel/src/kernel/money/index.ts"),
      "@hm/kernel/calendar": resolve(packages, "kernel/src/kernel/calendar/index.ts"),
      "@hm/refi-review": resolve(packages, "refi-review/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    // Every test here is computation over generated tasks, and the sweeps
    // that take two seconds on a laptop took six to seven on CI's runners,
    // past the five-second default: deploys failed on 22 October on tests
    // that had not changed. A test's own longer timeout still wins.
    testTimeout: 60_000,
  },
});
