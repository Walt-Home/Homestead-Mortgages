/**
 * The Supermortgage Gym, inside the ops console.
 *
 * The Gym is every training environment in `packages/environments` in one
 * page: draw a task, work it with the tools a model gets, grade the answer
 * with the engine (docs/environments.md, "The Supermortgage Gym"). Its home
 * is a claude.ai page shared by link; this is the same page served on the
 * servicing host at `/console/hm/gym/`, so the team can open it from the
 * console they already sign in to.
 *
 * Gated like the tape desk: the servicing app's own staff session, checked
 * with it (`services/console-staff.ts`), any of the four staff roles. A
 * servicer's member never opens it — their session is ours, not the
 * servicing app's, and the gate asks the servicing app — and a request with
 * no session is the same 401 every other `/console/hm` door gives. It is
 * mounted on the servicing host only (`console-host.ts`); the consumer host
 * never answers it.
 *
 * Three files and nothing else, each named:
 *
 * - `index.html` and `environments.js`, built from source in the image by
 *   `scripts/build-playground.mjs --site-only` (the Dockerfile);
 * - `scores.json`, the held-out counts committed at
 *   `packages/environments/playground/snapshot/scores.json` by
 *   `npm run env:gym-snapshot`: counts, no task, prompt or transcript.
 *
 * `runs.json`, the model's recorded attempts on training tasks, is not
 * committed and not served: a 404 here. The page built for this route is
 * marked as carrying none and never asks for it, and says where they are;
 * a page that did ask would read the 404 the same way. See
 * docs/decisions.md, "The Gym is in the ops console, without its recorded
 * attempts".
 *
 * The page is one document with one inline script, and the host's policy
 * admits no inline script, so the page's answer carries the host's policy
 * with that script's hash added (`gymContentSecurityDirectives`), computed
 * from the bytes served, on this path alone.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import helmet from "helmet";
import { asyncRoute } from "../middleware/error-handler.js";
import { gymContentSecurityDirectives } from "../security-policy.js";
import {
  consoleStaffGate,
  STAFF_ROLES,
  type ConsoleStaffGateOptions,
} from "../services/console-staff.js";

export interface GymFiles {
  /** The build: `index.html` and `environments.js`. Without them the Gym answers 503. */
  readonly site?: string;
  /** The committed held-out counts. */
  readonly scores?: string;
  /** The Plaid environment the host's policy names; the Gym's policy is that one plus its hash. */
  readonly plaidEnvironment: "sandbox" | "production";
}

function notBuilt(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(503).json({
    error: { message: "The Gym is not built on this deployment.", code: "NOT_BUILT" },
  });
}

/** The path, when there is a file at it; null when it was not built. */
async function fileAt(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** A file of the Gym's, revalidated on every load: the names carry no hash, so nothing is cached for good. */
function sendNamed(path: string | undefined) {
  return asyncRoute(async (_req: Request, res: Response, next: NextFunction) => {
    const file = await fileAt(path);
    if (!file) {
      notBuilt(res);
      return;
    }
    // Sent by its name from its own directory: a checkout under a dot-directory
    // (a worktree in `.claude/`) is otherwise refused as a dotfile.
    const options = { root: dirname(file), headers: { "Cache-Control": "private, no-cache" } };
    res.sendFile(basename(file), options, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });
}

export function consoleGymRouter(gate: ConsoleStaffGateOptions, files: GymFiles): Router {
  const router = express.Router();
  router.use(consoleStaffGate({ ...gate, roles: STAFF_ROLES, what: "The Gym" }));

  /** The page. Its policy is computed from the document served, so the hash cannot go stale. */
  let policy: { html: string; set: ReturnType<typeof helmet.contentSecurityPolicy> } | null = null;
  router.get(
    "/",
    asyncRoute(async (req: Request, res: Response, next: NextFunction) => {
      // The page loads its files by relative name, so it must be addressed as a directory.
      const at = req.originalUrl.indexOf("?");
      const path = at < 0 ? req.originalUrl : req.originalUrl.slice(0, at);
      if (!path.endsWith("/")) {
        // To the mount path as it matched, never to the request's own text: a
        // request line in absolute form (`GET http://elsewhere/console/hm/gym`)
        // would otherwise send the browser to the host it names.
        res.redirect(302, `${req.baseUrl}/${at < 0 ? "" : req.originalUrl.slice(at)}`);
        return;
      }
      const page = await fileAt(files.site && join(files.site, "index.html"));
      if (!page) {
        notBuilt(res);
        return;
      }
      const html = await readFile(page, "utf8");
      if (policy?.html !== html) {
        policy = {
          html,
          set: helmet.contentSecurityPolicy({
            directives: gymContentSecurityDirectives(files.plaidEnvironment, html),
          }),
        };
      }
      policy.set(req, res, (err?: unknown) => {
        if (err) {
          next(err);
          return;
        }
        res.setHeader("Cache-Control", "no-store");
        res.type("html").send(html);
      });
    }),
  );
  router.get("/environments.js", sendNamed(files.site && join(files.site, "environments.js")));
  router.get("/scores.json", sendNamed(files.scores));

  // Everything else, `runs.json` among it: not here. The page this route
  // serves never asks for it, and one that did would read the 404 as a build
  // that carries no recorded attempts.
  router.use((_req, res) => {
    res.status(404).json({ error: { message: "No such page.", code: "NOT_FOUND" } });
  });
  return router;
}
