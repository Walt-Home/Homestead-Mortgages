import { defineConfig } from "vitest/config";

// `include` is not the default on purpose. `tsc -b` compiles this package's
// tests into dist alongside everything else, and vitest's default pattern
// picks up both the source and the build output — so every test ran twice, and
// the dist copy would keep passing after the source had changed. Same shape as
// packages/requirements.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});
