import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    // The worktree's own shared package, not whichever dist node_modules
    // resolves to — the same reason underwriting aliases it.
    alias: { "@hm/shared": resolve(import.meta.dirname, "../shared/src/index.ts") },
  },
  // The generator is a .mjs script, so its tests are .mjs too: importing an
  // untyped module from a .ts test would need a declaration file for a script
  // that is never imported at runtime.
  test: { include: ["src/**/*.test.ts", "src/**/*.test.mjs"] },
});
