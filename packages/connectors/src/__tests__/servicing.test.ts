/**
 * The servicing port: the fixture, and the adapter over his machine door.
 *
 * The adapter is driven against a stub of `fetch` that answers what his door
 * answered on 21 September 2026 — the import list, one import's loan lines,
 * a monitored loan's events and timers, and the two tools — so what is
 * asserted is the reading, not his server. The fixture's answers are the
 * same day's verdicts, so the two agree on loan 1 by construction, and the
 * test says so.
 */

import { describe, expect, it } from "vitest";
import {
  fixtureRegistry,
  fixtureServicingConnector,
  fractionToPct,
  ServicingUnavailableError,
  supermortgageServicingConnector,
} from "../index.js";

const LOAN = "e5852b7f-cc52-40e8-b923-3a6e34faf95b";
const IMPORT = "916e6f3a-1531-44f9-9e83-596770d0eda5";

/** What his door answered, path by path. */
const ANSWERS: Record<string, unknown> = {
  "GET /v1/partner-book/imports": {
    imports: [
      {
        import_id: IMPORT,
        partner_party_id: "1b47f981",
        as_of_date: "2026-09-01",
        status: "loaded",
      },
    ],
  },
  [`GET /v1/partner-book/imports/${IMPORT}`]: {
    import_id: IMPORT,
    loans: [
      { change: "created", loan_id: LOAN, party_id: "ce8784c6", servicer_loan_number: "NL-100001" },
      {
        change: "created",
        loan_id: "2d926064-82e8-44d1-8fcc-f3516ac3fe8d",
        party_id: "89a66fa3",
        servicer_loan_number: "NL-100002",
      },
    ],
  },
  [`GET /v1/loans/${LOAN}/events`]: {
    events: [
      {
        type: "partner_book.loan.loaded",
        occurredAt: "2026-09-21T15:24:17.000Z",
        payload: { change: "created", as_of_date: "2026-09-01", servicer_loan_number: "NL-100001" },
      },
      {
        type: "partner_book.invitation.sent",
        occurredAt: "2026-09-21T15:24:17.249Z",
        payload: { kind: "invitation" },
      },
      {
        type: "refi.opportunity.offer_ready",
        occurredAt: "2026-09-21T15:28:17.500Z",
        payload: {
          pi_cents: "279494",
          note_rate: "0.06375",
          detected_at: "2026-09-21T15:28:17.432Z",
          rate_delta_bps: 87.5,
          benefit_disclosure: {
            new_rate: "0.06375",
            current_rate: "0.07250",
            new_pi_cents: "279494",
            pi_delta_cents: "27485",
            rate_delta_bps: 87.5,
            new_term_months: 360,
            current_pi_cents: "306979",
            remaining_term_months: 337,
          },
        },
      },
      {
        type: "partner_book.review.written",
        occurredAt: "2026-09-21T15:28:38.000Z",
        payload: {
          verdict: "candidate",
          reasons: [
            "rate_delta",
            "npv_positive",
            "seven_year_delta_positive",
            "prescreen",
            "state_rule",
          ],
          as_of_date: "2026-09-21",
        },
      },
      {
        type: "refi.opportunity.offered",
        occurredAt: "2026-09-21T15:28:40.200Z",
        payload: { offered_at: "2026-09-21T15:28:40.194Z" },
      },
    ],
  },
  [`GET /v1/loans/${LOAN}/timers`]: {
    timers: [
      { code: "SM_PARTNER_BOOK_INVITATION_REMINDER_14", status: "armed", dueDate: "2026-10-05" },
      { code: "SM_REFI_OPPORTUNITY_EXPIRY_30", status: "armed", dueDate: "2026-10-21" },
      { code: "SM_REFI_OFFER_SLA_2BD", status: "satisfied", dueDate: "2026-09-23" },
    ],
  },
  [`POST /v1/loans/${LOAN}/tools/33.2/review.facts`]: {
    output: {
      verdict: "candidate",
      reasons_text: [
        "the rate reduction clears the program's floor",
        "the savings over the holding period are positive",
        "the total cost over seven years is lower",
        "the loan passes the eligibility prescreen",
        "the state's borrower's-interest rule is met",
      ],
    },
  },
  [`POST /v1/loans/${LOAN}/tools/33.3/readiness.read`]: {
    output: {
      found: true,
      as_of_date: "2026-09-21",
      items: [
        { item: "contact", status: "present" },
        { item: "account", status: "missing" },
      ],
    },
  },
};

