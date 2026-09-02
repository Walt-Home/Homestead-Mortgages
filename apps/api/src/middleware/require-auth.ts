/**
 * The authentication gate.
 *
 * Refuses with a machine-readable code rather than a bare 401 so the client
 * can route to sign-in instead of guessing from a status number. Mirrors the
 * shape the connector guard uses for APP-005 — a refusal should always say
 * what would fix it.
 */

import type { NextFunction, Request, Response } from "express";
import { prisma } from "@hm/db";
import type { User } from "@hm/db";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: { message: "Sign in to continue.", code: "SIGN_IN_REQUIRED" } });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    // The session outlived the account. Destroy it rather than leaving a
    // cookie that will fail this lookup on every future request.
    req.session.destroy(() => undefined);
    res.status(401).json({ error: { message: "Sign in to continue.", code: "SIGN_IN_REQUIRED" } });
    return;
  }

  req.user = user;
  next();
}
