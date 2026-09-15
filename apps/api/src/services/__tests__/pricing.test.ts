/**
 * What the flow does when a rate does not arrive.
 *
 * The connector package pins what an adapter may answer; this pins the one
 * thing the layer above it may do with the answer, which is nothing clever. A
 * rate that no vendor quoted must not reach `loan_files.note_rate`, because
 * every ratio on the decision is computed from that column and none of them
 * would look wrong.
 *
 * The failure worth ruling out is the comfortable one. `DEFAULT_NOTE_RATE`
 * existed precisely so a rate was always available, and the natural shape for
 * this service is `?? config.something` — which restores the environment
 * variable under a new name and hides every pricing outage behind 6.25%.
 */

import { describe, expect, it } from "vitest";
import type { PriceQuote, PricingScenario } from "@hm/shared";
import type { PricingConnector } from "@hm/connectors";
import { fixturePricingConnector, SHEET_LOCK_DAYS, UnquotableScenarioError } from "@hm/connectors";
import { config } from "../../config.js";
import { AppError } from "../../middleware/error-handler.js";
import { quoteSubjectProduct, QUOTED_LOCK_DAYS } from "../pricing.js";

const LOAN = {
  purpose: "purchase",
  occupancy: "primary_residence",
  propertyType: "single_family",
  state: "tx",
  loanAmount: 332_000,
  propertyValue: 415_000,
} as const;

/** A connector answering exactly what it is told to, and nothing else. */
function answering(quotes: readonly PriceQuote[]): PricingConnector {
  return {
    capabilities: { provider: "test", mode: "fixture", satisfies: [] },
    quoteProducts: async () => quotes,
    quoteForBorrower: async () => quotes,
  };
}

const INVESTOR: PriceQuote = {
  basis: "investor_price",
  productCode: config.quotedProductCode,
  productName: "Conforming 30-year fixed",
  termMonths: 360,
  amortization: "fixed",
  lockDays: QUOTED_LOCK_DAYS,
  effectiveAt: "2026-09-15T00:00:00.000Z",
  expiresAt: "2026-09-15T23:59:59.999Z",
  adjustments: [],
  creditTierApplied: true,
  locked: false,
  pricePercentOfPar: 101.375,
  pricedNoteRate: 6.25,
};

/** One rung of a pricing engine's rate/point stack, under the one product code. */
function rung(noteRate: number, pricePercentOfPar: number): PriceQuote {
  return {
    basis: "borrower_rate",
    productCode: config.quotedProductCode,
    productName: "Conforming 30-year fixed",
    termMonths: 360,
    amortization: "fixed",
    noteRate,
    pricePercentOfPar,
    lockDays: QUOTED_LOCK_DAYS,
    effectiveAt: "2026-09-15T00:00:00.000Z",
    expiresAt: "2026-09-15T23:59:59.999Z",
    adjustments: [],
    creditTierApplied: false,
    locked: false,
  };
}

/** The code on the `AppError` a rejected call carries, for the cases below. */
async function codeOf(call: Promise<unknown>): Promise<string | undefined> {
  return call.then(
    () => undefined,
    (err: unknown) => (err instanceof AppError ? err.code : `not an AppError: ${String(err)}`),
  );
}

