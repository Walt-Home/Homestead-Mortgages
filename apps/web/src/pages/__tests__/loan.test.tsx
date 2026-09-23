/**
 * What the mortgage page puts on the page, for each thing the record can be.
 *
 * Rendered to a string with the query cache seeded, like the home page's
 * suite: the page takes no interaction the markup cannot answer for, and a
 * static render runs no effects. The assertions are the ones only markup can
 * make — that the tape's figures are the tape's, that the four live shapes
 * each say what they are, and that nothing the engine is written in (a
 * reason code, a clock code, an event name) reaches a borrower.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { LoanPage } from "../LoanPage.js";
import { ApiError } from "../../lib/api.js";
import type {
  LiveServicing,
  RefiOfferWire,
  ServicingRecordWire,
  ServicingResponse,
} from "../../lib/loan.js";
import { FINDING_WHERE_YOU_STAND, TRY_AGAIN } from "../../lib/home-copy.js";
import type { LoanReviewWire } from "../../lib/loan.js";
import {
  IN_PLAIN_WORDS,
  NEVER_ASK,
  NOT_CHECKED_HERE,
  NOT_HELD,
  NOT_NOW,
  NOT_REVIEWED_YET,
  OFFER_LEAD,
  OUR_READINESS,
  PLATFORM_SAYS,
  SAME_TERM_PAYMENT,
  NOT_YOUR_MORTGAGE_LEAD,
  NO_TAPE_YET,
  READINESS,
  STILL_NEEDED,
  UNREACHABLE,
  VERDICT,
  WATCHING,
  WE_HAVE_IT,
  YES_LOOK,
  notWired,
  offerAnswered,
  offerOpenUntil,
  reviewedOn,
  watchRateLine,
} from "../../lib/loan-copy.js";
import { entryFor } from "../../lib/states.js";

const ID = "50c48cdc-c20d-47a3-9c11-b2e5cbb9de37";
const SERVICER = "Northlight Mortgage Servicing (sample partner)";

/** The record the deployed platform answered for NL-100001 on 21 September, figure for figure. */
const RECORD: ServicingRecordWire = {
  externalLoanId: "e5852b7f-cc52-40e8-b923-3a6e34faf95b",
  servicerLoanNumber: "NL-100001",
  relationship: "monitored",
  loadedAsOf: "2026-09-01",
  review: {
    asOf: "2026-09-21",
    verdict: "candidate",
    reasons: ["rate_delta", "npv_positive", "seven_year_delta_positive", "prescreen", "state_rule"],
    reasonsInWords: ["the rate reduction clears the program's floor"],
  },
  offer: {
    detectedAt: "2026-09-21T15:28:17.432Z",
    offeredAt: "2026-09-21T15:28:40.194Z",
    expiresOn: "2026-10-21",
    currentRatePct: "7.250",
    offeredRatePct: "6.375",
    rateDeltaBps: 87.5,
    currentPiCents: "306979",
    offeredPiCents: "279494",
    piDeltaCents: "27485",
    remainingTermMonths: 337,
    newTermMonths: 360,
  },
  readiness: {
    asOf: "2026-09-21",
    items: [
      { item: "contact", status: "present" },
      { item: "credit_authorization", status: "missing" },
    ],
  },
  openClocks: [{ code: "SM_REFI_OPPORTUNITY_EXPIRY_30", dueOn: "2026-10-21" }],
  events: [{ at: "2026-09-21T15:28:40.194Z", type: "refi.opportunity.offered" }],
};

function response(over: Partial<ServicingResponse> = {}): ServicingResponse {
  return {
    review: null,
    offer: null,
    readiness: null,
    loan: {
      id: ID,
      state: "imported_unclaimed",
      servicerLoanNumber: "NL-100001",
      noteRateBps: 725,
      originalPrincipalCents: "45000000",
      property: { line1: "1200 W Maple Ave", city: "Phoenix", state: "AZ", postalCode: "85013" },
    },
    servicer: { slug: "northlight", displayName: SERVICER, integrationDepth: "API" },
    observed: {
      asOf: "2026-09-01",
      status: "CURRENT",
      principalBalanceCents: "44136613",
      escrowBalanceCents: "412250",
      scheduledPaymentCents: "306979",
      currentRatePct: "7.250",
      nextPaymentDueOn: "2026-10-01",
      delinquencyDays: 0,
      recordedAt: "2026-09-21T20:09:00.000Z",
    },
    live: {
      status: "fetched",
      provider: "supermortgage",
      retrievedAt: "2026-09-21T21:15:00.000Z",
      record: RECORD,
    },
    ...over,
  };
}

