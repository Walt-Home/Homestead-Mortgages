import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const packages = resolve(import.meta.dirname, "../../packages");

export default defineConfig({
  resolve: {
    alias: {
      "@sm/shared": resolve(packages, "shared/src/index.ts"),
      "@sm/requirements": resolve(packages, "requirements/src/index.ts"),
      "@sm/connectors": resolve(packages, "connectors/src/index.ts"),
      "@sm/underwriting": resolve(packages, "underwriting/src/index.ts"),
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
