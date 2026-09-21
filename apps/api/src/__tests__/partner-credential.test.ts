/**
 * A partner is a key, not a sign-in.
 *
 * The session tests stub the session because the session is not what they are
 * about. Here the gate IS the subject, so these stand up express with the
 * partner router where `index.ts` mounts it, the session gate below it with a
 * probe behind, and drive both with real headers — a key, a stubbed session,
 * neither, both — against the real Postgres.
 */

import express, { type Express } from "express";
import { readFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { errorHandler } from "../middleware/error-handler.js";
import { requireAuth } from "../middleware/require-auth.js";
import { partnerRouter } from "../routes/partner.js";
import {
  authenticatePartnerKey,
  hashPartnerKey,
  issuePartnerCredential,
  looksLikePartnerKey,
  mintPartnerKey,
  PARTNER_KEY_PREFIX,
  revokePartnerCredential,
} from "../services/partner-credentials.js";
import { createUser } from "./support/factories.js";

let seq = 0;
async function createServicer(slug = `northlight-${Date.now().toString(36)}-${(seq += 1)}`) {
  return prisma.servicer.create({
    data: { slug, displayName: "Northlight Mortgage Servicing" },
    select: { id: true, slug: true },
  });
}

interface Reply<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/** The two gates as `index.ts` arranges them, with a probe behind each. */
async function serve(stubSessionFor?: { id: string }) {
  const app: Express = express();
  app.use(express.json());
  if (stubSessionFor) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: stubSessionFor.id } });
    app.use((req, _res, next) => {
      req.user = user;
      (req as unknown as { session: Record<string, unknown> }).session = {
        userId: user.id,
        secondFactor: "verified",
        destroy: (cb: () => void) => cb(),
        regenerate: (cb: () => void) => cb(),
      };
      next();
    });
  }
  app.use("/api/partner", partnerRouter);
  app.use("/api", requireAuth);
  app.get("/api/probe", (req, res) => {
    res.json({ userId: req.user!.id });
  });
  app.use(errorHandler);

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  function call<T = Record<string, unknown>>(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Reply<T>> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "GET", path, headers, agent: false },
        (res) => {
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
      req.end();
    });
  }

  return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe("issuing a key", () => {
  it("prints a key once and keeps only its hash, under the servicer's PARTNER principal", async () => {
    const servicer = await createServicer();
    const issued = await issuePartnerCredential(prisma, {
      servicerId: servicer.id,
      label: "tape drop, september",
    });

    expect(issued.key.startsWith(PARTNER_KEY_PREFIX)).toBe(true);
    expect(looksLikePartnerKey(issued.key)).toBe(true);

    const row = await prisma.partnerCredential.findUniqueOrThrow({
      where: { id: issued.id },
      include: { principal: true },
    });
    expect(row.keyHash).toBe(hashPartnerKey(issued.key));
    expect(row.keyHash).not.toContain(issued.key.slice(PARTNER_KEY_PREFIX.length, 20));
    expect(row.principal.kind).toBe("PARTNER");
    expect(row.principal.subject).toBe(servicer.slug);
    expect(row.revokedAt).toBeNull();
    expect(row.lastUsedAt).toBeNull();
  });

  it("refuses a key with no label", async () => {
    const servicer = await createServicer();
    await expect(
      issuePartnerCredential(prisma, { servicerId: servicer.id, label: "  " }),
    ).rejects.toThrow(/label/);
  });

  it("lets one servicer hold two live keys, on one principal", async () => {
    const servicer = await createServicer();
    const a = await issuePartnerCredential(prisma, { servicerId: servicer.id, label: "a" });
    const b = await issuePartnerCredential(prisma, { servicerId: servicer.id, label: "b" });
    expect(a.key).not.toBe(b.key);
    const rows = await prisma.partnerCredential.findMany({ where: { servicerId: servicer.id } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.principalId)).size).toBe(1);
  });

  it("mints keys that are the shape the gate accepts, and nothing shorter is", () => {
    expect(looksLikePartnerKey(mintPartnerKey())).toBe(true);
    expect(looksLikePartnerKey("hm_pk_short")).toBe(false);
    expect(looksLikePartnerKey("Bearer hm_pk_x")).toBe(false);
    expect(looksLikePartnerKey("")).toBe(false);
  });
});

