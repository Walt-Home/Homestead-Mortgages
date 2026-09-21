/**
 * What the servicing platform says about a mortgage, read live.
 *
 * Not what the servicer's tape said — that is a `servicing_observations` row,
 * appended per tape and kept on our side. This is what the platform that
 * watches or services the loan has CONCLUDED about it since: the daily
 * review's verdict and its reasons in words, the offer the review produced
 * if it produced one, what a refinance would still need, the clocks that
 * are running, and the events that led here. Balance and next due are not
 * on it on purpose: the tape already delivers those, and a second source for
 * the same figure is a disagreement waiting to happen.
 *
 * Every rate is a percent to three decimals as a string ("6.375"), the unit
 * a note is quoted in; every amount is `bigint` cents.
 */

/** The daily review's word for a loan, in the platform's own vocabulary. */
export type ServicingReviewVerdict = "candidate" | "watching" | "not_now" | "excluded";

export interface ServicingReview {
  readonly asOf: string;
  readonly verdict: ServicingReviewVerdict;
  /** The engine's reason codes, as it recorded them. */
  readonly reasons: readonly string[];
  /** The same reasons as the platform words them for a person; empty when it has no words for them. */
  readonly reasonsInWords: readonly string[];
}

/**
 * The refinance the review found worth the borrower's attention. Every figure
 * is the platform's benefit disclosure as it computed it, and the disclosure
 * itself says it is not a commitment.
 */
export interface ServicingOffer {
  readonly detectedAt: string;
  /** When the offer went out, or null while it is ready and not yet delivered. */
  readonly offeredAt: string | null;
  /** The day the offer lapses, from the platform's own expiry clock, when one is armed. */
  readonly expiresOn: string | null;
  readonly currentRatePct: string;
  readonly offeredRatePct: string;
  readonly rateDeltaBps: number;
  readonly currentPiCents: bigint | null;
  readonly offeredPiCents: bigint | null;
  readonly piDeltaCents: bigint | null;
  readonly remainingTermMonths: number | null;
  readonly newTermMonths: number | null;
}

export interface ServicingReadinessItem {
  readonly item: string;
  readonly status: string;
}

export interface ServicingReadiness {
  readonly asOf: string;
  readonly items: readonly ServicingReadinessItem[];
}

export interface ServicingClock {
  readonly code: string;
  readonly dueOn: string | null;
}

export interface ServicingEvent {
  readonly at: string;
  readonly type: string;
}

export interface ServicingRecord {
  /** The platform's own id for the loan. Opaque here; the next read uses it. */
  readonly externalLoanId: string;
  readonly servicerLoanNumber: string;
  /** Whether the platform services the loan or only watches it for the servicer of record. */
  readonly relationship: "monitored" | "serviced";
  /** The as-of date of the newest tape the platform loaded for it, when it came from one. */
  readonly loadedAsOf: string | null;
  readonly review: ServicingReview | null;
  readonly offer: ServicingOffer | null;
  readonly readiness: ServicingReadiness | null;
  readonly openClocks: readonly ServicingClock[];
  /** Newest first, capped by the adapter. */
  readonly events: readonly ServicingEvent[];
}
