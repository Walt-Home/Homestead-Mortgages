/**
 * The Plaid CRA adapter, tested without keys.
 *
 * Everything here runs against a stubbed `fetch`, which is the point: the
 * mapping and the sequencing are the parts that will be wrong, and neither
 * needs a sandbox to be wrong in front of a test.
 */

import { describe, expect, it, vi } from "vitest";
import type { LoanFile } from "@hm/shared";
import {
  AuthorizationError,
  detectLargeDeposits,
  detectRecurringObligations,
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

function file(authorized = true): LoanFile {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stage: "bank",
    property: null,
    loan: null,
    product: null,
    borrowers: [],
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
  it("refuses a link session before APP-005, without reaching Plaid", async () => {
    const spy = vi.fn();
    const { c } = connector(spy as unknown as typeof fetch);
    await expect(c.createLinkSession(file(false))).rejects.toBeInstanceOf(AuthorizationError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a report fetch before APP-005, without reaching Plaid", async () => {
    const spy = vi.fn();
    const { c } = connector(spy as unknown as typeof fetch);
    await expect(
      c.fetchAssetReport(file(false), { sessionId: "s", publicToken: "pub" }, 12),
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
    const session = await c.createLinkSession(file());

    expect(session.linkToken).toBe("link-tok");
    // The whole reason for this adapter: without the hand-off the borrower
    // never signs into their bank and there is nothing to fetch.
    expect(session.requiresClientHandoff).toBe(true);

    const link = calls.find((k) => k.path === "/link/token/create")!;
    expect(link.body.cra_enabled_products).toEqual(["cra_base_report", "cra_income_insights"]);
    expect(link.body.products).toEqual([]);
    expect(link.body.consumer_report_permissible_purpose).toBe(
      "WRITTEN_INSTRUCTIONS_PREQUALIFICATION",
    );
    expect(link.body.user_token).toBe("user-tok");
  });

  it("reuses the user token rather than orphaning the first report", async () => {
    const { impl, calls } = stubFetch(routes);
    const { c } = connector(impl);
    await c.createLinkSession(file());
    await c.createLinkSession(file());

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
    await c.createLinkSession(file());
    const out = await c.fetchAssetReport(file(), { sessionId: "s", publicToken: "pub" }, 12);

    expect(out.status).toBe("ready");
    if (out.status !== "ready") return;
    expect(out.result.externalId).toBe("rep_123");
    expect(out.result.data.accounts).toHaveLength(2);
    expect(out.result.data.vendorAuthorizedForDu).toBe(true);
    expect(calls.map((k) => k.path)).toContain("/cra/check_report/create");
  });

  it("does not re-exchange on a later poll that has no public token", async () => {
    const { impl, calls } = stubFetch(routes);
    const { c } = connector(impl);
    await c.createLinkSession(file());
    await c.fetchAssetReport(file(), { sessionId: "s", publicToken: "pub" }, 12);
    await c.fetchAssetReport(file(), { sessionId: "s" }, 12);

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
    await c.createLinkSession(file());
    const out = await c.fetchAssetReport(file(), { sessionId: "s", publicToken: "pub" }, 12);

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
    await c.createLinkSession(file());
    const out = await c.fetchAssetReport(file(), { sessionId: "s", publicToken: "pub" }, 12);

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
    await c.createLinkSession(file());
    await expect(
      c.fetchAssetReport(file(), { sessionId: "s", publicToken: "pub" }, 2),
    ).rejects.toThrow(/require 12/);
  });

  it("refuses to fetch for a file that never created a session", async () => {
    const { impl } = stubFetch(routes);
    const { c } = connector(impl);
    await expect(
      c.fetchAssetReport(file(), { sessionId: "s", publicToken: "pub" }, 12),
    ).rejects.toThrow(/never created/);
  });
});

describe("plaid mapping", () => {
  it("maps accounts, types and the reporting window", () => {
    const report = toAssetReport(BASE_REPORT, INCOME_INSIGHTS);
    expect(report.monthsCovered).toBe(12);
    expect(report.accounts.map((a) => a.type)).toEqual(["checking", "retirement"]);
    expect(report.accounts[0]!.institution).toBe("First Fictional");
    expect(report.accounts[0]!.balanceHistory[0]).toEqual({ month: "2026-08", balance: 18_400 });
  });

  it("derives income and employment from deposits, without inventing a job title", () => {
    const report = toAssetReport(BASE_REPORT, INCOME_INSIGHTS);
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
    const report = toAssetReport(BASE_REPORT, INCOME_INSIGHTS);
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
