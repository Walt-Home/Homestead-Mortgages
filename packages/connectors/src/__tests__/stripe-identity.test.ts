/**
 * The Stripe Identity adapter, without touching Stripe.
 *
 * The first test is the one that matters most and has nothing to do with
 * Stripe's API: a live key must be refused. Live mode collects real government
 * IDs and face scans from everyone who walks the flow, and face geometry is
 * biometric data with statutory duties attached. That refusal is a safety
 * property, so it is pinned rather than trusted to a comment.
 */

import { describe, expect, it, vi } from "vitest";
import { statusFor, stripeIdentityConnector, toIsoDate } from "../adapters/stripe-identity.js";
import type { LoanFile } from "@hm/shared";

const file = { id: "file-123" } as unknown as LoanFile;
const ORIGIN = "https://example.test";

function stub(body: unknown, ok = true) {
  return vi.fn(async () =>
    ok
      ? new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      : new Response("", { status: 402 }),
  ) as unknown as typeof fetch;
}

describe("live-mode refusal", () => {
  it("refuses a live secret key", () => {
    expect(() => stripeIdentityConnector({ secretKey: "sk_live_abc", origin: ORIGIN })).toThrow(
      /Refusing a live Stripe key/,
    );
  });

  it("names biometric collection as the reason, not the cost", () => {
    // The next person to hit this needs to know why it is not about a few
    // dollars per verification.
    expect(() => stripeIdentityConnector({ secretKey: "sk_live_abc", origin: ORIGIN })).toThrow(
      /biometric|BIPA/i,
    );
  });

  it("allows live only on a deliberate opt-in", () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_live_abc",
      origin: ORIGIN,
      allowLiveMode: true,
    });
    expect(c.capabilities.provider).toContain("LIVE");
    expect(c.capabilities.mode).toBe("production");
  });

  it("accepts a test key without ceremony, and says it is test", () => {
    const c = stripeIdentityConnector({ secretKey: "sk_test_abc", origin: ORIGIN });
    expect(c.capabilities.mode).toBe("sandbox");
    expect(c.capabilities.satisfies).toContain("APP-001");
  });
});

describe("sessions", () => {
  it("asks for a matching selfie and a live capture", async () => {
    const fetchImpl = stub({ id: "vs_1", url: "https://verify.stripe.test/vs_1" });
    const c = stripeIdentityConnector({ secretKey: "sk_test_x", origin: ORIGIN, fetchImpl });
    const s = await c.createVerificationSession(file, "b1");

    expect(s).toEqual({
      verificationId: "vs_1",
      verificationUrl: "https://verify.stripe.test/vs_1",
    });
    const body = String(
      (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1]!
        .body,
    );
    // Without the selfie this verifies a document, not the person holding it.
    expect(body).toContain("require_matching_selfie");
    // The borrower comes back to a fresh page load, so the return URL has to
    // say which application they were filling in.
    expect(decodeURIComponent(body)).toContain("/f/file-123/identity/return");
    expect(body).toContain("metadata%5Bborrower_id%5D=b1");
  });

  it("throws rather than returning a session Stripe did not create", async () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      origin: ORIGIN,
      fetchImpl: stub({}, false),
    });
    await expect(c.createVerificationSession(file, "b1")).rejects.toThrow(/did not return/);
  });
});

