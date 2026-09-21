import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const packages = resolve(import.meta.dirname, "..");

export default defineConfig({
  resolve: {
    // The worktree's own packages, not whichever dist node_modules resolves
    // to — the same reason every other package aliases `@hm/shared`. The
    // kernel's subpaths point at his source, which vite reads as written.
    alias: {
      "@hm/kernel/money": resolve(packages, "kernel/src/kernel/money/index.ts"),
      "@hm/kernel/calendar": resolve(packages, "kernel/src/kernel/calendar/index.ts"),
      "@hm/shared/portfolio": resolve(packages, "shared/src/portfolio.ts"),
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
