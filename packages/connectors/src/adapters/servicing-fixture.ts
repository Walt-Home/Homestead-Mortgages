/**
 * The servicing fixture: what the servicing platform answered about the
 * sample book.
 *
 * The twelve loans are Northlight's — the same `NL-100001` … `NL-100012`
 * that `@hm/partner-book`'s sample tape carries and that his seed-demo loads
 * on the other side — and every verdict and reason here is what his engine
 * wrote for them on 21 September 2026, read back from his
 * `partner_book_reviews` after `seed-demo` and one sweep. Loan 1's offer is
 * the benefit disclosure his `refi.opportunity.offer_ready` carried that
 * day, figure for figure. Nothing is invented; a loan the fixture does not
 * know is a loan the platform does not hold, which is `null`.
 *
 * Words for the reasons exist only for loan 1, because that is the one
 * whose `review.facts` was read; the others carry the engine's codes alone,
 * exactly as his event does.
 */

import type { ServicingRecord, ServicingReviewVerdict } from "@hm/shared";
import type { ConnectorResult, ServicingConnector, ServicingLoanRef } from "../ports/index.js";

/** The slug the sample partner has on our side. */
export const FIXTURE_SERVICER_SLUG = "northlight";
export const FIXTURE_SERVICING_AS_OF = "2026-09-21";

interface Captured {
  readonly verdict: ServicingReviewVerdict;
  readonly reasons: readonly string[];
  readonly reasonsInWords?: readonly string[];
  readonly offer?: boolean;
}

/* prettier-ignore */
const CAPTURED: Readonly<Record<string, Captured>> = {
  "NL-100001": {
    verdict: "candidate",
    reasons: ["rate_delta", "npv_positive", "seven_year_delta_positive", "prescreen", "state_rule"],
    reasonsInWords: [
      "the rate reduction clears the program's floor",
      "the savings over the holding period are positive",
      "the total cost over seven years is lower",
      "the loan passes the eligibility prescreen",
      "the state's borrower's-interest rule is met",
    ],
    offer: true,
  },
  "NL-100002": { verdict: "watching", reasons: ["seven_year_total_cost_delta ≤ 0"] },
  "NL-100003": { verdict: "watching", reasons: ["rate_delta_bps -62.5 < 25", "npv_cents -417560 ≤ 0", "seven_year_total_cost_delta ≤ 0", "lifetime_interest_delta > 0 and same_term_npv ≤ 0"] },
  "NL-100004": { verdict: "watching", reasons: ["not_priceable", "not_priced"] },
  "NL-100005": { verdict: "watching", reasons: ["not_priceable", "not_priced"] },
  "NL-100006": { verdict: "watching", reasons: ["not_priceable", "not_priced"] },
  "NL-100007": { verdict: "watching", reasons: ["not_priceable", "not_priced"] },
  "NL-100008": { verdict: "excluded", reasons: ["delinquent"] },
  "NL-100009": { verdict: "watching", reasons: ["rate_delta_bps -50 < 25", "seven_year_total_cost_delta ≤ 0", "lifetime_interest_delta > 0 and same_term_npv ≤ 0"] },
  "NL-100010": { verdict: "excluded", reasons: ["foreclosure_referred"] },
  "NL-100011": { verdict: "excluded", reasons: ["bankruptcy_active"] },
  "NL-100012": { verdict: "watching", reasons: ["not_priceable", "not_priced"] },
};

/** A stable, obviously-fixture id for each loan, so a caller can see which it was. */
const externalLoanId = (n: string) => `fixture-servicing-${n.toLowerCase()}`;

function record(n: string, c: Captured): ServicingRecord {
  return {
    externalLoanId: externalLoanId(n),
    servicerLoanNumber: n,
    relationship: "monitored",
    loadedAsOf: "2026-09-01",
    review: {
      asOf: FIXTURE_SERVICING_AS_OF,
      verdict: c.verdict,
      reasons: c.reasons,
      reasonsInWords: c.reasonsInWords ?? [],
    },
    offer: c.offer
      ? {
          detectedAt: "2026-09-21T15:28:17.432Z",
          offeredAt: "2026-09-21T15:28:40.194Z",
          expiresOn: "2026-10-21",
          currentRatePct: "7.250",
          offeredRatePct: "6.375",
          rateDeltaBps: 87.5,
          currentPiCents: 306_979n,
          offeredPiCents: 279_494n,
          piDeltaCents: 27_485n,
          remainingTermMonths: 337,
          newTermMonths: 360,
        }
      : null,
    readiness: {
      asOf: FIXTURE_SERVICING_AS_OF,
      items: [
        { item: "contact", status: "present" },
        { item: "account", status: "missing" },
        { item: "esign", status: "missing" },
        { item: "credit_authorization", status: "missing" },
        { item: "identity", status: "missing" },
        { item: "credit", status: "missing" },
        { item: "income", status: "missing" },
      ],
    },
    openClocks: c.offer
      ? [
          { code: "SM_REFI_OPPORTUNITY_EXPIRY_30", dueOn: "2026-10-21" },
          { code: "SM_PARTNER_BOOK_INVITATION_REMINDER_14", dueOn: "2026-10-05" },
        ]
      : [{ code: "SM_PARTNER_BOOK_INVITATION_REMINDER_14", dueOn: "2026-10-05" }],
    events: [
      ...(c.offer
        ? [
            { at: "2026-09-21T15:28:40.194Z", type: "refi.opportunity.offered" },
            { at: "2026-09-21T15:28:17.432Z", type: "refi.opportunity.offer_ready" },
          ]
        : []),
      { at: "2026-09-21T15:28:38.000Z", type: "partner_book.review.written" },
      { at: "2026-09-21T15:24:17.249Z", type: "partner_book.invitation.sent" },
      { at: "2026-09-21T15:24:17.000Z", type: "partner_book.loan.loaded" },
    ],
  };
}

export interface FixtureServicingOptions {
  readonly latencyMs?: number;
}

export function fixtureServicingConnector(
  options: FixtureServicingOptions = {},
): ServicingConnector {
  const latencyMs = options.latencyMs ?? 0;
  return {
    capabilities: { provider: "fixture-servicing", mode: "fixture", satisfies: [] },
    async fetchRecord(ref: ServicingLoanRef): Promise<ConnectorResult<ServicingRecord> | null> {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      const captured = CAPTURED[ref.servicerLoanNumber];
      if (!captured || ref.servicerSlug !== FIXTURE_SERVICER_SLUG) return null;
      return {
        data: record(ref.servicerLoanNumber, captured),
        provider: "fixture-servicing",
        retrievedAt: new Date().toISOString(),
        externalId: externalLoanId(ref.servicerLoanNumber),
      };
    },
  };
}
