/**
 * The portal's client for our own door, `/api/servicer`, on the same origin
 * the portal is served from. The session is our cookie; nothing about it is
 * held here. Every refusal is our envelope, `{ error: { message, code,
 * ...facts } }`, folded into one error the pages can read.
 */

import type { Cadence, MeterTerms } from "../lib/billing.js";
import type { Statement, StatementStanding } from "../lib/billing.js";

export class PortalError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null,
    /** Facts beside the code, e.g. `locked_until`. */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Fired when the server says there is no session any more. */
export const PORTAL_SIGNED_OUT = "partners:signed-out";

export interface PortalCall {
  readonly method?: "GET" | "POST" | "DELETE";
  readonly body?: unknown;
  readonly query?: Record<string, string | number | boolean | null | undefined>;
  readonly signal?: AbortSignal;
}

function qs(query: PortalCall["query"]): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function portal<T>(path: string, init: PortalCall = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`/api/servicer${path}${qs(init.query)}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    signal: init.signal,
  });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: { message: text.slice(0, 200) } };
  }
  if (!response.ok) {
    const error = ((body as { error?: Record<string, unknown> }).error ?? {}) as Record<
      string,
      unknown
    >;
    const code = typeof error.code === "string" ? error.code : null;
    if (response.status === 401 && !path.startsWith("/auth/") && path !== "/me") {
      window.dispatchEvent(new CustomEvent(PORTAL_SIGNED_OUT));
    }
    const { message, code: _code, ...extra } = error;
    void _code;
    throw new PortalError(
      response.status,
      typeof message === "string" && message ? message : `Request failed (${response.status})`,
      code,
      extra,
    );
  }
  return body as T;
}

/* ── what the door answers ─────────────────────────────────────────────────── */

export interface PortalMe {
  user: { id: string; email: string; name: string | null };
  servicer: { slug: string; displayName: string };
}

export interface PortalBook {
  servicer: { slug: string; displayName: string };
  book: {
    imports: number;
    lastAsOf: string | null;
    loans: { total: number; byState: Record<string, number> };
    analysis: { asOf: string; verdicts: Record<string, number> } | null;
  };
  team: { active: number };
}

export interface PortalLoan {
  id: string;
  number: string;
  borrower: string | null;
  property: string | null;
  state: string;
  noteRatePct: string;
  balanceCents: string | null;
  review: { verdict: string; asOf: string } | null;
  offer: { status: string; deliveredAt: string | null; validUntil: string | null } | null;
  claim: {
    deliveredTo: string | null;
    deliveredAt: string | null;
    acceptedAt: string | null;
    expiresAt: string;
  } | null;
}

/** One loan's page: `servicerBookLoan` in `apps/api`. */
export interface PortalLoanDetail {
  id: string;
  number: string;
  borrower: string | null;
  state: string;
  watchedSince: string;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };
  terms: {
    rateType: string;
    noteRatePct: string;
    termMonths: number;
    originalPrincipalCents: string;
    originatedOn: string | null;
    firstPaymentOn: string | null;
    maturityOn: string | null;
  };
  tapes: PortalTape[];
  reviews: PortalReview[];
  offers: PortalOffer[];
  claim: PortalLoan["claim"];
}

export interface PortalTape {
  asOf: string;
  status: string;
  principalBalanceCents: string;
  escrowBalanceCents: string | null;
  scheduledPaymentCents: string | null;
  currentRatePct: string | null;
  nextPaymentDueOn: string | null;
  delinquencyDays: number | null;
}

export interface PortalReview {
  asOf: string;
  verdict: string;
  reasons: string[];
  candidateRatePct: string | null;
}

export interface PortalOffer {
  id: string;
  status: string;
  detectedOn: string;
  deliveredAt: string | null;
  validUntil: string | null;
  answeredAt: string | null;
  currentRatePct: string | null;
  newRatePct: string;
  currentPaymentCents: string | null;
  newPaymentCents: string | null;
  monthlySavingsCents: string | null;
}

/** A month's statement as the servicer's team reads it: closed is an invoice. */
export interface PortalStatement {
  statement: Statement;
  standing: StatementStanding;
  closedAt: string | null;
}

export interface PortalInvoice {
  id: string;
  month: string;
  sheetVersion: string;
  loansBilled: number;
  loanMonths: string;
  balanceCents: string;
  tokens: string;
  cents: string;
  closedAt: string;
  /** The invoice issued for the month and where it stands; null until one has been sent. */
  issued: {
    id: string;
    month: string;
    number: string | null;
    standing: "open" | "sent" | "past_due" | "paid" | "uncollectible";
    amountCents: string;
    amountRemainingCents: string;
    creditedCents: string;
    dueAt: string | null;
    sentAt: string | null;
    paidAt: string | null;
  } | null;
}

export interface PortalCreditNote {
  id: string;
  number: string | null;
  amountCents: string;
  memo: string;
  issuedAt: string | null;
}

export interface PortalBilling {
  sheet: { version: string; date: string };
  today: string;
  servicer: { displayName: string; annualTokenPool: string | null; since: string | null };
  terms: MeterTerms;
  cadence: Cadence;
  current: PortalStatement;
  invoices: PortalInvoice[];
}

export interface PortalBankAccount {
  id: string;
  bankName: string | null;
  last4: string | null;
  accountType: string | null;
  isDefault: boolean;
  addedAt: string;
}

export interface PortalTeamMember {
  id: string;
  email: string;
  name: string | null;
  standing: "invited" | "active" | "disabled" | "expired";
  invitedAt: string;
  inviteExpiresAt: string | null;
  inviteDeliveredAt: string | null;
  acceptedAt: string | null;
  lastSignedInAt: string | null;
}

export const PORTAL_PAGE = 100;
