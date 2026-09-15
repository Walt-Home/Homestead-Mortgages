/**
 * The Plaid CRA adapter, tested without keys.
 *
 * Everything here runs against a stubbed `fetch`, which is the point: the
 * mapping and the sequencing are the parts that will be wrong, and neither
 * needs a sandbox to be wrong in front of a test.
 */

import { describe, expect, it, vi } from "vitest";
import { mintPurposeToken, type Grant, type LoanFile, type PurposeToken } from "@hm/shared";
import {
  AuthorizationError,
  detectLargeDeposits,
  detectRecurringDeposits,
  detectRecurringObligations,
  monthEndBalances,
  plaidConnector,
  toAssetReport,
  type PlaidBaseReport,
  type VendorTokenStore,
} from "../index.js";

function memoryStore(): VendorTokenStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(fileId, key) {
      return map.get(`${fileId}:${key}`) ?? null;
    },
    async put(fileId, key, value) {
      map.set(`${fileId}:${key}`, value);
    },
  };
}

const PARTY = "11111111-1111-1111-1111-111111111111";
/** The file every token here is minted on. A token from another one is refused. */
const FILE = "11111111-1111-1111-1111-111111111111";
const GRANT: Grant = {
  id: "grant-app-005",
  partyId: PARTY,
  purpose: "fcra_written_instruction",
  dataCategories: ["credit_report", "bank_transactions"],
  grantedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-12-30T00:00:00.000Z",
  revokedAt: null,
};

/** Permission for the party to have their bank data fetched. */
function token(
  category: "bank_transactions" | "credit_report" = "bank_transactions",
): PurposeToken {
  const r = mintPurposeToken({
    partyId: PARTY,
    fileId: FILE,
    purpose: "fcra_written_instruction",
    dataCategory: category,
    grants: [GRANT],
    now: new Date("2026-09-08T12:00:00.000Z"),
  });
  if (!r.ok) throw new Error(`test setup: ${r.message}`);
  return r.token;
}

/** The same permission, held by a party who is on no borrower row of this file. */
function strangerToken(): PurposeToken {
  const partyId = "99999999-9999-9999-9999-999999999999";
  const r = mintPurposeToken({
    partyId,
    fileId: FILE,
    purpose: "fcra_written_instruction",
    dataCategory: "bank_transactions",
    grants: [{ ...GRANT, partyId }],
    now: new Date("2026-09-08T12:00:00.000Z"),
  });
  if (!r.ok) throw new Error(`test setup: ${r.message}`);
  return r.token;
}

function file(authorized = true): LoanFile {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stage: "bank",
    property: null,
    loan: null,
    product: null,
    // The consent below names b1. The guard now refuses a consent from a
    // borrower who is not on the file, so the fixture has to hold one — the
    // old fixture was dangling and nothing could tell.
    borrowers: [
      {
        id: "b1",
        partyId: "11111111-1111-1111-1111-111111111111",
        firstName: "Test",
        lastName: "Borrower",
        dateOfBirth: "1990-01-01",
        ssn: { last4: "0000", vaultHandle: "vault:b1" },
        email: "b1@example.test",
        phone: "5555550100",
        currentAddress: {
          line1: "1 Fixture St",
          city: "Demo City",
          state: "CA",
          postalCode: "94000",
        },
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
      },
    ],
    consents: authorized
      ? [
          {
            kind: "verification_authorization",
            borrowerId: "b1",
            grantedAt: "2026-01-01T00:00:00.000Z",
            ipAddress: "127.0.0.1",
            userAgent: "test",
          },
        ]
      : [],
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
  };
}

