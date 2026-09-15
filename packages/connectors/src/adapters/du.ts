/**
 * Submitting a casefile to Desktop Underwriter, for real.
 *
 * A shape rather than a working adapter, and the reason is not that nobody got
 * to it. Two things are missing and neither is code:
 *
 *   1. **A seller/servicer number.** A casefile goes in under one. Grander is
 *      the creditor and Supermortgage administers as their agent, so it would
 *      be Grander's — and whether the agency agreement permits us to submit
 *      under it is a contract question with a longer lead time than any code.
 *      It is `sellerServicerNumber` below, refused at construction when absent,
 *      for the reason the Plaid adapter refuses a missing key at boot: a
 *      credential discovered at the first borrower's request is a credential
 *      discovered in front of a borrower.
 *   2. **The conversation.** The vendored corpus in `packages/du-schema`
 *      specifies the casefile — the schema chain, the enumerations, the arcs —
 *      and says nothing about the endpoint it goes to, how a caller
 *      authenticates, what envelope carries it, or what the answer looks like
 *      coming back. Those live in the DU integration agreement, which nobody
 *      here has read.
 *
 * So `submit` runs the guard and then refuses, and the refusal names what is
 * missing. Writing a plausible POST against an invented endpoint would produce
 * an adapter that compiles, passes its tests, and is wrong in the one way
 * nothing in this repository could detect — and the guard, which is the half
 * that IS knowable today, would be sitting behind it looking exercised.
 *
 * The guard runs FIRST and unconditionally, and the emptiness check runs second
 * for the same reason. A future half-wiring that gets a transport and no
 * permission check is the failure this ordering exists to make impossible: the
 * refusal below is the only thing between an assembled submission and Fannie
 * Mae, and when it is deleted everything that must happen before a send has to
 * already be above it. An emptiness check that lived only in the fixture would
 * be exactly the piece that argument had not been applied to — and it is the
 * one that only matters in the adapter that can send.
 */

import type { PurposeToken, DuResponse } from "@hm/shared";
import { requireEveryBorrowerAuthorized } from "../guard.js";
import { requireDocument } from "../ports/index.js";
import type { ConnectorResult, DuConnector, DuSubmission } from "../ports/index.js";

export type DuEnvironment = "test" | "production";

export interface DuOptions {
  /**
   * The institution the casefile is submitted under. Not ours: see the header.
   */
  readonly sellerServicerNumber: string;
  readonly environment: DuEnvironment;
  /**
   * Where the casefile is sent, from the integration agreement. There is no
   * default, and there must never be one — a wrong endpoint that happens to
   * answer is worse than none.
   */
  readonly endpoint: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Thrown by the only adapter that could transmit, because it cannot yet.
 *
 * Distinct from `AuthorizationError`: this one says the credential and the
 * protocol are missing, and that is an operator's problem. An authorization
 * refusal is a borrower's, and a route that collapsed the two would tell
 * somebody to sign something that would not have helped.
 */
export class DuTransportNotWiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuTransportNotWiredError";
  }
}

export function duConnector(options: DuOptions): DuConnector {
  if (options.sellerServicerNumber.trim() === "") {
    throw new DuTransportNotWiredError(
      "A DU casefile is submitted under a seller/servicer number, and none is configured.",
    );
  }
  if (options.endpoint.trim() === "") {
    throw new DuTransportNotWiredError("DU_ENDPOINT is not set, so there is nowhere to submit to.");
  }

  return {
    capabilities: {
      provider: "desktop-underwriter",
      mode: options.environment === "production" ? "production" : "sandbox",
      // Nothing. An adapter that cannot send satisfies no requirement, and a
      // list here would put UW-001 behind a call that always throws.
      satisfies: [],
    },
    async submit(
      submission: DuSubmission,
      tokens: readonly PurposeToken[],
    ): Promise<ConnectorResult<DuResponse>> {
      requireEveryBorrowerAuthorized(submission, tokens);
      requireDocument(submission);
      throw new DuTransportNotWiredError(
        "This adapter cannot submit to Desktop Underwriter yet. What it is missing is the " +
          "message envelope, the authentication scheme and the response format, none of which " +
          "are in the vendored specification — they are in the DU integration agreement. " +
          "Whoever writes them must read the recommendation through parseDuRecommendation " +
          "rather than storing the string that arrived.",
      );
    },
  };
}
