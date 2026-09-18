/**
 * Server-side sessions, in Postgres.
 *
 * A stateless signed cookie would have been less code, and it would also mean
 * no way to sign anybody out — a token stays valid until it expires no matter
 * what happens to the account behind it. For something that will eventually
 * front borrower files, the ability to end a session has to exist before it is
 * needed, so the session lives in the database and the cookie is only a key.
 */

import connectPgSimple from "connect-pg-simple";
import session from "express-session";
import type { RequestHandler } from "express";
import { config } from "../config.js";

declare module "express-session" {
  interface SessionData {
    userId?: string;
    /**
     * Where the second step of sign-in stands for THIS session.
     *
     * Unset is the state a Google sign-in leaves it in: somebody has proven
     * who they are and not yet that they hold their phone, and `requireAuth`
     * refuses everything past `/api/auth` until they do. "verified" is a code
     * accepted in this session. "exempt" is a session minted for a sample
     * borrower or the local developer — neither is a person with a phone to
     * enroll, and both are already refused every write or unreachable in
     * production.
     */
    secondFactor?: "verified" | "exempt";
    /**
     * An enrollment in progress: the secret the QR code encodes, held here
     * and not in a row until a code from it has been seen. A half-enrolled
     * row would lock its owner out with an authenticator they never finished
     * adding.
     */
    pendingAuthenticatorSecret?: string;
  }
}

export function sessionMiddleware(): RequestHandler {
  const PgStore = connectPgSimple(session);

  return session({
    name: "hm.sid",
    secret: config.sessionSecret,
    store: new PgStore({
      conString: config.databaseUrl,
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      // Secure in production only — a secure cookie is never sent over the
      // plain-HTTP localhost origin the dev server uses, which would make
      // sign-in silently impossible locally.
      secure: config.nodeEnv === "production",
      // `lax` and not `none`: the SPA is same-origin with the API in
      // production, so nothing needs cross-site cookies, and `none` would
      // hand this session to any site that can make a request.
      sameSite: "lax",
      maxAge: 12 * 60 * 60 * 1000,
    },
  });
}
