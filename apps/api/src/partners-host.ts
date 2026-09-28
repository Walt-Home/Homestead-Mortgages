/**
 * The partner portal's hostname, served by this process.
 *
 * `partners.supermortgage.com` reaches the same backend as the borrower app
 * — no Identity-Aware Proxy, because a servicer's team are not our Google
 * accounts — and on that Host, and only on it, the API serves the portal:
 * apps/console built a second time for `/` (`dist-partners`), and of the
 * API only the portal's own door, `/api/servicer`, and health. The borrower
 * app and its routes do not answer on this name, so a cookie minted here
 * is a servicer's and nothing else.
 *
 * Mounted above the body parser and the session: the bundle needs neither,
 * and the door's calls fall through to the ordinary chain where both are.
 * On any other Host this is a no-op.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type Router } from "express";
import { config } from "./config.js";

export function partnersHostRouter(opts: { readonly dist?: string }): Router {
  const router = express.Router();

  // Of the API, only the portal's door and health. `next("router")` leaves
  // this router for the chain below, where the session and the door are.
  router.use("/api", (req, res, next) => {
    if (req.path === "/health" || req.path.startsWith("/servicer")) {
      next("router");
      return;
    }
    res.status(404).json({ error: { message: "No such endpoint.", code: "NOT_FOUND" } });
  });

  if (opts.dist) {
    const dist = opts.dist;
    router.use(
      express.static(dist, {
        index: false,
        setHeaders: (res, path) => {
          res.setHeader(
            "Cache-Control",
            path.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable",
          );
        },
      }),
    );
    router.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(join(dist, "index.html"));
    });
  } else {
    router.get(/^\/(?!api\/).*/, (_req, res) => {
      res.status(503).json({
        error: {
          message: "The partner portal is not built on this deployment.",
          code: "NOT_BUILT",
        },
      });
    });
  }
  return router;
}

/** Mount the partner-host router when there is a partner hostname to answer. */
export function partnersHost(app: Express): "not-configured" | "not-built" | "served" {
  const hosts = new Set(config.partners.publicHosts);
  if (hosts.size === 0) return "not-configured";
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/index.js → ../../console/dist-partners in the image; src/ → the same in the repo.
  const dist = resolve(here, "../../console/dist-partners");
  const built = existsSync(join(dist, "index.html"));
  const router = partnersHostRouter({ dist: built ? dist : undefined });
  app.use((req, res, next) => {
    if (hosts.has(req.hostname)) router(req, res, next);
    else next();
  });
  return built ? "served" : "not-built";
}
