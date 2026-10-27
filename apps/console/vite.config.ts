import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * The ops console — and the partner portal inside it, at `/console/portal`
 * — is served under `/console` on the servicing hostname, by the API
 * container (apps/api/src/console-host.ts), which also proxies the
 * servicing app's console API as `/console/api/*`, answers our own tape
 * desk at `/console/hm/*` and lets the portal's door, `/api/servicer`,
 * through to itself. `base` makes the bundle's asset URLs match that mount,
 * and the dev proxy plays the same part against a local servicing runtime
 * on 8090 (`npm run dev -w @hm/servicing`) and our API on 8080.
 *
 * `__BUILD_COMMIT__` is the commit the bundle was built from, for the account
 * footer (src/lib/build.ts). The API image's build passes BUILD_COMMIT
 * (Dockerfile, deploy.yml), so the console and the API beside it in that
 * image name one commit. Anything but a full commit id — a developer's
 * build, a test — is null, and the footer shows nothing.
 */
const buildCommit = process.env.BUILD_COMMIT?.trim() ?? "";

export default defineConfig({
  plugins: [react()],
  base: "/console/",
  define: {
    __BUILD_COMMIT__: JSON.stringify(/^[0-9a-f]{40}$/.test(buildCommit) ? buildCommit : null),
  },
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
      // Our own API: the partner portal's door, with its own session.
      "/api/servicer": {
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
