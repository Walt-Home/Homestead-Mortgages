/**
 * The gate for a partner, which is not a person.
 *
 * `requireAuth` asks for a session, a user and the second step of sign-in.
 * None of those exists for a servicer's integration: it holds a bearer key
 * minted by `partner:key`, and this gate asks for that and nothing else. It
 * does not read the session at all, so a signed-in person is refused here
 * exactly as an anonymous request is — a person is not a partner, whatever
 * else they are — and `index.ts` mounts it on `/api/partner` before the
 * session gate, so a key opens that prefix and nothing past it.
 *
 * Two refusals, both 401, both with a code the caller can act on: no key was
 * presented, or the one presented is not one we honor. Unknown and revoked
 * are the same refusal on purpose; see `authenticatePartnerKey`.
 */

import type { NextFunction, Request, Response } from "express";
import { prisma } from "@hm/db";
import { authenticatePartnerKey, type PartnerActor } from "../services/partner-credentials.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      partner?: PartnerActor;
    }
  }
}

export async function requirePartner(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const presented = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "")?.[1];
  if (!presented) {
    res.status(401).json({
      error: { message: "Present a partner key as a bearer token.", code: "PARTNER_KEY_REQUIRED" },
    });
    return;
  }
  const actor = await authenticatePartnerKey(prisma, presented);
  if (!actor) {
    res.status(401).json({
      error: {
        message: "That partner key is not one we issued, or it has been revoked.",
        code: "PARTNER_KEY_INVALID",
      },
    });
    return;
  }
  req.partner = actor;
  next();
}
