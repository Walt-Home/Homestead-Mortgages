import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AuthorizationError, PlaidRequestError } from "@hm/connectors";

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  // An authorization failure is a 403 with the requirement id attached, not a
  // generic error. The client's job is to route the borrower to the consent
  // step, and it can only do that if the response says which consent.
  if (err instanceof AuthorizationError) {
    res.status(403).json({
      error: {
        message: err.message,
        code: "AUTHORIZATION_REQUIRED",
        requirementId: err.requirementId,
      },
    });
    return;
  }
  /**
   * A vendor error is not our server failing.
   *
   * Two of Plaid's are recoverable by the borrower doing the thing again, and
   * a 500 tells the client nothing it can act on. The vendor's own message
   * goes to the log and never to the response: it is written for a developer
   * and routinely names internal state.
   */
  if (err instanceof PlaidRequestError) {
    const relink = err.code === "ITEM_LOGIN_REQUIRED" || err.code === "INVALID_PUBLIC_TOKEN";
    console.error(`plaid ${err.code}: ${err.message}`);
    res.status(relink ? 409 : 502).json({
      error: {
        message: relink
          ? "Your bank needs signing into again."
          : "We could not reach your bank just now.",
        code: relink ? "BANK_RELINK_REQUIRED" : "BANK_CONNECTION_FAILED",
      },
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: { message: err.message, code: err.code } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { message: "Validation failed", code: "VALIDATION_ERROR", details: err.issues },
    });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { message: "Internal server error", code: "INTERNAL_ERROR" } });
}

/** Wrap an async handler so a rejected promise reaches the error middleware. */
export function asyncRoute<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}
