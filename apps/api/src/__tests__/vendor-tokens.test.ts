/**
 * The vendor credential store.
 *
 * What is being protected: a Plaid access token reads a named person's bank
 * transactions on demand, for as long as the item lives. These tests exist so
 * that "encrypted at rest" is a property of the code rather than a claim in a
 * comment.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@hm/db";
import {
  decryptToken,
  encryptToken,
  vendorTokenStore,
  VendorTokenKeyError,
} from "../services/vendor-tokens.js";

const key = randomBytes(32);
const keyB64 = key.toString("base64");

/** Just enough Prisma to exercise the store. */
function fakePrisma() {
  const rows = new Map<string, { ciphertext: string }>();
  const prisma = {
    vendorToken: {
      findUnique: vi.fn(
        async ({ where }: { where: { loanFileId_key: { loanFileId: string; key: string } } }) => {
          const { loanFileId, key: k } = where.loanFileId_key;
          return rows.get(`${loanFileId}:${k}`) ?? null;
        },
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { loanFileId_key: { loanFileId: string; key: string } };
          create: { ciphertext: string };
        }) => {
          const { loanFileId, key: k } = where.loanFileId_key;
          rows.set(`${loanFileId}:${k}`, { ciphertext: create.ciphertext });
        },
      ),
    },
  } as unknown as PrismaClient;
  return { prisma, rows };
}

describe("vendor token encryption", () => {
  it("round-trips a token", () => {
    const sealed = encryptToken("access-sandbox-abc", key);
    expect(decryptToken(sealed, key)).toBe("access-sandbox-abc");
  });

  it("never stores the plaintext", () => {
    const sealed = encryptToken("access-sandbox-abc", key);
    expect(sealed).not.toContain("access-sandbox-abc");
    expect(sealed.split(":")).toHaveLength(3);
  });

  it("produces a different ciphertext each time", () => {
    // A fixed IV would leak that two files hold the same token, and worse,
    // would leak the XOR of two plaintexts in a stream cipher mode.
    expect(encryptToken("same", key)).not.toBe(encryptToken("same", key));
  });

  it("refuses a tampered ciphertext rather than returning altered bytes", () => {
    // GCM rather than CBC: the point is that this throws.
    const [iv, tag, ct] = encryptToken("access-sandbox-abc", key).split(":") as [
      string,
      string,
      string,
    ];
    const flipped = Buffer.from(ct, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => decryptToken([iv, tag, flipped.toString("base64")].join(":"), key)).toThrow();
  });

  it("refuses another key's ciphertext", () => {
    const sealed = encryptToken("access-sandbox-abc", key);
    expect(() => decryptToken(sealed, randomBytes(32))).toThrow();
  });
});

describe("vendor token store", () => {
  it("refuses to construct without a key, rather than storing plaintext", () => {
    const { prisma } = fakePrisma();
    expect(() => vendorTokenStore(prisma, undefined)).toThrow(VendorTokenKeyError);
    expect(() => vendorTokenStore(prisma, Buffer.from("too short").toString("base64"))).toThrow(
      VendorTokenKeyError,
    );
  });

  it("stores ciphertext and reads back plaintext", async () => {
    const { prisma, rows } = fakePrisma();
    const store = vendorTokenStore(prisma, keyB64);

    await store.put("file-1", "plaid.access_token", "access-sandbox-abc");
    expect([...rows.values()][0]!.ciphertext).not.toContain("access-sandbox-abc");
    expect(await store.get("file-1", "plaid.access_token")).toBe("access-sandbox-abc");
  });

  it("keeps one file's token away from another's", async () => {
    const { prisma } = fakePrisma();
    const store = vendorTokenStore(prisma, keyB64);
    await store.put("file-1", "plaid.access_token", "one");
    expect(await store.get("file-2", "plaid.access_token")).toBeNull();
  });

  it("reads an undecryptable row as absent, so a rotated key sends the borrower back through Link", async () => {
    const { prisma, rows } = fakePrisma();
    const store = vendorTokenStore(prisma, keyB64);
    await store.put("file-1", "plaid.access_token", "one");
    rows.set("file-1:plaid.access_token", { ciphertext: "garbage" });

    // Not a throw: a borrower stranded on a screen that cannot recover is a
    // worse outcome than one asked to reconnect their bank.
    expect(await store.get("file-1", "plaid.access_token")).toBeNull();
  });
});
