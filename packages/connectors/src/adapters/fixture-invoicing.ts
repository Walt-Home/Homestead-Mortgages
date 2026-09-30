/**
 * Invoicing's fixture: invoices that live in memory and move when a test
 * moves them.
 *
 * It keeps the port's three rules the way the real adapter must — a second
 * draft for the same invoice id finds the first, a hosted link is minted per
 * read, and an event is believed only when its signature is the fixture's —
 * so the service above it is tested against the behavior it will meet, not
 * against a stub that says yes. It moves no money and sends no mail, and a
 * deployed service refuses to issue through it: an invoice nobody can pay
 * is worse than no invoice.
 *
 * `settle`, `reopen`, `failNext` and `event` are for tests: a payment that
 * arrives, a payment that is taken back, a provider that is down, and the
 * delivery that tells us.
 */

import type {
  ConnectorCapabilities,
  CreditNoteInput,
  InvoiceDraftInput,
  InvoicingConnector,
  InvoicingCustomerInput,
  InvoicingEvent,
  ProviderCreditNote,
  ProviderInvoice,
  ProviderInvoiceStatus,
} from "../ports/index.js";
import {
  InvoicingProviderError,
  InvoicingSignatureError,
  invoicingKey,
} from "./invoicing-errors.js";

/** The one signature the fixture's `readEvent` accepts. */
export const FIXTURE_INVOICING_SIGNATURE = "fixture-signature";

type Act =
  | "upsertCustomer"
  | "draftInvoice"
  | "sendInvoice"
  | "voidInvoice"
  | "retrieveInvoice"
  | "issueCreditNote";

export interface FixtureInvoicingConnector extends InvoicingConnector {
  /** Every customer made, by the provider's id. */
  readonly customers: Map<string, InvoicingCustomerInput>;
  /** Every write, by its idempotency key, in order: what a retry must not repeat. */
  readonly writes: string[];
  /** A payment arrives, in full. */
  settle(providerInvoiceId: string, at?: Date): void;
  /** A payment is taken back: a paid invoice is open again. */
  reopen(providerInvoiceId: string): void;
  /** The next call of this kind fails as a provider outage would. */
  failNext(act: Act): void;
  /** A signed delivery about an invoice, or a credit note, as a request body and its signature. */
  event(
    type: string,
    providerInvoiceId: string | null,
    id?: string,
    providerCreditNoteId?: string | null,
  ): { readonly body: string; readonly signature: string };
}

interface Held {
  invoice: ProviderInvoice;
  ourId: string;
}

interface HeldNote {
  note: ProviderCreditNote;
  ourId: string;
}

const MAX_INVOICE_CENTS = 99_999_999n;

