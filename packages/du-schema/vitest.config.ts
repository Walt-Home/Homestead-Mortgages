import { defineConfig } from "vitest/config";

export default defineConfig({
  // Compiling a 6.9M XSD takes libxml2 about a tenth of a second and eighteen
  // samples are validated one at a time, so the default five-second timeout is
  // comfortable — but the chain is read from disk on a cold cache the first
  // time, and a laptop swapping is not a failing schema.
  test: { include: ["src/**/*.test.ts"], testTimeout: 30_000 },
});
