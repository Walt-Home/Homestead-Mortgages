/**
 * The second step of sign-in, walked through a real session.
 *
 * `callAs` stubs the session, which is right for every route whose subject is
 * what a signed-in person's request does. Here the session IS the subject —
 * what a Google sign-in leaves it holding, what a code changes, what a new
 * cookie does not inherit — so these tests stand up express-session with its
 * memory store, the auth router, the gate as `index.ts` mounts it, and one
 * probe route behind it, and drive the lot with a cookie jar.
 *
 * Google is the one thing mocked: the ID token is a user id, and the mocked
 * `signInWithGoogle` looks the row up. Everything after that is the real
 * code against the real Postgres.
 */

import express from "express";
import session from "express-session";
import { readdirSync, readFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "@hm/db";

// The persona router is mounted at import time, under the flag.
vi.hoisted(() => {
  process.env.DEMO_PERSONAS = "true";
});

vi.mock("../services/auth.js", async (original) => {
  const real = await original<typeof import("../services/auth.js")>();
  return {
    ...real,
    signInWithGoogle: (credential: string) =>
      prisma.user.findUniqueOrThrow({ where: { id: credential } }),
  };
});

import { authRouter } from "../routes/auth.js";
import { requireAuth } from "../middleware/require-auth.js";
import { personaReadOnly } from "../middleware/persona-read-only.js";
import { errorHandler } from "../middleware/error-handler.js";
import { base32Decode, hotp, totpStep } from "../services/totp.js";
import { LOCK_AFTER_FAILURES, RECOVERY_CODE_COUNT } from "../services/second-factor.js";
import { createUser } from "./support/factories.js";

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/** One browser: one cookie jar against one server, closed when the test is done. */
async function browser() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      name: "hm.sid",
      secret: "test",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax" },
    }),
  );
  app.use("/api/auth", authRouter);
  app.use("/api", requireAuth);
  app.use("/api", personaReadOnly);
  app.get("/api/probe", (req, res) => {
    res.json({ userId: req.user!.id });
  });
  app.use(errorHandler);

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  let cookie: string | undefined;

  function call<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Reply<T>> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method,
          path,
          headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
          agent: false,
        },
        (res) => {
          const set = res.headers["set-cookie"]?.find((c) => c.startsWith("hm.sid="));
          if (set) cookie = set.split(";")[0];
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: (text ? JSON.parse(text) : {}) as T });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  return {
    call,
    /** The session cookie as last set, so a test can see it change. */
    get cookie() {
      return cookie;
    },
    signIn: (userId: string) => call("POST", "/api/auth/google", { credential: userId }),
    probe: () => call("GET", "/api/probe"),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Browser = Awaited<ReturnType<typeof browser>>;

/** A code for a step the row has not seen: the next one, which the window admits. */
function freshCode(secret: string, ahead = 1): string {
  return hotp(base32Decode(secret), totpStep(Date.now()) + ahead);
}

/** Six digits that are certainly not the code for any step in the window. */
function wrongCode(secret: string): string {
  const live = new Set(
    [-1, 0, 1, 2].map((d) => hotp(base32Decode(secret), totpStep(Date.now()) + d)),
  );
  let candidate = 0;
  while (live.has(String(candidate).padStart(6, "0"))) candidate += 1;
  return String(candidate).padStart(6, "0");
}

/** A person enrolled through the real routes, with the secret and codes handed back. */
async function enrolled(b: Browser, userId: string) {
  await b.signIn(userId);
  const start = await b.call<{ secret: string }>("POST", "/api/auth/second-factor/enroll");
  const done = await b.call<{ recoveryCodes: string[] }>(
    "POST",
    "/api/auth/second-factor/enroll/confirm",
    { code: freshCode(start.body.secret, 0) },
  );
  expect(done.status).toBe(201);
  return { secret: start.body.secret, recoveryCodes: done.body.recoveryCodes };
}

const code = (r: Reply) => (r.body as { error?: { code?: string } }).error?.code;

describe("a Google sign-in is identified, not yet authenticated", () => {
  it("opens nothing past /api/auth until an authenticator is set up", async () => {
    const me = await createUser();
    const b = await browser();
    try {
      const signedIn = await b.signIn(me.id);
      expect(signedIn.status).toBe(201);
      expect(signedIn.body.secondFactor).toBe("enroll");

      const whoami = await b.call("GET", "/api/auth/me");
      expect(whoami.status).toBe(200);
      expect(whoami.body.secondFactor).toBe("enroll");

      const probe = await b.probe();
      expect(probe.status).toBe(401);
      expect(code(probe)).toBe("SECOND_FACTOR_ENROLLMENT_REQUIRED");
    } finally {
      await b.close();
    }
  });

  it("is a plain sign-in refusal with no session at all", async () => {
    const b = await browser();
    try {
      const probe = await b.probe();
      expect(probe.status).toBe(401);
      expect(code(probe)).toBe("SIGN_IN_REQUIRED");
    } finally {
      await b.close();
    }
  });
});

describe("enrollment", () => {
  it("hands over a secret, takes a code from it, and only then writes the row", async () => {
    const me = await createUser();
    const b = await browser();
    try {
      await b.signIn(me.id);
      const start = await b.call<{ secret: string; otpauthUri: string; account: string }>(
        "POST",
        "/api/auth/second-factor/enroll",
      );
      expect(start.status).toBe(200);
      expect(start.body.otpauthUri).toContain(`secret=${start.body.secret}`);
      expect(start.body.account).toBe(me.email);
      expect(await prisma.userAuthenticator.findUnique({ where: { userId: me.id } })).toBeNull();

      const wrong = await b.call("POST", "/api/auth/second-factor/enroll/confirm", {
        code: wrongCode(start.body.secret),
      });
      expect(wrong.status).toBe(400);
      expect(code(wrong)).toBe("WRONG_CODE");
      expect(await prisma.userAuthenticator.findUnique({ where: { userId: me.id } })).toBeNull();

      const done = await b.call<{ recoveryCodes: string[]; secondFactor: string }>(
        "POST",
        "/api/auth/second-factor/enroll/confirm",
        { code: freshCode(start.body.secret, 0) },
      );
      expect(done.status).toBe(201);
      expect(done.body.secondFactor).toBe("satisfied");
      expect(done.body.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
      for (const c of done.body.recoveryCodes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);

      // The row holds ciphertext, not the secret.
      const row = await prisma.userAuthenticator.findUniqueOrThrow({ where: { userId: me.id } });
      expect(row.secretCiphertext).not.toContain(start.body.secret);
      expect(row.secretCiphertext.split(":")).toHaveLength(3);
      // And the codes are hashes.
      const stored = await prisma.userRecoveryCode.findMany({ where: { userId: me.id } });
      expect(stored).toHaveLength(RECOVERY_CODE_COUNT);
      for (const s of stored) expect(done.body.recoveryCodes).not.toContain(s.codeHash);

      expect((await b.probe()).status).toBe(200);
      expect((await b.call("GET", "/api/auth/me")).body.secondFactor).toBe("satisfied");
    } finally {
      await b.close();
    }
  });

  it("refuses a confirmation with nothing to confirm", async () => {
    const me = await createUser();
    const b = await browser();
    try {
      await b.signIn(me.id);
      const r = await b.call("POST", "/api/auth/second-factor/enroll/confirm", { code: "123456" });
      expect(r.status).toBe(409);
      expect(code(r)).toBe("NO_ENROLLMENT_IN_PROGRESS");
    } finally {
      await b.close();
    }
  });

  it("requires the current authenticator before it will hand out a new one", async () => {
    const me = await createUser();
    const first = await browser();
    const later = await browser();
    try {
      const { secret, recoveryCodes } = await enrolled(first, me.id);

      await later.signIn(me.id);
      const refused = await later.call("POST", "/api/auth/second-factor/enroll");
      expect(refused.status).toBe(401);
      expect(code(refused)).toBe("SECOND_FACTOR_REQUIRED");

      const verified = await later.call("POST", "/api/auth/second-factor/verify", {
        code: freshCode(secret),
      });
      expect(verified.status).toBe(200);

      const replaced = await later.call<{ secret: string }>(
        "POST",
        "/api/auth/second-factor/enroll",
      );
      expect(replaced.status).toBe(200);
      expect(replaced.body.secret).not.toBe(secret);
      const done = await later.call<{ recoveryCodes: string[] }>(
        "POST",
        "/api/auth/second-factor/enroll/confirm",
        { code: freshCode(replaced.body.secret, 0) },
      );
      expect(done.status).toBe(201);

      // The old recovery codes went with the old secret.
      const third = await browser();
      try {
        await third.signIn(me.id);
        const stale = await third.call("POST", "/api/auth/second-factor/verify", {
          code: recoveryCodes[0],
        });
        expect(stale.status).toBe(401);
        const fresh = await third.call("POST", "/api/auth/second-factor/verify", {
          code: done.body.recoveryCodes[0],
        });
        expect(fresh.status).toBe(200);
      } finally {
        await third.close();
      }
    } finally {
      await first.close();
      await later.close();
    }
  });
});

describe("a later sign-in", () => {
  it("asks for a code, and a code is good once", async () => {
    const me = await createUser();
    const first = await browser();
    const second = await browser();
    const third = await browser();
    try {
      const { secret } = await enrolled(first, me.id);

      const signedIn = await second.signIn(me.id);
      expect(signedIn.body.secondFactor).toBe("verify");
      const closed = await second.probe();
      expect(closed.status).toBe(401);
      expect(code(closed)).toBe("SECOND_FACTOR_REQUIRED");

      // The enrollment code was spent by the enrollment.
      const replayedEnrollment = await second.call("POST", "/api/auth/second-factor/verify", {
        code: freshCode(secret, 0),
      });
      expect(replayedEnrollment.status).toBe(401);
      expect(code(replayedEnrollment)).toBe("WRONG_CODE");

      const next = freshCode(secret);
      const opened = await second.call("POST", "/api/auth/second-factor/verify", { code: next });
      expect(opened.status).toBe(200);
      expect((await second.probe()).status).toBe(200);

      // The same code, read over a shoulder, opens nothing for a third browser.
      await third.signIn(me.id);
      const replayed = await third.call("POST", "/api/auth/second-factor/verify", { code: next });
      expect(replayed.status).toBe(401);
      expect(code(replayed)).toBe("WRONG_CODE");
      expect((await third.probe()).status).toBe(401);
    } finally {
      await first.close();
      await second.close();
      await third.close();
    }
  });

  it("rotates the session id when the code is accepted", async () => {
    const me = await createUser();
    const first = await browser();
    const second = await browser();
    try {
      const { secret } = await enrolled(first, me.id);
      await second.signIn(me.id);
      const identified = second.cookie;
      expect(identified).toBeDefined();
      const before = await prisma.userAuthenticator.findUniqueOrThrow({ where: { userId: me.id } });

      const opened = await second.call("POST", "/api/auth/second-factor/verify", {
        code: freshCode(secret),
      });
      expect(opened.status).toBe(200);

      // A session id fixed before the second step is not the one trusted after it.
      expect(second.cookie).toBeDefined();
      expect(second.cookie).not.toBe(identified);
      // And the step the code was for is now the last one seen.
      const after = await prisma.userAuthenticator.findUniqueOrThrow({ where: { userId: me.id } });
      expect(after.lastUsedStep).toBeGreaterThan(before.lastUsedStep ?? 0);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe("guessing", () => {
  it("locks the row after five wrong codes, for a session and every other one", async () => {
    const me = await createUser();
    const first = await browser();
    const second = await browser();
    const other = await browser();
    try {
      const { secret } = await enrolled(first, me.id);
      await second.signIn(me.id);

      for (let i = 1; i < LOCK_AFTER_FAILURES; i += 1) {
        const r = await second.call("POST", "/api/auth/second-factor/verify", {
          code: wrongCode(secret),
        });
        expect(r.status).toBe(401);
        expect(code(r)).toBe("WRONG_CODE");
      }
      const fifth = await second.call("POST", "/api/auth/second-factor/verify", {
        code: wrongCode(secret),
      });
      expect(fifth.status).toBe(429);
      expect(code(fifth)).toBe("SECOND_FACTOR_LOCKED");

      // The right code does not get in while the lock holds, and a fresh
      // sign-in does not buy five more guesses.
      const right = freshCode(secret);
      expect(
        (await second.call("POST", "/api/auth/second-factor/verify", { code: right })).status,
      ).toBe(429);
      await other.signIn(me.id);
      expect(
        (await other.call("POST", "/api/auth/second-factor/verify", { code: right })).status,
      ).toBe(429);

      // Fifteen minutes pass.
      await prisma.userAuthenticator.update({
        where: { userId: me.id },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      const opened = await other.call("POST", "/api/auth/second-factor/verify", { code: right });
      expect(opened.status).toBe(200);
      const row = await prisma.userAuthenticator.findUniqueOrThrow({ where: { userId: me.id } });
      expect(row.failedAttempts).toBe(0);
      expect(row.lockedUntil).toBeNull();
    } finally {
      await first.close();
      await second.close();
      await other.close();
    }
  });
});

describe("a recovery code", () => {
  it("signs in once, however it is typed", async () => {
    const me = await createUser();
    const first = await browser();
    const second = await browser();
    const third = await browser();
    try {
      const { recoveryCodes } = await enrolled(first, me.id);

      await second.signIn(me.id);
      const typed = ` ${recoveryCodes[0]!.toUpperCase().replace("-", " ")} `;
      const opened = await second.call("POST", "/api/auth/second-factor/verify", { code: typed });
      expect(opened.status).toBe(200);
      expect((await second.probe()).status).toBe(200);

      await third.signIn(me.id);
      const spent = await third.call("POST", "/api/auth/second-factor/verify", {
        code: recoveryCodes[0],
      });
      expect(spent.status).toBe(401);
      expect(code(spent)).toBe("WRONG_CODE");
      const another = await third.call("POST", "/api/auth/second-factor/verify", {
        code: recoveryCodes[1],
      });
      expect(another.status).toBe(200);

      const status = await third.call<{ enrolled: boolean; recoveryCodesRemaining: number }>(
        "GET",
        "/api/auth/second-factor",
      );
      expect(status.body).toEqual({
        enrolled: true,
        recoveryCodesRemaining: RECOVERY_CODE_COUNT - 2,
      });
    } finally {
      await first.close();
      await second.close();
      await third.close();
    }
  });
});

describe("who is exempt", () => {
  it("the local developer, who is not a person with a phone", async () => {
    const b = await browser();
    try {
      const signedIn = await b.call("POST", "/api/auth/developer");
      expect(signedIn.status).toBe(201);
      expect(signedIn.body.secondFactor).toBe("satisfied");
      expect((await b.probe()).status).toBe(200);
    } finally {
      await b.close();
    }
  });

  it("a sample borrower, who is shared with every tester and refused every write", async () => {
    await createUser({ personaKey: "sample_person" });
    const b = await browser();
    try {
      const signedIn = await b.call("POST", "/api/auth/personas/sample_person");
      expect(signedIn.status).toBe(201);
      expect(signedIn.body.secondFactor).toBe("satisfied");
      expect((await b.probe()).status).toBe(200);
    } finally {
      await b.close();
    }
  });
});

describe("the weaker gate", () => {
  const ROUTES = new URL("../routes/", import.meta.url);
  const source = (name: string) => readFileSync(new URL(name, ROUTES), "utf8");

  it("is used by /me and the second-factor routes, and by nothing else", () => {
    for (const name of readdirSync(ROUTES)) {
      const text = source(name);
      if (name !== "auth.ts") {
        expect(text, `${name} imports requireSession`).not.toContain("requireSession");
        continue;
      }
      // Every use in auth.ts sits under a path that is /me or /second-factor/*.
      const uses = [...text.matchAll(/\n\s*requireSession,/g)];
      expect(uses.length).toBeGreaterThan(0);
      for (const use of uses) {
        const before = text.slice(0, use.index);
        const path = before.match(/"(\/[^"]*)",\s*$/)?.[1];
        expect(path, `requireSession under ${path}`).toMatch(/^\/(me|second-factor(\/.*)?)$/);
      }
    }
  });

  it("is not what index.ts mounts", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(index).toContain('app.use("/api", requireAuth)');
    expect(index).not.toContain("requireSession");
  });
});