/** A stub that answers by path, and records what it was asked. */
function stubFetch(routes: Record<string, unknown | (() => unknown)>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ path, body });
    const route = routes[path];
    if (route === undefined) {
      return { ok: false, status: 404, json: async () => ({ error_code: "NO_ROUTE" }) };
    }
    const value = typeof route === "function" ? (route as () => unknown)() : route;
    if (value && typeof value === "object" && "error_code" in (value as object)) {
      return { ok: false, status: 400, json: async () => value };
    }
    return { ok: true, status: 200, json: async () => value };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BASE_REPORT: PlaidBaseReport = {
  report: {
    report_id: "rep_123",
    date_generated: "2026-09-01T00:00:00.000Z",
    days_requested: 365,
    items: [
      {
        institution_name: "First Fictional",
        accounts: [
          {
            account_id: "acc_1",
            name: "Everyday Checking",
            mask: "4412",
            type: "depository",
            subtype: "checking",
            balances: { current: 18_400 },
            historical_balances: [
              { date: "2026-08-31", current: 18_400 },
              { date: "2026-07-31", current: 16_900 },
            ],
            transactions: [
              { amount: -6_250, date: "2026-08-15", description: "ACME CORP DIRECT DEP" },
              { amount: -14_000, date: "2026-08-02", description: "TRANSFER FROM UNKNOWN" },
            ],
          },
          {
            account_id: "acc_2",
            name: "Rollover IRA",
            mask: "9001",
            type: "investment",
            subtype: "ira",
            balances: { current: 52_000 },
            historical_balances: [{ date: "2026-08-31", current: 52_000 }],
          },
        ],
      },
    ],
  },
};

const INCOME_INSIGHTS = {
  report: {
    items: [
      {
        bank_income_sources: [
          {
            income_category: "SALARY",
            income_description: "ACME CORP DIRECT DEP",
            employer_name: "ACME CORP",
            historical_summary: Array.from({ length: 12 }, () => ({})),
            mean_amount: { amount: 6_250 },
          },
        ],
      },
    ],
  },
};

function connector(fetchImpl: typeof fetch, tokens = memoryStore()) {
  return {
    tokens,
    c: plaidConnector({
      clientId: "cid",
      secret: "sec",
      environment: "sandbox",
      tokens,
      fetchImpl,
    }),
  };
}

