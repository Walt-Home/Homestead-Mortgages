import { defineConfig } from "vitest/config";

export default defineConfig({
  // The generator is a .mjs script, so its tests are .mjs too: importing an
  // untyped module from a .ts test would need a declaration file for a script
  // that is never imported at runtime.
  test: { include: ["src/**/*.test.ts", "src/**/*.test.mjs"] },
});
