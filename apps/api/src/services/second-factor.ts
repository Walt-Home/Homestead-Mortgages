/**
 * The second step of sign-in: a code from an authenticator app.
 *
 * Google proves who somebody is. This proves they are holding the phone they
 * enrolled, and `requireAuth` refuses everything past `/api/auth` until a
 * session has done both. It is enforced rather than offered: the file behind
 * the gate holds twelve months of somebody's bank transactions and their
 * credit report, and a second factor a person can decline is a second factor
 * the person whose password was phished did decline.
 *
 * Three promises, each kept by a column on `user_authenticators`:
 *
 *   - A code is good once. `lastUsedStep` is the 30-second step of the last
 *     code accepted, and nothing at or before it gets in again.
 *   - Guessing is expensive. Five wrong codes in a row lock the row for
 *     fifteen minutes, and the count is on the row rather than the session,
 *     so signing in again does not buy five more.
 *   - Losing the phone is survivable. Eight recovery codes are handed over at
 *     enrollment, each good once, only their hashes kept.
 *
 * The secret itself is AES-256-GCM ciphertext under VENDOR_TOKEN_KEY — the
 * same key and the same reasoning as `vendor-tokens.ts`, because a TOTP
 * secret read out of a backup mints every code from then on. Outside
 * production a fixed development key stands in, the way the session secret
 * has a development fallback; in production `assertAuthConfigured` refuses to
 * boot without the real one.
 */

import { createHash, randomInt } from "node:crypto";
import { prisma } from "@hm/db";
import { config } from "../config.js";
import { AppError } from "../middleware/error-handler.js";
import { decryptToken, encryptToken, loadKey } from "./vendor-tokens.js";
import { base32Decode, matchTotp, newSecret, otpauthUri } from "./totp.js";

/** What the authenticator app files the account under. */
export const ISSUER = "Supermortgage";

export const RECOVERY_CODE_COUNT = 8;
export const LOCK_AFTER_FAILURES = 5;
export const LOCK_MS = 15 * 60 * 1000;

/**
 * Where a session stands. "enroll" and "verify" are the two screens the
 * client can render; "satisfied" is the gate open.
 */
export type SecondFactorStanding = "satisfied" | "enroll" | "verify";

/** The one session field this file reads. Typed narrowly so a test can pass a literal. */
export interface SecondFactorSession {
  secondFactor?: "verified" | "exempt";
}

/**
 * No ambiguous letters — a code read off a printout must not turn on whether
 * that was a one or an el — and no dash, because the dash is formatting.
 */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RECOVERY_LENGTH = 10;

/**
 * Deliberately obvious as a fallback, like `development-only-session-secret`.
 * Never reached in production: `assertAuthConfigured` refuses to boot there
 * without VENDOR_TOKEN_KEY.
 */
const DEVELOPMENT_KEY = createHash("sha256")
  .update("development-only-second-factor-key")
  .digest("base64");

let key: Buffer | undefined;
function secondFactorKey(): Buffer {
  key ??= loadKey(
    config.vendorTokenKey ?? (config.nodeEnv === "production" ? undefined : DEVELOPMENT_KEY),
  );
  return key;
}

export async function secondFactorStanding(
  session: SecondFactorSession | undefined,
  userId: string,
): Promise<SecondFactorStanding> {
  if (session?.secondFactor === "verified" || session?.secondFactor === "exempt") {
    return "satisfied";
  }
  return (await isEnrolled(userId)) ? "verify" : "enroll";
}

export async function isEnrolled(userId: string): Promise<boolean> {
  const row = await prisma.userAuthenticator.findUnique({
    where: { userId },
    select: { userId: true },
  });
  return row !== null;
}

/**
 * A fresh secret and the URI the QR code carries. Nothing is written: the
 * secret rides in the session until a code from it has been seen.
 */
export function beginEnrollment(user: { email: string }): { secret: string; otpauthUri: string } {
  const secret = newSecret();
  return { secret, otpauthUri: otpauthUri({ issuer: ISSUER, account: user.email, secret }) };
}

