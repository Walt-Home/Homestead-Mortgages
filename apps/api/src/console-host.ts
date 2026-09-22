/**
 * The servicing hostname, served by this process.
 *
 * `servicing.supermortgage.com` is one backend behind Identity-Aware Proxy,
 * and that backend is this container. On that Host — and only on it — the
 * API is not the borrower app: it serves the ops console built from
 * apps/console under `/console`, and it forwards the console's calls to
 * Doug's runtime, whose door is `SERVICING_API_URL`, the same URL the
 * `servicing` connector reads. `/console/api/*` is his `/ops/api/*` and
 * `/console/documents/*` is his `/api/documents/*`; his own console at
 * `/ops` is forwarded too, so the original stays reachable on the branded
 * name for comparison. Everything else on that Host is a 404, so nothing of
 * the borrower app is reachable through the servicing name.
 *
 * Why a proxy rather than a second backend on the load balancer: IAP keys
 * its session cookie per backend, and a console served by one backend
 * calling an API on another would sign in twice and fail the second time
 * silently, from a fetch. One backend, one cookie, one sign-in. His session
 * cookie (`sm_staff`, Secure, SameSite=Strict, Path=/) is set by his
 * response and passed through unchanged, so it lands on the branded host
 * and rides every later call.
 *
 * Mounted first, above the body parser and the session, so a request on the
 * servicing Host is forwarded whole — his server parses its own bodies — and
 * never mints a cookie of ours. On any other Host this is a no-op.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import express, { type Express, type Request, type Response, type Router } from "express";
import { config } from "./config.js";

export interface ConsoleHostOptions {
  /** The Host this router answers. */
  readonly host: string;
  /** His runtime's origin, e.g. https://…run.app — no trailing slash. */
  readonly upstream: string;
  /** Where the console bundle is; unset when it was not built. */
  readonly dist?: string;
  /** Test seam: the fetch to forward with. */
  readonly fetchImpl?: typeof fetch;
}

/** The request headers that cross to his server. Nothing else does. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "cookie",
  "if-none-match",
  "range",
  "x-actor-id",
  "x-actor-role",
  // The role the console acts as, on every call; without it his API runs
  // each act as the least role the session holds and refuses the rest.
  "x-staff-role",
] as const;

/** The response headers that cross back. `set-cookie` is handled apart. */
const FORWARDED_RESPONSE_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-type",
  "etag",
  "location",
  "retry-after",
  // The role his API actually ran under, which the console shows when it
  // differs from the one asked for.
  "x-acted-as",
] as const;

/** The paths of his that a browser on the branded host may reach. */
const HIS_BROWSER_PATHS = ["/ops", "/api", "/login", "/verify"] as const;

export function consoleHostRouter(opts: ConsoleHostOptions): Router {
  const router = express.Router();
  const upstream = opts.upstream.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;

  const forward =
    (rewrite: (path: string) => string) =>
    async (req: Request, res: Response): Promise<void> => {
      const headers = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      headers.set("x-forwarded-for", req.ip ?? "");
      headers.set("x-forwarded-proto", req.protocol);
      headers.set("x-forwarded-host", opts.host);
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      let answer: globalThis.Response;
      try {
        answer = await doFetch(upstream + rewrite(req.url), {
          method: req.method,
          headers,
          body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
          redirect: "manual",
          // A streamed request body needs this; the DOM lib does not know it.
          ...({ duplex: "half" } as object),
        });
      } catch (err) {
        res.status(502).json({
          error: { message: "The servicing platform could not be reached.", code: "UPSTREAM" },
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      res.status(answer.status);
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = answer.headers.get(name);
        if (value !== null) res.setHeader(name, value);
      }
      for (const cookie of answer.headers.getSetCookie()) res.append("Set-Cookie", cookie);
      if (!answer.body || req.method === "HEAD" || answer.status === 204 || answer.status === 304) {
        res.end();
        return;
      }
      await pipeline(Readable.fromWeb(answer.body as never), res);
    };

  // The front door of the branded host is the console. Exactly `/console`,
  // with no slash: Express's loose matching would send `/console/` here
  // too, ahead of the bundle, and redirect it to itself forever.
  router.get("/", (_req, res) => res.redirect(302, "/console/"));
  router.get(/^\/console$/, (_req, res) => res.redirect(302, "/console/"));

  // The console's calls, to his console API and his document reads.
  router.use(
    "/console/api",
    forward((path) => `/ops/api${path}`),
  );
  router.use(
    "/console/documents",
    forward((path) => `/api/documents${path}`),
  );

  // His own console and what it calls, forwarded as they are. Express hands
  // the remainder as "/" or "/?query" for the bare prefix; his server wants
  // the prefix itself.
  for (const prefix of HIS_BROWSER_PATHS) {
    router.use(
      prefix,
      forward(
        (path) => `${prefix}${path === "/" ? "" : path.startsWith("/?") ? path.slice(1) : path}`,
      ),
    );
  }

  // The bundle: immutable hashed assets, an entrypoint that is never cached,
  // and a history fallback for the console's own routes.
  if (opts.dist) {
    const dist = opts.dist;
    router.use(
      "/console",
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
    router.get(/^\/console\/.*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(join(dist, "index.html"));
    });
  } else {
    router.get(/^\/console\/.*/, (_req, res) => {
      res.status(503).json({
        error: { message: "The console is not built on this deployment.", code: "NOT_BUILT" },
      });
    });
  }

  // Nothing of the borrower app answers on the servicing name.
  router.use((_req, res) => {
    res.status(404).json({ error: { message: "No such page.", code: "NOT_FOUND" } });
  });

  return router;
}

/**
 * Mount the servicing-host router when there is a servicing hostname to
 * answer. Returns what was mounted, for the start-up log.
 */
export function consoleHost(app: Express): "not-configured" | "proxy-only" | "console" {
  const host = config.servicing.publicHost;
  const upstream = config.servicing.apiUrl;
  if (!host || !upstream) return "not-configured";
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/index.js → ../../console/dist in the image; src/ → the same in the repo.
  const dist = resolve(here, "../../console/dist");
  const built = existsSync(join(dist, "index.html"));
  const router = consoleHostRouter({ host, upstream, dist: built ? dist : undefined });
  app.use((req, res, next) => {
    if (req.hostname === host) router(req, res, next);
    else next();
  });
  return built ? "console" : "proxy-only";
}
