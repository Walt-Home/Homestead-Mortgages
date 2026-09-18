/**
 * The authentication gate, in two strengths.
 *
 * `requireAuth` is the one `index.ts` mounts over everything past `/api/auth`:
 * a session, a user behind it, AND the second step of sign-in done. That is
 * the default because it is the safe default — a router that forgets to ask
 * for the weaker gate gets the stronger one.
 *
 * `requireSession` is the weaker one: a session and a user, nothing about the
 * second factor. It exists for the handful of routes a person needs BEFORE
 * they have presented a code — `/me`, so the client can learn which screen to
 * show, and the second-factor routes themselves, which are how the code gets
 * presented. Nothing else may use it, and `second-factor.test.ts` reads
 * `routes/auth.ts` to hold that.
 *
 * Refuses with a machine-readable code rather than a bare 401 so the client
 * can route to the right screen instead of guessing from a status number.
 * Mirrors the shape the connector guard uses for APP-005 — a refusal should
 * always say what would fix it.
 */

import type { NextFunction, Request, Response } from "express";
import { prisma } from "@hm/db";
import type { User } from "@hm/db";
import { secondFactorStanding } from "../services/second-factor.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/** The user the session names, or null with the session destroyed. */
async function sessionUser(req: Request): Promise<User | null> {
  const userId = req.session?.userId;
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    // The session outlived the account. Destroy it rather than leaving a
    // cookie that will fail this lookup on every future request.
    req.session.destroy(() => undefined);
    return null;
  }
  return user;
}

function signInRequired(res: Response): void {
  res.status(401).json({ error: { message: "Sign in to continue.", code: "SIGN_IN_REQUIRED" } });
}

export async function requireSession(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = await sessionUser(req);
  if (!user) {
    signInRequired(res);
    return;
  }
  req.user = user;
  next();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await sessionUser(req);
  if (!user) {
    signInRequired(res);
    return;
  }

  const standing = await secondFactorStanding(req.session, user.id);
  if (standing !== "satisfied") {
    // Still a 401: the person is identified, not yet authenticated. The code
    // says which of the two screens finishes it.
    res.status(401).json({
      error:
        standing === "enroll"
          ? {
              message: "Set up an authenticator app to continue.",
              code: "SECOND_FACTOR_ENROLLMENT_REQUIRED",
            }
          : {
              message: "Enter the code from your authenticator app to continue.",
              code: "SECOND_FACTOR_REQUIRED",
            },
    });
    return;
  }

  req.user = user;
  next();
}
