/**
 * The pricing port, both adapters.
 *
 * What is worth pinning here is not that a fixture returns 6.25%. It is the
 * set of things neither adapter may do: quote a loan of nothing, present a
 * base rate as though a borrower's credit had been priced into it, invent the
 * spread between two lock periods, or turn an investor's price into a note
 * rate. Each of those is a number somebody would be quoted, and UW-010's
 * failure severity in Drew's sheet is "Financial loss".
 */

import { describe, expect, it } from "vitest";
import {
  borrowerNoteRate,
  mintPurposeToken,
  type Borrower,
  type BorrowerRateQuote,
  type DataCategory,
  type Grant,
  type InvestorPriceQuote,
  type LoanFile,
  type PricingScenario,
  type PurposeToken,
} from "@hm/shared";
import {
  AuthorizationError,
  fixturePricingConnector,
  pricingConnector,
  PricingNotWiredError,
  PURPOSE_FOR,
  RATE_SHEET,
  requireQuotableQuote,
  SHEET_LOCK_DAYS,
  UnquotableScenarioError,
} from "../index.js";

const PARTY = "22222222-2222-2222-2222-222222222222";
const FILE = "00000000-0000-0000-0000-000000000000";
const NOW = new Date("2026-09-15T12:00:00.000Z");

const GRANT: Grant = {
  id: "grant-app-005",
  partyId: PARTY,
  purpose: "fcra_written_instruction",
  dataCategories: ["credit_report", "bank_transactions"],
  grantedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-12-30T00:00:00.000Z",
  revokedAt: null,
};

function token(category: DataCategory): PurposeToken {
  const r = mintPurposeToken({
    partyId: PARTY,
    fileId: FILE,
    purpose: PURPOSE_FOR[category],
    dataCategory: category,
    grants: [GRANT],
    now: NOW,
  });
  if (!r.ok) throw new Error(`test setup: ${r.message}`);
  return r.token;
}

const BORROWER = {
  id: "b1",
  partyId: PARTY,
  firstName: "Test",
  lastName: "Borrower",
  dateOfBirth: "1990-01-01",
  ssn: { last4: "0000", vaultHandle: "vault:b1" },
  email: "b1@example.test",
  phone: "5555550100",
  currentAddress: { line1: "1 Fixture St", city: "Austin", state: "TX", postalCode: "78704" },
  maritalStatus: "unmarried",
  citizenship: "us_citizen",
  identityVerification: null,
  nonBorrowingSpouseSignatureRequired: false,
  preferredLanguage: "en",
  demographics: null,
  firstTimeHomebuyer: null,
  isMilitary: false,
  currentHousing: "rent",
  declaration: null,
  residences: [],
} satisfies Borrower;

const FILE_ROW = {
  id: FILE,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  stage: "credit",
  property: null,
  loan: null,
  product: null,
  borrowers: [BORROWER],
  invitedBorrowers: [],
  consents: [],
  application: null,
  propertyRecord: null,
  valuation: null,
  flood: null,
  sanctions: null,
  lienSearch: null,
  credit: null,
  assets: null,
  payroll: null,
  transcripts: [],
  incomeSources: [],
  employment: [],
  documents: [],
  disclosures: [],
  links: [],
  decision: null,
  sanctionsScreenClear: null,
  ssnValidatedWithSsa: null,
  fraudReviewComplete: false,
  applicationSignedAt: null,
  intentToProceedAt: null,
  deliveryMethod: "electronic",
} satisfies LoanFile;

const SCENARIO: PricingScenario = {
  purpose: "purchase",
  occupancy: "primary_residence",
  propertyType: "single_family",
  state: "TX",
  loanAmount: 332_000,
  propertyValue: 415_000,
  lockDays: SHEET_LOCK_DAYS,
};

const fixture = () => fixturePricingConnector({ latencyMs: 0, referenceDate: NOW });

/** The vendor nobody has picked, configured as far as it can be. */
const wired = (basis: "borrower_rate" | "investor_price") =>
  pricingConnector({
    endpoint: "https://pricing.example.test/quotes",
    sellerId: "seller-1",
    basis,
    environment: "sandbox",
  });

