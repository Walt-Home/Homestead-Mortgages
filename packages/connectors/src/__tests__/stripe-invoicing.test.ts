/**
 * The Stripe invoicing adapter against a stub of Stripe's HTTP API: what it
 * sends, under which version and which idempotency key, and what it refuses.
 *
 * The SDK is real and the network is not. `Stripe.createFetchHttpClient`
 * takes the fetch the adapter is handed, so every request the SDK would
 * make is recorded here and answered from a script — a test cannot reach
 * Stripe by accident, and the wire shape is asserted as bytes rather than
 * trusted to a type.
 */

import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import {
  InvoicingNotConfiguredError,
  InvoicingProviderError,
  InvoicingSignatureError,
  STRIPE_INVOICING_API_VERSION,
  STRIPE_MAX_INVOICE_CENTS,
  stripeInvoicingConnector,
} from "../index.js";

const KEY = "rk_test_not_a_real_key";
const SECRET = "whsec_test_not_a_real_secret";
const OUR_INVOICE = "0b8f6f7e-1111-4222-8333-444455556666";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: URLSearchParams;
  readonly headers: Headers;
}

type Answer = { status?: number; json: unknown };

function stub(script: (req: Seen) => Answer) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const req: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
      headers: new Headers(init?.headers as Record<string, string>),
    };
    seen.push(req);
    const answer = script(req);
    return new Response(JSON.stringify(answer.json), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json", "request-id": "req_test" },
    });
  };
  return { seen, fetchImpl };
}

const invoiceJson = (over: Record<string, unknown> = {}) => ({
  id: "in_1",
  object: "invoice",
  customer: "cus_1",
  number: null,
  status: "draft",
  currency: "usd",
  total: 0,
  amount_due: 0,
  amount_paid: 0,
  amount_remaining: 0,
  due_date: null,
  status_transitions: {
    finalized_at: null,
    paid_at: null,
    voided_at: null,
    marked_uncollectible_at: null,
  },
  hosted_invoice_url: null,
  invoice_pdf: null,
  livemode: false,
  metadata: {},
  ...over,
});

const emptyList = { object: "list", data: [], has_more: false, url: "/v1/invoices" };

const draft = {
  invoiceId: OUR_INVOICE,
  customerId: "cus_1",
  netDays: 30,
  memo: "September 2026",
  purchaseOrder: "PO-77",
  paymentMethods: ["customer_balance", "us_bank_account"] as const,
  lines: [
    { description: "Self-improving mortgage", amountCents: 60_912_581n, metadata: { code: "A.x" } },
  ],
  metadata: { hm_statement_id: "st-1", hm_month: "2026-09" },
};

describe("the key it is built with", () => {
  it("refuses a live key unless the deployment says live is meant", () => {
    expect(() => stripeInvoicingConnector({ apiKey: "sk_live_x" })).toThrow(/allowLiveMode/);
    expect(() => stripeInvoicingConnector({ apiKey: "rk_live_x" })).toThrow(/allowLiveMode/);
    const live = stripeInvoicingConnector({ apiKey: "rk_live_x", allowLiveMode: true });
    expect(live.capabilities).toMatchObject({
      provider: "stripe-invoicing (LIVE)",
      mode: "production",
    });
  });

  it("refuses a key that is not Stripe's, and no key at all", () => {
    expect(() => stripeInvoicingConnector({ apiKey: "" })).toThrow(/required/);
    expect(() => stripeInvoicingConnector({ apiKey: "whatever" })).toThrow(/neither/);
  });

  it("is a sandbox on a test key, and carries Stripe's payment ceiling", () => {
    const c = stripeInvoicingConnector({ apiKey: KEY });
    expect(c.capabilities).toMatchObject({
      provider: "stripe-invoicing (sandbox)",
      mode: "sandbox",
    });
    expect(c.maxInvoiceCents).toBe(STRIPE_MAX_INVOICE_CENTS);
    expect(c.maxInvoiceCents).toBe(99_999_999n);
    expect(c.verifiesEvents).toBe(false);
    expect(stripeInvoicingConnector({ apiKey: KEY, webhookSecret: SECRET }).verifiesEvents).toBe(
      true,
    );
  });
});