export function fixtureInvoicingConnector(): FixtureInvoicingConnector {
  const capabilities: ConnectorCapabilities = {
    provider: "fixture-invoicing",
    mode: "fixture",
    satisfies: [],
  };
  const customers = new Map<string, InvoicingCustomerInput>();
  const invoices = new Map<string, Held>();
  const notes = new Map<string, HeldNote>();
  const writes: string[] = [];
  const failing = new Set<Act>();
  let sequence = 0;
  let events = 0;

  const maybeFail = (act: Act): void => {
    if (failing.delete(act)) {
      throw new InvoicingProviderError(`fixture: ${act} is down`, "fixture_outage", 503);
    }
  };
  const held = (id: string): Held => {
    const h = invoices.get(id);
    if (!h) throw new InvoicingProviderError(`No such invoice: ${id}`, "resource_missing", 404);
    return h;
  };
  // A link is minted per read, as a real one is: nothing above may keep it.
  const fresh = (i: ProviderInvoice): ProviderInvoice =>
    i.status === "draft"
      ? i
      : {
          ...i,
          hostedUrl: `https://invoice.fixture.test/${i.id}?t=${Date.now()}`,
          pdfUrl: `https://invoice.fixture.test/${i.id}.pdf`,
        };
  const move = (
    id: string,
    from: readonly ProviderInvoiceStatus[],
    patch: Partial<ProviderInvoice>,
  ): ProviderInvoice => {
    const h = held(id);
    if (!from.includes(h.invoice.status)) {
      throw new InvoicingProviderError(
        `An invoice that is ${h.invoice.status} cannot do that.`,
        "invoice_not_editable",
        400,
      );
    }
    h.invoice = { ...h.invoice, ...patch };
    return fresh(h.invoice);
  };

  return {
    capabilities,
    maxInvoiceCents: MAX_INVOICE_CENTS,
    verifiesEvents: true,
    customers,
    writes,

    async upsertCustomer(input, existingCustomerId) {
      maybeFail("upsertCustomer");
      const customerId = existingCustomerId ?? `cus_fixture_${input.servicerSlug}`;
      customers.set(customerId, input);
      return { customerId };
    },

    async draftInvoice(input: InvoiceDraftInput) {
      maybeFail("draftInvoice");
      if (!customers.has(input.customerId)) {
        throw new InvoicingProviderError(
          `No such customer: ${input.customerId}`,
          "resource_missing",
          404,
        );
      }
      // Found, not made again: the rule a retry depends on.
      for (const h of invoices.values()) if (h.ourId === input.invoiceId) return fresh(h.invoice);
      writes.push(invoicingKey(input.invoiceId, "create"));
      const total = input.lines.reduce((n, l) => n + l.amountCents, 0n);
      const id = `in_fixture_${String(++sequence).padStart(4, "0")}`;
      const invoice: ProviderInvoice = {
        id,
        customerId: input.customerId,
        number: null,
        status: "draft",
        currency: "usd",
        totalCents: total,
        amountDueCents: total,
        amountPaidCents: 0n,
        amountRemainingCents: total,
        dueAt: null,
        finalizedAt: null,
        paidAt: null,
        voidedAt: null,
        markedUncollectibleAt: null,
        hostedUrl: null,
        pdfUrl: null,
        livemode: false,
        metadata: {
          ...input.metadata,
          hm_invoice_id: input.invoiceId,
          net_days: String(input.netDays),
        },
      };
      invoices.set(id, { invoice, ourId: input.invoiceId });
      return invoice;
    },

    async sendInvoice(providerInvoiceId, invoiceId) {
      maybeFail("sendInvoice");
      const h = held(providerInvoiceId);
      // Sending twice is one invoice sent once.
      if (h.invoice.status === "open") return fresh(h.invoice);
      writes.push(invoicingKey(invoiceId, "send"));
      const now = new Date();
      const netDays = Number(h.invoice.metadata.net_days ?? "30");
      return move(providerInvoiceId, ["draft"], {
        status: "open",
        number: `FIX-${providerInvoiceId.slice(-4)}`,
        finalizedAt: now.toISOString(),
        dueAt: new Date(now.getTime() + netDays * 86_400_000).toISOString(),
      });
    },

    async voidInvoice(providerInvoiceId, invoiceId) {
      maybeFail("voidInvoice");
      if (held(providerInvoiceId).invoice.status === "void") {
        return fresh(held(providerInvoiceId).invoice);
      }
      writes.push(invoicingKey(invoiceId, "void"));
      return move(providerInvoiceId, ["open", "uncollectible"], {
        status: "void",
        voidedAt: new Date().toISOString(),
      });
    },

    async deleteDraft(providerInvoiceId) {
      const h = held(providerInvoiceId);
      if (h.invoice.status !== "draft") {
        throw new InvoicingProviderError(
          "Only a draft can be deleted.",
          "invoice_not_editable",
          400,
        );
      }
      invoices.delete(providerInvoiceId);
    },

    async markPaidOutOfBand(providerInvoiceId, invoiceId) {
      if (held(providerInvoiceId).invoice.status === "paid") {
        return fresh(held(providerInvoiceId).invoice);
      }
      writes.push(invoicingKey(invoiceId, "paid"));
      const h = held(providerInvoiceId);
      return move(providerInvoiceId, ["open", "uncollectible"], {
        status: "paid",
        paidAt: new Date().toISOString(),
        amountPaidCents: h.invoice.totalCents,
        amountRemainingCents: 0n,
      });
    },

    async markUncollectible(providerInvoiceId, invoiceId) {
      writes.push(invoicingKey(invoiceId, "uncollectible"));
      return move(providerInvoiceId, ["open"], {
        status: "uncollectible",
        markedUncollectibleAt: new Date().toISOString(),
      });
    },

    async retrieveInvoice(providerInvoiceId) {
      maybeFail("retrieveInvoice");
      const h = invoices.get(providerInvoiceId);
      return h ? fresh(h.invoice) : null;
    },

    async issueCreditNote(input: CreditNoteInput) {
      maybeFail("issueCreditNote");
      for (const h of notes.values()) if (h.ourId === input.creditNoteId) return h.note;
      const h = held(input.providerInvoiceId);
      const inv = h.invoice;
      if (inv.status !== "open" && inv.status !== "paid" && inv.status !== "uncollectible") {
        throw new InvoicingProviderError(
          `A credit note cannot be issued against an invoice that is ${inv.status}.`,
          "invoice_not_editable",
          400,
        );
      }
      if (inv.status === "paid" && input.settlement === null) {
        throw new InvoicingProviderError(
          "A credit note on a paid invoice must say how it is settled.",
          "parameter_missing",
          400,
        );
      }
      const ceiling = inv.status === "paid" ? inv.amountPaidCents : inv.amountRemainingCents;
      if (input.amountCents <= 0n || input.amountCents > ceiling) {
        throw new InvoicingProviderError(
          `A credit note must be between 1 and ${ceiling} cents on this invoice.`,
          "parameter_invalid_integer",
          400,
        );
      }
      writes.push(invoicingKey(input.creditNoteId, "credit-create"));
      const id = `cn_fixture_${String(notes.size + 1).padStart(4, "0")}`;
      const note: ProviderCreditNote = {
        id,
        invoiceId: inv.id,
        number: `${inv.number ?? "FIX"}-CN${String(notes.size + 1).padStart(2, "0")}`,
        status: "issued",
        amountCents: input.amountCents,
        refundedCents: input.settlement === "refund" ? input.amountCents : 0n,
        creditedToBalance: input.settlement === "customer_balance",
        outOfBandCents: input.settlement === "out_of_band" ? input.amountCents : 0n,
        createdAt: new Date().toISOString(),
        voidedAt: null,
        pdfUrl: `https://invoice.fixture.test/${id}.pdf`,
        livemode: false,
        metadata: { ...input.metadata, hm_credit_note_id: input.creditNoteId },
      };
      notes.set(id, { note, ourId: input.creditNoteId });
      // On an open invoice the credit lowers what is due; at nothing it is paid.
      if (inv.status !== "paid") {
        const remaining = inv.amountRemainingCents - input.amountCents;
        h.invoice = {
          ...inv,
          amountDueCents: inv.amountDueCents - input.amountCents,
          amountRemainingCents: remaining,
          ...(remaining === 0n
            ? { status: "paid" as const, paidAt: new Date().toISOString() }
            : {}),
        };
      }
      return note;
    },

    async voidCreditNote(providerCreditNoteId, creditNoteId) {
      const h = notes.get(providerCreditNoteId);
      if (!h) {
        throw new InvoicingProviderError(
          `No such credit note: ${providerCreditNoteId}`,
          "resource_missing",
          404,
        );
      }
      if (h.note.status === "void") return h.note;
      const inv = held(h.note.invoiceId);
      if (inv.invoice.status !== "open") {
        throw new InvoicingProviderError(
          "A credit note can be voided only while its invoice is open.",
          "credit_note_not_voidable",
          400,
        );
      }
      writes.push(invoicingKey(creditNoteId, "credit-void"));
      h.note = { ...h.note, status: "void", voidedAt: new Date().toISOString() };
      inv.invoice = {
        ...inv.invoice,
        amountDueCents: inv.invoice.amountDueCents + h.note.amountCents,
        amountRemainingCents: inv.invoice.amountRemainingCents + h.note.amountCents,
      };
      return h.note;
    },

    async retrieveCreditNote(providerCreditNoteId) {
      return notes.get(providerCreditNoteId)?.note ?? null;
    },

    readEvent(rawBody, signature) {
      if (signature !== FIXTURE_INVOICING_SIGNATURE) throw new InvoicingSignatureError();
      const text = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
      let parsed: Partial<InvoicingEvent>;
      try {
        parsed = JSON.parse(text) as Partial<InvoicingEvent>;
      } catch {
        throw new InvoicingSignatureError("The event's body is not JSON.");
      }
      if (!parsed.id || !parsed.type) throw new InvoicingSignatureError("The event names nothing.");
      return {
        id: parsed.id,
        type: parsed.type,
        createdAt: parsed.createdAt ?? new Date().toISOString(),
        livemode: false,
        apiVersion: null,
        invoiceId: parsed.invoiceId ?? null,
        creditNoteId: parsed.creditNoteId ?? null,
      };
    },

    settle(providerInvoiceId, at = new Date()) {
      const h = held(providerInvoiceId);
      move(providerInvoiceId, ["open", "uncollectible"], {
        status: "paid",
        paidAt: at.toISOString(),
        amountPaidCents: h.invoice.totalCents,
        amountRemainingCents: 0n,
      });
    },

    reopen(providerInvoiceId) {
      const h = held(providerInvoiceId);
      move(providerInvoiceId, ["paid"], {
        status: "open",
        paidAt: null,
        amountPaidCents: 0n,
        amountRemainingCents: h.invoice.totalCents,
      });
    },

    failNext(act) {
      failing.add(act);
    },

    event(type, providerInvoiceId, id, providerCreditNoteId = null) {
      const event: InvoicingEvent = {
        id: id ?? `evt_fixture_${String(++events).padStart(4, "0")}`,
        type,
        createdAt: new Date().toISOString(),
        livemode: false,
        apiVersion: null,
        invoiceId: providerInvoiceId,
        creditNoteId: providerCreditNoteId,
      };
      return { body: JSON.stringify(event), signature: FIXTURE_INVOICING_SIGNATURE };
    },
  };
}
