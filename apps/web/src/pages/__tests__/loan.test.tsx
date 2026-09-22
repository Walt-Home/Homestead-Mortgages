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
import type { LiveServicing, ServicingRecordWire, ServicingResponse } from "../../lib/loan.js";
import { FINDING_WHERE_YOU_STAND, TRY_AGAIN } from "../../lib/home-copy.js";
import {
  NOT_HELD,
  NOT_REVIEWED_YET,
  NOT_YOUR_MORTGAGE_LEAD,
  NO_TAPE_YET,
  READINESS,
  UNREACHABLE,
  VERDICT,
  WATCHING,
  notWired,
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