describe("drafting an invoice", () => {
  it("looks for ours first, then creates it and its lines, each under a pinned version and our key", async () => {
    const { seen, fetchImpl } = stub((req) => {
      if (req.method === "GET") return { json: emptyList };
      if (req.path === "/v1/invoices") return { json: invoiceJson() };
      return {
        json: invoiceJson({
          total: 60_912_581,
          amount_due: 60_912_581,
          amount_remaining: 60_912_581,
        }),
      };
    });
    const c = stripeInvoicingConnector({ apiKey: KEY, fetchImpl });
    const made = await c.draftInvoice(draft);

    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/invoices",
      "POST /v1/invoices",
      "POST /v1/invoices/in_1/add_lines",
    ]);
    const [list, create, lines] = seen as [Seen, Seen, Seen];
    expect(list.query.get("customer")).toBe("cus_1");
    for (const r of seen) {
      expect(r.headers.get("stripe-version")).toBe(STRIPE_INVOICING_API_VERSION);
      expect(r.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    }

    expect(create.headers.get("idempotency-key")).toBe(`hm-invoice-${OUR_INVOICE}-create`);
    expect(create.body.get("customer")).toBe("cus_1");
    expect(create.body.get("collection_method")).toBe("send_invoice");
    expect(create.body.get("days_until_due")).toBe("30");
    // Nothing automatic: no reminders, no self-finalizing, until a late policy says so.
    expect(create.body.get("auto_advance")).toBe("false");
    expect(create.body.get("pending_invoice_items_behavior")).toBe("exclude");
    expect(create.body.get("currency")).toBe("usd");
    expect(create.body.get("description")).toBe("September 2026");
    expect(create.body.get("custom_fields[0][name]")).toBe("PO number");
    expect(create.body.get("custom_fields[0][value]")).toBe("PO-77");
    expect(create.body.get("metadata[hm_invoice_id]")).toBe(OUR_INVOICE);
    expect(create.body.get("metadata[hm_statement_id]")).toBe("st-1");
    expect(create.body.get("payment_settings[payment_method_types][0]")).toBe("customer_balance");
    expect(create.body.get("payment_settings[payment_method_types][1]")).toBe("us_bank_account");
    expect(
      create.body.get("payment_settings[payment_method_options][customer_balance][funding_type]"),
    ).toBe("bank_transfer");
    expect(
      create.body.get(
        "payment_settings[payment_method_options][customer_balance][bank_transfer][type]",
      ),
    ).toBe("us_bank_transfer");

    expect(lines.headers.get("idempotency-key")).toBe(`hm-invoice-${OUR_INVOICE}-lines`);
    expect(lines.body.get("lines[0][amount]")).toBe("60912581");
    expect(lines.body.get("lines[0][description]")).toBe("Self-improving mortgage");
    expect(lines.body.get("lines[0][metadata][code]")).toBe("A.x");

    expect(made).toMatchObject({ id: "in_1", status: "draft", totalCents: 60_912_581n });
    expect(made.hostedUrl).toBeNull();
  });

  it("finds the draft an earlier attempt made instead of making a second", async () => {
    const ours = invoiceJson({
      total: 60_912_581,
      amount_due: 60_912_581,
      amount_remaining: 60_912_581,
      metadata: { hm_invoice_id: OUR_INVOICE },
    });
    const { seen, fetchImpl } = stub(() => ({
      json: { ...emptyList, data: [invoiceJson({ id: "in_other" }), ours] },
    }));
    const c = stripeInvoicingConnector({ apiKey: KEY, fetchImpl });
    const found = await c.draftInvoice(draft);
    expect(found.id).toBe("in_1");
    expect(seen.map((r) => r.method)).toEqual(["GET"]);
  });

  it("adds the lines to a draft that was made and then lost its second call", async () => {
    const { seen, fetchImpl } = stub((req) =>
      req.method === "GET"
        ? {
            json: {
              ...emptyList,
              data: [invoiceJson({ metadata: { hm_invoice_id: OUR_INVOICE } })],
            },
          }
        : {
            json: invoiceJson({
              total: 60_912_581,
              amount_due: 60_912_581,
              amount_remaining: 60_912_581,
            }),
          },
    );
    const c = stripeInvoicingConnector({ apiKey: KEY, fetchImpl });
    await c.draftInvoice(draft);
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /v1/invoices",
      "POST /v1/invoices/in_1/add_lines",
    ]);
  });

  it("refuses a draft whose total is not the statement's", async () => {
    const { fetchImpl } = stub((req) =>
      req.method === "GET"
        ? {
            json: {
              ...emptyList,
              data: [invoiceJson({ total: 5, metadata: { hm_invoice_id: OUR_INVOICE } })],
            },
          }
        : { json: invoiceJson() },
    );
    const c = stripeInvoicingConnector({ apiKey: KEY, fetchImpl });
    await expect(c.draftInvoice(draft)).rejects.toMatchObject({
      name: "InvoicingProviderError",
      providerCode: "draft_total_mismatch",
    });
  });

  it("leaves card off and the bank-transfer option out when only a debit is offered", async () => {
    const { seen, fetchImpl } = stub((req) =>
      req.method === "GET" ? { json: emptyList } : { json: invoiceJson({ total: 60_912_581 }) },
    );
    const c = stripeInvoicingConnector({ apiKey: KEY, fetchImpl });
    await c.draftInvoice({ ...draft, paymentMethods: ["us_bank_account"], purchaseOrder: null });
    const create = seen[1]!;
    expect(create.body.get("payment_settings[payment_method_types][0]")).toBe("us_bank_account");
    expect([...create.body.keys()].some((k) => k.includes("customer_balance"))).toBe(false);
    expect([...create.body.keys()].some((k) => k.startsWith("custom_fields"))).toBe(false);
  });
});

