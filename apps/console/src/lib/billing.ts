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

export interface BillingServicerPage {
  readonly sheet: { readonly version: string; readonly date: string };
  readonly today: string;
  readonly servicer: BillingServicer;
  readonly current: StatementAnswer;
  readonly statements: readonly ClosedStatement[];
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
