/**
 * RFC 4226 and RFC 6238: the one-time code an authenticator app shows.
 *
 * Hand-rolled rather than a dependency, and that is a considered choice. The
 * whole of the algorithm is one HMAC-SHA1, one truncation and one modulo; the
 * RFCs publish test vectors for both halves, and `totp.test.ts` holds every
 * one of them. A library would be the same forty lines behind a name, plus a
 * base32 package, plus whatever those depend on next year — and the thing
 * this protects is the sign-in, which is the wrong place to inherit a
 * transitive dependency's next advisory.
 *
 * SHA-1 is not a weakness here. HMAC-SHA1 is what every authenticator app
 * speaks by default, its collision problems do not reach an HMAC, and the
 * RFC has no other interoperable option worth the compatibility cost.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 4648 base32, which is what an otpauth URI carries the secret in. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerant of case, spaces, dashes and padding — the ways a key gets typed. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 §5.3: HMAC, dynamic truncation, modulo. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** Which 30-second step a moment falls in. What a code is good for once. */
export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpAt(secret: Buffer, atMs: number, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(atMs), digits);
}

/**
 * The step a code is valid for, or null.
 *
 * One step either side, which is what the RFC suggests and what every phone
 * whose clock drifts a little needs. Returned rather than a boolean because
 * the caller records it: a code is accepted once, and "once" is a comparison
 * against the last step that got in.
 */
export function matchTotp(
  secret: Buffer,
  code: string,
  atMs: number,
  window = 1,
  digits = TOTP_DIGITS,
): number | null {
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return null;
  const base = totpStep(atMs);
  const given = Buffer.from(code);
  for (let delta = -window; delta <= window; delta += 1) {
    const step = base + delta;
    if (step < 0) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step, digits)), given)) return step;
  }
  return null;
}

/** 160 bits, which is what RFC 4226 recommends and what the apps expect. */
export function newSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * The URI a QR code carries. Issuer in both the label and the parameter,
 * because the apps disagree about which one they read.
 */
export function otpauthUri(o: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(o.issuer)}:${encodeURIComponent(o.account)}`;
  const params = new URLSearchParams({
    secret: o.secret,
    issuer: o.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