describe("quoting the product this deployment offers", () => {
  it("takes the rate and the term off the quote, not out of configuration", async () => {
    const product = await quoteSubjectProduct(fixturePricingConnector({ latencyMs: 0 }), LOAN);
    expect(product.productCode).toBe(config.quotedProductCode);
    expect(product.noteRate).toBe(6.25);
    expect(product.termMonths).toBe(360);
  });

  it("asks off the lock column the sheet is published for", async () => {
    // Two constants that have to agree, and they are in two packages: the
    // service names the column it reads and the fixture sheet names the one it
    // publishes. Drifting apart is silent — the quote comes back empty and
    // reads as "we offer nothing for this loan".
    let asked: PricingScenario | null = null;
    const spy: PricingConnector = {
      ...answering([]),
      quoteProducts: async (scenario) => {
        asked = scenario;
        return [];
      },
    };
    await expect(quoteSubjectProduct(spy, LOAN)).rejects.toBeInstanceOf(AppError);
    expect(asked!.lockDays).toBe(SHEET_LOCK_DAYS);
    // Upper-cased on the way out: a sheet keyed on state must not see two.
    expect(asked!.state).toBe("TX");
  });

  it("raises rather than falling back when nothing is offered", async () => {
    await expect(quoteSubjectProduct(answering([]), LOAN)).rejects.toBeInstanceOf(AppError);
  });

  it("raises rather than falling back when the offer is a price and not a rate", async () => {
    // An execution API's answer. Deriving a note rate from it needs a margin,
    // which is a pricing policy nobody here may choose — so this is blocked,
    // exactly as a compliance test with no APOR is blocked.
    await expect(quoteSubjectProduct(answering([INVESTOR]), LOAN)).rejects.toBeInstanceOf(AppError);
  });

  it("carries the window and the lock column the rate came off", async () => {
    // Thirteen fields arrive and four used to survive, which left the whole
    // argument for carrying a window — that a quote read back a week later
    // must not still look current — unreadable by anything downstream.
    const product = await quoteSubjectProduct(fixturePricingConnector({ latencyMs: 0 }), LOAN);
    expect(product.lockDays).toBe(QUOTED_LOCK_DAYS);
    expect(product.expiresAt.getTime()).toBeGreaterThan(product.effectiveAt.getTime());
  });
});

/**
 * The three answers that arrive looking like prices and are not one.
 *
 * Each of these reached `loan_files.note_rate` and none of them would have
 * looked wrong on the decision — which is the whole failure mode this service
 * exists to close, one layer above `DerivationLog.blocked`.
 */
describe("an answer that is not one rate", () => {
  it("refuses a rate/point stack rather than taking whichever came first", async () => {
    // A product and pricing engine returns the same 30-year fixed several
    // times over: buy the rate down and you pay points, take a credit and the
    // rate goes up. `find` took whichever the vendor serialized first, so the
    // SAME loan quoted 6.875% or 5.75% depending on array order — 112.5 basis
    // points of somebody's rate settled by `Array.prototype.find`. Which rung
    // a borrower is offered is a pricing policy with a disclosure attached.
    const stack = [rung(6.875, 101.5), rung(6.25, 100), rung(5.75, 98.25)];
    expect(await codeOf(quoteSubjectProduct(answering(stack), LOAN))).toBe("AMBIGUOUS_RATE_QUOTED");
    // Reversing the vendor's list must not change the answer, which is the
    // half a `find` could never keep.
    expect(await codeOf(quoteSubjectProduct(answering([...stack].reverse()), LOAN))).toBe(
      "AMBIGUOUS_RATE_QUOTED",
    );
  });

  it("refuses a quote taken off a lock column it did not ask for", async () => {
    // The scenario names a period so a figure off the 30-day column cannot
    // later be read as though it came off the 60-day one. Nothing compared the
    // answer to the question, so a 90-day sheet was accepted for a 30-day ask
    // — a lock-extension spread this product did not request and would not
    // disclose.
    const ninety = { ...rung(6.875, 100), lockDays: 90 };
    expect(await codeOf(quoteSubjectProduct(answering([ninety]), LOAN))).toBe("WRONG_LOCK_COLUMN");
  });

  it.each([
    ["zero, which is what a field the vendor never sent becomes", 0],
    ["negative", -4.5],
    ["a decimal read as a whole number", 999],
    ["not a number", Number.NaN],
  ])("refuses a rate that is %s before it can reach a file", async (_why, noteRate) => {
    // Zero is the one worth stating. It does not read as missing anywhere
    // downstream: it amortizes, `housingPitia` records the payment as a
    // derivation with a formula beside it, and a $332,000 loan at no interest
    // arrives at the decision with nothing blocked and nothing to refer on.
    //
    // `UnquotableScenarioError` rather than an `AppError`, because the check
    // is the connector package's — the path that reaches a vendor, not this
    // one service. `errorHandler` gives it a 422 with a code.
    await expect(
      quoteSubjectProduct(answering([rung(noteRate, 100)]), LOAN),
    ).rejects.toBeInstanceOf(UnquotableScenarioError);
  });

  it("refuses a term no loan is written for, alongside the rate", async () => {
    await expect(
      quoteSubjectProduct(answering([{ ...rung(6.25, 100), termMonths: 0 }]), LOAN),
    ).rejects.toBeInstanceOf(UnquotableScenarioError);
  });
});
