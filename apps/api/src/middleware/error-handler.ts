import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import {
  AuthorizationError,
  PlaidRequestError,
  PricingNotWiredError,
  UnquotableScenarioError,
} from "@hm/connectors";
import { IllegalTransition } from "@hm/shared";
import { ProjectionError } from "../services/borrower-projection.js";

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
  /**
   * A pricing failure never answers a borrower with a stack-logged 500.
   *
   * Both of these come out of the pricing port, neither is an `AppError`, and
   * without a branch here both fell to the generic handler — which is how
   * screen 1's affordability gate came to answer "Internal server error" to a
   * down payment that covered the price. The messages below are ours; the
   * errors' own messages name a loan amount, an endpoint or a missing pricing
   * policy and are written for whoever operates this, so they go to the log.
   *
   * They are two responses rather than one because they are two people's
   * problems. An unquotable scenario is the request's — there is nothing here
   * worth pricing, and sending it again unchanged gets the same answer. A
   * pricing adapter with no vendor behind it is an operator's, and a borrower
   * who tries later may well get through.
   */
  if (err instanceof UnquotableScenarioError) {
    console.error(err);
    res.status(422).json({
      error: {
        message: "There is not a loan here we can price, so there is nothing to check it against.",
        code: "UNQUOTABLE_LOAN",
      },
    });
    return;
  }
  if (err instanceof PricingNotWiredError) {
    console.error(err);
    res.status(503).json({
      error: {
        message:
          "We could not get a rate for this loan just now, so there is nothing to quote it against.",
        code: "NO_RATE_QUOTED",
      },
    });
    return;
  }
  // An invariant violation in the person, not a crash: the client can tell
  // the two apart and the log names the borrower and the predicate.
  if (err instanceof ProjectionError) {
    console.error(err);
    res.status(500).json({
      error: {
        message: err.message,
        code: "PROJECTION_ERROR",
        borrowerId: err.borrowerId,
        predicate: err.predicate,
      },
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: { message: err.message, code: err.code } });
    return;
  }
  // The machine has no such edge from where the file is. The routes ask
  // before they move, so they never reach this; a seed or a future caller
  // that asks for an impossible move gets a readable refusal rather than a
  // crash, and nothing was written.
  if (err instanceof IllegalTransition) {
    res.status(409).json({ error: { message: err.message, code: "ILLEGAL_TRANSITION" } });
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
