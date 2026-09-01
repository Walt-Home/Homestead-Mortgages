import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  // The monorepo keeps one .env at the root; the API reads it the same way.
  envDir: resolve(__dirname, "../.."),
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@hm/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8080", changeOrigin: true } },
  },
});
