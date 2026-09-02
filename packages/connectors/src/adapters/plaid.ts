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
  | "WRITTEN_INSTRUCTIONS_PREQUALIFICATION"
  | "WRITTEN_INSTRUCTIONS_PROSPECTIVE_EMPLOYMENT"
  | "ACCOUNT_REVIEW_CREDIT"
  | "EXTENSION_OF_CREDIT";

export interface PlaidOptions {
  readonly clientId: string;
  readonly secret: string;
  readonly environment: PlaidEnvironment;
  readonly tokens: VendorTokenStore;
  /** Where Plaid Link returns after an OAuth bank. Must be registered with Plaid. */
  readonly redirectUri?: string;
  readonly permissiblePurpose?: PermissiblePurpose;
  readonly fetchImpl?: typeof fetch;
}

const HOSTS: Record<PlaidEnvironment, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

/** Keys under which this adapter's credentials live in the token store. */
const USER_TOKEN = "plaid.user_token";
const ACCESS_TOKEN = "plaid.access_token";

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

  const capabilities: ConnectorCapabilities = {
    provider: `plaid-cra (${options.environment})`,
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
    satisfies: ["AST-001", "AST-005", "AST-008", "CRD-013", "CRD-018", "INC-001", "INC-002"],
  };

  return {
    capabilities,

    async createLinkSession(file: LoanFile): Promise<LinkSession> {
      // Rule 4. Before any network call, not after.
      assertVerificationAuthorized(file);

      // The user token outlives the link token and is what the report is keyed
      // on, so reuse it if this borrower has been here before. A second
      // /user/create would orphan the first report.
      let userToken = await options.tokens.get(file.id, USER_TOKEN);
      if (!userToken) {
        const created = await call<{ user_token: string }>("/user/create", {
          client_user_id: file.id,
        });
        userToken = created.user_token;
        await options.tokens.put(file.id, USER_TOKEN, userToken);
      }

      const link = await call<{ link_token: string; expiration: string }>("/link/token/create", {
        user: { client_user_id: file.id },
        user_token: userToken,
        client_name: "Homestead Mortgages",
        language: "en",
        country_codes: ["US"],
        // Empty on purpose: with CRA, the products are named under
        // cra_enabled_products and repeating them here double-bills the item.
        products: [],
        cra_enabled_products: ["cra_base_report", "cra_income_insights"],
        consumer_report_permissible_purpose:
          options.permissiblePurpose ?? "WRITTEN_INSTRUCTIONS_PREQUALIFICATION",
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
            data: toAssetReport(base, income),
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
  description?: string;
}

export interface PlaidAccount {
  account_id?: string;
  name?: string;
  mask?: string;
  subtype?: string;
  balances?: { current?: number; available?: number };
  historical_balances?: { date?: string; current?: number }[];
  transactions?: PlaidTransaction[];
}

export interface PlaidBaseReport {
  report?: {
    report_id?: string;
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

const ACCOUNT_TYPE: Record<string, DepositAccount["type"]> = {
  checking: "checking",
  savings: "savings",
  "money market": "money_market",
  brokerage: "brokerage",
  ira: "retirement",
  "401k": "retirement",
  "roth 401k": "retirement",
  "403b": "retirement",
  roth: "retirement",
};

/** Plaid returns money as either a bare number or a {amount, iso_currency_code}. */
function money(v: { amount?: number } | number | undefined): number {
  if (typeof v === "number") return v;
  return v?.amount ?? 0;
}

export function toAssetReport(
  base: PlaidBaseReport,
  income: PlaidIncomeInsights | null,
): AssetReport {
  const items = base.report?.items ?? [];

  const accounts: DepositAccount[] = items.flatMap((item) =>
    (item.accounts ?? []).map((a) => ({
      id: a.account_id ?? "",
      institution: item.institution_name ?? "Unknown institution",
      // Anything Plaid names that this map does not know becomes checking,
      // which is the conservative direction: a checking balance counts in
      // full, where a mis-typed retirement account would need vesting and
      // withdrawal eligibility it does not have and would fail AST-008.
      type: ACCOUNT_TYPE[(a.subtype ?? "").toLowerCase()] ?? "checking",
      mask: a.mask ?? "",
      currentBalance: a.balances?.current ?? 0,
      balanceHistory: (a.historical_balances ?? []).map((h) => ({
        month: (h.date ?? "").slice(0, 7),
        balance: h.current ?? 0,
      })),
      // Every connected account is presumed usable. The borrower deselecting
      // one is a product decision this adapter does not get to make.
      usedForQualifying: true,
    })),
  );

  const allTransactions = items.flatMap((item) =>
    (item.accounts ?? []).flatMap((a) =>
      (a.transactions ?? []).map((t) => ({ ...t, accountId: a.account_id ?? "" })),
    ),
  );

  const sources = (income?.report?.items ?? []).flatMap((i) => i.bank_income_sources ?? []);

  const incomeSources: IncomeSource[] = sources.map((s) => ({
    // Plaid's categories are coarser than the sheet's. Anything it cannot
    // place becomes base wage, which is the conservative reading: base wage
    // counts toward qualifying income and therefore raises the denominator of
    // nothing and the numerator of DTI's income side in full.
    type: s.income_category === "SELF_EMPLOYMENT" ? "self_employment" : "base_wage",
    monthlyAmount: Math.round(money(s.mean_amount)),
    historyMonths: (s.historical_summary ?? []).length,
    // Continuance is an underwriting judgment about the next three years, not
    // a fact in a bank feed. Null is "not yet determined" — which is exactly
    // the state INC-027 exists to resolve, and is not "no".
    continuanceEstablished: null,
    evidenceDocumentIds: [],
  }));

  const employments: EmploymentRecord[] = sources
    .filter((s) => s.employer_name)
    .map((s) => ({
      employerName: s.employer_name!,
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
    incomeSources.length === 0 ? "insufficient" : incomeSources.length === 1 ? "verified" : "estimated";

  return {
    reportId: base.report?.report_id ?? "",
    generatedAt: base.report?.date_generated ?? new Date().toISOString(),
    monthsCovered: Math.round((base.report?.days_requested ?? DAYS_REQUESTED) / 30),
    // True only because these are the CRA products. An Assets-only integration
    // would have to set this false and would lose CRD-017 with it.
    vendorAuthorizedForDu: true,
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

function classify(key: string): AlternativeReference["kind"] {
  if (RENT_WORDS.test(key)) return "rent";
  if (UTILITY_WORDS.test(key)) return "utility";
  if (INSURANCE_WORDS.test(key)) return "insurance";
  if (PHONE_WORDS.test(key)) return "phone";
  return "other";
}

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
    const key = norm(t.description);
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

    found.push({
      kind: classify(key),
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
      const key = norm(t.description);
      const matched = [...knownPayers].some((p) => p && (p.includes(key) || key.includes(p)));
      return {
        accountId: t.accountId ?? "",
        date: t.date ?? "",
        amount: Math.abs(t.amount!),
        description: t.description ?? "",
        ...(matched ? { sourceType: "payroll" } : {}),
      };
    })
    .sort((a, b) => b.amount - a.amount);
}