describe("authenticating a key", () => {
  it("answers the servicer behind a live key and records the use", async () => {
    const servicer = await createServicer();
    const { key, id } = await issuePartnerCredential(prisma, {
      servicerId: servicer.id,
      label: "x",
    });

    const actor = await authenticatePartnerKey(prisma, key);
    expect(actor?.servicerSlug).toBe(servicer.slug);
    expect(actor?.credentialId).toBe(id);
    expect(actor?.integrationDepth).toBe("NONE");

    const row = await prisma.partnerCredential.findUniqueOrThrow({ where: { id } });
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("answers null for a malformed key, an unknown key and a revoked key alike", async () => {
    const servicer = await createServicer();
    const { key, id } = await issuePartnerCredential(prisma, {
      servicerId: servicer.id,
      label: "x",
    });

    expect(await authenticatePartnerKey(prisma, "not a key")).toBeNull();
    expect(await authenticatePartnerKey(prisma, mintPartnerKey())).toBeNull();

    await revokePartnerCredential(prisma, id);
    expect(await authenticatePartnerKey(prisma, key)).toBeNull();
    // And again: revoking a revoked key is nothing, not an error.
    await revokePartnerCredential(prisma, id);
  });
});

describe("the database", () => {
  it("never un-revokes a key", async () => {
    const servicer = await createServicer();
    const { id } = await issuePartnerCredential(prisma, { servicerId: servicer.id, label: "x" });
    await revokePartnerCredential(prisma, id);
    await expect(
      prisma.$executeRaw`UPDATE partner_credentials SET revoked_at = NULL WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/stays revoked/);
  });

  it("never lets a row become another key or another servicer's", async () => {
    const servicer = await createServicer();
    const other = await createServicer();
    const { id } = await issuePartnerCredential(prisma, { servicerId: servicer.id, label: "x" });
    const otherHash = hashPartnerKey(mintPartnerKey());
    await expect(
      prisma.$executeRaw`UPDATE partner_credentials SET key_hash = ${otherHash} WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/mint one/);
    await expect(
      prisma.$executeRaw`UPDATE partner_credentials SET servicer_id = ${other.id}::uuid WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/mint one/);
  });

  it("keeps a servicer that holds keys", async () => {
    const servicer = await createServicer();
    await issuePartnerCredential(prisma, { servicerId: servicer.id, label: "x" });
    await expect(prisma.servicer.delete({ where: { id: servicer.id } })).rejects.toThrow();
  });
});

describe("the gate", () => {
  it("refuses a request with no key, naming what would fix it", async () => {
    const s = await serve();
    try {
      const r = await s.call<{ error: { code: string } }>("/api/partner/me");
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("PARTNER_KEY_REQUIRED");
    } finally {
      await s.close();
    }
  });

  it("refuses a key we did not issue, and a revoked one, in the same words", async () => {
    const servicer = await createServicer();
    const { key, id } = await issuePartnerCredential(prisma, {
      servicerId: servicer.id,
      label: "x",
    });
    const s = await serve();
    try {
      const stranger = await s.call<{ error: { code: string } }>(
        "/api/partner/me",
        bearer(mintPartnerKey()),
      );
      expect(stranger.status).toBe(401);
      expect(stranger.body.error.code).toBe("PARTNER_KEY_INVALID");

      await revokePartnerCredential(prisma, id);
      const revoked = await s.call<{ error: { code: string } }>("/api/partner/me", bearer(key));
      expect(revoked.status).toBe(401);
      expect(revoked.body.error).toEqual(stranger.body.error);
    } finally {
      await s.close();
    }
  });

  it("opens the partner prefix to a live key", async () => {
    const servicer = await createServicer();
    const { key, id } = await issuePartnerCredential(prisma, {
      servicerId: servicer.id,
      label: "x",
    });
    const s = await serve();
    try {
      const r = await s.call<{
        servicer: { slug: string; integrationDepth: string };
        credential: { id: string; label: string };
      }>("/api/partner/me", bearer(key));
      expect(r.status).toBe(200);
      expect(r.body.servicer.slug).toBe(servicer.slug);
      expect(r.body.servicer.integrationDepth).toBe("NONE");
      expect(r.body.credential).toEqual({ id, label: "x" });
    } finally {
      await s.close();
    }
  });

  it("does not open anything past the prefix to a key", async () => {
    const servicer = await createServicer();
    const { key } = await issuePartnerCredential(prisma, { servicerId: servicer.id, label: "x" });
    const s = await serve();
    try {
      const r = await s.call<{ error: { code: string } }>("/api/probe", bearer(key));
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("SIGN_IN_REQUIRED");
    } finally {
      await s.close();
    }
  });

  it("does not open the prefix to a signed-in person", async () => {
    const user = await createUser();
    const s = await serve(user);
    try {
      // The session opens the probe, which proves the stub is a session...
      expect((await s.call("/api/probe")).status).toBe(200);
      // ...and it opens nothing under /api/partner, because a person is not a partner.
      const r = await s.call<{ error: { code: string } }>("/api/partner/me");
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("PARTNER_KEY_REQUIRED");
    } finally {
      await s.close();
    }
  });

  it("is mounted in index.ts above the session gate, and nothing else is", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const partner = index.indexOf('app.use("/api/partner", partnerRouter)');
    const gate = index.indexOf('app.use("/api", requireAuth)');
    expect(partner).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(partner).toBeLessThan(gate);
    // Everything mounted above the gate is one of: health, auth, partner.
    const above = index.slice(0, gate).match(/app\.use\("\/api\/[^"]*"/g) ?? [];
    expect(above.map((m) => m.slice(9, -1)).sort()).toEqual(
      ["/api/auth", "/api/health", "/api/partner"].sort(),
    );
  });
});
