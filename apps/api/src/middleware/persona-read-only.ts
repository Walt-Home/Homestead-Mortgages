/**
 * A sample borrower can be looked at and nothing else.
 *
 * The file rule already refuses writes to a demo file, and every persona file
 * is one — but that rule can only see a file. It cannot see a persona POSTing
 * `/api/files` to start a file of its own, which would be an ordinary
 * non-demo file that the persona then owns and may edit, and it cannot see the
 * routes that take no file id at all. So the session gets its own gate: while
 * signed in as a sample borrower, nothing is a write.
 *
 * Mounted once, on the line after the authentication gate, so a router added
 * later cannot forget it. The refusal is uniform — it says nothing about
 * whether the thing being written to exists — so it is not an oracle for ids.
 *
 * `/api/auth/*` is mounted before this: signing out has to stay possible, and
 * `DELETE /me` carries the same refusal itself.
 */

import type { NextFunction, Request, Response } from "express";

/** Methods that change nothing. Everything else is refused for a persona. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export function personaReadOnly(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.personaKey || READS.has(req.method)) {
    next();
    return;
  }
  res.status(403).json({
    error: {
      message: "This is a sample borrower. Nothing can be changed while signed in as one.",
      code: "PERSONA_READ_ONLY",
    },
  });
}
