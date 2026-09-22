/**
 * A mortgage, as the API hands it to a screen, and the two reads behind it.
 *
 * `GET /loans` is the list the signed-in person stands on; `GET
 * /loans/:id/servicing` is one of them with its record: what the servicer's
 * tape last said (ours, appended per tape) beside what the servicing
 * platform has concluded since (read live, when the servicer is wired that
 * deep). The two halves arrive apart and are rendered apart, because a card
 * that blended them would show a balance from one source beside a verdict
 * from the other as if they were one reading.
 *
 * Cents cross the wire as decimal strings — `bigint` on the server — and a
 * date the tape or the platform gives as a day stays a day here: it is
 * formatted as one, never turned into an instant and back, which is how a
 * due date on the first of the month comes out as the thirty-first.
 */

import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./api.js";
import { money } from "./figures.js";
import { entryFor } from "./states.js";

export interface LoanServicer {
  readonly slug: string;
  readonly displayName: string;
  readonly integrationDepth: "NONE" | "DEEP_LINK" | "API" | "SUBSERVICED";
}

export interface LoanProperty {
  readonly line1: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
}

export interface LoanRow {
  readonly id: string;
  /** A `LoanState`, in the domain's lower-case words. */
  readonly state: string;
  readonly servicerLoanNumber: string | null;
  readonly servicer: LoanServicer | null;
  readonly noteRateBps: number;
  readonly originalPrincipalCents: string;
  readonly property: LoanProperty;
}

export type ObservedStatus =
  "CURRENT" | "DELINQUENT" | "PAID_OFF" | "CHARGED_OFF" | "MATURED" | "TRANSFERRED";

/** The newest row the servicer's tape wrote about this loan. */
export interface ServicingObservation {
  readonly asOf: string;
  readonly status: ObservedStatus;
  readonly principalBalanceCents: string;
  readonly escrowBalanceCents: string | null;
  readonly scheduledPaymentCents: string | null;
  readonly currentRatePct: string | null;
  readonly nextPaymentDueOn: string | null;
  readonly delinquencyDays: number | null;
  readonly recordedAt: string;
}

export type ReviewVerdict = "candidate" | "watching" | "not_now" | "excluded";

/** What the platform concluded, as `ServicingRecord` in `@hm/shared` with its cents as strings. */
export interface ServicingRecordWire {
  readonly externalLoanId: string;
  readonly servicerLoanNumber: string;
  readonly relationship: "monitored" | "serviced";
  readonly loadedAsOf: string | null;
  readonly review: {
    readonly asOf: string;
    readonly verdict: ReviewVerdict;
    /** The engine's codes. Never rendered; the words below are. */
    readonly reasons: readonly string[];
    readonly reasonsInWords: readonly string[];
  } | null;
  readonly offer: {
    readonly detectedAt: string;
    readonly offeredAt: string | null;
    readonly expiresOn: string | null;
    readonly currentRatePct: string;
    readonly offeredRatePct: string;
    readonly rateDeltaBps: number;
    readonly currentPiCents: string | null;
    readonly offeredPiCents: string | null;
    readonly piDeltaCents: string | null;
    readonly remainingTermMonths: number | null;
    readonly newTermMonths: number | null;
  } | null;
  readonly readiness: {
    readonly asOf: string;
    readonly items: readonly { readonly item: string; readonly status: string }[];
  } | null;
  readonly openClocks: readonly { readonly code: string; readonly dueOn: string | null }[];
  readonly events: readonly { readonly at: string; readonly type: string }[];
}

/**
 * The live half, in four shapes the screen has to tell apart: "we did not
 * ask", "we asked and there is nothing", "we asked and could not reach it",
 * and an answer. One `null` for the first three would make the screen guess.
 */
