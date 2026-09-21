/**
 * A partner's way in.
 *
 * A servicer that sends us its book authenticates with a bearer key, not a
 * session: it is a machine, it has no Google account and no phone to enroll,
 * and the second step of sign-in would be a step nothing could take. The key
 * is minted here, printed once by the `partner:key` command, and never stored
 * — the row keeps its SHA-256, exactly as `invitations.ts` keeps a token's, so
 * a copy of the table is not a way in.
 *
 * What a key authenticates AS is the PARTNER principal `partnerPrincipal`
 * mints for the servicer's slug. That is deliberate rather than convenient: a
 * loan the key imports is then caused by a principal the loan ledger already
 * has a word for, and `loan_transitions.actor_principal_id` never has to learn
 * a second one.
 */

import { createHash, randomBytes } from "node:crypto";
import type { IntegrationDepth } from "@hm/db";
import { type Db } from "./db.js";
import { partnerPrincipal } from "./party.js";

/**
 * Keys are recognizable on sight. A leaked one in a log or a scanner's output
 * is findable by this prefix, which a random string would not be.
 */
export const PARTNER_KEY_PREFIX = "hm_pk_";
const KEY_SHAPE = /^hm_pk_[A-Za-z0-9_-]{43}$/;

/** 256 bits of randomness behind the prefix, url-safe so it survives a shell. */
export function mintPartnerKey(): string {
  return PARTNER_KEY_PREFIX + randomBytes(32).toString("base64url");
}

export function hashPartnerKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Whether a string is even the shape of a key, before any lookup. */
export function looksLikePartnerKey(s: string): boolean {
  return KEY_SHAPE.test(s);
}

/** Who a request is, once a key has opened it. */
export interface PartnerActor {
  readonly credentialId: string;
  readonly label: string;
  readonly servicerId: string;
  readonly servicerSlug: string;
  readonly servicerDisplayName: string;
  readonly integrationDepth: IntegrationDepth;
  /** The PARTNER principal every write under this key is attributed to. */
  readonly principalId: string;
}

/**
 * Issue a key for a servicer. The key comes back exactly once, to be printed;
 * only its hash is written.
 *
 * Not a transaction on purpose: `partnerPrincipal` is insert-then-read and
 * idempotent, so a failure after it leaves a principal that was going to exist
 * anyway and no half-made credential.
 */
export async function issuePartnerCredential(
  db: Db,
  args: { servicerId: string; label: string },
): Promise<{ id: string; key: string }> {
  const label = args.label.trim();
  if (!label)
    throw new Error("a partner key needs a label, so it can be told apart when it is revoked");
  const servicer = await db.servicer.findUniqueOrThrow({
    where: { id: args.servicerId },
    select: { slug: true },
  });
  const principalId = await partnerPrincipal(db, servicer.slug);
  const key = mintPartnerKey();
  const row = await db.partnerCredential.create({
    data: { servicerId: args.servicerId, principalId, keyHash: hashPartnerKey(key), label },
    select: { id: true },
  });
  return { id: row.id, key };
}

/**
 * Revoke a key. Idempotent: revoking a revoked key changes nothing, and the
 * database refuses the one thing this must never do, which is clear the
 * column again.
 */
export async function revokePartnerCredential(db: Db, credentialId: string): Promise<void> {
  await db.partnerCredential.updateMany({
    where: { id: credentialId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * The actor behind a presented key, or null.
 *
 * Null for a malformed key, an unknown key and a revoked key alike. The three
 * are one refusal on the wire, because "this key used to work" is a fact
 * about our issuance that a stranger holding a stolen key has no business
 * learning.
 */
export async function authenticatePartnerKey(db: Db, key: string): Promise<PartnerActor | null> {
  if (!looksLikePartnerKey(key)) return null;
  const row = await db.partnerCredential.findUnique({
    where: { keyHash: hashPartnerKey(key) },
    select: {
      id: true,
      label: true,
      principalId: true,
      revokedAt: true,
      servicer: { select: { id: true, slug: true, displayName: true, integrationDepth: true } },
    },
  });
  if (!row || row.revokedAt) return null;
  await db.partnerCredential.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date() },
    select: { id: true },
  });
  return {
    credentialId: row.id,
    label: row.label,
    servicerId: row.servicer.id,
    servicerSlug: row.servicer.slug,
    servicerDisplayName: row.servicer.displayName,
    integrationDepth: row.servicer.integrationDepth,
    principalId: row.principalId,
  };
}
