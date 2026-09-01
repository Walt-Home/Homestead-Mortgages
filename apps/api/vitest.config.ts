import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const packages = resolve(import.meta.dirname, "../../packages");

export default defineConfig({
  resolve: {
    alias: {
      "@hm/shared": resolve(packages, "shared/src/index.ts"),
      "@hm/requirements": resolve(packages, "requirements/src/index.ts"),
      "@hm/connectors": resolve(packages, "connectors/src/index.ts"),
      "@hm/underwriting": resolve(packages, "underwriting/src/index.ts"),
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
