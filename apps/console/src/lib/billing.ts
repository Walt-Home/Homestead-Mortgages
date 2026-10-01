/**
 * Billing's wire: what our API answers at `/console/hm/billing`, and the
 * calls the pages make. The shapes are `services/billing.ts` in `apps/api`
 * and `@hm/billing`'s statement, spelled here once for the screens.
 */

import { call, type Call } from "./api.js";

export async function billing<T>(path: string, init: Call = {}): Promise<T> {
  return (await call<T>(path, init, "billing")).data;
}

export interface BillingServicer {
  readonly slug: string;
  readonly displayName: string;
  readonly integrationDepth: string;
  /** Tokens, as a decimal string; null until somebody sets it. */
  readonly annualTokenPool: string | null;
  /** The day the first loan of theirs was loaded; null with no book. */
  readonly since: string | null;
}

export interface ClosedStatement {
  readonly id: string;
  readonly month: string;
  readonly sheetVersion: string;
  readonly loansBilled: number;
  readonly loanMonths: string;
  readonly balanceCents: string;
  readonly tokens: string;
  readonly cents: string;
  readonly closedAt: string;
  readonly closedBy: string;
}

export interface BillingServicerCard extends BillingServicer {
  readonly loansOnBook: number;
  readonly running: {
    readonly month: string;
    readonly through: string;
    readonly loansBilled: number;
    readonly balanceCents: string;
    readonly tokens: string;
    readonly cents: string;
  };
  readonly lastClosed: ClosedStatement | null;
  readonly yearToDate: { readonly year: number; readonly tokens: string; readonly cents: string };
}

export type ObservedStatus =
  "current" | "delinquent" | "paid_off" | "charged_off" | "matured" | "transferred";

export interface LoanCharge {
  readonly loanId: string;
  readonly number: string;
  readonly watchedFrom: string;
  readonly endedOn: string | null;
  readonly days: number;
  readonly basis: {
    readonly asOf: string;
    readonly status: ObservedStatus;
    readonly principalBalanceCents: string;
  } | null;
  readonly tokens: string;
  readonly touches: number;
  readonly touchTokens: string;
}

export type LineQuantity =
  | {
      readonly kind: "loan_months";
      readonly loanMonths: string;
      readonly loanDays: number;
      readonly loans: number;
      readonly balanceCents: string;
    }
  | { readonly kind: "events"; readonly count: number };

export interface StatementLine {
  readonly code: string;
  readonly action: string;
  readonly fires: string;
  readonly basis: "per_100k" | "flat";
  readonly tokensEach: number;
  readonly quantity: LineQuantity;
  readonly tokens: string;
  readonly cents: string;
}

export interface Statement {
  readonly sheet: { readonly version: string; readonly date: string };
  readonly month: string;
  readonly from: string;
  readonly to: string;
  readonly through: string;
  readonly daysInMonth: number;
  readonly loansOnBook: number;
  readonly loansBilled: number;
  readonly loanDays: number;
  readonly loanMonths: string;
  readonly balanceCents: string;
  readonly tokens: string;
  readonly cents: string;
  readonly lines: readonly StatementLine[];
  readonly loans: readonly LoanCharge[];
}

export type StatementStanding = "closed" | "open" | "running";

export interface StatementAnswer {
  readonly servicer: BillingServicer;
  readonly statement: Statement;
  readonly standing: StatementStanding;
  readonly closed: {
    readonly id: string;
    readonly closedAt: string;
    readonly closedBy: string;
  } | null;
}

export interface BillingList {
  readonly sheet: { readonly version: string; readonly date: string };
  readonly today: string;
  readonly servicers: readonly BillingServicerCard[];
}

