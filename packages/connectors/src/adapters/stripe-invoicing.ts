/**
 * Invoicing through Stripe: one-off invoices, sent for payment, collected by
 * bank transfer or bank debit.
 *
 * One-off invoices and not Stripe Billing, on purpose. Our meter is the
 * source of truth for what a month cost; Stripe's own documentation says its
 * meters and credits do not model commitments or drawdown, and one-off
 * invoices carry the Invoicing fee alone. So Stripe is asked to do what it
 * is for here: issue the document, host the page, collect the money, and say
 * what happened.
 *
 * What this adapter holds to, each against a failure that costs money:
 *
 *   - **The official SDK, with the API version it was built for pinned.**
 *     A request never drifts onto a newer API because the account's default
 *     moved. `STRIPE_INVOICING_API_VERSION` is the one string.
 *   - **Every write carries an idempotency key derived from OUR invoice
 *     id**, and the SDK retries a network failure with the same key. Keys
 *     are forgotten after a day, so a draft is also FOUND before it is made:
 *     the customer's invoices are listed and matched on the id we stamped.
 *   - **A live key is refused unless the deployment says so explicitly**,
 *     the pattern the identity adapter keeps. A sandbox key moves no money
 *     and mails nobody.
 *   - **A delivery is verified over the raw bytes with the endpoint's own
 *     secret**, inside the SDK's five-minute tolerance, before a byte of it
 *     is read.
 *   - **Nothing automatic until somebody decides it should be.**
 *     `auto_advance` is off, so Stripe sends no reminders and marks nothing
 *     uncollectible by itself; the late policy is a decision still open.
 *
 * The ceiling is Stripe's: a single non-card payment is at most eight
 * digits, $999,999.99. An invoice above it could be issued and never paid
 * by bank, so the service above refuses to issue one.
 */

import Stripe from "stripe";
import type {
  ConnectorCapabilities,
  InvoiceDraftInput,
  InvoicePaymentMethod,
  InvoicingConnector,
  InvoicingCustomerInput,
  InvoicingEvent,
  ProviderInvoice,
  ProviderInvoiceStatus,
} from "../ports/index.js";
import {
  InvoicingNotConfiguredError,
  InvoicingProviderError,
  InvoicingSignatureError,
  invoicingKey,
} from "./invoicing-errors.js";

/** The API version every request is sent under: the one the installed SDK was generated for. */
export const STRIPE_INVOICING_API_VERSION = "2026-08-26.dahlia";

/** Stripe's ceiling on a single non-card payment in USD: eight digits. */
export const STRIPE_MAX_INVOICE_CENTS = 99_999_999n;

/** The metadata key that names our invoice on Stripe's. */
const OUR_ID = "hm_invoice_id";

export interface StripeInvoicingOptions {
  /** A restricted key (`rk_…`) scoped to customers and invoices, or a secret key. */
  readonly apiKey: string;
  /** The webhook endpoint's signing secret (`whsec_…`); without it no delivery can be verified. */
  readonly webhookSecret?: string;
  /**
   * Permit an `sk_live_` or `rk_live_` key. A caller setting this is
   * asserting that real invoices to real customers are intended.
   */
  readonly allowLiveMode?: boolean;
  /**
   * Let Stripe advance an invoice by itself: reminders, and marking it
   * uncollectible on its own schedule. Off unless the late policy says so.
   */
  readonly autoAdvance?: boolean;
  readonly fetchImpl?: typeof fetch;
}

const iso = (seconds: number | null | undefined): string | null =>
  seconds === null || seconds === undefined ? null : new Date(seconds * 1000).toISOString();

const STATUSES: readonly ProviderInvoiceStatus[] = [
  "draft",
  "open",
  "paid",
  "void",
  "uncollectible",
];

function mapInvoice(i: Stripe.Invoice): ProviderInvoice {
  const status = STATUSES.find((s) => s === i.status);
  if (!status) {
    // A status this code has never heard of is not one to guess at.
    throw new InvoicingProviderError(
      `Stripe answered an invoice status this system does not know: ${String(i.status)}`,
      "unknown_status",
    );
  }
  const customerId = typeof i.customer === "string" ? i.customer : (i.customer?.id ?? "");
  return {
    id: i.id,
    customerId,
    number: i.number,
    status,
    currency: i.currency,
    totalCents: BigInt(i.total),
    amountDueCents: BigInt(i.amount_due),
    amountPaidCents: BigInt(i.amount_paid),
    amountRemainingCents: BigInt(i.amount_remaining),
    dueAt: iso(i.due_date),
    finalizedAt: iso(i.status_transitions.finalized_at),
    paidAt: iso(i.status_transitions.paid_at),
    voidedAt: iso(i.status_transitions.voided_at),
    markedUncollectibleAt: iso(i.status_transitions.marked_uncollectible_at),
    hostedUrl: i.hosted_invoice_url ?? null,
    pdfUrl: i.invoice_pdf ?? null,
    livemode: i.livemode,
    metadata: i.metadata ?? {},
  };
}