describe("reading a result", () => {
  // What a secret key's read of a verified session carries, as the sandbox
  // answered it on 14 October 2026: the name, the address, the email, the
  // phone, and no `dob` key at all.
  const verified = {
    id: "vs_1",
    status: "verified",
    verified_outputs: {
      first_name: "Dana",
      last_name: "Whitfield",
      address: { line1: "9 Rent Rd", city: "Austin", state: "TX", postal_code: "78704" },
      email: null,
      phone: null,
      id_number_type: null,
    },
  };

  it("maps a verified session, including the document address", async () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      origin: ORIGIN,
      fetchImpl: stub(verified),
    });
    const r = await c.getVerification("vs_1");
    expect(r?.status).toBe("verified");
    expect(r?.documentName).toBe("Dana Whitfield");
    // A secret key never receives it; without a restricted key, screen 2 asks.
    expect(r?.documentDateOfBirth).toBeUndefined();
    expect(r?.documentAddress).toEqual({
      line1: "9 Rent Rd",
      line2: undefined,
      city: "Austin",
      state: "TX",
      postalCode: "78704",
    });
  });

  it("expands verified_outputs, or a verified session tells us nothing", async () => {
    const fetchImpl = stub(verified);
    const c = stripeIdentityConnector({ secretKey: "sk_test_x", origin: ORIGIN, fetchImpl });
    await c.getVerification("vs_1");
    const url = String((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]);
    expect(url).toContain("expand[]=verified_outputs");
  });

  it("drops a partial document address rather than half-filling the form", async () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      origin: ORIGIN,
      fetchImpl: stub({
        ...verified,
        verified_outputs: { ...verified.verified_outputs, address: { city: "Austin" } },
      }),
    });
    expect((await c.getVerification("vs_1"))?.documentAddress).toBeUndefined();
  });

  it("treats processing as pending, not as failure", async () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      origin: ORIGIN,
      fetchImpl: stub({ id: "vs_1", status: "processing" }),
    });
    const r = await c.getVerification("vs_1");
    expect(r?.status).toBe("pending");
    expect(r?.verifiedAt).toBeUndefined();
  });

  it("surfaces why a verification failed", async () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      origin: ORIGIN,
      fetchImpl: stub({
        id: "vs_1",
        status: "canceled",
        last_error: { reason: "The document was expired." },
      }),
    });
    const r = await c.getVerification("vs_1");
    expect(r?.status).toBe("failed");
    expect(r?.failureReason).toBe("The document was expired.");
  });
});

/* ── Status, and the one Stripe overloads ───────────────────────────────── */

/** Responses in order, one per call, and every call kept for inspection. */
function sequence(...responses: { status: number; body: unknown }[]) {
  const calls: { url: string; auth: string }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: String((init?.headers as Record<string, string>)?.Authorization ?? ""),
    });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("the date of birth", () => {
  const secretRead = {
    id: "vs_1",
    status: "verified",
    verified_outputs: {
      first_name: "Dana",
      last_name: "Whitfield",
      address: { line1: "9 Rent Rd", city: "Austin", state: "TX", postal_code: "78704" },
    },
  };
  const restrictedRead = {
    id: "vs_1",
    status: "verified",
    verified_outputs: { ...secretRead.verified_outputs, dob: { day: 12, month: 4, year: 1988 } },
  };
  // What Stripe answers a secret key that asks for it, seen 14 October 2026.
  const refusal = {
    error: {
      type: "invalid_request_error",
      message:
        "To access sensitive verification results, configure a restricted API key with appropriate permissions.",
    },
  };

  it("is read with the restricted key, in a second read the secret key cannot make", async () => {
    const { fetchImpl, calls } = sequence(
      { status: 200, body: secretRead },
      { status: 200, body: restrictedRead },
    );
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      resultsKey: "rk_test_r",
      origin: ORIGIN,
      fetchImpl,
    });
    const r = await c.getVerification("vs_1");
    expect(r?.documentDateOfBirth).toBe("1988-04-12");
    expect(r?.documentName).toBe("Dana Whitfield");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.auth).toBe("Bearer sk_test_x");
    expect(calls[0]!.url).toContain("expand[]=verified_outputs");
    expect(calls[0]!.url).not.toContain("verified_outputs.dob");
    expect(calls[1]!.auth).toBe("Bearer rk_test_r");
    expect(calls[1]!.url).toContain("expand[]=verified_outputs.dob");
  });

  it("is not asked for without a restricted key: one read, and screen 2 asks", async () => {
    const { fetchImpl, calls } = sequence({ status: 200, body: secretRead });
    const c = stripeIdentityConnector({ secretKey: "sk_test_x", origin: ORIGIN, fetchImpl });
    const r = await c.getVerification("vs_1");
    expect(r?.documentDateOfBirth).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("leaves the verification standing when the restricted read is refused", async () => {
    // No permission, past the 48-hour window, a rolled key: the person still
    // verified, and the date is asked rather than the result thrown away.
    const { fetchImpl } = sequence(
      { status: 200, body: secretRead },
      { status: 400, body: refusal },
    );
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      resultsKey: "rk_test_r",
      origin: ORIGIN,
      fetchImpl,
    });
    const r = await c.getVerification("vs_1");
    expect(r?.status).toBe("verified");
    expect(r?.documentName).toBe("Dana Whitfield");
    expect(r?.documentDateOfBirth).toBeUndefined();
  });

  it("is not read for a session that has not verified", async () => {
    const { fetchImpl, calls } = sequence({
      status: 200,
      body: { id: "vs_1", status: "processing" },
    });
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      resultsKey: "rk_test_r",
      origin: ORIGIN,
      fetchImpl,
    });
    await c.getVerification("vs_1");
    expect(calls).toHaveLength(1);
  });

  it("puts nothing from a redacted session on a form, and does not ask for its date", async () => {
    const { fetchImpl, calls } = sequence({
      status: 200,
      body: {
        ...secretRead,
        redaction: { status: "redacted" },
        verified_outputs: {
          first_name: "[redacted]",
          last_name: "[redacted]",
          dob: { day: 1, month: 1, year: 1 },
        },
      },
    });
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      resultsKey: "rk_test_r",
      origin: ORIGIN,
      fetchImpl,
    });
    const r = await c.getVerification("vs_1");
    expect(r?.status).toBe("verified");
    expect(r?.documentName).toBeUndefined();
    expect(r?.documentDateOfBirth).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("is never a date that cannot be a person's", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    expect(toIsoDate({ day: 12, month: 4, year: 1988 }, now)).toBe("1988-04-12");
    expect(toIsoDate({ day: 1, month: 1, year: 1 }, now)).toBeUndefined();
    expect(toIsoDate({ day: 31, month: 2, year: 1990 }, now)).toBeUndefined();
    expect(toIsoDate({ day: 1, month: 1, year: 2030 }, now)).toBeUndefined();
    expect(toIsoDate({ month: 4, year: 1988 }, now)).toBeUndefined();
  });

  it("refuses a secret key where the restricted key goes", () => {
    expect(() =>
      stripeIdentityConnector({ secretKey: "sk_test_x", resultsKey: "sk_test_y", origin: ORIGIN }),
    ).toThrow(/restricted key/);
  });

  it("refuses keys from two modes", () => {
    expect(() =>
      stripeIdentityConnector({ secretKey: "sk_test_x", resultsKey: "rk_live_y", origin: ORIGIN }),
    ).toThrow(/different modes/);
  });

  it("refuses a live restricted key without the live opt-in, because the live secret key is", () => {
    expect(() =>
      stripeIdentityConnector({ secretKey: "sk_live_x", resultsKey: "rk_live_y", origin: ORIGIN }),
    ).toThrow(/Refusing a live Stripe key/);
  });

  it("says it reads the date of birth when it does, which the boot log prints", () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      resultsKey: "rk_test_r",
      origin: ORIGIN,
    });
    expect(c.capabilities.provider).toBe("stripe-identity (test), reads date of birth");
    expect(
      stripeIdentityConnector({ secretKey: "sk_test_x", origin: ORIGIN }).capabilities.provider,
    ).toBe("stripe-identity (test)");
  });
});

