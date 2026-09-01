/**
 * A shared-passphrase gate in front of the whole prototype.
 *
 * This exists because the alternative access models are both wrong for what
 * this is. Cloud Run's IAM auth needs an OIDC token on every request, which a
 * browser will not send — so an IAM-protected URL is unusable by a person
 * clicking a link. And leaving it open means a page that renders SSN fields
 * and asks for verification consent is reachable by anyone who finds the URL.
 *
 * So: the service is publicly routable, and this decides who gets in.
 *
 * It is deliberately modest. It is a door on a demo, not an authentication
 * system — there are no accounts, no sessions and no audit trail, and it must
 * not become the thing real borrower data sits behind. When this stops being a
 * prototype, it gets deleted and replaced, not extended.
 *
 * Unset `ACCESS_PASSPHRASE` disables it entirely, which is what local dev
 * wants. Fail-OPEN is correct here and would not be if this guarded anything
 * real: a prototype that locks the team out on a bad deploy has failed at its
 * only job.
 */

import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

/** Paths that answer before the gate. Health is probed by infrastructure. */
const OPEN_PATHS = new Set(["/api/health"]);

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function accessGate(passphrase: string | undefined) {
  if (!passphrase) {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    if (OPEN_PATHS.has(req.path)) return next();

    const header = req.get("authorization") ?? "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const supplied = decoded.slice(decoded.indexOf(":") + 1);
      if (safeEqual(supplied, passphrase)) return next();
    }

    res
      .status(401)
      .set("WWW-Authenticate", 'Basic realm="SuperMortgage prototype", charset="UTF-8"')
      .type("text/plain")
      .send("SuperMortgage — prototype. Ask Joe for the passphrase.");
  };
}