/**
 * The first code from a new authenticator, and the row it earns.
 *
 * Replaces any authenticator the person already had — this is how a new
 * phone is enrolled — and every recovery code with it, because the old ones
 * were issued alongside a secret that no longer exists. The step the code
 * matched is recorded as used, so the enrollment code cannot also be the
 * first sign-in code.
 */
export async function confirmEnrollment(
  userId: string,
  secret: string,
  code: string,
  now = new Date(),
): Promise<{ recoveryCodes: string[] }> {
  const step = matchTotp(base32Decode(secret), normalizeCode(code), now.getTime());
  if (step === null) {
    throw new AppError(400, "That code did not match.", "WRONG_CODE");
  }
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const secretCiphertext = encryptToken(secret, secondFactorKey());
  await prisma.$transaction(async (tx) => {
    await tx.userAuthenticator.upsert({
      where: { userId },
      create: { userId, secretCiphertext, lastUsedStep: step },
      update: {
        secretCiphertext,
        lastUsedStep: step,
        failedAttempts: 0,
        lockedUntil: null,
        enrolledAt: now,
      },
    });
    await tx.userRecoveryCode.deleteMany({ where: { userId } });
    await tx.userRecoveryCode.createMany({
      data: recoveryCodes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })),
    });
  });
  return { recoveryCodes };
}

/**
 * A code at sign-in: six digits from the app, or a recovery code.
 *
 * Every way to be wrong lands on the same counter — a replayed code, a spent
 * recovery code, a typo — because every one of them is a guess as far as the
 * lock is concerned. Success clears it.
 */
export async function verifySecondFactor(
  userId: string,
  input: string,
  now = new Date(),
): Promise<void> {
  const row = await prisma.userAuthenticator.findUnique({ where: { userId } });
  if (!row) {
    throw new AppError(409, "There is no authenticator to check a code against.", "NOT_ENROLLED");
  }
  if (row.lockedUntil && row.lockedUntil > now) throw locked(row.lockedUntil, now);
  // A lock that has lifted starts the count over; one that never existed
  // carries it.
  const failuresSoFar = row.lockedUntil ? 0 : row.failedAttempts;

  const code = normalizeCode(input);
  if (/^\d{6}$/.test(code)) {
    const secret = base32Decode(decryptToken(row.secretCiphertext, secondFactorKey()));
    const step = matchTotp(secret, code, now.getTime());
    if (step !== null && (row.lastUsedStep === null || step > row.lastUsedStep)) {
      await prisma.userAuthenticator.update({
        where: { userId },
        data: { lastUsedStep: step, failedAttempts: 0, lockedUntil: null },
      });
      return;
    }
  } else {
    // The update IS the check: a code is spent by the one request that finds
    // it unspent, and a second request racing for the same code sees zero.
    const spent = await prisma.userRecoveryCode.updateMany({
      where: { userId, codeHash: hashRecoveryCode(code), usedAt: null },
      data: { usedAt: now },
    });
    if (spent.count === 1) {
      await prisma.userAuthenticator.update({
        where: { userId },
        data: { failedAttempts: 0, lockedUntil: null },
      });
      return;
    }
  }

  const failedAttempts = failuresSoFar + 1;
  const lockedUntil =
    failedAttempts >= LOCK_AFTER_FAILURES ? new Date(now.getTime() + LOCK_MS) : null;
  await prisma.userAuthenticator.update({
    where: { userId },
    data: { failedAttempts, lockedUntil },
  });
  if (lockedUntil) throw locked(lockedUntil, now);
  throw new AppError(401, "That code did not match.", "WRONG_CODE");
}

/** How many recovery codes are still good. What the privacy page reports. */
export async function recoveryCodesRemaining(userId: string): Promise<number> {
  return prisma.userRecoveryCode.count({ where: { userId, usedAt: null } });
}

function locked(until: Date, now: Date): AppError {
  const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
  return new AppError(
    429,
    `Too many wrong codes. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    "SECOND_FACTOR_LOCKED",
  );
}

/** Lowercase, and only the characters a code is made of: spaces and dashes are how people type them. */
export function normalizeCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function newRecoveryCode(): string {
  let code = "";
  for (let i = 0; i < RECOVERY_LENGTH; i += 1) {
    code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeCode(code)).digest("hex");
}