describe("the acts on an invoice", () => {
  it("sends, voids and marks paid outside Stripe, each once under its own key", async () => {
    const { seen, fetchImpl } = stub((req) => ({
      json: invoiceJson({
        status: req.path.endsWith("/void") ? "void" : req.path.endsWith("/pay") ? "paid" : "open",
        number: "ABCD-0001",
        total: 100,
        amount_due: 100,
        amount_remaining: req.path.endsWith("/pay") ? 0 : 100,
        amount_paid: req.path.endsWith("/pay") ? 100 : 0,
        due_date: 1_790_000_000,
        status_transitions: {
          finalized_at: 1_789_000_000,
          paid_at: req.path.endsWith("/pay") ? 1_789_500_000 : null,
          voided_at: req.path.endsWith("/void") ? 1_789_400_000 : null,
          marked_uncollectible_at: null,
        },
        hosted_invoice_url: "https://invoice.stripe.com/i/x",
        invoice_pdf: "https://pay.stripe.com/invoice/x/pdf",
      }),
    }));
    const c = stripeInvoicingConnector({ apiKey: KEY, fetchImpl });

    const sent = await c.sendInvoice("in_1", OUR_INVOICE);
    expect(sent).toMatchObject({
      status: "open",
      number: "ABCD-0001",
      hostedUrl: "https://invoice.stripe.com/i/x",
      dueAt: new Date(1_790_000_000 * 1000).toISOString(),
    });
    const voided = await c.voidInvoice("in_1", OUR_INVOICE);
    expect(voided.status).toBe("void");
    expect(voided.voidedAt).not.toBeNull();
    const paid = await c.markPaidOutOfBand("in_1", OUR_INVOICE);
    expect(paid).toMatchObject({ status: "paid", amountPaidCents: 100n, amountRemainingCents: 0n });

    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/invoices/in_1/send",
      "POST /v1/invoices/in_1/void",
      "POST /v1/invoices/in_1/pay",
    ]);
    expect(seen.map((r) => r.headers.get("idempotency-key"))).toEqual([
      `hm-invoice-${OUR_INVOICE}-send`,
      `hm-invoice-${OUR_INVOICE}-void`,
      `hm-invoice-${OUR_INVOICE}-paid`,
    ]);
    expect(seen[2]!.body.get("paid_out_of_band")).toBe("true");
  });

  it("answers null for an invoice Stripe does not hold, and Stripe's own sentence for a refusal", async () => {
    const missing = stub(() => ({
      status: 404,
      json: {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: "No such invoice: 'in_nope'",
        },
      },
    }));
    const c = stripeInvoicingConnector({ apiKey: KEY, fetchImpl: missing.fetchImpl });
    expect(await c.retrieveInvoice("in_nope")).toBeNull();

    const refused = stub(() => ({
      status: 400,
      json: {
        error: {
          type: "invalid_request_error",
          code: "invoice_not_editable",
          message: "This invoice can no longer be voided.",
        },
      },
    }));
    const d = stripeInvoicingConnector({ apiKey: KEY, fetchImpl: refused.fetchImpl });
    const err = await d.voidInvoice("in_1", OUR_INVOICE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoicingProviderError);
    expect(err).toMatchObject({
      providerCode: "invoice_not_editable",
      statusCode: 400,
      message: "Stripe: This invoice can no longer be voided.",
    });
    expect(String((err as Error).message)).not.toContain(KEY);
  });

  it("refuses an invoice status it has never heard of rather than guess", async () => {
    const { fetchImpl } = stub(() => ({ json: invoiceJson({ status: "past_due" }) }));
    const c = stripeInvoicingConnector({ apiKey: KEY, fetchImpl });
    await expect(c.retrieveInvoice("in_1")).rejects.toMatchObject({
      providerCode: "unknown_status",
    });
  });
});

