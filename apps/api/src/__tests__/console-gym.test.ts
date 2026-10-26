/**
 * The Supermortgage Gym inside the ops console: `/console/hm/gym/` on the
 * servicing host, for the servicing app's staff and nobody else.
 *
 * The server here is assembled the way `index.ts` assembles it: the host's
 * security headers on everything, the servicing-host router first (the
 * console, the tape desk, the Gym), and below it the body parser, a session
 * and the partner portal's door, which the host router lets through. The
 * page and its bundle are the real ones, built from source the way the
 * image builds them (`build-playground.mjs --site-only`), and the scores are
 * the committed snapshot. The servicing app is a stub that knows one staff
 * cookie, because the gate is its answer to `/ops/api/me` and nothing else.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import helmet from "helmet";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import type { FixtureMailConnector } from "@hm/connectors";
import { consoleHostRouter } from "../console-host.js";
import { errorHandler } from "../middleware/error-handler.js";
import { consoleGymRouter } from "../routes/console-gym.js";
import { consoleTapeRouter } from "../routes/console-tape.js";
import { servicerPortalRouter } from "../routes/servicer-portal.js";
import { inlineScriptHashes, securityHeaders } from "../security-policy.js";
import { connectors } from "../services/connectors.js";
import { inviteServicerTeam } from "../services/servicer-team.js";

const HOST = "servicing.example.test";
const CONSUMER = "app.example.test";
const STAFF_COOKIE = "sm_staff=gym-staff";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const playground = join(repo, "packages/environments");
const SNAPSHOT = join(playground, "playground/snapshot/scores.json");
const PASSWORD = "correct horse battery staple 22";

let upstream: Server;
let app: Server;
let port: number;
let site = "";
let unbuilt = "";

beforeAll(async () => {
  // The page and the bundle, as the image builds them.
  site = mkdtempSync(join(tmpdir(), "gym-site-"));
  const built = spawnSync(
    process.execPath,
    [join(playground, "scripts/build-playground.mjs"), "--site-only", "--out", site],
    { encoding: "utf8" },
  );
  if (built.status !== 0)
    throw new Error(`build-playground.mjs failed:\n${built.stdout}\n${built.stderr}`);
  unbuilt = mkdtempSync(join(tmpdir(), "gym-unbuilt-"));

  upstream = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/ops/api/me" && String(req.headers.cookie ?? "").includes(STAFF_COOKIE)) {
      res.end(
        JSON.stringify({
          staff_user_id: "staff-gym",
          legal_name: "Gym Person",
          roles: ["ops_analyst", "officer", "compliance", "admin"],
          role: "ops_analyst",
          source: "session",
        }),
      );
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ code: "AUTH_REQUIRED" }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const gate = { upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` };

  const consoleDist = mkdtempSync(join(tmpdir(), "gym-console-"));
  mkdirSync(join(consoleDist, "assets"));
  writeFileSync(join(consoleDist, "index.html"), "<!doctype html><title>console</title>");

  const server = express();
  server.set("trust proxy", 1);
  server.use(helmet(securityHeaders("sandbox")));
  const host = consoleHostRouter({
    host: HOST,
    upstream: gate.upstream,
    dist: consoleDist,
    tape: consoleTapeRouter(gate),
    gym: consoleGymRouter(gate, { site, scores: SNAPSHOT, plaidEnvironment: "sandbox" }),
  });
  server.use((req, res, next) => (req.hostname === HOST ? host(req, res, next) : next()));
  // A Gym with nothing built beside it, on a path of its own, below the host's router.
  server.use(
    "/unbuilt/gym",
    consoleGymRouter(gate, { site: unbuilt, scores: SNAPSHOT, plaidEnvironment: "sandbox" }),
  );
  server.use(express.json());
  server.use(
    session({
      secret: "test",
      resave: false,
      saveUninitialized: false,
      cookie: { sameSite: "lax" },
    }),
  );
  server.use("/api/servicer", servicerPortalRouter);
  server.use(errorHandler);
  app = server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => app.once("listening", r));
  port = (app.address() as AddressInfo).port;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
  for (const dir of [site, unbuilt]) if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  (connectors().mail as FixtureMailConnector).outbox.length = 0;
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** One browser on one host: requests carry its cookies, and answers that set one keep it. */
function browser(hostname = HOST, cookie = "") {
  return (
    path: string,
    init: { method?: string; body?: unknown; cookie?: string } = {},
  ): Promise<Answer> =>
    new Promise((done, fail) => {
      const body = init.body === undefined ? undefined : JSON.stringify(init.body);
      const jar = init.cookie ?? cookie;
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method: init.method ?? "GET",
          agent: false,
          headers: {
            host: hostname,
            ...(jar ? { cookie: jar } : {}),
            ...(body ? { "content-type": "application/json" } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const set = res.headers["set-cookie"];
            if (set?.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
            done({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", fail);
      if (body) req.write(body);
      req.end();
    });
}

const staff = () => browser(HOST, STAFF_COOKIE);
const csp = (a: Answer) => String(a.headers["content-security-policy"] ?? "");
const scriptSrc = (a: Answer) =>
  csp(a)
    .split(";")
    .find((d) => d.startsWith("script-src "));

/** The page's one inline script, read out of what was served, hashed the way a browser hashes it. */
function servedScriptHash(html: string): string {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  expect(inline).toHaveLength(1);
  return `'sha256-${createHash("sha256").update(inline[0]!, "utf8").digest("base64")}'`;
}

/** A servicer's member, signed in through the portal's own door on the servicing host. */
async function member() {
  await prisma.servicer.create({ data: { slug: "gym-servicer", displayName: "Gym Servicing" } });
  const [outcome] = await inviteServicerTeam({
    servicerSlug: "gym-servicer",
    invitations: [{ email: "ada@gym-servicer.example", name: "Ada" }],
    invitedBy: "staff-1",
  });
  expect(outcome!.status).toBe("sent");
  const mail = (connectors().mail as FixtureMailConnector).outbox.at(-1)!;
  const token = mail.text.match(/https?:\/\/\S+/)![0].split("#")[1]!;
  const call = browser(HOST);
  const accepted = await call("/api/servicer/auth/accept", {
    method: "POST",
    body: { token, password: PASSWORD },
  });
  expect(accepted.status).toBe(201);
  expect((await call("/api/servicer/me")).status).toBe(200);
  return call;
}

describe("the Gym on the servicing host", () => {
  it("opens for a staff session: the page, its bundle and the committed held-out counts", async () => {
    const call = staff();
    const page = await call("/console/hm/gym/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.body).toMatch(/^<!doctype html>/);
    expect(page.body).toContain('<script src="environments.js"></script>');
    expect(page.body).toContain("<h1>Gym</h1>");
    expect(page.body).toBe(readFileSync(join(site, "index.html"), "utf8"));

    const bundle = await call("/console/hm/gym/environments.js");
    expect(bundle.status).toBe(200);
    expect(bundle.headers["content-type"]).toMatch(/javascript/);
    expect(bundle.headers["cache-control"]).toBe("private, no-cache");
    expect(bundle.body).toContain("HMEnvironments");
    expect(bundle.body.length).toBe(readFileSync(join(site, "environments.js"), "utf8").length);

    const scores = await call("/console/hm/gym/scores.json");
    expect(scores.status).toBe(200);
    expect(scores.headers["content-type"]).toMatch(/^application\/json/);
    expect(scores.body).toBe(readFileSync(SNAPSHOT, "utf8"));
    expect((JSON.parse(scores.body) as { scores: unknown[] }).scores.length).toBeGreaterThan(0);
  });

  it("serves no recorded attempts, and nothing it does not name", async () => {
    const call = staff();
    for (const path of [
      "runs.json",
      "demo.html",
      "../dist/runs.json",
      "index.html/x",
      "entry.ts",
    ]) {
      const r = await call(`/console/hm/gym/${path}`);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toContain("HMEnvironments");
    }
  });

  it("is addressed as a directory, so the page finds its files", async () => {
    const r = await staff()("/console/hm/gym?env=refi-review");
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/console/hm/gym/?env=refi-review");
  });

  it("refuses a request with no session as the tape desk does", async () => {
    const call = browser(HOST);
    const desk = await call("/console/hm/tape/servicers");
    expect(desk.status).toBe(401);
    for (const path of ["/console/hm/gym/", "/console/hm/gym", "/console/hm/gym/environments.js"]) {
      const r = await call(path);
      expect(r.status, path).toBe(401);
      expect(JSON.parse(r.body), path).toEqual(JSON.parse(desk.body));
    }
    const stranger = await browser(HOST, "sm_staff=nobody")("/console/hm/gym/scores.json");
    expect(stranger.status).toBe(401);
  });

  it("refuses a servicer member's session: a member never sees the ops console", async () => {
    const call = await member();
    for (const path of [
      "/console/hm/gym/",
      "/console/hm/gym/environments.js",
      "/console/hm/gym/scores.json",
    ]) {
      const r = await call(path);
      expect(r.status, path).toBe(401);
      expect((JSON.parse(r.body) as { error: { code: string } }).error.code).toBe(
        "STAFF_SIGN_IN_REQUIRED",
      );
      expect(r.body).not.toContain("HMEnvironments");
    }
  });

  it("is not served on the consumer host, with a staff cookie or without", async () => {
    for (const cookie of ["", STAFF_COOKIE]) {
      const call = browser(CONSUMER, cookie);
      for (const path of ["/console/hm/gym/", "/console/hm/gym/environments.js"]) {
        const r = await call(path);
        expect(r.status, `${path} ${cookie}`).toBe(404);
        expect(r.body).not.toContain("HMEnvironments");
        expect(r.body).not.toContain("<h1>Gym</h1>");
      }
    }
  });

  it("answers 503 where the page was not built", async () => {
    // Mounted beside the host's router rather than in it, so asked on another name.
    const call = browser(CONSUMER, STAFF_COOKIE);
    const r = await call("/unbuilt/gym/");
    expect(r.status).toBe(503);
    expect((JSON.parse(r.body) as { error: { code: string } }).error.code).toBe("NOT_BUILT");
    expect((await call("/unbuilt/gym/environments.js")).status).toBe(503);
  });
});

describe("the Gym's Content-Security-Policy", () => {
  it("admits the page's own inline script by its hash, and no other inline script", async () => {
    const page = await staff()("/console/hm/gym/");
    const hash = servedScriptHash(page.body);
    expect(inlineScriptHashes(page.body)).toEqual([hash]);
    expect(scriptSrc(page)).toBe(`script-src 'self' ${hash}`);
    expect(scriptSrc(page)).not.toContain("unsafe");
    // The page's one <style> is already admitted by the host's style-src; nothing else moved.
    const host = csp(await browser(HOST)("/console/"));
    const others = (v: string) =>
      v
        .split(";")
        .filter((d) => !d.startsWith("script-src "))
        .sort();
    expect(others(csp(page))).toEqual(others(host));
    expect(csp(page)).toContain("style-src 'self' https: 'unsafe-inline'");
    expect(csp(page)).toContain("object-src 'none'");
    expect(csp(page)).toContain("script-src-attr 'none'");
  });

  it("is on that page alone: the console, the bundle and the other doors keep the host's", async () => {
    const call = staff();
    const hostScripts =
      "script-src 'self' https://accounts.google.com/gsi/client https://cdn.plaid.com";
    for (const path of [
      "/console/",
      "/console/staff",
      "/console/hm/gym/environments.js",
      "/console/hm/gym/scores.json",
      "/console/hm/tape/servicers",
    ]) {
      const r = await call(path);
      expect(scriptSrc(r), path).toBe(hostScripts);
      expect(csp(r), path).not.toContain("sha256-");
    }
    // Refused, the Gym's path says nothing of its page either.
    expect(csp(await browser(HOST)("/console/hm/gym/"))).not.toContain("sha256-");
  });
});
