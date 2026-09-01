/**
 * Serving the built SPA from the API process.
 *
 * One container serves both, which is why there is no CORS problem in
 * production and why the deployed URL is a thing a person can click. The
 * image builds `apps/web/dist` and copies it in; without this the service was
 * API-only and the deployed URL returned 404 to a browser.
 *
 * In development this is a no-op — Vite serves the SPA on 5173 and proxies
 * /api here, so `dist` does not exist and should not be consulted.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";

export function serveSpa(app: Express): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/index.js → ../../web/dist in the image; src/ → the same in the repo.
  const spa = resolve(here, "../../web/dist");
  if (!existsSync(join(spa, "index.html"))) return false;

  // Hashed assets are immutable; index.html must never be cached, or a deploy
  // leaves browsers holding an entrypoint that references deleted bundles.
  app.use(
    express.static(spa, {
      index: false,
      setHeaders: (res, path) => {
        res.setHeader(
          "Cache-Control",
          path.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
        );
      },
    }),
  );

  // History fallback. Anything that is not an API route is a client route —
  // the flow's URLs (/f/:id/credit) exist only in the browser.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(join(spa, "index.html"));
  });

  return true;
}
