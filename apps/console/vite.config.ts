import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * The ops console is served under `/console` on the servicing hostname, by
 * the API container (apps/api/src/console-host.ts), which also proxies the servicing
 * app's console API as `/console/api/*` and answers our own tape desk at `/console/hm/*`. `base` makes the bundle's
 * asset URLs match that mount, and the dev proxy plays the same part against
 * a local servicing runtime on 8090 (`npm run dev -w @hm/servicing`).
 */
export default defineConfig({
  plugins: [react()],
  base: "/console/",
  envDir: resolve(__dirname, "../.."),
  resolve: {
    alias: { "@": resolve(__dirname, "./src") },
  },
  server: {
    port: 5174,
    proxy: {
      "/console/api": {
        target: process.env.SERVICING_API_URL ?? "http://localhost:8090",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/console\/api/, "/ops/api"),
      },
      // Our own API: the tape desk, gated by the servicing app's session.
      "/console/hm": {
        target: process.env.HM_API_URL ?? "http://localhost:8080",
        changeOrigin: true,
      },
      "/console/documents": {
        target: process.env.SERVICING_API_URL ?? "http://localhost:8090",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/console\/documents/, "/api/documents"),
      },
    },
  },
});
