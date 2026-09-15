/**
 * Pricing a loan against a vendor, for real.
 *
 * A shape rather than a working adapter, and — as with the Desktop Underwriter
 * one — the reason is not that nobody got to it. Three things are missing and
 * only the last of them is code:
 *
 *   1. **The vendor.** Not chosen, and this file deliberately does not choose
 *      one. Its options are named after what any of them needs rather than
 *      after whose documentation they came from, and `basis` below is the
 *      field that says WHICH KIND was chosen, because that decides what a
 *      quote even is.
 *   2. **The product identifiers.** A rate sheet's product codes are the
 *      vendor's, not ours, and `CONF-30-FIXED` is a name this repository made
 *      up. Mapping their catalog onto ours is a table somebody has to write
 *      and cannot be guessed from the shape of the request.
 *   3. **A margin and an adjustment grid, but only for one of the two kinds.**
 *      A product and pricing engine answers with a borrower-facing rate and
 *      needs neither. An investor execution API answers with a price for a
 *      stated coupon, and turning a price stack into the one rate a borrower
 *      is offered means choosing what we keep — which is a pricing policy with
 *      fair-lending consequences, owned, documented and tested as one. It is
 *      not a constant an adapter may carry, and this adapter will not carry
 *      it: `InvestorPriceQuote` has no note rate on it, and `borrowerNoteRate`
 *      returns null rather than deriving one.
 *
 * So both methods run their checks and then refuse, and the refusal names what
 * is missing. Writing a plausible POST against an invented endpoint would
 * produce an adapter that compiles, passes its tests, and misprices every loan
 * in a way nothing here could detect — and UW-010's failure severity in Drew's
 * sheet is "Financial loss", which is what mispricing means.
 *
 * The checks run FIRST and unconditionally, for the reason the DU adapter's
 * do. The guard on `quoteForBorrower` is the half that IS knowable today: a
 * representative FICO going out to a pricing vendor is the credit report's
 * number reaching a third party, and a future half-wiring that gets an
 * endpoint before it gets a permission check is exactly the failure this
 * ordering makes impossible. Whoever deletes the refusal below finds
 * everything that must happen before a quote already above it.
 */

import type { LoanFile, PriceQuote, PricingScenario, PurposeToken } from "@hm/shared";
import { requireCategory, requireSubject } from "../guard.js";
import { requireQuotableScenario, requireScorableFico } from "../ports/index.js";
import type { PricingConnector } from "../ports/index.js";

/**
 * Which kind of vendor this deployment is pointed at.
 *
 * Configuration rather than a detail inside the adapter, because it changes
 * what comes back: `borrower_rate` is a rate somebody may be shown, and
 * `investor_price` is a price that is not a rate until a margin has been
 * applied to it. A caller that could not tell the two apart would read a
 * coupon as a quote.
 */
export type PricingBasis = "borrower_rate" | "investor_price";

export interface PricingVendorOptions {
  /**
   * Where the quote request goes, from the vendor's integration guide. There
   * is no default and there must never be one — a wrong endpoint that happens
   * to answer prices loans.
   */
  readonly endpoint: string;
  /**
   * Who is asking. Every pricing vendor scopes a sheet to a seller or an
   * originator, because the sheet IS the commercial relationship: two lenders
   * asking the same question get different numbers.
   */
  readonly sellerId: string;
  readonly basis: PricingBasis;
  readonly environment: "sandbox" | "production";
  readonly fetchImpl?: typeof fetch;
}

/**
 * Thrown by the only adapter that could quote, because it cannot yet.
 *
 * Distinct from `UnquotableScenarioError`, which says there is nothing here
 * worth pricing and is the caller's problem, and from `AuthorizationError`,
 * which is the borrower's. This one says the vendor, the catalog and — for an
 * execution API — the pricing policy are missing, and that is an operator's.
 * A route that collapsed them would tell somebody to sign something that would
 * not have helped.
 */
export class PricingNotWiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingNotWiredError";
  }
}

const MISSING = {
  borrower_rate:
    "This adapter cannot price a loan yet. What it is missing is the vendor, its request " +
    "envelope and authentication scheme, and the table mapping its product catalog onto the " +
    "product codes this repository uses — none of which can be guessed from the shape of a " +
    "quote.",
  investor_price:
    "This adapter cannot price a loan yet, and an execution API is missing one thing more " +
    "than a pricing engine is: an investor returns a price for a stated coupon, and the " +
    "margin and adjustment grid that turn a price stack into the rate a borrower is offered " +
    "are a pricing policy with fair-lending consequences. They are owned and tested as a " +
    "policy, not defaulted in an adapter.",
} as const satisfies Record<PricingBasis, string>;

export function pricingConnector(options: PricingVendorOptions): PricingConnector {
  if (options.endpoint.trim() === "") {
    throw new PricingNotWiredError("No pricing endpoint is configured, so there is nobody to ask.");
  }
  if (options.sellerId.trim() === "") {
    throw new PricingNotWiredError(
      "A rate sheet is scoped to a seller, and none is configured — so whose sheet this " +
        "would be is undecided.",
    );
  }

  return {
    capabilities: {
      provider: "pricing-vendor",
      mode: options.environment === "production" ? "production" : "sandbox",
      // Nothing. An adapter that cannot quote satisfies no requirement, and a
      // list here would put UW-010 behind a call that always throws.
      satisfies: [],
    },

    async quoteProducts(scenario: PricingScenario): Promise<readonly PriceQuote[]> {
      requireQuotableScenario(scenario);
      throw new PricingNotWiredError(MISSING[options.basis]);
    },

    async quoteForBorrower(
      file: LoanFile,
      token: PurposeToken,
      scenario: PricingScenario,
      representativeFico: number,
    ): Promise<readonly PriceQuote[]> {
      requireCategory(token, "credit_report");
      requireSubject(token, file);
      requireQuotableScenario(scenario);
      requireScorableFico(representativeFico);
      throw new PricingNotWiredError(MISSING[options.basis]);
    },
  };
}