describe("plaid adapter — the guard", () => {
  it("cannot get a token before APP-005, so Plaid is never reached", () => {
    // The refusal lives in the minting of the token. A method that cannot be
    // called without a token cannot be called before the permission exists,
    // and no network call is possible.
    const spy = vi.fn();
    connector(spy as unknown as typeof fetch);
    const r = mintPurposeToken({
      partyId: PARTY,
      fileId: FILE,
      purpose: "fcra_written_instruction",
      dataCategory: "bank_transactions",
      grants: [],
      now: new Date(),
    });
    expect(r).toMatchObject({ ok: false, reason: "no_grant" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a bank token that was minted for something else", async () => {
    const spy = vi.fn();
    const { c } = connector(spy as unknown as typeof fetch);
    await expect(c.createLinkSession(file(), token("credit_report"))).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a bank token that was minted for somebody else", async () => {
    // The adapter written for a real vendor gets the same party check as the
    // fixtures. A permission belonging to a party this file is not about is a
    // real permission about the wrong person, and no request may leave for it.
    const spy = vi.fn();
    const { c } = connector(spy as unknown as typeof fetch);
    await expect(c.createLinkSession(file(), strangerToken())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      c.fetchAssetReport(file(), strangerToken(), { sessionId: "s", publicToken: "pub" }, 12),
    ).rejects.toBeInstanceOf(AuthorizationError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("plaid adapter — the link session", () => {
  const routes = {
    "/user/create": { user_token: "user-tok" },
    "/link/token/create": { link_token: "link-tok", expiration: "2026-09-01T04:00:00Z" },
  };

  it("asks for the CRA products, not plain assets", async () => {
    const { impl, calls } = stubFetch(routes);
    const { c } = connector(impl);
    const session = await c.createLinkSession(file(), token());

    expect(session.linkToken).toBe("link-tok");
    // The whole reason for this adapter: without the hand-off the borrower
    // never signs into their bank and there is nothing to fetch.
    expect(session.requiresClientHandoff).toBe(true);

    const link = calls.find((k) => k.path === "/link/token/create")!;
    // All three of these were wrong in the first draft and were caught by the
    // live sandbox, not by a fixture. Pinned so a refactor cannot undo them:
    // the CRA products go in `products`; `cra_enabled_products` is rejected as
    // UNKNOWN_FIELDS; and the purpose enum is INSTRUCTION, not INSTRUCTIONS.
    expect(link.body.products).toEqual(["cra_base_report", "cra_income_insights"]);
    expect(link.body.cra_enabled_products).toBeUndefined();
    expect(link.body.consumer_report_permissible_purpose).toBe(
      "WRITTEN_INSTRUCTION_PREQUALIFICATION",
    );
    expect(link.body.user_token).toBe("user-tok");
  });

  it("says what is actually wrong when the account has no CRA entitlement", async () => {
    // /user/create SUCCEEDS on a non-CRA account and returns only user_id.
    // Storing that undefined surfaced three calls later as INVALID_USER_TOKEN,
    // which reads like a bug here rather than a missing product.
    const { impl } = stubFetch({ ...routes, "/user/create": { user_id: "usr_1" } });
    const { c } = connector(impl);
    await expect(c.createLinkSession(file(), token())).rejects.toThrow(/request-products/);
  });

  it("reuses the user token rather than orphaning the first report", async () => {
    const { impl, calls } = stubFetch(routes);
    const { c } = connector(impl);
    await c.createLinkSession(file(), token());
    await c.createLinkSession(file(), token());

    expect(calls.filter((k) => k.path === "/user/create")).toHaveLength(1);
    expect(calls.filter((k) => k.path === "/link/token/create")).toHaveLength(2);
  });
});

describe("plaid adapter — the report", () => {
  const routes = {
    "/user/create": { user_token: "user-tok" },
    "/link/token/create": { link_token: "link-tok", expiration: "2026-09-01T04:00:00Z" },
    "/item/public_token/exchange": { access_token: "access-tok" },
    "/cra/check_report/create": { request_id: "r1" },
    "/cra/check_report/base_report/get": BASE_REPORT,
    "/cra/check_report/income_insights/get": INCOME_INSIGHTS,
  };

  it("exchanges, creates and reads on the first arrival", async () => {
    const { impl, calls } = stubFetch(routes);
    const { c } = connector(impl);
    await c.createLinkSession(file(), token());
    const out = await c.fetchAssetReport(
      file(),
      token(),
      { sessionId: "s", publicToken: "pub" },
      12,
    );

    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    expect(out.result.externalId).toBe("rep_123");
    expect(out.result.data.accounts).toHaveLength(2);
    expect(out.result.data.vendorAuthorizedForDu).toBe(true);
    expect(calls.map((k) => k.path)).toContain("/cra/check_report/create");
    // The endpoint rejects the call without both of these.
    const create = calls.find((k) => k.path === "/cra/check_report/create")!;
    expect(create.body.webhook).toBeTruthy();
    expect(create.body.consumer_report_permissible_purpose).toBe(
      "WRITTEN_INSTRUCTION_PREQUALIFICATION",
    );
  });

  it("does not re-exchange on a later poll that has no public token", async () => {
    const { impl, calls } = stubFetch(routes);
    const { c } = connector(impl);
    await c.createLinkSession(file(), token());
    await c.fetchAssetReport(file(), token(), { sessionId: "s", publicToken: "pub" }, 12);
    await c.fetchAssetReport(file(), token(), { sessionId: "s" }, 12);

    expect(calls.filter((k) => k.path === "/item/public_token/exchange")).toHaveLength(1);
    expect(calls.filter((k) => k.path === "/cra/check_report/create")).toHaveLength(1);
    expect(calls.filter((k) => k.path === "/cra/check_report/base_report/get")).toHaveLength(2);
  });

  it("reports PRODUCT_NOT_READY as a wait, not a failure", async () => {
    const { impl } = stubFetch({
      ...routes,
      "/cra/check_report/base_report/get": { error_code: "PRODUCT_NOT_READY" },
    });
    const { c } = connector(impl);
    await c.createLinkSession(file(), token());
    const out = await c.fetchAssetReport(
      file(),
      token(),
      { sessionId: "s", publicToken: "pub" },
      12,
    );

    expect(out.status).toBe("pending");
    if (out.status !== "pending") return;
    expect(out.retryAfterMs).toBeGreaterThan(0);
  });

  it("still returns the report when income insights is unavailable", async () => {
    const { impl } = stubFetch({
      ...routes,
      "/cra/check_report/income_insights/get": { error_code: "PRODUCTS_NOT_SUPPORTED" },
    });
    const { c } = connector(impl);
    await c.createLinkSession(file(), token());
    const out = await c.fetchAssetReport(
      file(),
      token(),
      { sessionId: "s", publicToken: "pub" },
      12,
    );

    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    // Insufficient routes the borrower to the payroll step. Silently
    // qualifying them on no income is the failure this guards against.
    expect(out.result.data.incomeConfidence).toBe("insufficient");
    expect(out.result.data.incomeConfidenceReason).toBeTruthy();
  });

  it("refuses a window shorter than the twelve months CRD-017 and CRD-018 need", async () => {
    const { impl } = stubFetch(routes);
    const { c } = connector(impl);
    await c.createLinkSession(file(), token());
    await expect(
      c.fetchAssetReport(file(), token(), { sessionId: "s", publicToken: "pub" }, 2),
    ).rejects.toThrow(/require 12/);
  });

  it("refuses to fetch for a file that never created a session", async () => {
    const { impl } = stubFetch(routes);
    const { c } = connector(impl);
    await expect(
      c.fetchAssetReport(file(), token(), { sessionId: "s", publicToken: "pub" }, 12),
    ).rejects.toThrow(/never created/);
  });
});

describe("plaid mapping", () => {
  it("maps accounts, types and the reporting window", () => {
    const report = toAssetReport(BASE_REPORT, INCOME_INSIGHTS, { vendorAuthorizedForDu: true });
    expect(report.monthsCovered).toBe(12);
    expect(report.accounts.map((a) => a.type)).toEqual(["checking", "retirement"]);
    expect(report.accounts[0]!.institution).toBe("First Fictional");
    expect(report.accounts[0]!.balanceHistory[0]).toEqual({ month: "2026-08", balance: 18_400 });
  });

  it("derives income and employment from deposits, without inventing a job title", () => {
    const report = toAssetReport(BASE_REPORT, INCOME_INSIGHTS, { vendorAuthorizedForDu: true });
    expect(report.incomeSources).toHaveLength(1);
    expect(report.incomeSources[0]!.monthlyAmount).toBe(6_250);
    expect(report.incomeSources[0]!.historyMonths).toBe(12);
    // Not false. A bank feed cannot see three years forward.
    expect(report.incomeSources[0]!.continuanceEstablished).toBeNull();
    expect(report.employments[0]!.employerName).toBe("ACME CORP");
    expect(report.employments[0]!.position).toBe("");
    expect(report.employments[0]!.verificationMethod).toBe("bank_inference");
  });

  it("leaves the cash flow assessment unperformed rather than claiming one", () => {
    // Plaid supplies the report; DU performs the assessment. Filling this in
    // would turn CRD-017 green on the strength of nothing.
    const report = toAssetReport(BASE_REPORT, INCOME_INSIGHTS, { vendorAuthorizedForDu: true });
    expect(report.cashFlowAssessmentResult).toBeUndefined();
    expect(report.earnestMoneyVerified).toBe(false);
  });
});

/* ── Detectors ──────────────────────────────────────────────────────────── */

function monthly(description: string, amount: number, months: number, from = 8) {
  return Array.from({ length: months }, (_, i) => {
    const m = from + i;
    const year = 2025 + Math.floor((m - 1) / 12);
    const month = ((m - 1) % 12) + 1;
    return {
      amount,
      date: `${year}-${String(month).padStart(2, "0")}-05`,
      description,
    };
  });
}

describe("recurring obligations", () => {
  it("finds twelve months of rent", () => {
    const found = detectRecurringObligations(monthly("ACH WEB PMT OAKWOOD APARTMENTS", 2_150, 12));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("rent");
    expect(found[0]!.monthsOfHistory).toBe(12);
    expect(found[0]!.monthlyAmount).toBe(2_150);
    expect(found[0]!.onTime).toBe(true);
  });

  it("ignores credits — a paycheque is not an obligation", () => {
    // The sign convention is the whole risk here: get it backwards and every
    // borrower has twelve months of "rent" paid to their employer.
    const found = detectRecurringObligations(monthly("ACME CORP DIRECT DEP", -6_250, 12));
    expect(found).toHaveLength(0);
  });

  it("does not treat a wildly variable payee as one obligation", () => {
    const swings = monthly("SOME MERCHANT", 100, 12).map((t, i) => ({
      ...t,
      amount: i % 2 === 0 ? 100 : 900,
    }));
    expect(detectRecurringObligations(swings)).toHaveLength(0);
  });

  it("marks a missed month as not on time and counts only the unbroken run", () => {
    const withGap = monthly("OAKWOOD APARTMENTS", 2_150, 12).filter((_, i) => i !== 5);
    const found = detectRecurringObligations(withGap);
    expect(found[0]!.onTime).toBe(false);
    expect(found[0]!.monthsOfHistory).toBeLessThan(12);
  });

  it("classifies utilities, phone and insurance so CRD-013 can count to three", () => {
    const kinds = detectRecurringObligations([
      ...monthly("OAKWOOD APARTMENTS", 2_150, 12),
      ...monthly("CITY WATER SEWER", 74, 12),
      ...monthly("VERIZON WIRELESS", 91, 12),
      ...monthly("GEICO INSURANCE", 138, 12),
    ]).map((r) => r.kind);
    expect(new Set(kinds)).toEqual(new Set(["rent", "utility", "phone", "insurance"]));
  });

  it("will not call three payments a twelve-month reference", () => {
    const short = detectRecurringObligations(monthly("OAKWOOD APARTMENTS", 2_150, 4));
    expect(short[0]!.monthsOfHistory).toBe(4);
  });
});

describe("large deposits", () => {
  const payers = new Set(["ACME CORP"]);
  const txns = [
    { amount: -6_250, date: "2026-08-15", description: "ACME CORP DIRECT DEP", accountId: "a" },
    { amount: -14_000, date: "2026-08-02", description: "TRANSFER FROM UNKNOWN", accountId: "a" },
    { amount: 2_150, date: "2026-08-05", description: "OAKWOOD APARTMENTS", accountId: "a" },
  ];

  it("sources the paycheque so AST-005 does not flag the borrower's own salary", () => {
    const found = detectLargeDeposits(txns, 6_250, payers);
    const paycheque = found.find((d) => d.description.includes("ACME"));
    expect(paycheque?.sourceType).toBe("payroll");
  });

  it("leaves an unexplained transfer unsourced, which is the question AST-005 asks", () => {
    const found = detectLargeDeposits(txns, 6_250, payers);
    const transfer = found.find((d) => d.description.includes("UNKNOWN"));
    expect(transfer?.sourceType).toBeUndefined();
    expect(transfer?.amount).toBe(14_000);
  });

  it("ignores outflows entirely", () => {
    const found = detectLargeDeposits(txns, 100, payers);
    expect(found.every((d) => d.description !== "OAKWOOD APARTMENTS")).toBe(true);
  });
});

/* ── Assets mode ─────────────────────────────────────────────────────────
 *
 * The stand-in while CRA access is granted. What matters in these tests is
 * not that it works — it is that it does not quietly claim what CRA claims.
 */

const ASSETS_ROUTES = {
  "/link/token/create": { link_token: "link-tok", expiration: "2026-09-01T04:00:00Z" },
  "/item/public_token/exchange": { access_token: "access-tok" },
  "/asset_report/create": { asset_report_token: "art-tok" },
  "/asset_report/get": {
    report: {
      report_id: "assets_1",
      date_generated: "2026-09-01T00:00:00.000Z",
      days_requested: 365,
      items: [
        {
          institution_name: "First Fictional",
          accounts: [
            {
              account_id: "acc_1",
              mask: "4412",
              type: "depository",
              subtype: "checking",
              balances: { current: 18_400 },
              historical_balances: [{ date: "2026-08-31", current: 18_400 }],
              transactions: [
                // Assets reports use original_description, not description.
                ...monthly("ACME CORP PAYROLL", -6_250, 12).map((t) => ({
                  amount: t.amount,
                  date: t.date,
                  original_description: t.description,
                })),
                ...monthly("OAKWOOD APARTMENTS", 2_150, 12).map((t) => ({
                  amount: t.amount,
                  date: t.date,
                  original_description: t.description,
                })),
              ],
            },
          ],
        },
      ],
    },
  },
};

function assetsConnector(fetchImpl: typeof fetch) {
  return plaidConnector({
    clientId: "cid",
    secret: "sec",
    environment: "sandbox",
    product: "assets",
    tokens: memoryStore(),
    fetchImpl,
  });
}

describe("plaid adapter — assets mode", () => {
  it("asks for assets, with no user token and no permissible purpose", async () => {
    const { impl, calls } = stubFetch(ASSETS_ROUTES);
    const c = assetsConnector(impl);
    await c.createLinkSession(file(), token());

    const link = calls.find((k) => k.path === "/link/token/create")!;
    expect(link.body.products).toEqual(["assets"]);
    // Both belong to a consumer report. Sending them here is rejected, and
    // more importantly they would misdescribe what this pull is.
    expect(link.body.user_token).toBeUndefined();
    expect(link.body.consumer_report_permissible_purpose).toBeUndefined();
    expect(calls.some((k) => k.path === "/user/create")).toBe(false);
  });

  it("does NOT claim DU authorization, so CRD-017 stays unsatisfied", async () => {
    // The whole point. Real transactions, no consumer-report status — and
    // CRD-017 turns on the status, not the transactions.
    const { impl } = stubFetch(ASSETS_ROUTES);
    const c = assetsConnector(impl);
    await c.createLinkSession(file(), token());
    const out = await c.fetchAssetReport(
      file(),
      token(),
      { sessionId: "s", publicToken: "pub" },
      12,
    );

    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    expect(out.result.data.vendorAuthorizedForDu).toBe(false);
    expect(out.result.provider).toContain("assets");
  });

  it("does not claim INC-002, which is what Day 1 Certainty buys", () => {
    const { impl } = stubFetch(ASSETS_ROUTES);
    expect(assetsConnector(impl).capabilities.satisfies).not.toContain("INC-002");
    expect(assetsConnector(impl).capabilities.satisfies).not.toContain("CRD-017");
  });

  it("infers income from deposits but never calls it verified", async () => {
    const { impl } = stubFetch(ASSETS_ROUTES);
    const c = assetsConnector(impl);
    await c.createLinkSession(file(), token());
    const out = await c.fetchAssetReport(
      file(),
      token(),
      { sessionId: "s", publicToken: "pub" },
      12,
    );
    if (out.status !== "ready") throw new Error("expected ready");

    expect(out.result.data.incomeSources).toHaveLength(1);
    expect(out.result.data.incomeSources[0]!.monthlyAmount).toBe(6_250);
    expect(out.result.data.employments[0]!.employerName).toContain("ACME");
    // "verified" is what lets a borrower skip the payroll step. An inference
    // from deposits does not earn it, however clean the pattern looks.
    expect(out.result.data.incomeConfidence).toBe("estimated");
    expect(out.result.data.incomeConfidenceReason).toBeTruthy();
  });

  it("still reads rent out of the same transactions", async () => {
    const { impl } = stubFetch(ASSETS_ROUTES);
    const c = assetsConnector(impl);
    await c.createLinkSession(file(), token());
    const out = await c.fetchAssetReport(
      file(),
      token(),
      { sessionId: "s", publicToken: "pub" },
      12,
    );
    if (out.status !== "ready") throw new Error("expected ready");

    expect(out.result.data.identifiedRentPayments).toBe(12);
    expect(out.result.data.identifiedMonthlyRent).toBe(2_150);
  });

  it("waits rather than failing while the report assembles", async () => {
    const { impl } = stubFetch({
      ...ASSETS_ROUTES,
      "/asset_report/get": { error_code: "PRODUCT_NOT_READY" },
    });
    const c = assetsConnector(impl);
    await c.createLinkSession(file(), token());
    const out = await c.fetchAssetReport(
      file(),
      token(),
      { sessionId: "s", publicToken: "pub" },
      12,
    );
    expect(out.status).toBe("pending");
  });
});

describe("inferred income leans toward under-counting", () => {
  it("ignores transfers between the borrower's own accounts", () => {
    // Counting a transfer as income inflates the qualifying figure, which is
    // the one direction this must never be wrong in.
    for (const label of ["TRANSFER FROM SAVINGS", "ZELLE FROM MOM", "VENMO CASHOUT"]) {
      expect(detectRecurringDeposits(monthly(label, -3_000, 12))).toHaveLength(0);
    }
  });

  it("ignores small recurring credits like interest", () => {
    expect(detectRecurringDeposits(monthly("SAVINGS INTEREST", -12, 12))).toHaveLength(0);
  });

  it("takes the median, so one big month cannot lift the figure", () => {
    const withBonus = monthly("ACME CORP PAYROLL", -6_000, 12).map((t, i) =>
      i === 11 ? { ...t, amount: -7_800 } : t,
    );
    expect(detectRecurringDeposits(withBonus)[0]!.monthlyAmount).toBe(6_000);
  });

  it("ignores a payer whose amount is arbitrary", () => {
    const erratic = monthly("ODD JOBS", -3_000, 12).map((t, i) => ({
      ...t,
      amount: i % 2 === 0 ? -1_000 : -9_000,
    }));
    expect(detectRecurringDeposits(erratic)).toHaveLength(0);
  });

  it("ignores outflows — the sign convention, pinned again", () => {
    expect(detectRecurringDeposits(monthly("OAKWOOD APARTMENTS", 2_150, 12))).toHaveLength(0);
  });
});

/* ── Regressions found by running against the live sandbox ───────────────
 *
 * Every case below is data Plaid actually returned. None of it was caught by
 * the hand-written fixtures above, which is the argument for this block
 * existing.
 */

describe("what real Plaid data broke", () => {
  it("collapses DAILY balances to one per month, newest first", () => {
    // Plaid returned 357 daily rows for a year. Slicing each to YYYY-MM gave
    // 357 entries with the same month repeated, so AST-001's "two months of
    // history" check passed on one month of data.
    const daily = [
      { date: "2026-09-01", current: 43_200 },
      { date: "2026-08-31", current: 210 },
      { date: "2026-08-30", current: 205 },
      { date: "2026-08-29", current: 200 },
      { date: "2026-07-31", current: 180 },
    ];
    expect(monthEndBalances(daily)).toEqual([
      { month: "2026-09", balance: 43_200 },
      { month: "2026-08", balance: 210 },
      { month: "2026-07", balance: 180 },
    ]);
  });

  it("does not call a coffee subscription a credit reference", () => {
    // Verbatim from the sandbox: twelve months each, perfectly consistent
    // amounts. CRD-013 wants three twelve-month references to extend credit
    // to a thin file, and these would have been twelve of them.
    const retail = [
      ...monthly("Starbucks", 4.33, 12),
      ...monthly("McDonalds #3322", 12, 12),
      ...monthly("Uber 063015 SF**POOL**", 5.4, 12),
      ...monthly("SparkFun", 89.4, 12),
      ...monthly("Madison Bicycle Shop", 500, 12),
      ...monthly("KFC", 500, 12),
      ...monthly("Tectra Inc", 500, 12),
    ];
    expect(detectRecurringObligations(retail)).toEqual([]);
  });

  it("still finds the obligations that are actually obligations", () => {
    const real = [
      ...monthly("OAKWOOD APARTMENTS", 2_150, 12),
      ...monthly("CITY WATER SEWER", 74, 12),
      ...monthly("VERIZON WIRELESS", 91, 12),
      ...monthly("Starbucks", 4.33, 12),
    ];
    const found = detectRecurringObligations(real);
    expect(found.map((f) => f.kind).sort()).toEqual(["phone", "rent", "utility"]);
  });

  it("excludes an unlabelled liability even with no type field", () => {
    // The subtype fallback errs toward exclusion: "mortgage" is not in the
    // asset subtype map, so it stays out even when `type` is missing.
    const report = toAssetReport(
      {
        report: {
          items: [
            {
              accounts: [
                { account_id: "a", subtype: "checking", balances: { current: 500 } },
                { account_id: "b", subtype: "mortgage", balances: { current: 250_000 } },
              ],
            },
          ],
        },
      },
      null,
      { vendorAuthorizedForDu: false },
    );
    expect(report.accounts).toHaveLength(1);
    expect(report.accounts[0]!.currentBalance).toBe(500);
  });

  it("reads the asset report's own id field", () => {
    // Asset reports key it asset_report_id; CRA base reports use report_id.
    // Reading only the latter left every stored snapshot with an empty id.
    const report = toAssetReport(
      { report: { asset_report_id: "c951b59b", days_requested: 365, items: [] } },
      null,
      { vendorAuthorizedForDu: false },
    );
    expect(report.reportId).toBe("c951b59b");
  });

  it("reads original_description, which is the name asset reports use", () => {
    const found = detectRecurringObligations(
      monthly("x", 2_150, 12).map((t) => ({
        amount: t.amount,
        date: t.date,
        original_description: "OAKWOOD APARTMENTS",
      })),
    );
    expect(found[0]?.kind).toBe("rent");
  });
});

describe("liabilities are not assets", () => {
  /**
   * The worst bug the sandbox exposed. Plaid returns EVERY account at the
   * institution — mortgage, student loan, auto loan, credit cards — each with
   * a positive `balances.current` representing what the borrower OWES. The
   * subtype fallback mapped all of them to "checking", so roughly $150k of
   * debt was counted as $150k of verified assets.
   */
  const mixed = {
    report: {
      asset_report_id: "r1",
      days_requested: 365,
      items: [
        {
          institution_name: "First Fictional",
          accounts: [
            {
              account_id: "d1",
              type: "depository",
              subtype: "checking",
              mask: "0000",
              balances: { current: 5_000 },
            },
            {
              account_id: "d2",
              type: "depository",
              subtype: "savings",
              mask: "1111",
              balances: { current: 12_000 },
            },
            {
              account_id: "d3",
              type: "depository",
              subtype: "hsa",
              mask: "9001",
              balances: { current: 6_009 },
            },
            {
              account_id: "i1",
              type: "investment",
              subtype: "401k",
              mask: "6666",
              balances: { current: 23_631 },
            },
            // Everything below is money OWED.
            {
              account_id: "l1",
              type: "loan",
              subtype: "mortgage",
              mask: "8888",
              balances: { current: 56_302 },
            },
            {
              account_id: "l2",
              type: "loan",
              subtype: "student",
              mask: "7777",
              balances: { current: 65_262 },
            },
            {
              account_id: "l3",
              type: "loan",
              subtype: "auto",
              mask: "9003",
              balances: { current: 23_211 },
            },
            {
              account_id: "c1",
              type: "credit",
              subtype: "credit card",
              mask: "3333",
              balances: { current: 410 },
            },
          ],
        },
      ],
    },
  };

  it("counts only depository and investment accounts", () => {
    const report = toAssetReport(mixed, null, { vendorAuthorizedForDu: false });
    expect(report.accounts.map((a) => a.mask).sort()).toEqual(["0000", "1111", "6666", "9001"]);
  });

  it("does not turn a mortgage balance into a down payment", () => {
    const report = toAssetReport(mixed, null, { vendorAuthorizedForDu: false });
    const total = report.accounts.reduce((s, a) => s + a.currentBalance, 0);
    // 5,000 + 12,000 + 6,009 + 23,631 — and not a cent of the 145,185 owed.
    expect(total).toBe(46_640);
  });

  it("treats an unplaceable investment account as retirement, not brokerage", () => {
    // Retirement is the type AST-008 forces a liquidity question about.
    // Guessing brokerage would let an untouchable balance count in full.
    const report = toAssetReport(
      {
        report: {
          items: [{ accounts: [{ account_id: "x", type: "investment", subtype: "esop" }] }],
        },
      },
      null,
      { vendorAuthorizedForDu: false },
    );
    expect(report.accounts[0]!.type).toBe("retirement");
  });

  it("ignores a loan account's transactions", () => {
    // A servicer's ledger is not the borrower's cash flow, and the mortgage
    // payment recorded there would double-count the one in their checking.
    const withLoanTxns = {
      report: {
        items: [
          {
            accounts: [
              {
                account_id: "l1",
                type: "loan",
                subtype: "mortgage",
                mask: "8888",
                balances: { current: 56_302 },
                transactions: monthly("OAKWOOD APARTMENTS", 2_150, 12).map((t) => ({
                  amount: t.amount,
                  date: t.date,
                  original_description: t.description,
                })),
              },
            ],
          },
        ],
      },
    };
    const report = toAssetReport(withLoanTxns, null, { vendorAuthorizedForDu: false });
    expect(report.identifiedRentPayments).toBe(0);
    expect(report.alternativeReferences).toEqual([]);
  });
});
