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
import { stripeIdentityConnector } from "../adapters/stripe-identity.js";
import type { LoanFile } from "@hm/shared";

const file = { id: "f" } as unknown as LoanFile;
const RETURN_URL = "https://example.test/f/1/identity";

function stub(body: unknown, ok = true) {
  return vi.fn(async () =>
    ok
      ? new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response("", { status: 402 }),
  ) as unknown as typeof fetch;
}

describe("live-mode refusal", () => {
  it("refuses a live secret key", () => {
    expect(() =>
      stripeIdentityConnector({ secretKey: "sk_live_abc", returnUrl: RETURN_URL }),
    ).toThrow(/Refusing a live Stripe key/);
  });

  it("names biometric collection as the reason, not the cost", () => {
    // The next person to hit this needs to know why it is not about a few
    // dollars per verification.
    expect(() =>
      stripeIdentityConnector({ secretKey: "sk_live_abc", returnUrl: RETURN_URL }),
    ).toThrow(/biometric|BIPA/i);
  });

  it("allows live only on a deliberate opt-in", () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_live_abc",
      returnUrl: RETURN_URL,
      allowLiveMode: true,
    });
    expect(c.capabilities.provider).toContain("LIVE");
    expect(c.capabilities.mode).toBe("production");
  });

  it("accepts a test key without ceremony, and says it is test", () => {
    const c = stripeIdentityConnector({ secretKey: "sk_test_abc", returnUrl: RETURN_URL });
    expect(c.capabilities.mode).toBe("sandbox");
    expect(c.capabilities.satisfies).toContain("APP-001");
  });
});

describe("sessions", () => {
  it("asks for a matching selfie and a live capture", async () => {
    const fetchImpl = stub({ id: "vs_1", url: "https://verify.stripe.test/vs_1" });
    const c = stripeIdentityConnector({ secretKey: "sk_test_x", returnUrl: RETURN_URL, fetchImpl });
    const s = await c.createVerificationSession(file, "b1");

    expect(s).toEqual({ verificationId: "vs_1", verificationUrl: "https://verify.stripe.test/vs_1" });
    const body = String((fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1]!.body);
    // Without the selfie this verifies a document, not the person holding it.
    expect(body).toContain("require_matching_selfie");
    expect(body).toContain("metadata%5Bborrower_id%5D=b1");
  });

  it("throws rather than returning a session Stripe did not create", async () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x", returnUrl: RETURN_URL, fetchImpl: stub({}, false),
    });
    await expect(c.createVerificationSession(file, "b1")).rejects.toThrow(/did not return/);
  });
});

describe("reading a result", () => {
  const verified = {
    id: "vs_1",
    status: "verified",
    verified_outputs: {
      first_name: "Dana",
      last_name: "Whitfield",
      dob: { day: 12, month: 4, year: 1988 },
      address: { line1: "9 Rent Rd", city: "Austin", state: "TX", postal_code: "78704" },
    },
  };

  it("maps a verified session, including the document address", async () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x", returnUrl: RETURN_URL, fetchImpl: stub(verified),
    });
    const r = await c.getVerification("vs_1");
    expect(r?.status).toBe("verified");
    expect(r?.documentName).toBe("Dana Whitfield");
    expect(r?.documentDateOfBirth).toBe("1988-04-12");
    expect(r?.documentAddress).toEqual({
      line1: "9 Rent Rd", line2: undefined, city: "Austin", state: "TX", postalCode: "78704",
    });
  });

  it("expands verified_outputs, or a verified session tells us nothing", async () => {
    const fetchImpl = stub(verified);
    const c = stripeIdentityConnector({ secretKey: "sk_test_x", returnUrl: RETURN_URL, fetchImpl });
    await c.getVerification("vs_1");
    const url = String((fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]);
    expect(url).toContain("expand[]=verified_outputs");
  });

  it("drops a partial document address rather than half-filling the form", async () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      returnUrl: RETURN_URL,
      fetchImpl: stub({ ...verified, verified_outputs: { ...verified.verified_outputs, address: { city: "Austin" } } }),
    });
    expect((await c.getVerification("vs_1"))?.documentAddress).toBeUndefined();
  });

  it("treats processing as pending, not as failure", async () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x", returnUrl: RETURN_URL, fetchImpl: stub({ id: "vs_1", status: "processing" }),
    });
    const r = await c.getVerification("vs_1");
    expect(r?.status).toBe("pending");
    expect(r?.verifiedAt).toBeUndefined();
  });

  it("surfaces why a verification failed", async () => {
    const c = stripeIdentityConnector({
      secretKey: "sk_test_x",
      returnUrl: RETURN_URL,
      fetchImpl: stub({ id: "vs_1", status: "canceled", last_error: { reason: "The document was expired." } }),
    });
    const r = await c.getVerification("vs_1");
    expect(r?.status).toBe("failed");
    expect(r?.failureReason).toBe("The document was expired.");
  });
});
