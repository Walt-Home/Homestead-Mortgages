/**
 * The partner portal's gate: a servicer's team member, signed in with both
 * factors. Reads `session.servicerUserId` and nothing else — a borrower's
 * session carries `userId`, which this never looks at, so a borrower opens
 * nothing here; and `requireAuth` never looks at `servicerUserId`, so a
 * member opens nothing of the borrower app. `servicer-portal.test.ts`
 * holds both.
 */

import type { NextFunction, Request, Response } from "express";
import { prisma } from "@hm/db";
import type { ServicerUser } from "@hm/db";

export interface SignedInServicerUser extends ServicerUser {
  readonly servicer: { readonly id: string; readonly slug: string; readonly displayName: string };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      servicerUser?: SignedInServicerUser;
    }
  }
}

export async function requireServicerUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const id = req.session?.servicerUserId;
  const user = id
    ? await prisma.servicerUser.findFirst({
        where: { id, acceptedAt: { not: null }, disabledAt: null },
        include: { servicer: { select: { id: true, slug: true, displayName: true } } },
      })
    : null;
  if (!user) {
    if (id) {
      // The session outlived the membership. Drop it rather than keep a
      // cookie that fails this lookup on every request.
      delete req.session.servicerUserId;
    }
    res.status(401).json({ error: { message: "Sign in to continue.", code: "SIGN_IN_REQUIRED" } });
    return;
  }
  req.servicerUser = user;
  next();
}
