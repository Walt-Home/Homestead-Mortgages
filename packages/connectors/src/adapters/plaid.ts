/**
 * The twelve-month asset report, from Plaid.
 *
 * ── Why CRA and not Assets ────────────────────────────────────────────────
 *
 * CRD-017 says the cash-flow assessment must come from "a 12-month asset
 * verification report from an authorized DU vendor". That is not a description
 * of any bank-data feed — it names Fannie Mae's Day 1 Certainty programme, and
 * Day 1 Certainty is the reason the flow can be four screens at all: a
 * validated report is what lets INC-002 accept deposits instead of paystubs,
 * which is what lets a salaried borrower skip the payroll step entirely.
 *
 * Plaid's ordinary Assets product returns the same transactions and carries
 * none of that status. The CRA products (`cra_base_report`,
 * `cra_income_insights`) are the ones issued as consumer reports under the
 * FCRA, and they are separately enabled on the account. Building against
 * Assets would produce a working bank connection that cannot satisfy the
 * requirement it exists for.
 *
 * ── The shape ─────────────────────────────────────────────────────────────
 *
 * Three round trips with a person in the middle:
 *
 *   1. `/user/create` and `/link/token/create` — server. The borrower gets a
 *      link token; the user token is kept, because the report is keyed on it.
 *   2. Plaid Link — the borrower's browser. They pick their bank and sign in.
 *      The server learns nothing until this returns a `public_token`.
 *   3. `/cra/check_report/create`, then `/cra/check_report/base_report/get`
 *      and `/cra/check_report/income_insights/get` — server. The report is
 *      assembled asynchronously, so the last calls legitimately answer
 *      "not yet", which is a wait and not a failure.
 *
 * ⚠ Written against Plaid's documented CRA API and NOT yet exercised against a
 * live sandbox — there were no credentials when this was written. The response
 * mapping is the part most likely to need correcting once a real payload is in
 * hand, which is why it is concentrated in `toAssetReport` and the two
 * exported detectors below rather than spread through the adapter.
 */

import type {
  AlternativeReference,
  AssetReport,
  Deposit,
  DepositAccount,
  EmploymentRecord,
  IncomeSource,
  LoanFile,
} from "@hm/shared";
import { assertVerificationAuthorized } from "../guard.js";
import type {
  AssetReportResult,
  BankConnector,
  ConnectorCapabilities,
  LinkHandoff,
  LinkSession,
  VendorTokenStore,
} from "../ports/index.js";

export type PlaidEnvironment = "sandbox" | "production";

/**
 * Which Plaid product backs the report.
 *
 * `cra` is the real target and the only one that satisfies CRD-017 — see the
 * header. `assets` exists because CRA is enabled per account by a sales
 * request, and waiting on that would mean nobody can walk screen 3 with a real
 * bank in the meantime.
 *
 * The difference is not cosmetic and is not hidden. Assets mode sets
 * `vendorAuthorizedForDu: false`, so CRD-017 reads "asset report did not come
 * from a DU-authorized vendor" and the file cannot reach a decision on the
 * strength of it. That is the honest result: the transactions are real, the
 * consumer-report status is not, and the requirement turns on the status.
 */
export type PlaidProduct = "cra" | "assets";

/**
 * The FCRA purpose under which the report is pulled.
 *
 * This is a legal assertion, not a configuration constant, which is why it is
 * an option with a comment rather than a literal buried in the request body.
 * The default is the one APP-005 actually collects: the borrower's written
 * instruction to verify their credit, employment, income and assets. If this
 * app ever pulls a report for a reason APP-005 does not cover, this has to
 * change with it.
 */
export type PermissiblePurpose =
  | "WRITTEN_INSTRUCTION_PREQUALIFICATION"
  | "WRITTEN_INSTRUCTION_OTHER"
  | "ACCOUNT_REVIEW_CREDIT"
  | "ACCOUNT_REVIEW_NON_CREDIT"
  | "EXTENSION_OF_CREDIT"
  | "ELIGIBILITY_FOR_GOVT_BENEFITS"
  | "LEGITIMATE_BUSINESS_NEED_OTHER"
  | "LEGITIMATE_BUSINESS_NEED_TENANT_SCREENING";

export interface PlaidOptions {
  readonly clientId: string;
  readonly secret: string;
  readonly environment: PlaidEnvironment;
  /** Defaults to "cra". See PlaidProduct. */
  readonly product?: PlaidProduct;
  readonly tokens: VendorTokenStore;
  /** Where Plaid Link returns after an OAuth bank. Must be registered with Plaid. */
  readonly redirectUri?: string;
  readonly permissiblePurpose?: PermissiblePurpose;
  /** Where Plaid announces report completion. Required by /cra/check_report/create. */
  readonly webhookUrl?: string;
  readonly publicOrigin?: string;
  readonly fetchImpl?: typeof fetch;
}