function stubFetch(
  overrides: Record<string, unknown> = {},
  seen: { url: string; init: RequestInit }[] = [],
) {
  const answers = { ...ANSWERS, ...overrides };
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const key = `${init?.method ?? "GET"} ${path}`;
    seen.push({ url, init: init ?? {} });
    const answer = answers[key];
    if (answer === undefined)
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    // A `Response` body reads once, so a canned refusal is a factory.
    if (typeof answer === "function") return (answer as () => Response)();
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("the fixture", () => {
  const port = fixtureServicingConnector();

  it("answers the sample book's loans with his engine's verdicts, and no others", async () => {
    const one = await port.fetchRecord({
      servicerSlug: "northlight",
      servicerLoanNumber: "NL-100001",
    });
    expect(one?.data.review).toMatchObject({ verdict: "candidate" });
    expect(one?.data.offer).toMatchObject({
      currentRatePct: "7.250",
      offeredRatePct: "6.375",
      rateDeltaBps: 87.5,
    });
    expect(one?.data.offer?.currentPiCents).toBe(306_979n);
    const eight = await port.fetchRecord({
      servicerSlug: "northlight",
      servicerLoanNumber: "NL-100008",
    });
    expect(eight?.data.review).toMatchObject({ verdict: "excluded", reasons: ["delinquent"] });
    expect(eight?.data.offer).toBeNull();
    expect(
      await port.fetchRecord({ servicerSlug: "northlight", servicerLoanNumber: "NL-999999" }),
    ).toBeNull();
    expect(
      await port.fetchRecord({ servicerSlug: "somebody-else", servicerLoanNumber: "NL-100001" }),
    ).toBeNull();
  });

  it("is in the registry", () => {
    expect(fixtureRegistry({ latencyMs: 0 }).servicing.capabilities.provider).toBe(
      "fixture-servicing",
    );
  });
});

describe("the adapter over his machine door", () => {
  it("finds the loan by its servicer number and reads the record off his events", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const port = supermortgageServicingConnector({
      baseUrl: "http://servicing.test/",
      token: "dev-token",
      fetch: stubFetch({}, seen),
    });
    const r = await port.fetchRecord({
      servicerSlug: "northlight",
      servicerLoanNumber: "NL-100001",
    });
    expect(r).not.toBeNull();
    expect(r!.provider).toBe("supermortgage");
    expect(r!.externalId).toBe(LOAN);
    expect(r!.data).toMatchObject({
      externalLoanId: LOAN,
      servicerLoanNumber: "NL-100001",
      relationship: "monitored",
      loadedAsOf: "2026-09-01",
      review: {
        asOf: "2026-09-21",
        verdict: "candidate",
        reasons: [
          "rate_delta",
          "npv_positive",
          "seven_year_delta_positive",
          "prescreen",
          "state_rule",
        ],
      },
      offer: {
        currentRatePct: "7.250",
        offeredRatePct: "6.375",
        rateDeltaBps: 87.5,
        offeredAt: "2026-09-21T15:28:40.194Z",
        expiresOn: "2026-10-21",
        remainingTermMonths: 337,
        newTermMonths: 360,
      },
      readiness: {
        asOf: "2026-09-21",
        items: [
          { item: "contact", status: "present" },
          { item: "account", status: "missing" },
        ],
      },
    });
    expect(r!.data.review?.reasonsInWords[0]).toBe("the rate reduction clears the program's floor");
    expect(r!.data.offer?.currentPiCents).toBe(306_979n);
    expect(r!.data.offer?.piDeltaCents).toBe(27_485n);
    // Satisfied clocks are not open ones.
    expect(r!.data.openClocks.map((c) => c.code).sort()).toEqual([
      "SM_PARTNER_BOOK_INVITATION_REMINDER_14",
      "SM_REFI_OPPORTUNITY_EXPIRY_30",
    ]);
    // Newest first.
    expect(r!.data.events[0]).toEqual({
      at: "2026-09-21T15:28:40.200Z",
      type: "refi.opportunity.offered",
    });
    // Every call carried the bearer, and the tools were called as a system actor.
    for (const s of seen)
      expect((s.init.headers as Record<string, string>).authorization).toBe("Bearer dev-token");
    const toolCall = seen.find((s) => s.url.endsWith("/tools/33.2/review.facts"));
    expect(JSON.parse(String(toolCall!.init.body))).toEqual({
      actor: { kind: "system", id: "homestead-api" },
      input: {},
    });
  });

  it("agrees with the fixture about loan 1", async () => {
    const live = await supermortgageServicingConnector({
      baseUrl: "http://servicing.test",
      token: "t",
      fetch: stubFetch(),
    }).fetchRecord({ servicerSlug: "northlight", servicerLoanNumber: "NL-100001" });
    const fixture = await fixtureServicingConnector().fetchRecord({
      servicerSlug: "northlight",
      servicerLoanNumber: "NL-100001",
    });
    expect(live!.data.review).toEqual(fixture!.data.review);
    expect(live!.data.offer).toEqual(fixture!.data.offer);
  });

  it("answers null for a number no tape carried", async () => {
    const port = supermortgageServicingConnector({
      baseUrl: "http://servicing.test",
      token: "t",
      fetch: stubFetch(),
    });
    expect(
      await port.fetchRecord({ servicerSlug: "northlight", servicerLoanNumber: "NL-424242" }),
    ).toBeNull();
  });

  it("stands without the tools when his bus refuses them, and throws when his door does", async () => {
    const refused = () =>
      new Response(JSON.stringify({ error: "refused", code: "NOT_ALLOWLISTED" }), { status: 409 });
    const without = supermortgageServicingConnector({
      baseUrl: "http://servicing.test",
      token: "t",
      fetch: stubFetch({
        [`POST /v1/loans/${LOAN}/tools/33.2/review.facts`]: refused,
        [`POST /v1/loans/${LOAN}/tools/33.3/readiness.read`]: refused,
      }),
    });
    const r = await without.fetchRecord({
      servicerSlug: "northlight",
      servicerLoanNumber: "NL-100001",
    });
    expect(r!.data.review?.verdict).toBe("candidate");
    expect(r!.data.review?.reasonsInWords).toEqual([]);
    expect(r!.data.readiness).toBeNull();

    const down = supermortgageServicingConnector({
      baseUrl: "http://servicing.test",
      token: "t",
      fetch: stubFetch({
        "GET /v1/partner-book/imports": () => new Response("nope", { status: 500 }),
      }),
    });
    await expect(
      down.fetchRecord({ servicerSlug: "northlight", servicerLoanNumber: "NL-100001" }),
    ).rejects.toBeInstanceOf(ServicingUnavailableError);
  });

  it("turns his fractions into the percent strings the product uses", () => {
    expect(fractionToPct("0.06375")).toBe("6.375");
    expect(fractionToPct("0.07250")).toBe("7.250");
    expect(fractionToPct("0.0525")).toBe("5.250");
  });
});
