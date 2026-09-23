/**
 * Who is at the console, as the servicing app's own console API says.
 *
 * The console signs in to the servicing app — an e-mailed code, a password,
 * its `sm_staff` cookie — and nothing of ours ever sees that credential.
 * When the console asks OUR API to do something (load a tape into the loans
 * database, mail a claim), "who is asking" is answered the only honest way
 * there is: by forwarding the request's cookie and acting role to the
 * servicing app's `/ops/api/me` and taking what it answers. A staff session
 * is one that names a `staff_user_id`; the header-actor path his console API
 * also admits is read-only by his rule and is refused here.
 *
 * A gate of its own, like `requirePartner`: a borrower's session opens
 * nothing here and this opens nothing below the session gate. It sits on
 * the servicing hostname, where there is no borrower sign-in to confuse it
 * with, and in development on the console's dev proxy.
 */

import type { NextFunction, Request, Response } from "express";
import { IDENTITY_HEADER, type IdentityTokenProvider } from "./google-identity.js";

export interface ConsoleStaff {
  readonly id: string;
  readonly legalName: string | null;
  readonly roles: readonly string[];
  /** The role the servicing app is acting as for this request. */
  readonly role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staff?: ConsoleStaff;
    }
  }
}

/** The roles that may load a tape and mail a claim. Compliance reads; it does not load. */
export const TAPE_ROLES = ["ops_analyst", "officer", "admin"] as const;

export interface ConsoleStaffGateOptions {
  /** The servicing app's origin, no trailing slash. */
  readonly upstream: string;
  readonly fetchImpl?: typeof fetch;
  readonly identityToken?: IdentityTokenProvider;
}

function refuse(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { message, code } });
}

export function consoleStaffGate(opts: ConsoleStaffGateOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const cookie = req.headers.cookie;
    if (!cookie) {
      refuse(res, 401, "STAFF_SIGN_IN_REQUIRED", "Sign in to the console to continue.");
      return;
    }
    const headers: Record<string, string> = { accept: "application/json", cookie };
    const acting = req.headers["x-staff-role"];
    if (typeof acting === "string" && acting) headers["x-staff-role"] = acting;
    const token = opts.identityToken ? await opts.identityToken() : null;
    if (token) headers[IDENTITY_HEADER] = `Bearer ${token}`;

    let me: {
      staff_user_id?: string | null;
      legal_name?: string | null;
      roles?: string[];
      role?: string;
      source?: string;
    };
    try {
      const r = await doFetch(`${opts.upstream}/ops/api/me`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) {
        refuse(res, 401, "STAFF_SIGN_IN_REQUIRED", "Sign in to the console to continue.");
        return;
      }
      me = (await r.json()) as typeof me;
    } catch {
      refuse(res, 502, "UPSTREAM", "The servicing app could not be reached to check your session.");
      return;
    }
    if (!me.staff_user_id || me.source === "header") {
      refuse(res, 401, "STAFF_SIGN_IN_REQUIRED", "Sign in to the console to continue.");
      return;
    }
    const roles = Array.isArray(me.roles) ? me.roles.map(String) : [];
    if (!roles.some((r) => (TAPE_ROLES as readonly string[]).includes(r))) {
      res.status(403).json({
        error: {
          message: `Loading a tape needs one of ${TAPE_ROLES.join(", ")}.`,
          code: "ROLE_REQUIRED",
        },
        act_as: [],
      });
      return;
    }
    req.staff = {
      id: String(me.staff_user_id),
      legalName: me.legal_name ?? null,
      roles,
      role: typeof me.role === "string" && me.role ? me.role : roles[0]!,
    };
    next();
  };
}