const HOSTS: Record<PlaidEnvironment, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

/** Keys under which this adapter's credentials live in the token store. */
const USER_TOKEN = "plaid.user_token";
const ACCESS_TOKEN = "plaid.access_token";
const ASSET_REPORT_TOKEN = "plaid.asset_report_token";

/** CRD-017 and CRD-018 both want a full year; 365 days is what buys both. */
const DAYS_REQUESTED = 365;

export class PlaidRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PlaidRequestError";
  }
}

export function plaidConnector(options: PlaidOptions): BankConnector {
  const doFetch = options.fetchImpl ?? fetch;
  const host = HOSTS[options.environment];

  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await doFetch(`${host}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: options.clientId, secret: options.secret, ...body }),
    });
    const payload = (await res.json().catch(() => ({}))) as T & {
      error_code?: string;
      error_message?: string;
    };
    if (!res.ok) {
      throw new PlaidRequestError(
        payload.error_code ?? "PLAID_ERROR",
        payload.error_message ?? `Plaid returned ${res.status} from ${path}`,
      );
    }
    return payload;
  }

  const product: PlaidProduct = options.product ?? "cra";
  const cra = product === "cra";

  const capabilities: ConnectorCapabilities = {
    provider: `plaid-${product} (${options.environment})`,
    mode: options.environment === "sandbox" ? "sandbox" : "production",
    /*
     * Two entries the fixture claims and this does not, deliberately:
     *
     * AST-007 — earnest money. Tracing an EMD cheque to a verified source
     * needs the purchase contract, which no bank feed has.
     *
     * CRD-017 — the cash-flow *assessment*. Plaid supplies the report that is
     * eligible for one; DU performs it. `vendorAuthorizedForDu` is therefore
     * true and `cashFlowAssessmentResult` stays undefined, and CRD-017 reads
     * "cash flow assessment not performed" — which is the truth until there is
     * a DU submission.
     */
    satisfies: cra
      ? ["AST-001", "AST-005", "AST-008", "CRD-013", "CRD-018", "INC-001", "INC-002"]
      : // Assets mode drops INC-002. Day 1 Certainty is what lets deposits
        // stand in for paystubs, and it is precisely what an unvalidated
        // report does not carry. The asset and rent requirements survive
        // because they turn on the transactions, which are the same either way.
        ["AST-001", "AST-005", "AST-008", "CRD-013", "CRD-018", "INC-001"],
  };

  /**
   * The Assets path.
   *
   * Same three round trips as CRA, different endpoints: exchange the public
   * token, create a report, poll for it. `/asset_report/get` answers
   * PRODUCT_NOT_READY while Plaid assembles, exactly as the CRA one does.
   */
  async function fetchAssetsReport(file: LoanFile, handoff: LinkHandoff): Promise<AssetReportResult> {
    let accessToken = await options.tokens.get(file.id, ACCESS_TOKEN);
    if (!accessToken) {
      if (!handoff.publicToken) {
        throw new PlaidRequestError(
          "NO_PUBLIC_TOKEN",
          "Plaid Link has not returned a public token for this file yet.",
        );
      }
      const exchanged = await call<{ access_token: string }>("/item/public_token/exchange", {
        public_token: handoff.publicToken,
      });
      accessToken = exchanged.access_token;
      await options.tokens.put(file.id, ACCESS_TOKEN, accessToken);
    }

    let reportToken = await options.tokens.get(file.id, ASSET_REPORT_TOKEN);
    if (!reportToken) {
      const created = await call<{ asset_report_token: string }>("/asset_report/create", {
        access_tokens: [accessToken],
        days_requested: DAYS_REQUESTED,
        options: {
          client_report_id: file.id,
          ...(options.webhookUrl || options.publicOrigin
            ? { webhook: options.webhookUrl ?? `${options.publicOrigin}/api/webhooks/plaid` }
            : {}),
        },
      });
      reportToken = created.asset_report_token;
      await options.tokens.put(file.id, ASSET_REPORT_TOKEN, reportToken);
    }

    try {
      const base = await call<PlaidBaseReport>("/asset_report/get", {
        asset_report_token: reportToken,
      });
      return {
        status: "ready",
        result: {
          // No income insights here — that is a separate gated product. Income
          // is inferred from recurring deposits instead, and marked
          // "estimated" rather than "verified" because an inference from
          // deposits is not a vendor's income determination.
          data: toAssetReport(base, null, { vendorAuthorizedForDu: false, deriveIncome: true }),
          provider: capabilities.provider,
          retrievedAt: new Date().toISOString(),
          externalId: base.report?.asset_report_id ?? file.id,
        },
      };
    } catch (err) {
      if (err instanceof PlaidRequestError && err.code === "PRODUCT_NOT_READY") {
        return { status: "pending", retryAfterMs: 4_000 };
      }
      throw err;
    }
  }

  return {
    capabilities,

    async createLinkSession(file: LoanFile): Promise<LinkSession> {
      // Rule 4. Before any network call, not after.
      assertVerificationAuthorized(file);

      if (!cra) {
        // Assets needs no user token and no permissible purpose: it is not a
        // consumer report, which is the entire difference.
        const link = await call<{ link_token: string; expiration: string }>(
          "/link/token/create",
          {
            user: { client_user_id: file.id },
            client_name: "Homestead Mortgages",
            language: "en",
            country_codes: ["US"],
            products: ["assets"],
            ...(options.redirectUri ? { redirect_uri: options.redirectUri } : {}),
          },
        );
        return {
          sessionId: file.id,
          linkToken: link.link_token,
          expiresAt: link.expiration,
          requiresClientHandoff: true,
        };
      }

      // The user token outlives the link token and is what the report is keyed
      // on, so reuse it if this borrower has been here before. A second
      // /user/create would orphan the first report.
      let userToken = await options.tokens.get(file.id, USER_TOKEN);
      if (!userToken) {
        const created = await call<{ user_token?: string; user_id?: string }>("/user/create", {
          client_user_id: file.id,
        });
        // On an account without CRA enabled, /user/create succeeds and returns
        // only `user_id` — no token. Storing that undefined would surface three
        // calls later as INVALID_USER_TOKEN, which reads like a bug in this
        // adapter rather than a missing entitlement. Say what is actually wrong.
        if (!created.user_token) {
          throw new PlaidRequestError(
            "NO_USER_TOKEN_ISSUED",
            "Plaid issued no user_token. This account is almost certainly not enabled " +
              "for the CRA products — request them at " +
              "https://dashboard.plaid.com/overview/request-products",
          );
        }
        userToken = created.user_token;
        await options.tokens.put(file.id, USER_TOKEN, userToken);
      }

      const link = await call<{ link_token: string; expiration: string }>("/link/token/create", {
        user: { client_user_id: file.id },
        user_token: userToken,
        client_name: "Homestead Mortgages",
        language: "en",
        country_codes: ["US"],
        // The CRA products go in `products`, like any other. There is a
        // `cra_enabled_products` field in some of Plaid's older CRA material;
        // the live API rejects it as UNKNOWN_FIELDS, and setting
        // `consumer_report_permissible_purpose` without a CRA product in
        // `products` is rejected too. Verified against sandbox.
        products: ["cra_base_report", "cra_income_insights"],
        consumer_report_permissible_purpose:
          options.permissiblePurpose ?? "WRITTEN_INSTRUCTION_PREQUALIFICATION",
        cra_options: { days_requested: DAYS_REQUESTED },
        ...(options.redirectUri ? { redirect_uri: options.redirectUri } : {}),
      });

      return {
        sessionId: file.id,
        linkToken: link.link_token,
        expiresAt: link.expiration,
        // The borrower has to sign into their bank inside Plaid Link. Nothing
        // exists to fetch until they do.
        requiresClientHandoff: true,
      };
    },

    async fetchAssetReport(
      file: LoanFile,
      handoff: LinkHandoff,
      monthsRequested: number,
    ): Promise<AssetReportResult> {
      assertVerificationAuthorized(file);

      if (monthsRequested < 12) {
        // CRD-017's cash-flow assessment and CRD-018's rent history both need
        // twelve. A shorter window satisfies neither, so asking for less is a
        // bug rather than a preference.
        throw new Error(
          `Asset report requested for ${monthsRequested} months; CRD-017 and CRD-018 require 12.`,
        );
      }

      if (!cra) return fetchAssetsReport(file, handoff);

      const userToken = await options.tokens.get(file.id, USER_TOKEN);
      if (!userToken) {
        throw new PlaidRequestError(
          "NO_USER_TOKEN",
          "No Plaid user for this file — the link session was never created.",
        );
      }

      // The report is keyed on the user token, not on the item, so the
      // exchange below is about item lifecycle (disconnecting later) and is
      // not a precondition for reading the report. Hence: exchange when Link
      // has handed something back and we have not stored one yet, and do not
      // refuse to read a report just because this call has no public token —
      // every poll after the first legitimately arrives without one.
      const stored = await options.tokens.get(file.id, ACCESS_TOKEN);
      const firstArrival = !stored && Boolean(handoff.publicToken);
      if (firstArrival) {
        const exchanged = await call<{ access_token: string }>("/item/public_token/exchange", {
          public_token: handoff.publicToken,
        });
        await options.tokens.put(file.id, ACCESS_TOKEN, exchanged.access_token);
        await call("/cra/check_report/create", {
          user_token: userToken,
          days_requested: DAYS_REQUESTED,
          consumer_report_permissible_purpose:
            options.permissiblePurpose ?? "WRITTEN_INSTRUCTION_PREQUALIFICATION",
          // Required, not optional — the endpoint rejects the call without it.
          // The report is still polled rather than driven by this webhook; it
          // exists because Plaid insists on somewhere to announce completion.
          webhook: options.webhookUrl ?? `${options.publicOrigin ?? ""}/api/webhooks/plaid`,
        });
      }

      try {
        const base = await call<PlaidBaseReport>("/cra/check_report/base_report/get", {
          user_token: userToken,
        });
        // Income insights is the weaker of the two: if it is unavailable the
        // report is still worth returning, and `incomeConfidence` degrades to
        // "insufficient", which routes the borrower to the payroll step
        // instead of silently qualifying them on nothing.
        const income = await call<PlaidIncomeInsights>("/cra/check_report/income_insights/get", {
          user_token: userToken,
        }).catch(() => null);

        return {
          status: "ready",
          result: {
            data: toAssetReport(base, income, { vendorAuthorizedForDu: true }),
            provider: capabilities.provider,
            retrievedAt: new Date().toISOString(),
            externalId: base.report?.report_id ?? file.id,
          },
        };
      } catch (err) {
        // Plaid says PRODUCT_NOT_READY while it is still assembling. That is a
        // wait, not a failure, and the difference is what the borrower is told.
        if (err instanceof PlaidRequestError && err.code === "PRODUCT_NOT_READY") {
          return { status: "pending", retryAfterMs: 4_000 };
        }
        throw err;
      }
    },
  };
}

/* ── Response mapping ─────────────────────────────────────────────────────
 *
 * Concentrated here on purpose: this is the part most likely to be wrong until
 * a real sandbox payload has been seen, and keeping it in one place makes the
 * correction one diff rather than a hunt.
 *
 * Plaid's sign convention on a depository account: a POSITIVE amount is money
 * leaving the account, a negative amount is money arriving. Getting this
 * backwards would turn every paycheque into a rent payment, so it is asserted
 * in the tests.
 */

export interface PlaidTransaction {
  amount?: number;
  date?: string;
  /** CRA base reports. */
  description?: string;
  /** Asset reports use this name for the same thing. */
  original_description?: string;
}

/** Whichever of the two names this payload happens to use. */
function describe(t: PlaidTransaction): string {
  return t.description ?? t.original_description ?? "";
}

export interface PlaidAccount {
  account_id?: string;
  name?: string;
  mask?: string;
  /** depository | credit | loan | investment | brokerage | other */
  type?: string;
  subtype?: string;
  balances?: { current?: number; available?: number };
  historical_balances?: { date?: string; current?: number }[];
  transactions?: PlaidTransaction[];
}

export interface PlaidBaseReport {
  report?: {
    report_id?: string;
    /** Asset reports use this name. CRA base reports use report_id. */
    asset_report_id?: string;
    date_generated?: string;
    days_requested?: number;
    items?: { institution_name?: string; accounts?: PlaidAccount[] }[];
  };
}

export interface PlaidIncomeInsights {
  report?: {
    items?: {
      bank_income_sources?: {
        income_category?: string;
        income_description?: string;
        employer_name?: string;
        historical_summary?: unknown[];
        mean_amount?: { amount?: number } | number;
        total_amount?: { amount?: number } | number;
      }[];
    }[];
  };
}

/**
 * Which Plaid account types are ASSETS.
 *
 * This filter is the most consequential line in the file, and it was missing.
 * Plaid returns every account at the institution — including the borrower's
 * mortgage, student loans, auto loan and credit cards, each with a positive
 * `balances.current` representing what they OWE. Mapping unrecognised subtypes
 * to "checking" counted all of it as money in the bank: against the sandbox
 * that turned roughly $150k of debt into $150k of verified assets.
 *
 * Assets are `depository` and `investment`. Everything else is a liability or
 * is not an asset, and belongs nowhere near a down payment or a reserves
 * calculation.
 */
const ASSET_ACCOUNT_TYPES = new Set(["depository", "investment", "brokerage"]);

/**
 * Is this an account whose balance the borrower owns?
 *
 * `type` is the authority. When it is absent — which the CRA payload shape is
 * not yet confirmed to avoid — fall back to whether the SUBTYPE is one this
 * adapter recognises as an asset. That fallback excludes by default: "mortgage"
 * and "credit card" are not in the subtype map, so an unlabelled liability
 * still does not become a down payment.
 */
function isAssetAccount(a: PlaidAccount): boolean {
  const type = (a.type ?? "").toLowerCase();
  if (type) return ASSET_ACCOUNT_TYPES.has(type);
  return Boolean(ACCOUNT_TYPE[(a.subtype ?? "").toLowerCase()]);
}

const ACCOUNT_TYPE: Record<string, DepositAccount["type"]> = {
  checking: "checking",
  savings: "savings",
  "money market": "money_market",
  "cash management": "checking",
  prepaid: "checking",
  paypal: "checking",
  cd: "savings",
  hsa: "savings",
  brokerage: "brokerage",
  ira: "retirement",
  roth: "retirement",
  "roth ira": "retirement",
  "401k": "retirement",
  "roth 401k": "retirement",
  "401a": "retirement",
  "403b": "retirement",
  "457b": "retirement",
  sep_ira: "retirement",
  simple_ira: "retirement",
  keogh: "retirement",
  pension: "retirement",
  "thrift savings plan": "retirement",
};

/**
 * Retirement money is not spendable money.
 *
 * An investment account we cannot place is treated as retirement rather than
 * brokerage, because retirement is the type AST-008 forces a liquidity
 * question about — vested balance and withdrawal eligibility, neither of which
 * a bank feed supplies. Guessing "brokerage" would let an untouchable balance
 * count toward the down payment in full and silently skip that check.
 */
function accountType(a: PlaidAccount): DepositAccount["type"] {
  const mapped = ACCOUNT_TYPE[(a.subtype ?? "").toLowerCase()];
  if (mapped) return mapped;
  return (a.type ?? "").toLowerCase() === "depository" ? "checking" : "retirement";
}

/**
 * One balance per month — the latest date in each — newest first.
 *
 * The daily series is not what any statement or requirement means by "months
 * of history", and passing it through made one month look like a year.
 */
export function monthEndBalances(
  daily: readonly { date?: string; current?: number }[],
): { month: string; balance: number }[] {
  const latest = new Map<string, { date: string; balance: number }>();
  for (const h of daily) {
    const date = h.date ?? "";
    const month = date.slice(0, 7);
    if (month.length !== 7) continue;
    const seen = latest.get(month);
    if (!seen || date > seen.date) latest.set(month, { date, balance: h.current ?? 0 });
  }
  return [...latest.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, v]) => ({ month, balance: v.balance }));
}

/** Plaid returns money as either a bare number or a {amount, iso_currency_code}. */
function money(v: { amount?: number } | number | undefined): number {
  if (typeof v === "number") return v;
  return v?.amount ?? 0;
}

export interface MappingOptions {
  /**
   * False in Assets mode. CRD-017 turns on this flag, and turning it on for a
   * report that is not a consumer report would satisfy the requirement with
   * the wrong thing.
   */
  readonly vendorAuthorizedForDu: boolean;
  /**
   * Infer income from recurring deposits, because Assets mode has no income
   * product behind it. Never produces "verified" — see `incomeConfidence`.
   */
  readonly deriveIncome?: boolean;
}

export function toAssetReport(
  base: PlaidBaseReport,
  income: PlaidIncomeInsights | null,
  opts: MappingOptions,
): AssetReport {
  const items = base.report?.items ?? [];

  const accounts: DepositAccount[] = items.flatMap((item) =>
    (item.accounts ?? [])
      .filter(isAssetAccount)
      .map((a) => ({
      id: a.account_id ?? "",
      institution: item.institution_name ?? "Unknown institution",
      type: accountType(a),
      mask: a.mask ?? "",
      currentBalance: a.balances?.current ?? 0,
      // Plaid returns DAILY balances — 357 rows for a year. Slicing each to
      // YYYY-MM produced 357 entries with the same month over and over, which
      // satisfied AST-001's "two months of history" check with one month of
      // data repeated. Collapse to the last observed balance in each month,
      // newest first, which is what a statement shows.
      balanceHistory: monthEndBalances(a.historical_balances ?? []),
      // Every connected asset account is presumed usable. The borrower
      // deselecting one is a product decision this adapter does not make.
      usedForQualifying: true,
    })),
  );

  // Same filter: a loan account's transaction list is the servicer's ledger,
  // not the borrower's cash flow, and a mortgage payment appearing there would
  // be double-counted against the one in their checking account.
  const allTransactions = items.flatMap((item) =>
    (item.accounts ?? [])
      .filter(isAssetAccount)
      .flatMap((a) => (a.transactions ?? []).map((t) => ({ ...t, accountId: a.account_id ?? "" }))),
  );

  const sources = (income?.report?.items ?? []).flatMap((i) => i.bank_income_sources ?? []);

  const inferred = opts.deriveIncome ? detectRecurringDeposits(allTransactions) : [];

  const incomeSources: IncomeSource[] = sources.length
    ? sources.map((s) => ({
        // Plaid's categories are coarser than the sheet's. Anything it cannot
        // place becomes base wage, which is the conservative reading: base
        // wage counts toward qualifying income in full.
        type:
          s.income_category === "SELF_EMPLOYMENT"
            ? ("self_employment" as const)
            : ("base_wage" as const),
        monthlyAmount: Math.round(money(s.mean_amount)),
        historyMonths: (s.historical_summary ?? []).length,
        // Continuance is an underwriting judgment about the next three years,
        // not a fact in a bank feed. Null is "not yet determined" — which is
        // exactly the state INC-027 exists to resolve, and is not "no".
        continuanceEstablished: null,
        evidenceDocumentIds: [],
      }))
    : inferred;

  const employments: EmploymentRecord[] = (
    sources.length
      ? sources.filter((s) => s.employer_name).map((s) => ({ employer_name: s.employer_name! }))
      : inferredPayers(opts.deriveIncome ? allTransactions : [])
  )
    .map((s) => ({
      employerName: s.employer_name,
      // Deposits name a payer, never a job title or a start date. Empty and
      // null are honest; a guess here would be shown to an underwriter as fact.
      position: "",
      startDate: null,
      status: "active" as const,
      isMilitary: false,
      verificationMethod: "bank_inference" as const,
    }));

  const monthlyIncome = incomeSources.reduce((s, i) => s + i.monthlyAmount, 0);
  const payers = new Set(
    sources.flatMap((s) => [s.employer_name, s.income_description].filter(Boolean).map(norm)),
  );

  const obligations = detectRecurringObligations(allTransactions);
  const rent = obligations.find((o) => o.kind === "rent");

  // Deposit-derived income cannot separate base pay from commission, which is
  // exactly what INC-005 turns on. One steady source is safe to stand alone;
  // several, or none, is where the payroll step earns its place.
  const incomeConfidence: AssetReport["incomeConfidence"] =
    incomeSources.length === 0
      ? "insufficient"
      : // An inference from deposits is not a vendor's income determination,
        // so it never reaches "verified" however clean the pattern looks.
        // "verified" is what lets a borrower skip the payroll step, and that
        // is a claim only Day 1 Certainty earns.
        !sources.length
        ? "estimated"
        : incomeSources.length === 1
          ? "verified"
          : "estimated";

  return {
    reportId: base.report?.asset_report_id ?? base.report?.report_id ?? "",
    generatedAt: base.report?.date_generated ?? new Date().toISOString(),
    monthsCovered: Math.round((base.report?.days_requested ?? DAYS_REQUESTED) / 30),
    // True only for the CRA products. Assets mode sets it false and loses
    // CRD-017 with it, which is the correct outcome rather than a limitation.
    vendorAuthorizedForDu: opts.vendorAuthorizedForDu,
    accounts,
    largeDeposits: detectLargeDeposits(allTransactions, monthlyIncome, payers),
    // Left undefined on purpose: Plaid supplies the report, DU performs the
    // assessment. See the note on `capabilities.satisfies`.
    cashFlowAssessmentResult: undefined,
    identifiedRentPayments: rent?.monthsOfHistory ?? 0,
    identifiedMonthlyRent: rent?.monthlyAmount,
    alternativeReferences: obligations,
    gifts: [],
    borrowedFunds: [],
    // Needs the purchase contract, which no bank feed has.
    earnestMoneyVerified: false,
    incomeSources,
    employments,
    incomeConfidence,
    incomeConfidenceReason:
      incomeConfidence === "verified"
        ? undefined
        : incomeConfidence === "insufficient"
          ? "We could not identify a steady paycheque in your deposits."
          : !sources.length
            ? "We worked your income out from your deposits, which is a good estimate rather than a confirmed figure."
            : "Your deposits vary month to month, so we can't tell base pay from commission.",
  };
}

/* ── Detectors ──────────────────────────────────────────────────────────── */

/** Strip the noise banks add to every line so the same payee groups together. */
function norm(description: string | undefined | null): string {
  return (description ?? "")
    .toUpperCase()
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\b(ACH|DEBIT|PMT|PAYMENT|WEB|RECURRING|XFER|POS|ID|CO|REF)\b/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
}

const RENT_WORDS = /RENT|APART|LEASING|PROPERT|REALTY|MANAGEMENT|HOMES|RESIDENT/;
const UTILITY_WORDS = /ELECTRIC|POWER|ENERGY|GAS|WATER|SEWER|UTILIT|MUNICIPAL/;
const INSURANCE_WORDS = /INSUR|GEICO|ALLSTATE|STATE FARM|PROGRESSIVE|LEMONADE/;
const PHONE_WORDS = /VERIZON|ATT|T MOBILE|TMOBILE|SPRINT|WIRELESS|MOBILE|XFINITY|COMCAST|SPECTRUM/;

/**
 * Null rather than "other" for anything unrecognised, and the caller drops it.
 *
 * This was "other" and it was wrong in a way only real data showed: against a
 * live sandbox, a $4-a-month coffee and a $12-a-month burger both came back as
 * twelve-month alternative credit references, and CRD-013 wants three of those
 * to call a thin-file borrower creditworthy. Three subscriptions are not a
 * credit history.
 *
 * Fannie's alternative credit is non-discretionary recurring obligations —
 * rent, utilities, insurance, phone. A merchant charging the same amount every
 * month is a subscription. Under-claiming here costs a borrower an alternative
 * route they might have had; over-claiming grants credit on a coffee habit.
 */
function classify(key: string): AlternativeReference["kind"] | null {
  if (RENT_WORDS.test(key)) return "rent";
  if (UTILITY_WORDS.test(key)) return "utility";
  if (INSURANCE_WORDS.test(key)) return "insurance";
  if (PHONE_WORDS.test(key)) return "phone";
  return null;
}

/** Below this, a recurring debit is a subscription, not an obligation. */
const MIN_OBLIGATION = 25;

function monthIndex(yyyymm: string): number {
  const [y, m] = yyyymm.split("-").map(Number);
  return (y ?? 0) * 12 + (m ?? 1) - 1;
}

/**
 * Recurring obligations, for CRD-013's alternative credit and CRD-018's rent.
 *
 * The honest limits, because they decide what the two requirements are allowed
 * to say:
 *
 * `onTime` — bank data cannot see a due date, so it cannot observe lateness in
 * the credit-report sense. What it can observe is a payment in every month
 * with none skipped, which is the test Fannie's own bank-statement rent
 * history uses (B3-5.4). That is what this reports, and only that.
 *
 * A payee whose amount swings more than 25% around its median is not treated
 * as one obligation. Variable bills exist, but so do coincidences, and a false
 * positive here lands in front of an underwriter as a claimed credit
 * reference.
 */
export function detectRecurringObligations(
  transactions: readonly PlaidTransaction[],
): AlternativeReference[] {
  const groups = new Map<string, Map<string, number>>();

  for (const t of transactions) {
    // Positive is money out. Credits are somebody paying the borrower and are
    // not an obligation.
    if (!t.amount || t.amount <= 0) continue;
    const month = (t.date ?? "").slice(0, 7);
    if (month.length !== 7) continue;
    const key = norm(describe(t));
    if (key.length < 3) continue;
    const byMonth = groups.get(key) ?? new Map<string, number>();
    byMonth.set(month, (byMonth.get(month) ?? 0) + t.amount);
    groups.set(key, byMonth);
  }

  const found: AlternativeReference[] = [];

  for (const [key, byMonth] of groups) {
    const months = [...byMonth.keys()].sort();
    if (months.length < 3) continue;

    // The longest run of consecutive months, and its amounts.
    let bestStart = 0;
    let bestLength = 1;
    let runStart = 0;
    for (let i = 1; i <= months.length; i++) {
      const contiguous =
        i < months.length && monthIndex(months[i]!) === monthIndex(months[i - 1]!) + 1;
      if (!contiguous) {
        if (i - runStart > bestLength) {
          bestLength = i - runStart;
          bestStart = runStart;
        }
        runStart = i;
      }
    }

    const run = months.slice(bestStart, bestStart + bestLength);
    if (run.length < 3) continue;

    const amounts = run.map((m) => byMonth.get(m)!).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)]!;
    if (median <= 0) continue;
    const consistent = amounts.every((a) => Math.abs(a - median) <= median * 0.25);
    if (!consistent) continue;

    const kind = classify(key);
    if (!kind || median < MIN_OBLIGATION) continue;

    found.push({
      kind,
      payeeName: key,
      monthsOfHistory: run.length,
      monthlyAmount: Math.round(median),
      // No month missed inside the observed span. See the note above.
      onTime: run.length === months.length,
    });
  }

  return found.sort((a, b) => b.monthsOfHistory - a.monthsOfHistory);
}


/**
 * Income inferred from recurring deposits, for Assets mode.
 *
 * The CRA income product does this properly, with a model and a consumer
 * report behind it. This is the honest approximation for when that product is
 * not available, and every choice below leans the same way: **underestimate**.
 * Income is the denominator's friend — an inflated figure makes a borrower
 * look more qualified than they are, which is the one direction a mortgage
 * system must never be wrong in.
 *
 * So: transfers between the borrower's own accounts are excluded rather than
 * counted, the monthly figure is the median rather than the mean (one bonus
 * month cannot lift it), small recurring credits like interest are ignored,
 * and the result is never labelled "verified" — see `incomeConfidence`.
 */

/** Money moving between a person's own accounts is not income. */
const TRANSFER_WORDS =
  /TRANSFER|XFER|ZELLE|VENMO|CASH APP|PAYPAL|WIRE|DEPOSIT MOBILE|CHECK DEP|ATM|REFUND|RETURN|REVERSAL|INTRST|INTEREST|DIVIDEND/;

/** Below this a recurring credit is interest or a rebate, not a paycheque. */
const MIN_MONTHLY_INCOME = 500;

interface RecurringDeposit {
  readonly payee: string;
  readonly monthlyAmount: number;
  readonly months: number;
}

function recurringDeposits(transactions: readonly PlaidTransaction[]): RecurringDeposit[] {
  const groups = new Map<string, Map<string, number>>();

  for (const t of transactions) {
    // Negative is money arriving. The mirror of the obligations detector, and
    // the same sign convention it is pinned on.
    if (!t.amount || t.amount >= 0) continue;
    const month = (t.date ?? "").slice(0, 7);
    if (month.length !== 7) continue;
    const key = norm(describe(t));
    if (key.length < 3 || TRANSFER_WORDS.test(key)) continue;
    const byMonth = groups.get(key) ?? new Map<string, number>();
    byMonth.set(month, (byMonth.get(month) ?? 0) + Math.abs(t.amount));
    groups.set(key, byMonth);
  }

  const found: RecurringDeposit[] = [];

  for (const [key, byMonth] of groups) {
    const months = [...byMonth.keys()].sort();
    if (months.length < 3) continue;

    let bestStart = 0;
    let bestLength = 1;
    let runStart = 0;
    for (let i = 1; i <= months.length; i++) {
      const contiguous =
        i < months.length && monthIndex(months[i]!) === monthIndex(months[i - 1]!) + 1;
      if (!contiguous) {
        if (i - runStart > bestLength) {
          bestLength = i - runStart;
          bestStart = runStart;
        }
        runStart = i;
      }
    }

    const run = months.slice(bestStart, bestStart + bestLength);
    if (run.length < 3) continue;

    const amounts = run.map((m) => byMonth.get(m)!).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)]!;
    if (median < MIN_MONTHLY_INCOME) continue;

    // Wider than the 25% the obligations detector allows: a paycheque moves
    // with overtime and pay-period drift in a way rent does not. Still bounded,
    // because a payer whose amount is arbitrary is not a salary.
    if (!amounts.every((a) => Math.abs(a - median) <= median * 0.4)) continue;

    found.push({ payee: key, monthlyAmount: Math.round(median), months: run.length });
  }

  return found.sort((a, b) => b.monthlyAmount - a.monthlyAmount);
}

export function detectRecurringDeposits(
  transactions: readonly PlaidTransaction[],
): IncomeSource[] {
  return recurringDeposits(transactions).map((d) => ({
    // Deposits cannot separate base pay from commission or overtime — that is
    // the distinction INC-005 turns on, and it is why this never reads
    // "verified". Base wage is the conservative label.
    type: "base_wage" as const,
    monthlyAmount: d.monthlyAmount,
    historyMonths: d.months,
    continuanceEstablished: null,
    evidenceDocumentIds: [],
  }));
}

/** The payers behind those deposits, as employer names. */
function inferredPayers(
  transactions: readonly PlaidTransaction[],
): { employer_name: string }[] {
  return recurringDeposits(transactions).map((d) => ({ employer_name: d.payee }));
}

/**
 * Deposits an underwriter has to ask about, for AST-005.
 *
 * The trap this avoids: reporting every large credit would flag the borrower's
 * own paycheque as an unsourced deposit, and AST-005 counts unsourced deposits
 * as a failure. So anything matching a payer that income insights already
 * identified is reported WITH a `sourceType`, which is what AST-005 filters
 * on — the deposit stays visible, and stops being a question.
 */
export function detectLargeDeposits(
  transactions: readonly (PlaidTransaction & { accountId?: string })[],
  monthlyIncome: number,
  knownPayers: ReadonlySet<string>,
): Deposit[] {
  // Fannie's threshold is 50% of monthly qualifying income. Before income is
  // known, $2,500 is a stand-in that errs toward showing too much rather than
  // hiding a deposit the borrower will be asked about later anyway.
  const threshold = monthlyIncome > 0 ? monthlyIncome * 0.5 : 2_500;

  return transactions
    .filter((t) => (t.amount ?? 0) < 0 && Math.abs(t.amount!) >= threshold)
    .map((t) => {
      const key = norm(describe(t));
      const matched = [...knownPayers].some((p) => p && (p.includes(key) || key.includes(p)));
      return {
        accountId: t.accountId ?? "",
        date: t.date ?? "",
        amount: Math.abs(t.amount!),
        description: describe(t),
        ...(matched ? { sourceType: "payroll" } : {}),
      };
    })
    .sort((a, b) => b.amount - a.amount);
}
