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
/**
 * The same app builds twice. `--mode partners` is the partner portal: a
 * servicer's team and their book, served at `/` on the partner hostname by
 * the same API container (apps/api/src/partners-host.ts), from
 * `dist-partners`. It calls our own door, `/api/servicer`, and nothing of
 * the servicing app. `main.tsx` picks the surface off the mode.
 */
export default defineConfig(({ mode }) => {
  const partners = mode === "partners";
  return {
    plugins: [react()],
    base: partners ? "/" : "/console/",
    build: { outDir: partners ? "dist-partners" : "dist" },
    envDir: resolve(__dirname, "../.."),
    resolve: {
      alias: { "@": resolve(__dirname, "./src") },
    },
    server: partners
      ? {
          port: 5175,
          proxy: {
            "/api": {
              target: process.env.HM_API_URL ?? "http://localhost:8080",
              changeOrigin: true,
            },
          },
        }
      : {
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
  };
});
