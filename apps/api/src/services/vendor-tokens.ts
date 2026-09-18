/**
 * Where a vendor's bearer credentials live.
 *
 * The port that needs this carries a warning, and it is not decoration. A
 * Plaid `access_token` reads a named person's bank transactions on demand, for
 * as long as the item lives, with no further action by them. A leaked row here
 * is worse than a leaked session cookie: the cookie expires and the person can
 * sign out, and this does neither.
 *
 * So: AES-256-GCM, with the key in Secret Manager rather than in the database
 * that holds the ciphertext. GCM rather than CBC because it authenticates —
 * a tampered row fails to decrypt instead of yielding a token of somebody
 * else's choosing.
 *
 * The key is not optional. `plaidTokenStore` refuses to construct without one,
 * which turns "we forgot to set VENDOR_TOKEN_KEY in staging" into a boot
 * failure rather than a table of plaintext bank credentials.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { PrismaClient } from "@hm/db";
import type { VendorTokenStore } from "@hm/connectors";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM's standard nonce length.

export class VendorTokenKeyError extends Error {}

/**
 * Exported for the authenticator secrets, which are the same kind of thing —
 * a credential that mints access on demand — and are kept under the same key
 * by the same cipher. See `services/second-factor.ts`.
 */
export function loadKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new VendorTokenKeyError(
      "VENDOR_TOKEN_KEY is not set. It encrypts vendor bank credentials at rest " +
        "and has no safe default. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new VendorTokenKeyError(
      `VENDOR_TOKEN_KEY decoded to ${key.length} bytes; AES-256 needs 32. ` +
        "It must be base64 of 32 random bytes.",
    );
  }
  return key;
}

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString("base64")).join(":");
}

export function decryptToken(stored: string, key: Buffer): string {
  const [iv, tag, ciphertext] = stored.split(":").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !ciphertext) {
    throw new Error("Stored vendor token is not in iv:tag:ciphertext form.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function vendorTokenStore(
  prisma: PrismaClient,
  rawKey: string | undefined,
): VendorTokenStore {
  const key = loadKey(rawKey);

  return {
    async get(loanFileId, tokenKey) {
      const row = await prisma.vendorToken.findUnique({
        where: { loanFileId_key: { loanFileId, key: tokenKey } },
      });
      if (!row) return null;
      try {
        return decryptToken(row.ciphertext, key);
      } catch {
        // A row that will not decrypt is a rotated key or a tampered row.
        // Either way the credential is unusable, and "no token" sends the
        // borrower back through Link — which works — where a thrown error
        // would strand them on a screen that cannot recover.
        return null;
      }
    },

    async put(loanFileId, tokenKey, value) {
      const ciphertext = encryptToken(value, key);
      await prisma.vendorToken.upsert({
        where: { loanFileId_key: { loanFileId, key: tokenKey } },
        create: { loanFileId, key: tokenKey, ciphertext },
        update: { ciphertext },
      });
    },
  };
}
