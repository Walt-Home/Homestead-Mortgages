/**
 * Google sign-in.
 *
 * The only identity source. There is no password column in this schema and
 * there must never be one — a mortgage prototype is not the place to start
 * storing credentials, and Google already knows who works here.
 *
 * Who may sign in is decided in two places, and only one of them is here:
 *
 *   1. The OAuth consent screen. It is currently External and published, so
 *      Google will mint a token for any Google account. Making it Internal
 *      again would restrict it to the Workspace before we ever see a token.
 *   2. `assertAllowedDomain`, which narrows further — but only when
 *      ALLOWED_DOMAIN is set, and it is deliberately unset today.
 *
 * `verifyIdToken` checks the audience against our client id, so a token minted
 * for a different app is rejected. That is not an audience restriction on
 * people; it says nothing about who the signer is.
 *
 * The upshot worth being clear-eyed about: sign-in is currently open to the
 * world, and what protects a person's data is ownership (see assertFileAccess),
 * not the front door.
 */

import { OAuth2Client } from "google-auth-library";
import { prisma } from "@hm/db";
import type { User } from "@hm/db";
import { config } from "../config.js";
import { AppError } from "../middleware/error-handler.js";

let client: OAuth2Client | undefined;

function oauthClient(): OAuth2Client {
  if (!config.googleClientId) {
    throw new AppError(
      500,
      "GOOGLE_CLIENT_ID is not configured; sign-in cannot work.",
      "AUTH_NOT_CONFIGURED",
    );
  }
  client ??= new OAuth2Client(config.googleClientId);
  return client;
}

function assertAllowedDomain(email: string, hostedDomain: string | undefined): void {
  const allowed = config.allowedDomain;
  if (!allowed) return;
  const domain = hostedDomain ?? email.split("@")[1];
  if (domain?.toLowerCase() !== allowed.toLowerCase()) {
    throw new AppError(403, `Sign-in is limited to ${allowed} accounts.`, "DOMAIN_NOT_ALLOWED");
  }
}

/**
 * Verify a Google ID token and return the matching user, creating one on
 * first sign-in. Throws rather than returning null — every failure here is a
 * refusal the caller must surface, not a condition to branch on.
 */
export async function signInWithGoogle(credential: string): Promise<User> {
  const ticket = await oauthClient()
    .verifyIdToken({ idToken: credential, audience: config.googleClientId! })
    .catch(() => {
      throw new AppError(401, "Could not verify that Google sign-in.", "INVALID_CREDENTIAL");
    });

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new AppError(401, "Google sign-in returned no identity.", "INVALID_CREDENTIAL");
  }
  // An unverified address on a Workspace account should be impossible, but the
  // claim is there to be checked and the cost of checking it is one line.
  if (payload.email_verified === false) {
    throw new AppError(403, "That Google address is not verified.", "EMAIL_NOT_VERIFIED");
  }
  assertAllowedDomain(payload.email, payload.hd);

  return prisma.user.upsert({
    where: { googleSub: payload.sub },
    create: {
      googleSub: payload.sub,
      email: payload.email,
      name: payload.name ?? null,
      pictureUrl: payload.picture ?? null,
      hostedDomain: payload.hd ?? null,
    },
    // Name and picture drift; email can change on a Workspace rename. The
    // subject claim is what identity is keyed on, so all three are refreshed.
    update: {
      email: payload.email,
      name: payload.name ?? null,
      pictureUrl: payload.picture ?? null,
      hostedDomain: payload.hd ?? null,
      lastSeenAt: new Date(),
    },
  });
}

/**
 * The development-only escape hatch.
 *
 * Creating an OAuth client is a console task, so without this nobody can run
 * the app locally until that is done. It is gated on NODE_ENV !== production
 * AND on the absence of a client id, and `assertAuthConfigured` refuses to let
 * the server boot in production without real credentials — so there is no
 * configuration in which this path is reachable on a deployed instance.
 */
export async function signInAsLocalDeveloper(): Promise<User> {
  if (config.nodeEnv === "production") {
    throw new AppError(500, "Developer sign-in is not available.", "NOT_AVAILABLE");
  }
  const email = "dev@localhost";
  return prisma.user.upsert({
    where: { googleSub: "local-developer" },
    create: { googleSub: "local-developer", email, name: "Local Developer" },
    update: { lastSeenAt: new Date() },
  });
}

/**
 * Fail at boot rather than at first sign-in.
 *
 * A production deploy with no client id would start happily, serve the sign-in
 * page, and reject every attempt — looking like a Google outage rather than a
 * missing environment variable.
 */
export function assertAuthConfigured(): void {
  if (config.nodeEnv === "production" && !config.googleClientId) {
    throw new Error(
      "GOOGLE_CLIENT_ID must be set in production. Sign-in is the only way in, " +
        "so starting without it would serve a door that never opens.",
    );
  }
}