/** Stripe's refusal, as ours: its sentence, its code, its status, and never the key. */
function refusal(err: unknown): InvoicingProviderError {
  if (err instanceof InvoicingProviderError) return err;
  if (err instanceof Stripe.errors.StripeError) {
    return new InvoicingProviderError(
      `Stripe: ${err.message}`,
      err.code ?? err.type ?? null,
      err.statusCode ?? null,
    );
  }
  return new InvoicingProviderError(
    `Stripe could not be reached: ${err instanceof Error ? err.message : String(err)}`,
  );
}

const isMissing = (err: unknown): boolean =>
  err instanceof Stripe.errors.StripeError &&
  (err.code === "resource_missing" || err.statusCode === 404);

function paymentSettings(
  methods: readonly InvoicePaymentMethod[],
): Stripe.InvoiceCreateParams.PaymentSettings {
  return {
    payment_method_types: [...methods],
    ...(methods.includes("customer_balance")
      ? {
          payment_method_options: {
            customer_balance: {
              funding_type: "bank_transfer",
              bank_transfer: { type: "us_bank_transfer" },
            },
          },
        }
      : {}),
  };
}

export function stripeInvoicingConnector(options: StripeInvoicingOptions): InvoicingConnector {
  if (!options.apiKey) throw new Error("stripeInvoicingConnector: an API key is required");
  const live = /^(sk|rk)_live_/.test(options.apiKey);
  if (live && !options.allowLiveMode) {
    throw new Error(
      "stripeInvoicingConnector: a live key was given without allowLiveMode. A live key issues " +
        "real invoices to real customers; set STRIPE_ALLOW_LIVE_BILLING=true only where that is meant.",
    );
  }
  if (!live && !/^(sk|rk)_test_/.test(options.apiKey)) {
    throw new Error("stripeInvoicingConnector: the key is neither a test key nor a live key.");
  }

  const stripe = new Stripe(options.apiKey, {
    apiVersion: STRIPE_INVOICING_API_VERSION,
    // A network failure is retried by the SDK with the same idempotency key.
    maxNetworkRetries: 2,
    timeout: 20_000,
    telemetry: false,
    appInfo: { name: "supermortgage-billing", version: "1.0.0" },
    ...(options.fetchImpl ? { httpClient: Stripe.createFetchHttpClient(options.fetchImpl) } : {}),
  });

  const capabilities: ConnectorCapabilities = {
    provider: live ? "stripe-invoicing (LIVE)" : "stripe-invoicing (sandbox)",
    mode: live ? "production" : "sandbox",
    satisfies: [],
  };

  /** Our invoice, on this customer, when an earlier attempt already made it. */
  async function findOurs(customerId: string, invoiceId: string): Promise<Stripe.Invoice | null> {
    for await (const invoice of stripe.invoices.list({ customer: customerId, limit: 100 })) {
      if (invoice.metadata?.[OUR_ID] === invoiceId) return invoice;
    }
    return null;
  }

  /** Bring the customer's US EIN in line with the profile: at most one, and the right one. */
  async function syncEin(customerId: string, ein: string | null): Promise<void> {
    const held = await stripe.customers.listTaxIds(customerId, { limit: 100 });
    const eins = held.data.filter((t) => t.type === "us_ein");
    if (ein !== null && eins.length === 1 && eins[0]!.value === ein) return;
    for (const t of eins) await stripe.customers.deleteTaxId(customerId, t.id);
    if (ein !== null)
      await stripe.customers.createTaxId(customerId, { type: "us_ein", value: ein });
  }

  return {
    capabilities,
    maxInvoiceCents: STRIPE_MAX_INVOICE_CENTS,
    verifiesEvents: Boolean(options.webhookSecret),

    async upsertCustomer(input: InvoicingCustomerInput, existingCustomerId) {
      const fields = {
        name: input.legalName,
        email: input.email,
        ...(input.address
          ? {
              address: {
                line1: input.address.line1,
                line2: input.address.line2 ?? "",
                city: input.address.city,
                state: input.address.state,
                postal_code: input.address.postalCode,
                country: input.address.country,
              },
            }
          : {}),
        metadata: { hm_servicer_id: input.servicerId, hm_servicer_slug: input.servicerSlug },
      };
      try {
        if (existingCustomerId) {
          await stripe.customers.update(existingCustomerId, fields);
          await syncEin(existingCustomerId, input.ein);
          return { customerId: existingCustomerId };
        }
        const created = await stripe.customers.create(
          {
            ...fields,
            ...(input.ein ? { tax_id_data: [{ type: "us_ein" as const, value: input.ein }] } : {}),
          },
          // One customer per servicer, however many times the first attempt is retried.
          { idempotencyKey: `hm-customer-${input.servicerId}-create` },
        );
        return { customerId: created.id };
      } catch (err) {
        throw refusal(err);
      }
    },

    async draftInvoice(input: InvoiceDraftInput) {
      const expected = input.lines.reduce((n, l) => n + l.amountCents, 0n);
      try {
        let invoice =
          (await findOurs(input.customerId, input.invoiceId)) ??
          (await stripe.invoices.create(
            {
              customer: input.customerId,
              collection_method: "send_invoice",
              days_until_due: input.netDays,
              auto_advance: options.autoAdvance ?? false,
              // Only the lines named below: nothing pending on the customer is swept in.
              pending_invoice_items_behavior: "exclude",
              currency: "usd",
              description: input.memo,
              ...(input.purchaseOrder
                ? { custom_fields: [{ name: "PO number", value: input.purchaseOrder }] }
                : {}),
              metadata: { ...input.metadata, [OUR_ID]: input.invoiceId },
              payment_settings: paymentSettings(input.paymentMethods),
            },
            { idempotencyKey: invoicingKey(input.invoiceId, "create") },
          ));
        // An invoice an earlier attempt already sent is what it is; hand it back.
        if (invoice.status !== "draft") return mapInvoice(invoice);
        if (invoice.total === 0 && expected > 0n) {
          invoice = await stripe.invoices.addLines(
            invoice.id,
            {
              lines: input.lines.map((l) => ({
                amount: Number(l.amountCents),
                description: l.description,
                metadata: { ...l.metadata },
              })),
            },
            { idempotencyKey: invoicingKey(input.invoiceId, "lines") },
          );
        }
        if (BigInt(invoice.total) !== expected) {
          throw new InvoicingProviderError(
            `The draft at Stripe totals ${invoice.total} cents and the statement ${expected}; ` +
              "it was not sent. Discard the draft and make it again.",
            "draft_total_mismatch",
          );
        }
        return mapInvoice(invoice);
      } catch (err) {
        throw refusal(err);
      }
    },

    async sendInvoice(providerInvoiceId, invoiceId) {
      try {
        return mapInvoice(
          await stripe.invoices.sendInvoice(
            providerInvoiceId,
            {},
            { idempotencyKey: invoicingKey(invoiceId, "send") },
          ),
        );
      } catch (err) {
        throw refusal(err);
      }
    },

    async voidInvoice(providerInvoiceId, invoiceId) {
      try {
        return mapInvoice(
          await stripe.invoices.voidInvoice(
            providerInvoiceId,
            {},
            { idempotencyKey: invoicingKey(invoiceId, "void") },
          ),
        );
      } catch (err) {
        throw refusal(err);
      }
    },

    async deleteDraft(providerInvoiceId) {
      try {
        await stripe.invoices.del(providerInvoiceId);
      } catch (err) {
        // Already gone is gone.
        if (isMissing(err)) return;
        throw refusal(err);
      }
    },

    async markPaidOutOfBand(providerInvoiceId, invoiceId) {
      try {
        return mapInvoice(
          await stripe.invoices.pay(
            providerInvoiceId,
            { paid_out_of_band: true },
            { idempotencyKey: invoicingKey(invoiceId, "paid") },
          ),
        );
      } catch (err) {
        throw refusal(err);
      }
    },

    async markUncollectible(providerInvoiceId, invoiceId) {
      try {
        return mapInvoice(
          await stripe.invoices.markUncollectible(
            providerInvoiceId,
            {},
            { idempotencyKey: invoicingKey(invoiceId, "uncollectible") },
          ),
        );
      } catch (err) {
        throw refusal(err);
      }
    },

    async retrieveInvoice(providerInvoiceId) {
      try {
        return mapInvoice(await stripe.invoices.retrieve(providerInvoiceId));
      } catch (err) {
        if (isMissing(err)) return null;
        throw refusal(err);
      }
    },

    readEvent(rawBody, signature): InvoicingEvent {
      if (!options.webhookSecret) throw new InvoicingNotConfiguredError();
      if (!signature) throw new InvoicingSignatureError("The delivery carries no signature.");
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, signature, options.webhookSecret);
      } catch (err) {
        throw new InvoicingSignatureError(
          err instanceof Error ? err.message : "The event's signature did not verify.",
        );
      }
      const object = event.data.object as { object?: string; id?: string };
      return {
        id: event.id,
        type: event.type,
        createdAt: new Date(event.created * 1000).toISOString(),
        livemode: event.livemode,
        apiVersion: event.api_version,
        invoiceId: object.object === "invoice" && object.id ? object.id : null,
      };
    },
  };
}