describe("the rate sheet, served by the fixture", () => {
  it("quotes every product on the sheet with a window and a lock column", async () => {
    const quotes = await fixture().quoteProducts(SCENARIO);
    expect(quotes.map((q) => q.productCode)).toEqual(RATE_SHEET.map((p) => p.productCode));
    for (const quote of quotes) {
      expect(quote.lockDays).toBe(SHEET_LOCK_DAYS);
      // A quote with no window is one nothing can tell is stale.
      expect(Date.parse(quote.expiresAt)).toBeGreaterThan(Date.parse(quote.effectiveAt));
    }
  });

  it("carries the rate the environment variable used to hold, off the sheet", async () => {
    // The point of the port is where the number comes from, not what it is.
    // Changing it here changes it for the flow, and nothing in the process
    // environment can.
    const [thirty] = await fixture().quoteProducts(SCENARIO);
    expect(thirty?.productCode).toBe("CONF-30-FIXED");
    expect(borrowerNoteRate(thirty!)).toBe(6.25);
  });

  it("holds one product, whose rate is the one this repo can account for", () => {
    // A 15-year row sat here at 5.50% and nothing could say where that came
    // from — a 75bp term spread nobody published, on a sheet whose other rate
    // is accounted for to the basis point. It was reachable:
    // `QUOTED_PRODUCT_CODE=CONF-15-FIXED` would have quoted every borrower on
    // that deployment a number this repository made up, into
    // `loan_files.note_rate` and every ratio computed from it. A second
    // product is welcome the day its rate has a source written beside it.
    expect(RATE_SHEET).toHaveLength(1);
    expect(RATE_SHEET[0]?.baseRate).toBe(6.25);
  });

  it("never says a rate is locked, because nothing here can lock one", async () => {
    for (const quote of await fixture().quoteProducts(SCENARIO)) expect(quote.locked).toBe(false);
  });

  it("offers nothing for a lock period the sheet has no column for", async () => {
    // An answer, not a failure: this sheet is quoted for one period, and
    // filling a 60-day request off the 30-day column would invent the spread
    // between them.
    expect(await fixture().quoteProducts({ ...SCENARIO, lockDays: 60 })).toEqual([]);
  });

  it("refuses a request for no lock period at all, which is not the same as the wrong one", async () => {
    // The line above answers a 60-day request with an empty list, because the
    // sheet has no such column. Zero days names no column to look for, so it
    // is a malformed request rather than an unserved one, and collapsing the
    // two would let a caller read "we offer nothing for this loan" off a bug.
    await expect(fixture().quoteProducts({ ...SCENARIO, lockDays: 0 })).rejects.toBeInstanceOf(
      UnquotableScenarioError,
    );
  });

  it("refuses a loan of nothing rather than answering off the base sheet", async () => {
    // A vendor handed a zero does not refuse — it quotes, and that quote lands
    // in loan_files.note_rate.
    await expect(fixture().quoteProducts({ ...SCENARIO, loanAmount: 0 })).rejects.toBeInstanceOf(
      UnquotableScenarioError,
    );
    await expect(fixture().quoteProducts({ ...SCENARIO, propertyValue: 0 })).rejects.toBeInstanceOf(
      UnquotableScenarioError,
    );
  });
});