async function page(options: { read?: ServicingResponse; failed?: Error } = {}): Promise<string> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  if (options.failed) {
    const err = options.failed;
    await client.prefetchQuery({
      queryKey: ["loan", ID, "servicing"],
      queryFn: () => Promise.reject(err),
    });
  } else if (options.read) {
    client.setQueryData(["loan", ID, "servicing"], options.read);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/loans/${ID}`]}>
        <Routes>
          <Route path="/loans/:loanId" element={<LoanPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

describe("the mortgage page", () => {
  it("says it is finding the record before the read lands", async () => {
    expect(await page()).toContain(FINDING_WHERE_YOU_STAND);
  });

  it("puts the tape's figures under the servicer's name and date, and the verdict under ours", async () => {
    const markup = await page({ read: response() });
    // Whose it is, and where.
    expect(markup).toContain(`${SERVICER} shared this mortgage with us`);
    expect(markup).toContain("1200 W Maple Ave, Phoenix, AZ");
    expect(markup).toContain(entryFor("loan_imported_unclaimed")!.pill);
    // The tape's half, dated as the tape was.
    expect(markup).toContain(`What ${SERVICER} told us, as of September 1, 2026`);
    expect(markup).toContain("$441,366");
    expect(markup).toContain("7.25%");
    expect(markup).toContain("October 1, 2026");
    expect(markup).toContain("$3,070");
    expect(markup).toContain("$4,123");
    expect(markup).toContain("Current");
    // Ours: the verdict in words, the platform's reason in its words, the offer as figures.
    expect(markup).toContain(WATCHING);
    expect(markup).toContain(VERDICT.candidate.lead);
    expect(markup).toContain("the rate reduction clears the program's floor");
    expect(markup).toContain("about 6.375%");
    expect(markup).toContain("about $2,795");
    expect(markup).toContain("about $275");
    expect(markup).toContain("Open until October 21, 2026");
    expect(markup).toContain("Checked September 21, 2026");
    expect(markup).toContain(READINESS);
    expect(markup).toContain("credit authorization · still needed");
  });

  it("never renders the engine's own vocabulary", async () => {
    const markup = await page({ read: response() });
    for (const word of [
      "rate_delta",
      "npv_positive",
      "SM_REFI_OPPORTUNITY_EXPIRY_30",
      "refi.opportunity.offered",
      "supermortgage",
      "credit_authorization",
      "e5852b7f",
    ]) {
      expect(markup, word).not.toContain(word);
    }
  });

  it("says a figure the tape did not carry is not there, rather than zero", async () => {
    const read = response();
    const markup = await page({
      read: {
        ...read,
        observed: { ...read.observed!, scheduledPaymentCents: null, escrowBalanceCents: null },
      },
    });
    expect(markup).toContain("—");
    expect(markup).not.toContain("$0");
  });

  it("says when the servicer has sent nothing yet", async () => {
    const markup = await page({ read: response({ observed: null }) });
    expect(markup).toContain(NO_TAPE_YET);
    expect(markup).toContain(`What ${SERVICER} told us`);
  });

  it.each<[LiveServicing, string]>([
    [{ status: "not_wired", integrationDepth: "DEEP_LINK" }, notWired(SERVICER)],
    [{ status: "not_held" }, NOT_HELD],
    [{ status: "unavailable", reason: "The servicing platform answered 502" }, UNREACHABLE],
  ])("tells the three answers that are not a record apart: %o", async (live, sentence) => {
    const markup = await page({ read: response({ live }) });
    expect(markup).toContain(sentence);
    expect(markup).not.toContain(VERDICT.candidate.lead);
    // The platform's own error text is not borrower copy.
    expect(markup).not.toContain("502");
    // Only the network answer is worth retrying.
    expect(markup.includes(TRY_AGAIN)).toBe(live.status === "unavailable");
  });

  it("says a record with no review yet has not been compared, and still shows the tape", async () => {
    const markup = await page({
      read: response({
        live: {
          status: "fetched",
          provider: "supermortgage",
          retrievedAt: "2026-09-21T21:15:00.000Z",
          record: { ...RECORD, review: null, offer: null, readiness: null },
        },
      }),
    });
    expect(markup).toContain(NOT_REVIEWED_YET);
    expect(markup).toContain("$441,366");
    expect(markup).not.toContain(READINESS);
  });

  it("answers a stranger's link as no mortgage of theirs, with no retry", async () => {
    const markup = await page({ failed: new ApiError(404, "Loan not found", "NOT_FOUND") });
    expect(markup).toContain(NOT_YOUR_MORTGAGE_LEAD);
    expect(markup).not.toContain(TRY_AGAIN);
  });

  it("offers a retry when the read itself failed", async () => {
    const markup = await page({ failed: new Error("network") });
    expect(markup).toContain(TRY_AGAIN);
    expect(markup).not.toContain(NOT_YOUR_MORTGAGE_LEAD);
  });
});

/** Our own review of loan 1, as the API hands it out after the first run against the fixture's sheet. */
const OUR_REVIEW: LoanReviewWire = {
  asOf: "2026-09-22",
  verdict: "candidate",
  reasons: ["rate_delta", "npv_positive", "seven_year_delta_positive", "prescreen", "state_rule"],
  reasonsInWords: [
    "the rate reduction clears the program's floor",
    "the savings over the holding period are positive",
  ],
  facts: { note_rate_pct: "7.250", candidate_rate_pct: "6.250" },
  analyst: null,
  offer: {
    current_rate_pct: "7.250",
    current_pi_cents: "306979",
    new_rate_pct: "6.250",
    new_pi_cents: "275832",
    pi_delta_cents: "31147",
    rate_delta_bps: 100,
    remaining_term_months: 337,
    new_term_months: 360,
    same_term_pi_cents: "281900",
    present_same_term_first: false,
  },
  candidateRatePct: "6.250",
  recordedAt: "2026-09-22T11:00:00.000Z",
};

describe("our own review on the mortgage page", () => {
  it("leads with our verdict and figures, and puts the platform's reading under its own heading", async () => {
    const markup = await page({ read: response({ review: OUR_REVIEW }) });
    expect(markup).toContain(VERDICT.candidate.lead);
    expect(markup).toContain("the savings over the holding period are positive");
    expect(markup).toContain("about 6.25%");
    expect(markup).toContain("about $2,758");
    expect(markup).toContain("about $311");
    expect(markup).toContain(SAME_TERM_PAYMENT);
    expect(markup).toContain(reviewedOn("September 22, 2026"));
    // The platform's own reading is still on the page, under its own heading, unblended.
    expect(markup).toContain(PLATFORM_SAYS);
    expect(markup).toContain("the rate reduction clears the program's floor");
    expect(markup).toContain("Open until October 21, 2026");
    // Nothing the engine is written in.
    for (const word of [
      "rate_delta",
      "npv_positive",
      "fixture-pricing",
      "CONF-30-FIXED",
      "candidate_rate_pct",
    ]) {
      expect(markup, word).not.toContain(word);
    }
  });

  it("says what rate it would take when we are watching, and shows no offer", async () => {
    const watching: LoanReviewWire = {
      ...OUR_REVIEW,
      verdict: "watching",
      reasons: ["rate_delta_bps -37.5 < 25"],
      reasonsInWords: ["the rate reduction is under the program's floor"],
      facts: { note_rate_pct: "5.875", candidate_rate_pct: "6.250", watch_rate_pct: "5.625" },
      offer: null,
    };
    const markup = await page({
      read: response({ review: watching, live: { status: "not_held" } }),
    });
    expect(markup).toContain(VERDICT.watching.lead);
    expect(markup).toContain(watchRateLine("5.625%"));
    expect(markup).not.toContain(SAME_TERM_PAYMENT);
    expect(markup).toContain(PLATFORM_SAYS);
    expect(markup).toContain(NOT_HELD);
  });

  it("keeps the platform's reading in the first section until our first review exists", async () => {
    const markup = await page({ read: response() });
    expect(markup).not.toContain(PLATFORM_SAYS);
    expect(markup).toContain(VERDICT.candidate.lead);
  });
});

/** The offer loan 1's candidate review became, as the API hands it out while it stands. */
const OFFER: RefiOfferWire = {
  id: "0f5a3b9e-6e2a-4d61-9c0b-2f4b1d7a8e11",
  status: "offered",
  detectedOn: "2026-09-22",
  offeredAt: "2026-09-22T11:00:00.000Z",
  validUntil: "2026-10-22T11:00:00.000Z",
  answeredAt: null,
  disclosure: {
    current_rate_pct: "7.250",
    current_pi_cents: "306979",
    new_rate_pct: "6.250",
    new_pi_cents: "275832",
    pi_delta_cents: "-31147",
    rate_delta_bps: -100,
    remaining_term_months: 337,
    new_term_months: 360,
    loan_amount_cents: "44800000",
    same_term_months: 337,
    same_term_pi_cents: "281900",
    present_same_term_first: false,
    borrower_paid_costs_cents: "0",
    costs_statement: "Closing costs are estimated and are not paid by you at closing.",
    not_a_commitment: true,
  },
  candidateRatePct: "6.250",
  applicationFileId: null,
};

describe("the offer on the mortgage page", () => {
  it("leads with the offer's figures, the analyst's words, what we'd still need, and three answers", async () => {
    const withAnalyst: LoanReviewWire = {
      ...OUR_REVIEW,
      analyst: {
        rationale:
          "Your rate is 7.25% and today's candidate is 6.25%, which would change your monthly payment by -$311.47.",
        flags: [],
        confidence: 1,
      },
    };
    const markup = await page({
      read: response({
        review: withAnalyst,
        offer: OFFER,
        readiness: {
          byScreen: [
            { screen: "identity", outstanding: 6 },
            { screen: "declarations", outstanding: 4 },
            { screen: "bank", outstanding: 3 },
            { screen: "decision", outstanding: 2 },
          ],
          unmapped: ["contact_details", "insurance"],
        },
      }),
    });
    expect(markup).toContain(OFFER_LEAD);
    expect(markup).toContain("about 6.25%");
    expect(markup).toContain("about $448,000");
    expect(markup).toContain("30 years");
    expect(markup).toContain(offerOpenUntil("October 22, 2026"));
    expect(markup).toContain(IN_PLAIN_WORDS);
    expect(markup).toContain("change your monthly payment by -$311.47");
    // Our own readiness: the property is answered, the person's screens are not.
    expect(markup).toContain(OUR_READINESS);
    expect(markup).toContain(`records · <span class="text-ink-faint">${WE_HAVE_IT}`);
    expect(markup).toContain(STILL_NEEDED);
    expect(markup).toContain(NOT_CHECKED_HERE);
    expect(markup).toContain("how to reach you · homeowner's insurance");
    for (const control of [YES_LOOK, NOT_NOW, NEVER_ASK]) expect(markup).toContain(control);
    // The analyst's sentence sits on the card, not twice.
    expect(markup.split(IN_PLAIN_WORDS)).toHaveLength(2);
    // Nothing the engine is written in.
    for (const word of ["pi_delta_cents", "contact_details", "byScreen", "identity ·"]) {
      expect(markup, word).not.toContain(word);
    }
  });

  it("says what was answered once the offer has ended, and where a yes went", async () => {
    const engaged = await page({
      read: response({
        review: OUR_REVIEW,
        offer: {
          ...OFFER,
          status: "engaged",
          answeredAt: "2026-09-23T09:00:00.000Z",
          applicationFileId: "2a1a0b7e-3f0e-4a3d-8f8a-0d1c2b3a4e55",
        },
      }),
    });
    expect(engaged).toContain(offerAnswered("engaged", null).lead);
    expect(engaged).toContain("/f/2a1a0b7e-3f0e-4a3d-8f8a-0d1c2b3a4e55");
    expect(engaged).not.toContain(YES_LOOK);

    const declined = await page({
      read: response({
        review: OUR_REVIEW,
        offer: { ...OFFER, status: "declined", answeredAt: "2026-09-23T09:00:00.000Z" },
      }),
    });
    expect(declined).toContain(offerAnswered("declined", "September 23, 2026").lead);
    expect(declined).not.toContain(NOT_NOW);

    const lapsed = await page({
      read: response({ review: OUR_REVIEW, offer: { ...OFFER, status: "expired" } }),
    });
    expect(lapsed).toContain(offerAnswered("expired", "October 22, 2026").lead);
    // With no open offer, our review's figures and the analyst's words live under "What we're watching".
    expect(lapsed).toContain(SAME_TERM_PAYMENT);
  });
});