describe("a customer", () => {
  it("is created once per servicer, with the EIN, and named by our ids", async () => {
    const { seen, fetchImpl } = stub(() => ({ json: { id: "cus_9", object: "customer" } }));
    const c = stripeInvoicingConnector({ apiKey: KEY, fetchImpl });
    const made = await c.upsertCustomer(
      {
        servicerId: "svc-1",
        servicerSlug: "northlight",
        legalName: "Northlight Mortgage Servicing LLC",
        email: "ap@northlight.example",
        address: {
          line1: "1 Main St",
          line2: null,
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
        },
        ein: "12-3456789",
      },
      null,
    );
    expect(made.customerId).toBe("cus_9");
    const create = seen[0]!;
    expect(`${create.method} ${create.path}`).toBe("POST /v1/customers");
    expect(create.headers.get("idempotency-key")).toBe("hm-customer-svc-1-create");
    expect(create.body.get("name")).toBe("Northlight Mortgage Servicing LLC");
    expect(create.body.get("email")).toBe("ap@northlight.example");
    expect(create.body.get("address[postal_code]")).toBe("78701");
    expect(create.body.get("tax_id_data[0][type]")).toBe("us_ein");
    expect(create.body.get("tax_id_data[0][value]")).toBe("12-3456789");
    expect(create.body.get("metadata[hm_servicer_slug]")).toBe("northlight");
  });

  it("is updated in place, and its EIN replaced only when it changed", async () => {
    const { seen, fetchImpl } = stub((req) => {
      if (req.method === "GET") {
        return {
          json: {
            object: "list",
            has_more: false,
            url: "/v1/customers/cus_9/tax_ids",
            data: [{ id: "txi_1", object: "tax_id", type: "us_ein", value: "11-1111111" }],
          },
        };
      }
      return { json: { id: req.path.includes("tax_ids") ? "txi_2" : "cus_9", object: "x" } };
    });
    const c = stripeInvoicingConnector({ apiKey: KEY, fetchImpl });
    const input = {
      servicerId: "svc-1",
      servicerSlug: "northlight",
      legalName: "Northlight Mortgage Servicing LLC",
      email: "ap@northlight.example",
      address: null,
      ein: "12-3456789",
    };
    await c.upsertCustomer(input, "cus_9");
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v1/customers/cus_9",
      "GET /v1/customers/cus_9/tax_ids",
      "DELETE /v1/customers/cus_9/tax_ids/txi_1",
      "POST /v1/customers/cus_9/tax_ids",
    ]);
  });
});

describe("a delivered event", () => {
  const payload = JSON.stringify({
    id: "evt_1",
    object: "event",
    api_version: STRIPE_INVOICING_API_VERSION,
    created: 1_790_000_000,
    livemode: false,
    type: "invoice.paid",
    data: { object: { id: "in_1", object: "invoice" } },
  });
  const header = (body: string, secret = SECRET) =>
    Stripe.webhooks.generateTestHeaderString({ payload: body, secret });

  it("is read only when its signature verifies over the raw bytes", () => {
    const c = stripeInvoicingConnector({ apiKey: KEY, webhookSecret: SECRET });
    const event = c.readEvent(Buffer.from(payload), header(payload));
    expect(event).toEqual({
      id: "evt_1",
      type: "invoice.paid",
      createdAt: new Date(1_790_000_000 * 1000).toISOString(),
      livemode: false,
      apiVersion: STRIPE_INVOICING_API_VERSION,
      invoiceId: "in_1",
    });
  });

  it("is refused when the body was changed, signed by another secret, or not signed", () => {
    const c = stripeInvoicingConnector({ apiKey: KEY, webhookSecret: SECRET });
    const good = header(payload);
    expect(() => c.readEvent(payload.replace("in_1", "in_2"), good)).toThrow(
      InvoicingSignatureError,
    );
    expect(() => c.readEvent(payload, header(payload, "whsec_other"))).toThrow(
      InvoicingSignatureError,
    );
    expect(() => c.readEvent(payload, undefined)).toThrow(InvoicingSignatureError);
  });

  it("is refused outright when no secret is held", () => {
    const c = stripeInvoicingConnector({ apiKey: KEY });
    expect(() => c.readEvent(payload, header(payload))).toThrow(InvoicingNotConfiguredError);
  });

  it("names no invoice when it is about something else", () => {
    const other = JSON.stringify({
      id: "evt_2",
      object: "event",
      api_version: null,
      created: 1_790_000_000,
      livemode: false,
      type: "customer.updated",
      data: { object: { id: "cus_1", object: "customer" } },
    });
    const c = stripeInvoicingConnector({ apiKey: KEY, webhookSecret: SECRET });
    expect(c.readEvent(other, header(other)).invoiceId).toBeNull();
  });
});