describe("the credit-priced call", () => {
  it("prices no credit tier, and says so rather than leaving it to be assumed", async () => {
    const base = await fixture().quoteProducts(SCENARIO);
    const priced = await fixture().quoteForBorrower(
      FILE_ROW,
      token("credit_report"),
      SCENARIO,
      780,
    );
    // The fixture holds no matrix, so the two agree — and the flag is what
    // stops the second from being read as a rate somebody's credit earned.
    expect(priced.map(borrowerNoteRate)).toEqual(base.map(borrowerNoteRate));
    for (const quote of priced) {
      expect(quote.creditTierApplied).toBe(false);
      expect(quote.adjustments).toEqual([]);
    }
  });

  it("refuses a token for anything but the credit report", async () => {
    await expect(
      fixture().quoteForBorrower(FILE_ROW, token("bank_transactions"), SCENARIO, 780),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses a score outside the range a score can take", async () => {
    // Zero sits below every tier, and a vendor that floors rather than
    // refusing prices the worst credit in the book.
    await expect(
      fixture().quoteForBorrower(FILE_ROW, token("credit_report"), SCENARIO, 0),
    ).rejects.toBeInstanceOf(UnquotableScenarioError);
    await expect(
      fixture().quoteForBorrower(FILE_ROW, token("credit_report"), SCENARIO, 900),
    ).rejects.toBeInstanceOf(UnquotableScenarioError);
  });
});

describe("what a vendor may answer", () => {
  /** The fixture's own quote, which every case below starts from. */
  async function good(): Promise<BorrowerRateQuote> {
    const [quote] = await fixture().quoteProducts(SCENARIO);
    if (quote?.basis !== "borrower_rate") throw new Error("test setup: fixture answers a rate");
    return quote;
  }

  it("accepts the sheet's own answer", async () => {
    const quote = await good();
    expect(() => requireQuotableQuote(quote)).not.toThrow();
  });

  /**
   * Every one of these was accepted, and each is a mapping bug rather than a
   * price: a field read off the wrong key, a decimal read as a percent, a
   * number the vendor never sent.
   *
   * Zero is the one that matters most, and the reason the check is here rather
   * than in a route. It is what an absent field deserializes to in most
   * mappings, and it does not read as missing anywhere downstream — it
   * amortizes, and the engine records the payment as a derivation instead of
   * blocking on it. A $332,000 loan at no interest, with a formula next to it.
   */
  it.each([
    ["zero, which is what an absent field usually becomes", 0],
    ["negative", -4.5],
    ["a whole-number mix-up", 999],
    ["not a number at all", Number.NaN],
    ["a field the vendor did not send", undefined as unknown as number],
  ])("refuses a note rate that is %s", async (_why, noteRate) => {
    const quote = { ...(await good()), noteRate };
    expect(() => requireQuotableQuote(quote)).toThrow(UnquotableScenarioError);
  });

  it.each([
    ["no months at all", 0],
    ["negative", -360],
    ["a fraction of a month", 360.5],
    ["longer than any loan is written for", 720],
  ])("refuses a term that is %s", async (_why, termMonths) => {
    const quote = { ...(await good()), termMonths };
    expect(() => requireQuotableQuote(quote)).toThrow(UnquotableScenarioError);
  });

  it("refuses a window that is not a window", async () => {
    const quote = await good();
    expect(() => requireQuotableQuote({ ...quote, expiresAt: quote.effectiveAt })).toThrow(
      UnquotableScenarioError,
    );
    expect(() => requireQuotableQuote({ ...quote, effectiveAt: "not a date" })).toThrow(
      UnquotableScenarioError,
    );
  });

  it("asks an investor's quote for no note rate, because it has none to give", async () => {
    // The arm with no `noteRate` by construction. Refusing its absence here
    // would refuse the whole vendor kind; what the caller does instead is read
    // `borrowerNoteRate` and record blocked. The term and the window are still
    // checked.
    const base = await good();
    const investor: InvestorPriceQuote = {
      basis: "investor_price",
      productCode: base.productCode,
      productName: base.productName,
      termMonths: base.termMonths,
      amortization: base.amortization,
      lockDays: base.lockDays,
      effectiveAt: base.effectiveAt,
      expiresAt: base.expiresAt,
      adjustments: base.adjustments,
      creditTierApplied: base.creditTierApplied,
      locked: base.locked,
      pricePercentOfPar: 101.375,
      pricedNoteRate: 6.25,
    };
    expect(() => requireQuotableQuote(investor)).not.toThrow();
    expect(() => requireQuotableQuote({ ...investor, termMonths: 0 })).toThrow(
      UnquotableScenarioError,
    );
  });
});

describe("a price is not a rate", () => {
  it("reads no note rate off an investor's quote", () => {
    // The shape an execution API answers in. Turning it into a rate needs a
    // margin and a grid, which are a pricing policy with fair-lending
    // consequences — so this returns null and whoever asked records blocked.
    const quote: InvestorPriceQuote = {
      basis: "investor_price",
      productCode: "CONF-30-FIXED",
      productName: "Conforming 30-year fixed",
      termMonths: 360,
      amortization: "fixed",
      lockDays: SHEET_LOCK_DAYS,
      effectiveAt: NOW.toISOString(),
      expiresAt: NOW.toISOString(),
      adjustments: [],
      creditTierApplied: true,
      locked: false,
      pricePercentOfPar: 101.375,
      pricedNoteRate: 6.25,
    };
    expect(borrowerNoteRate(quote)).toBeNull();
  });
});

describe("the adapter for the vendor nobody has picked", () => {
  it("refuses to be constructed without an endpoint or a seller", () => {
    expect(() =>
      pricingConnector({
        endpoint: "",
        sellerId: "seller-1",
        basis: "borrower_rate",
        environment: "sandbox",
      }),
    ).toThrow(PricingNotWiredError);
    expect(() =>
      pricingConnector({
        endpoint: "https://pricing.example.test/quotes",
        sellerId: "  ",
        basis: "borrower_rate",
        environment: "sandbox",
      }),
    ).toThrow(PricingNotWiredError);
  });

  it("says what it is missing rather than quoting something", async () => {
    await expect(wired("borrower_rate").quoteProducts(SCENARIO)).rejects.toBeInstanceOf(
      PricingNotWiredError,
    );
  });

  it("names the margin as the extra thing an execution API needs", async () => {
    await expect(wired("investor_price").quoteProducts(SCENARIO)).rejects.toThrow(/margin/);
  });

  it("runs the guard BEFORE it refuses", async () => {
    // The ordering is the whole of what this adapter proves today. A future
    // half-wiring that gets an endpoint before it gets a permission check is
    // the failure it makes impossible, and a refusal thrown first would leave
    // the guard looking exercised while never having run.
    const outsider = mintPurposeToken({
      partyId: "99999999-9999-9999-9999-999999999999",
      fileId: FILE,
      purpose: PURPOSE_FOR.credit_report,
      dataCategory: "credit_report",
      grants: [{ ...GRANT, partyId: "99999999-9999-9999-9999-999999999999" }],
      now: NOW,
    });
    if (!outsider.ok) throw new Error("test setup");
    await expect(
      wired("borrower_rate").quoteForBorrower(FILE_ROW, outsider.token, SCENARIO, 780),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("checks the scenario before it refuses, so a bad one is not hidden by a missing vendor", async () => {
    await expect(
      wired("borrower_rate").quoteProducts({ ...SCENARIO, loanAmount: 0 }),
    ).rejects.toBeInstanceOf(UnquotableScenarioError);
  });

  it("claims no requirement, because an adapter that cannot quote satisfies none", () => {
    expect(wired("borrower_rate").capabilities.satisfies).toEqual([]);
    expect(fixture().capabilities.satisfies).toEqual([]);
  });
});
