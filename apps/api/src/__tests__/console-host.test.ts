/**
 * The servicing hostname: the console served and his API forwarded, and
 * nothing of ours reachable through that name.
 *
 * His server is a stub that records what reached it and answers with a
 * cookie, the way his sign-in does. The thing under test is the seam — what
 * crosses in each direction and what does not — not his behavior.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consoleHostRouter, staffSignInCodeMessage, withoutEchoedCodes } from "../console-host.js";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const HOST = "servicing.example.test";

let upstream: Server;
let upstreamUrl: string;
let app: Server;
let appPort: number;
const seen: Seen[] = [];

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/ops/api/staff/invite") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("x-acted-as", String(req.headers["x-staff-role"] ?? "none"));
        res.end(
          JSON.stringify({
            role_seen: req.headers["x-staff-role"] ?? null,
            gate_seen: req.headers["x-serverless-authorization"] ?? null,
          }),
        );
        return;
      }
      if (req.url?.startsWith("/ops/api/auth/signin")) {
        res.setHeader("Set-Cookie", "sm_staff=abc; Path=/; Secure; HttpOnly; SameSite=Strict");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // His staff door on a stand-in mailer: the code comes back in the answer.
      if (req.url === "/ops/api/auth/code") {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("ETag", '"his-validator"');
        res.end(
          JSON.stringify({
            challenge_id: "ch_1",
            delivery: "FAKE",
            expires_at: "2026-10-05T16:10:00.000Z",
            fake_code: "246810",
          }),
        );
        return;
      }
      // Any other door of his that echoes one, however deep in the answer.
      if (req.url === "/ops/api/somewhere/else" || req.url === "/api/borrower/door") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            ok: true,
            fake_code: "111111",
            challenge: { id: "ch_2", fake_code: "222222" },
            many: [{ fake_code: "333333", keep: 1 }],
          }),
        );
        return;
      }
      if (req.url === "/login?token=t") {
        res.statusCode = 302;
        res.setHeader("Location", "/ops");
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ echo: req.url, cookie: req.headers.cookie ?? null }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const dist = mkdtempSync(join(tmpdir(), "console-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>console</title>");
  writeFileSync(join(dist, "assets", "app.js"), "// bundle");

  const server = express();
  server.set("trust proxy", 1);
  const router = consoleHostRouter({ host: HOST, upstream: upstreamUrl, dist });
  server.use((req, res, next) => (req.hostname === HOST ? router(req, res, next) : next()));
  server.get("/api/health", (_req, res) => res.json({ ours: true }));
  app = server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => app.once("listening", r));
  appPort = (app.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

function call(
  path: string,
  init: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: appPort,
        path,
        method: init.method ?? "GET",
        agent: false,
        headers: { host: init.host ?? HOST, ...init.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

describe("the servicing hostname", () => {
  it("lands on the console and serves the bundle", async () => {
    const root = await call("/");
    expect(root.status).toBe(302);
    expect(root.headers.location).toBe("/console/");
    const bare = await call("/console");
    expect(bare.status).toBe(302);
    expect(bare.headers.location).toBe("/console/");
    const home = await call("/console/");
    expect(home.status).toBe(200);
    expect(home.body).toContain("<title>console</title>");
    const page = await call("/console/staff/anything");
    expect(page.status).toBe(200);
    expect(page.body).toContain("<title>console</title>");
    expect(page.headers["cache-control"]).toBe("no-store");
    const asset = await call("/console/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
  });

  it("forwards the console's calls to his console API, cookies both ways", async () => {
    seen.length = 0;
    const signin = await call("/console/api/auth/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.c", password: "x" }),
    });
    expect(signin.status).toBe(200);
    expect(signin.headers["set-cookie"]).toEqual([
      "sm_staff=abc; Path=/; Secure; HttpOnly; SameSite=Strict",
    ]);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/ops/api/auth/signin" });
    expect(seen[0]?.body).toBe(JSON.stringify({ email: "a@b.c", password: "x" }));
    expect(seen[0]?.headers["x-forwarded-host"]).toBe(HOST);

    const list = await call("/console/api/staff?x=1", { headers: { cookie: "sm_staff=abc" } });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toEqual({ echo: "/ops/api/staff?x=1", cookie: "sm_staff=abc" });

    // The acting role crosses on every call, and the role he acted as comes back.
    const acted = await call("/console/api/staff/invite", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-staff-role": "admin",
        cookie: "sm_staff=abc",
      },
      body: "{}",
    });
    expect(JSON.parse(acted.body)).toEqual({ role_seen: "admin", gate_seen: null });
    expect(acted.headers["x-acted-as"]).toBe("admin");

    // A tape is a multipart body; it crosses whole, with its boundary.
    const boundary = "----tape-boundary";
    const multipart =
      `--${boundary}\r\nContent-Disposition: form-data; name="as_of_date"\r\n\r\n2026-10-01\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="tape"; filename="t.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\nPK\u0003\u0004bytes\r\n--${boundary}--\r\n`;
    seen.length = 0;
    const tape = await call("/console/api/partner-book/imports", {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        cookie: "sm_staff=abc",
      },
      body: multipart,
    });
    expect(tape.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/ops/api/partner-book/imports" });
    expect(seen[0]?.headers["content-type"]).toBe(`multipart/form-data; boundary=${boundary}`);
    expect(seen[0]?.body).toBe(multipart);

    const doc = await call("/console/documents/d1/content");
    expect(JSON.parse(doc.body).echo).toBe("/api/documents/d1/content");
  });

  it("serves nothing of his raw surface: not his console, his API or his sign-in links", async () => {
    // A bookmark to his console lands on ours.
    for (const path of ["/ops", "/ops/"]) {
      const ops = await call(path);
      expect(ops.status).toBe(302);
      expect(ops.headers.location).toBe("/console/");
    }
    seen.length = 0;
    for (const [path, method] of [
      ["/ops/api/roles", "GET"],
      ["/ops/api/auth/code", "POST"],
      ["/api/health", "GET"],
      ["/api/borrower/door", "POST"],
      ["/login?token=t", "GET"],
      ["/verify", "GET"],
      ["/v1/borrower/auth/account", "POST"],
    ] as const) {
      const r = await call(path, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: "{}" }
          : {}),
      });
      expect([path, r.status]).toEqual([path, 404]);
      expect(JSON.parse(r.body).error.code).toBe("NOT_FOUND");
    }
    // None of it reached his server.
    expect(seen).toEqual([]);
  });

  it("answers nothing of the borrower app on the servicing name, and everything on any other", async () => {
    // /api on the servicing name is nobody's: his is closed, and ours is
    // answered on the other name.
    const his = await call("/api/health");
    expect(his.status).toBe(404);
    // A borrower route is nobody's there.
    const nobody = await call("/f/123/bank");
    expect(nobody.status).toBe(404);
    expect(JSON.parse(nobody.body).error.code).toBe("NOT_FOUND");
    const elsewhere = await call("/api/health", { host: "app.example.test" });
    expect(elsewhere.status).toBe(200);
    expect(JSON.parse(elsewhere.body)).toEqual({ ours: true });
  });

  it("carries a Google identity token to his door when it has one", async () => {
    const gated = express();
    gated.use(
      consoleHostRouter({
        host: HOST,
        upstream: upstreamUrl,
        dist: undefined,
        identityToken: async () => "id-token-for-his-url",
      }),
    );
    const s = gated.listen(0, "127.0.0.1");
    await new Promise<void>((r) => s.once("listening", r));
    const port = (s.address() as AddressInfo).port;
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/console/api/staff/invite",
          method: "POST",
          agent: false,
          headers: { host: HOST, "x-staff-role": "admin", "content-type": "application/json" },
        },
        (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).gate_seen).toBe("Bearer id-token-for-his-url");
    await new Promise<void>((r) => s.close(() => r()));
  });

  it("says so when his server is down rather than hanging", async () => {
    const dead = express();
    const router = consoleHostRouter({
      host: HOST,
      upstream: "http://127.0.0.1:1",
      dist: undefined,
    });
    dead.use(router);
    const s = dead.listen(0, "127.0.0.1");
    await new Promise<void>((r) => s.once("listening", r));
    const port = (s.address() as AddressInfo).port;
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/console/api/roles",
          agent: false,
          headers: { host: HOST },
        },
        (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error.code).toBe("UPSTREAM");
    await new Promise<void>((r) => s.close(() => r()));
  });
});

describe("a sign-in code and the proxy", () => {
  const mails: { to: string; code: string }[] = [];
  let refuse = false;
  let guarded: Server;
  let guardedPort: number;

  beforeAll(async () => {
    const server = express();
    server.set("trust proxy", 1);
    const router = consoleHostRouter({
      host: HOST,
      upstream: upstreamUrl,
      codes: {
        internal: (email) => email.endsWith("@ours.test"),
        send: async (to, code) => {
          if (refuse) return false;
          mails.push({ to, code });
          return true;
        },
      },
    });
    server.use((req, res, next) => (req.hostname === HOST ? router(req, res, next) : next()));
    guarded = server.listen(0, "127.0.0.1");
    await new Promise<void>((r) => guarded.once("listening", r));
    guardedPort = (guarded.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => guarded.close(() => r()));
  });

  const post = (path: string, body: unknown, port = guardedPort) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path,
            method: "POST",
            agent: false,
            headers: { host: HOST, "content-type": "application/json" },
          },
          (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
            );
          },
        );
        req.on("error", reject);
        req.write(typeof body === "string" ? body : JSON.stringify(body));
        req.end();
      },
    );

  it("crosses as it is where the mailer is a stand-in, so a developer can sign in", async () => {
    const r = await post("/console/api/auth/code", { email: "ada@ours.test" }, appPort);
    expect(JSON.parse(r.body)).toMatchObject({ delivery: "FAKE", fake_code: "246810" });
  });

  it("is mailed to one of ours and never shown", async () => {
    for (const path of ["/console/api/auth/code"]) {
      mails.length = 0;
      seen.length = 0;
      const r = await post(path, { email: " Ada@Ours.test " });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({
        challenge_id: "ch_1",
        delivery: "email",
        expires_at: "2026-10-05T16:10:00.000Z",
      });
      expect(r.body).not.toContain("246810");
      // The body changed, so his validator for it is not passed on.
      expect(r.headers.etag).not.toBe('"his-validator"');
      expect(mails).toEqual([{ to: "ada@ours.test", code: "246810" }]);
      // His server got the request whole, as the person sent it.
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe("/ops/api/auth/code");
      expect(JSON.parse(seen[0]!.body)).toEqual({ email: " Ada@Ours.test " });
    }
  });

  it("answers a stranger's address the same and mails it nothing", async () => {
    mails.length = 0;
    const r = await post("/console/api/auth/code", { email: "eve@elsewhere.test" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({
      challenge_id: "ch_1",
      delivery: "email",
      expires_at: "2026-10-05T16:10:00.000Z",
    });
    expect(mails).toEqual([]);
    // No address at all is still no code.
    const none = await post("/console/api/auth/code", "not json");
    expect(none.body).not.toContain("246810");
    expect(mails).toEqual([]);
  });

  it("tells nobody the code when it could not be mailed", async () => {
    refuse = true;
    try {
      const r = await post("/console/api/auth/code", { email: "ada@ours.test" });
      expect(r.status).toBe(502);
      expect(JSON.parse(r.body).error.code).toBe("CODE_NOT_MAILED");
      expect(r.body).not.toContain("246810");
    } finally {
      refuse = false;
    }
  });

  it("takes an echoed code out of any forwarded write's answer, at any depth, and leaves the rest", async () => {
    for (const path of ["/console/api/somewhere/else"]) {
      const r = await post(path, { anything: true });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({
        ok: true,
        challenge: { id: "ch_2" },
        many: [{ keep: 1 }],
      });
      expect(r.body).not.toMatch(/fake_code|111111|222222|333333/);
    }
    // An answer with no code in it crosses byte for byte.
    const plain = await post("/console/api/staff/invite", { email: "x@ours.test" });
    expect(JSON.parse(plain.body)).toEqual({ role_seen: null, gate_seen: null });
  });

  it("refuses a code request too large to be an address", async () => {
    const r = await post("/console/api/auth/code", {
      email: "a@ours.test",
      pad: "x".repeat(20_000),
    });
    expect(r.status).toBe(413);
  });

  it("says in the mail that the code works only for an invited address, since the page cannot", () => {
    const mail = staffSignInCodeMessage({ to: "ada@ours.test", code: "246810" });
    expect(mail.to).toBe("ada@ours.test");
    expect(mail.subject).toContain("246810");
    expect(mail.text).toContain("246810");
    expect(mail.text).toContain("only for an address an admin has invited");
    expect(mail.text).toContain("sign in with the address that was invited");
    expect(mail.text).toContain("Staff & roles");
  });

  it("removes the echo wherever it sits, and says whether it found one", () => {
    expect(withoutEchoedCodes({ a: 1, fake_code: "1", b: [{ fake_code: "2", c: null }] })).toEqual({
      value: { a: 1, b: [{ c: null }] },
      found: true,
    });
    expect(withoutEchoedCodes({ a: [1, "two", null] })).toEqual({
      value: { a: [1, "two", null] },
      found: false,
    });
  });
});
