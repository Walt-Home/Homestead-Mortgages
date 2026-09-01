import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@hm/shared": resolve(import.meta.dirname, "../shared/src/index.ts") },
  },
  test: { include: ["src/**/*.test.ts"] },
});