describe("requires_input means two opposite things", () => {
  /**
   * From a real session: a borrower completed the hosted flow, Stripe refused
   * the document, and the session came back `requires_input` with
   * `last_error.code = "document_unverified_other"`. Reading the status alone
   * called that "pending", so the borrower was told their ID "is being
   * reviewed" — indefinitely, with no way forward and nothing being reviewed.
   */
  it("is failed once Stripe has seen the document and rejected it", () => {
    expect(
      statusFor("requires_input", {
        code: "document_unverified_other",
        reason: "The document could not be verified.",
      }),
    ).toBe("failed");
  });

  it("is pending when nobody has started it — which is every new session", () => {
    // The state a session is in the instant it is created. Calling this
    // "failed" would refuse every borrower before they had done anything.
    expect(statusFor("requires_input", null)).toBe("pending");
    expect(statusFor("requires_input", undefined)).toBe("pending");
    expect(statusFor("requires_input", {})).toBe("pending");
  });

  it("leaves the unambiguous statuses alone", () => {
    expect(statusFor("verified", null)).toBe("verified");
    expect(statusFor("processing", null)).toBe("pending");
    expect(statusFor("canceled", null)).toBe("failed");
  });

  it("does not let an error override a verified session", () => {
    // A session can carry a last_error from an earlier attempt and still end
    // up verified. The final status wins.
    expect(statusFor("verified", { code: "document_unverified_other" })).toBe("verified");
  });

  it("treats an unknown status as pending rather than guessing", () => {
    expect(statusFor("some_future_status", null)).toBe("pending");
  });
});