export interface BillingProfile {
  readonly legalName: string | null;
  readonly billingEmail: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string;
  readonly ein: string | null;
  readonly netDays: number | null;
  readonly purchaseOrder: string | null;
  readonly customer: { readonly provider: string; readonly id: string } | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export type ProfileGap = "legal_name" | "billing_email" | "net_days" | "address";

export const GAP_WORDS: Record<ProfileGap, string> = {
  legal_name: "the legal name",
  billing_email: "where the invoice goes",
  net_days: "the payment terms",
  address: "the rest of the address",
};

export type InvoiceStandingWord =
  "draft" | "approved" | "open" | "sent" | "past_due" | "paid" | "void" | "uncollectible";

export interface InvoiceView {
  readonly id: string;
  readonly statementId: string;
  readonly month: string;
  readonly attempt: number;
  readonly number: string | null;
  readonly standing: InvoiceStandingWord;
  readonly provider: string;
  readonly livemode: boolean;
  readonly atProvider: boolean;
  readonly providerInvoiceId: string | null;
  readonly currency: string;
  readonly amountCents: string;
  readonly amountDueCents: string;
  readonly amountPaidCents: string;
  readonly amountRemainingCents: string;
  readonly netDays: number;
  readonly dueAt: string | null;
  /** As its footer prints them; null on a row from before the issuer was decided. */
  readonly issuerName: string | null;
  readonly termsUrl: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly createdByName: string | null;
  /** One admin approves; a different one sends. */
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly approvedByName: string | null;
  readonly finalizedAt: string | null;
  readonly sentAt: string | null;
  readonly sentBy: string | null;
  readonly sentByName: string | null;
  readonly paidAt: string | null;
  readonly paidOutOfBand: boolean;
  readonly voidedAt: string | null;
  readonly voidedBy: string | null;
  readonly uncollectibleAt: string | null;
  readonly lastSyncedAt: string | null;
}

export type CreditNoteReason =
  "duplicate" | "fraudulent" | "order_change" | "product_unsatisfactory";
export type CreditNoteSettlement = "customer_balance" | "refund" | "out_of_band";

export const CREDIT_REASON_WORDS: Record<CreditNoteReason, string> = {
  duplicate: "Charged twice",
  order_change: "The charge changed",
  product_unsatisfactory: "The service fell short",
  fraudulent: "Fraudulent",
};

export const SETTLEMENT_WORDS: Record<string, string> = {
  REDUCES_AMOUNT_DUE: "Less due on this invoice",
  CUSTOMER_BALANCE: "Credit on the next invoice",
  REFUND: "Refunded through Stripe",
  OUT_OF_BAND: "Refunded outside Stripe",
};

export interface CreditNoteView {
  readonly id: string;
  readonly invoiceId: string;
  readonly number: string | null;
  readonly standing: "pending" | "issued" | "void";
  readonly atProvider: boolean;
  readonly providerCreditNoteId: string | null;
  readonly amountCents: string;
  readonly reason: CreditNoteReason;
  readonly memo: string;
  readonly settlement: "REDUCES_AMOUNT_DUE" | "CUSTOMER_BALANCE" | "REFUND" | "OUT_OF_BAND";
  readonly createdAt: string;
  readonly createdBy: string;
  readonly issuedAt: string | null;
  readonly voidedAt: string | null;
  readonly voidedBy: string | null;
}

export interface BankAccountOnFile {
  readonly id: string;
  readonly bankName: string | null;
  readonly last4: string | null;
  readonly accountType: string | null;
  readonly holderType: string | null;
  readonly isDefault: boolean;
  readonly addedAt: string;
}

export interface BankAccountsAnswer {
  readonly customer: { readonly provider: string; readonly id: string } | null;
  readonly accounts: readonly BankAccountOnFile[];
}

export interface BankSetupLink {
  readonly url: string;
  readonly expiresAt: string;
}

/** Who the provider prints at the head of an invoice: its account's public business name. */
export interface ProviderIssuer {
  readonly accountId: string;
  readonly name: string | null;
  readonly statementDescriptor: string | null;
  readonly supportEmail: string | null;
  readonly livemode: boolean;
}

export interface InvoicingStanding {
  readonly provider: string;
  readonly mode: "fixture" | "sandbox" | "production";
  readonly canIssue: boolean;
  readonly cannotIssueBecause: string | null;
  readonly maxInvoiceCents: string;
  readonly paymentMethods: readonly string[];
  readonly verifiesEvents: boolean;
  /** Who issues an invoice, as its footer prints it. */
  readonly issuer: {
    readonly name: string;
    readonly address: string;
    readonly supportEmail: string;
    readonly termsUrl: string;
  };
  /** Who the provider prints at the head; null when it could not be read. */
  readonly printed: ProviderIssuer | null;
  readonly printedError: string | null;
  /** Whether what the provider prints names us; null when it could not be read. */
  readonly issuerAgrees: boolean | null;
  /** Approved by one admin, sent by another. */
  readonly twoPerson: true;
}

export interface InvoiceLink {
  readonly hostedUrl: string;
  readonly pdfUrl: string | null;
}

export interface InvoiceHistoryEntry {
  readonly from: string | null;
  readonly to: string;
  readonly cause: string;
  /** The person, when the cause is one. */
  readonly actorName: string | null;
  readonly note: string | null;
  readonly at: string;
}

export interface BillingServicerPage {
  readonly sheet: { readonly version: string; readonly date: string };
  readonly today: string;
  readonly servicer: BillingServicer;
  readonly current: StatementAnswer;
  readonly statements: readonly ClosedStatement[];
  readonly profile: BillingProfile;
  readonly profileGaps: readonly ProfileGap[];
  readonly invoices: readonly InvoiceView[];
  readonly invoicing: InvoicingStanding;
}

export const PAYMENT_METHOD_WORDS: Record<string, string> = {
  customer_balance: "bank transfer",
  us_bank_account: "ACH debit",
  card: "card",
};
export const paymentMethodWord = (m: string): string => PAYMENT_METHOD_WORDS[m] ?? m;

/**
 * Open the invoice's hosted page in a new tab. The tab is opened before the
 * link is fetched, because a browser blocks a window opened after an await;
 * the link is read fresh each time, since it expires.
 */
export async function openInvoicePage(fetchLink: () => Promise<InvoiceLink>): Promise<void> {
  const tab = window.open("", "_blank", "noopener");
  try {
    const { hostedUrl } = await fetchLink();
    if (tab) tab.location.href = hostedUrl;
    else window.location.assign(hostedUrl);
  } catch (err) {
    tab?.close();
    throw err;
  }
}

export interface CloseReport {
  readonly month: string;
  readonly closed: readonly {
    readonly slug: string;
    readonly tokens: string;
    readonly cents: string;
  }[];
  readonly alreadyClosed: readonly string[];
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-09" → "September 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  const name = MONTHS[Number(m) - 1];
  return name && y ? `${name} ${y}` : month;
}

/** "YYYY-MM" of a day. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

/**
 * Every month from `since` through `today`, newest first — the months a
 * servicer's book has been on ours, which is the list a statement can be
 * asked for. A servicer with no book has only this month.
 */
export function monthsSince(since: string | null, today: string): string[] {
  const last = monthOf(today);
  const first = since ? monthOf(since) : last;
  const out: string[] = [];
  let [y, m] = last.split("-").map(Number) as [number, number];
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key <= first || out.length > 240) break;
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

/** "78,253 tokens", "1 token". */
export function tokensWord(tokens: string | number): string {
  const n = typeof tokens === "number" ? tokens : Number(tokens);
  if (!Number.isFinite(n)) return `${tokens} tokens`;
  return `${n.toLocaleString("en-US")} ${n === 1 ? "token" : "tokens"}`;
}

/**
 * The record in Stripe's own dashboard, for staff. A test-mode object
 * lives under `/test`; a live one at the root. Null for the fixture, which
 * has no dashboard.
 */
export function stripeDashboardUrl(
  kind: "invoices" | "credit_notes" | "customers",
  providerId: string | null,
  provider: string,
  livemode: boolean,
): string | null {
  if (!providerId || !provider.startsWith("stripe")) return null;
  return `https://dashboard.stripe.com/${livemode ? "" : "test/"}${kind}/${providerId}`;
}

/** The first day of the month after a "YYYY-MM-DD" day, as a day. */
export function firstOfNextMonth(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

/** Calendar days from one "YYYY-MM-DD" through another, inclusive. */
export function daysThrough(from: string, through: string): number {
  const a = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(through.slice(0, 4)),
    Number(through.slice(5, 7)) - 1,
    Number(through.slice(8, 10)),
  );
  return Math.max(0, Math.round((b - a) / 86_400_000) + 1);
}