export type LiveServicing =
  | {
      readonly status: "fetched";
      readonly provider: string;
      readonly retrievedAt: string;
      readonly record: ServicingRecordWire;
    }
  | { readonly status: "not_held" }
  | { readonly status: "not_wired"; readonly integrationDepth: string }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * Our own review of the loan: what the ported engine concluded on its last
 * run over the tape's newest observation and the sheet's rate. Its facts
 * and offer are in the engine's own names, cents as strings.
 */
export interface LoanReviewWire {
  readonly asOf: string;
  readonly verdict: ReviewVerdict;
  readonly reasons: readonly string[];
  readonly reasonsInWords: readonly string[];
  readonly facts: {
    readonly note_rate_pct?: string;
    readonly candidate_rate_pct?: string | null;
    readonly watch_rate_pct?: string;
    readonly npv_cents?: string | null;
    readonly seven_year_delta_cents?: string | null;
    readonly monthly_delta_cents?: string | null;
  } & Record<string, unknown>;
  readonly offer: {
    readonly current_rate_pct: string;
    readonly current_pi_cents: string;
    readonly new_rate_pct: string;
    readonly new_pi_cents: string;
    readonly pi_delta_cents: string;
    readonly rate_delta_bps: number;
    readonly remaining_term_months: number;
    readonly new_term_months: number;
    readonly same_term_pi_cents: string;
    readonly present_same_term_first: boolean;
  } | null;
  readonly candidateRatePct: string | null;
  readonly recordedAt: string;
}

export interface ServicingResponse {
  readonly review: LoanReviewWire | null;
  readonly loan: {
    readonly id: string;
    readonly state: string;
    readonly servicerLoanNumber: string | null;
    readonly noteRateBps: number;
    readonly originalPrincipalCents: string;
    readonly property: LoanProperty;
  };
  readonly servicer: LoanServicer | null;
  readonly observed: ServicingObservation | null;
  readonly live: LiveServicing;
}

export function useLoans() {
  return useQuery({
    queryKey: ["loans"],
    queryFn: () => api.get<{ loans: LoanRow[] }>("/loans"),
  });
}

export function useLoanServicing(loanId: string | undefined) {
  return useQuery({
    queryKey: ["loan", loanId, "servicing"],
    queryFn: () => api.get<ServicingResponse>(`/loans/${loanId}/servicing`),
    enabled: Boolean(loanId),
    // A 404 is "not yours or not there" and will never become a 200.
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
}

/** The catalog's entry for a loan state: `imported_unclaimed` → the `loan_imported_unclaimed` words. */
export const loanEntry = (state: string) => entryFor(`loan_${state}`);

/** Whole dollars from a cents string, through the one money formatter. */
export function dollars(cents: string | null | undefined): string | null {
  if (cents == null) return null;
  const n = Number(cents);
  return Number.isFinite(n) ? money(n / 100) : null;
}

/**
 * A rate as the note quotes it: "7.250" → "7.25%", "6.375" → "6.375%".
 * The trailing zeros a three-decimal wire format carries are not part of the
 * rate, and a person reads 7.25 rather than 7.250.
 */
export function ratePct(pct: string | null | undefined): string | null {
  if (pct == null) return null;
  const n = Number(pct);
  if (!Number.isFinite(n)) return null;
  return `${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;
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

/**
 * A day, said month-first, from a `YYYY-MM-DD`.
 *
 * Not `timelineDate`: that one takes an instant and prints it in the
 * creditor's zone, which is right for a deadline and wrong for a day —
 * `new Date("2026-10-01")` is midnight UTC, which is the evening of the
 * thirtieth in New York.
 */
export function calendarDate(day: string | null | undefined): string | null {
  const m = day ? /^(\d{4})-(\d{2})-(\d{2})/.exec(day) : null;
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}, ${m[1]}` : null;
}

/** "1247 Oak Street, Austin, TX", from whichever lines the tape carried. */
export function addressLine(p: LoanProperty): string {
  const town = [p.city, p.state].filter(Boolean).join(", ");
  return [p.line1, town].filter(Boolean).join(", ");
}
