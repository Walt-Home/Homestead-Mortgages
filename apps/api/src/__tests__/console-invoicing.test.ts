/**
 * An invoice is the provider's to collect and ours to decide: the profile
 * an invoice cannot be drafted without, the draft, the send, the void, the
 * payment recorded by hand, what the servicer's own team may see, and the
 * provider's deliveries — verified, kept once, acted on by re-reading.
 *
 * The provider is the fixture, whose invoices live in memory and which
 * keeps the port's rules the way Stripe's adapter must: a retried draft is
 * found, a link is minted per read, an event is believed only when signed.
 * `stripe-invoicing.test.ts` holds the wire against a stub of Stripe; this
 * holds everything above the port against a real Postgres.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@hm/db";
import { NORTHLIGHT, sampleBook } from "@hm/partner-book";
import type { FixtureInvoicingConnector } from "@hm/connectors";
import { plainDate } from "@hm/kernel/calendar";
import { errorHandler } from "../middleware/error-handler.js";
import { billingWebhookRouter } from "../routes/billing-webhook.js";
import { consoleBillingRouter } from "../routes/console-billing.js";
import { closeBillingMonth } from "../services/billing.js";
import {
  invoiceLink,
  memberInvoices,
  reconcileInvoices,
  type CreditNoteView,
  type InvoiceView,
} from "../services/billing-invoices.js";
import { connectors } from "../services/connectors.js";
import { importPartnerBook } from "../services/partner-book.js";
import { partnerPrincipal } from "../services/party.js";

const ADMIN_COOKIE = "sm_staff=admin";

let upstream: Server;
let app: Server;
let port: number;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/ops/api/me" || !String(req.headers.cookie ?? "").includes(ADMIN_COOKIE)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ code: "AUTH_REQUIRED" }));
      return;
    }
    res.end(
      JSON.stringify({
        staff_user_id: "staff-admin",
        legal_name: "The Admin",
        roles: ["ops_analyst", "officer", "compliance", "admin"],
        role: "ops_analyst",
        source: "session",
      }),
    );
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const server = express();
  server.use("/api/webhooks", billingWebhookRouter);
  server.use(
    "/console/hm/billing",
    consoleBillingRouter({
      upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    }),
  );
  server.use(errorHandler);
  app = server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => app.once("listening", r));
  port = (app.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

async function call<T = Record<string, unknown>>(
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const r = await fetch(`http://127.0.0.1:${port}/console/hm/billing${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: ADMIN_COOKIE },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as T };
}

async function deliver(
  body: string,
  signature?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}/api/webhooks/invoicing`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature ? { "stripe-signature": signature } : {}),
    },
    body,
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

const fixture = () => connectors().invoicing as FixtureInvoicingConnector;
const utf8 = (s: string) => new TextEncoder().encode(s);
const SLUG = NORTHLIGHT.slug;
const AUGUST = plainDate("2026-08-01");

const PROFILE = {
  legalName: "Northlight Mortgage Servicing LLC",
  billingEmail: "AP@Northlight.example",
  addressLine1: "1 Main Street",
  addressLine2: "",
  city: "Austin",
  state: "tx",
  postalCode: "78701",
  country: "US",
  ein: "12-3456789",
  netDays: 30,
  purchaseOrder: "PO-2026-09",
};

/** The sample book as of 1 August, loaded on 15 August, and August closed: one statement to invoice. */
async function closedAugust() {
  const servicer = await prisma.servicer.create({
    data: { slug: SLUG, displayName: NORTHLIGHT.legal_name, integrationDepth: "API" },
    select: { id: true, slug: true },
  });
  const principalId = await partnerPrincipal(prisma, servicer.slug);
  const book = sampleBook(() => ({ as_of_date: "2026-08-01" }));
  const imported = await importPartnerBook({
    servicerId: servicer.id,
    principalId,
    profile: "m3-v1",
    tape: { filename: "northlight.xlsx", bytes: book.tape },
    supplement: { filename: "supplement.csv", bytes: utf8(book.supplement) },
  });
  if (imported.status !== "loaded") throw new Error(imported.status);
  await prisma.loan.updateMany({
    where: { servicerId: servicer.id },
    data: { createdAt: new Date("2026-08-15T16:00:00.000Z") },
  });
  const closed = await closeBillingMonth({ month: AUGUST, closedBy: "job" });
  const statement = await prisma.billingStatement.findFirstOrThrow({
    where: { servicerId: servicer.id },
  });
  return { servicer, statement, cents: closed.closed[0]!.cents };
}

async function profiled() {
  const made = await closedAugust();
  const saved = await call("PUT", `/servicers/${SLUG}/profile`, PROFILE);
  expect(saved.status).toBe(200);
  return made;
}

const draftAugust = () =>
  call<{ invoice: InvoiceView; error?: { code: string } }>(
    "POST",
    `/servicers/${SLUG}/statements/2026-08/invoice`,
  );

describe("the billing profile", () => {
  it("starts empty, names what an invoice cannot be drafted without, and is saved normalized", async () => {
    await closedAugust();
    const page = await call<{
      profile: { legalName: null };
      profileGaps: string[];
      invoicing: { canIssue: boolean; provider: string; paymentMethods: string[] };
    }>("GET", `/servicers/${SLUG}`);
    expect(page.status).toBe(200);
    expect(page.body.profile.legalName).toBeNull();
    expect(page.body.profileGaps).toEqual(["legal_name", "billing_email", "net_days"]);
    expect(page.body.invoicing).toMatchObject({
      canIssue: true,
      provider: "fixture-invoicing",
      paymentMethods: ["us_bank_account"],
    });

    const saved = await call<{ profile: Record<string, unknown>; profileGaps: string[] }>(
      "PUT",
      `/servicers/${SLUG}/profile`,
      PROFILE,
    );
    expect(saved.status).toBe(200);
    expect(saved.body.profileGaps).toEqual([]);
    expect(saved.body.profile).toMatchObject({
      legalName: PROFILE.legalName,
      billingEmail: "ap@northlight.example",
      addressLine2: null,
      state: "TX",
      ein: "12-3456789",
      netDays: 30,
      customer: null,
      updatedBy: "staff-admin",
    });
  });

  it("refuses a malformed EIN, ZIP or state, and counts half an address as a gap", async () => {
    await closedAugust();
    expect(
      (await call("PUT", `/servicers/${SLUG}/profile`, { ...PROFILE, ein: "123456789" })).status,
    ).toBe(400);
    expect(
      (await call("PUT", `/servicers/${SLUG}/profile`, { ...PROFILE, postalCode: "7870" })).status,
    ).toBe(400);
    expect(
      (await call("PUT", `/servicers/${SLUG}/profile`, { ...PROFILE, state: "Texas" })).status,
    ).toBe(400);
    const half = await call<{ profileGaps: string[] }>("PUT", `/servicers/${SLUG}/profile`, {
      ...PROFILE,
      city: "",
      postalCode: "",
    });
    expect(half.status).toBe(200);
    expect(half.body.profileGaps).toEqual(["address"]);
  });
});

describe("drafting an invoice", () => {
  it("needs a closed month and a complete profile, and refuses a month that consumed nothing or too much", async () => {
    const { servicer } = await closedAugust();
    const unprofiled = await draftAugust();
    expect(unprofiled.status).toBe(409);
    expect(unprofiled.body.error?.code).toBe("PROFILE_INCOMPLETE");

    await call("PUT", `/servicers/${SLUG}/profile`, PROFILE);
    const notClosed = await call<{ error: { code: string } }>(
      "POST",
      `/servicers/${SLUG}/statements/2026-07/invoice`,
    );
    expect(notClosed.status).toBe(409);
    expect(notClosed.body.error.code).toBe("MONTH_NOT_CLOSED");

    // A month that consumed nothing, and one beyond what a bank payment carries.
    const empty = { sheet: { version: "1.0", date: "2026-09-28" }, lines: [], loans: [] };
    await prisma.billingStatement.create({
      data: {
        servicerId: servicer.id,
        month: new Date("2026-06-01T00:00:00.000Z"),
        sheetVersion: "1.0",
        loansBilled: 0,
        loanMonths: "0.00",
        balanceCents: 0n,
        tokens: 0n,
        cents: 0n,
        statement: empty,
        closedBy: "test",
      },
    });
    await prisma.billingStatement.create({
      data: {
        servicerId: servicer.id,
        month: new Date("2026-05-01T00:00:00.000Z"),
        sheetVersion: "1.0",
        loansBilled: 1,
        loanMonths: "1.00",
        balanceCents: 1n,
        tokens: 100_000_000n,
        cents: 100_000_000n,
        statement: empty,
        closedBy: "test",
      },
    });
    const nothing = await call<{ error: { code: string } }>(
      "POST",
      `/servicers/${SLUG}/statements/2026-06/invoice`,
    );
    expect(nothing.body.error.code).toBe("NOTHING_TO_INVOICE");
    const ceiling = await call<{ error: { code: string; message: string } }>(
      "POST",
      `/servicers/${SLUG}/statements/2026-05/invoice`,
    );
    expect(ceiling.status).toBe(409);
    expect(ceiling.body.error.code).toBe("ABOVE_PAYMENT_CEILING");
    expect(ceiling.body.error.message).toContain("$999,999.99");
    expect(await prisma.billingInvoice.count()).toBe(0);
  });

  it("makes the customer from the profile and the draft from the statement, once", async () => {
    const { statement, cents } = await profiled();
    const drafted = await draftAugust();
    expect(drafted.status).toBe(201);
    const invoice = drafted.body.invoice;
    expect(invoice).toMatchObject({
      month: "2026-08",
      attempt: 1,
      standing: "draft",
      provider: "fixture",
      livemode: false,
      atProvider: true,
      amountCents: cents,
      amountRemainingCents: cents,
      netDays: 30,
      createdBy: "staff-admin",
      sentAt: null,
      number: null,
    });
    expect(invoice.statementId).toBe(statement.id);

    // The provider's customer is the profile, and is remembered.
    const profile = await prisma.servicerBillingProfile.findFirstOrThrow();
    expect(profile.provider).toBe("fixture");
    expect(profile.providerCustomerId).toBe(`cus_fixture_${SLUG}`);
    expect(fixture().customers.get(profile.providerCustomerId!)).toMatchObject({
      legalName: PROFILE.legalName,
      email: "ap@northlight.example",
      ein: "12-3456789",
      address: { line1: "1 Main Street", state: "TX", postalCode: "78701" },
    });
    // The provider's draft is the statement's lines, named by ours.
    const row = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const atProvider = await fixture().retrieveInvoice(row.providerInvoiceId!);
    expect(atProvider?.totalCents).toBe(BigInt(cents));
    expect(atProvider?.metadata).toMatchObject({
      hm_invoice_id: invoice.id,
      hm_statement_id: statement.id,
      hm_month: "2026-08",
      hm_sheet_version: "1.0",
    });

    const again = await draftAugust();
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("ALREADY_INVOICED");
    expect(await prisma.billingInvoice.count()).toBe(1);
    const history = await call<{ history: { from: string | null; to: string; cause: string }[] }>(
      "GET",
      `/invoices/${invoice.id}/history`,
    );
    expect(history.body.history).toEqual([
      expect.objectContaining({ from: null, to: "draft", cause: "staff:staff-admin" }),
    ]);
  });

  it("resumes a draft the provider never answered for, under the same id, and never makes two", async () => {
    await profiled();
    fixture().failNext("draftInvoice");
    const failed = await draftAugust();
    expect(failed.status).toBe(502);
    expect(failed.body.error?.code).toBe("INVOICING_PROVIDER");
    const rows = await prisma.billingInvoice.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerInvoiceId).toBeNull();
    const page = await call<{ invoices: InvoiceView[] }>("GET", `/servicers/${SLUG}`);
    expect(page.body.invoices[0]).toMatchObject({
      id: rows[0]!.id,
      standing: "draft",
      atProvider: false,
    });
    expect((await call("POST", `/invoices/${rows[0]!.id}/send`)).status).toBe(409);

    const resumed = await draftAugust();
    expect(resumed.status).toBe(201);
    expect(resumed.body.invoice.id).toBe(rows[0]!.id);
    expect(resumed.body.invoice.atProvider).toBe(true);
    expect(await prisma.billingInvoice.count()).toBe(1);
    expect(fixture().writes.filter((w) => w.endsWith(`${rows[0]!.id}-create`))).toHaveLength(1);
  });
});

describe("sending, voiding, paying", () => {
  it("sends once, under the staff id, and the servicer's team sees it and its fresh link from then on", async () => {
    const { servicer } = await profiled();
    const invoice = (await draftAugust()).body.invoice;
    // A draft is ours: not on their list, no page, and no link at all to them.
    expect(await memberInvoices(servicer.id)).toEqual([]);
    expect((await call("GET", `/invoices/${invoice.id}/link`)).status).toBe(409);
    await expect(
      invoiceLink({ invoiceId: invoice.id, servicerId: servicer.id }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });

    const sent = await call<{ invoice: InvoiceView }>("POST", `/invoices/${invoice.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.invoice).toMatchObject({
      standing: "sent",
      sentBy: "staff-admin",
      number: expect.stringMatching(/^FIX-/),
    });
    expect(sent.body.invoice.sentAt).not.toBeNull();
    expect(sent.body.invoice.dueAt).not.toBeNull();
    expect((await call("POST", `/invoices/${invoice.id}/send`)).status).toBe(409);

    const link = await call<{ hostedUrl: string; pdfUrl: string }>(
      "GET",
      `/invoices/${invoice.id}/link`,
    );
    expect(link.status).toBe(200);
    expect(link.body.hostedUrl).toMatch(/^https:\/\/invoice\.fixture\.test\//);
    // Read fresh each time: two reads, two links, nothing kept on the row.
    const second = await call<{ hostedUrl: string }>("GET", `/invoices/${invoice.id}/link`);
    expect(second.body.hostedUrl).not.toBe(link.body.hostedUrl);

    const theirs = await memberInvoices(servicer.id);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ id: invoice.id, month: "2026-08", standing: "sent" });
    expect(
      (await invoiceLink({ invoiceId: invoice.id, servicerId: servicer.id })).hostedUrl,
    ).toMatch(/fixture\.test/);
    // Another servicer's invoice is a 404, as is one that belongs to nobody.
    const other = await prisma.servicer.create({ data: { slug: "other", displayName: "Other" } });
    await expect(
      invoiceLink({ invoiceId: invoice.id, servicerId: other.id }),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("voids a sent invoice with a reason and frees the month to be issued again as the next attempt", async () => {
    await profiled();
    const first = (await draftAugust()).body.invoice;
    await call("POST", `/invoices/${first.id}/send`);
    expect((await call("POST", `/invoices/${first.id}/void`, { reason: "" })).status).toBe(400);
    const voided = await call<{ invoice: InvoiceView }>("POST", `/invoices/${first.id}/void`, {
      reason: "Wrong PO number on it.",
    });
    expect(voided.status).toBe(200);
    expect(voided.body.invoice).toMatchObject({ standing: "void", voidedBy: "staff-admin" });
    expect(voided.body.invoice.voidedAt).not.toBeNull();

    const second = (await draftAugust()).body.invoice;
    expect(second.id).not.toBe(first.id);
    expect(second.attempt).toBe(2);
    const list = await call<{ invoices: InvoiceView[] }>("GET", `/servicers/${SLUG}`);
    expect(list.body.invoices.map((i) => [i.attempt, i.standing])).toEqual([
      [2, "draft"],
      [1, "void"],
    ]);
    const history = await call<{ history: { to: string; note: string | null }[] }>(
      "GET",
      `/invoices/${first.id}/history`,
    );
    expect(history.body.history.map((h) => h.to)).toEqual(["draft", "open", "void"]);
    expect(history.body.history[2]!.note).toBe("Wrong PO number on it.");
  });

  it("discards a draft outright, and refuses to void what has been paid", async () => {
    await profiled();
    const draft = (await draftAugust()).body.invoice;
    const discarded = await call<{ invoice: InvoiceView }>("POST", `/invoices/${draft.id}/void`, {
      reason: "Not this month.",
    });
    expect(discarded.body.invoice.standing).toBe("void");
    const row = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: draft.id } });
    expect(await fixture().retrieveInvoice(row.providerInvoiceId!)).toBeNull();

    const next = (await draftAugust()).body.invoice;
    await call("POST", `/invoices/${next.id}/send`);
    const paid = await call<{ invoice: InvoiceView }>("POST", `/invoices/${next.id}/paid`, {
      note: "Wire received 3 September, ref 4471.",
    });
    expect(paid.status).toBe(200);
    expect(paid.body.invoice).toMatchObject({
      standing: "paid",
      paidOutOfBand: true,
      amountRemainingCents: "0",
    });
    expect(paid.body.invoice.paidAt).not.toBeNull();
    const refused = await call<{ error: { code: string } }>("POST", `/invoices/${next.id}/void`, {
      reason: "Changed my mind.",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("NOT_VOIDABLE");
  });

  it("keeps the history as it happened", async () => {
    await profiled();
    const invoice = (await draftAugust()).body.invoice;
    const t = await prisma.billingInvoiceTransition.findFirstOrThrow({
      where: { invoiceId: invoice.id },
    });
    await expect(
      prisma.billingInvoiceTransition.update({ where: { id: t.id }, data: { cause: "rewritten" } }),
    ).rejects.toThrow(/never rewritten/);
  });
});

describe("the provider's deliveries", () => {
  async function sentInvoice() {
    const made = await profiled();
    const invoice = (await draftAugust()).body.invoice;
    await call("POST", `/invoices/${invoice.id}/send`);
    const row = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    return { ...made, invoice, providerId: row.providerInvoiceId! };
  }

  it("is believed only when signed, and kept once", async () => {
    const { providerId } = await sentInvoice();
    const { body, signature } = fixture().event("invoice.paid", providerId, "evt_once");
    expect((await deliver(body)).status).toBe(400);
    expect((await deliver(body, "not-the-signature")).status).toBe(400);
    expect((await deliver("not json", signature)).status).toBe(400);

    fixture().settle(providerId);
    const first = await deliver(body, signature);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ received: true, eventId: "evt_once", outcome: "applied" });
    const second = await deliver(body, signature);
    expect(second.body.outcome).toBe("duplicate");
    expect(await prisma.billingProviderEvent.count()).toBe(1);
  });

  it("acts on what the provider says now, not on the event: paid lands as paid, however the deliveries were ordered", async () => {
    const { invoice, providerId, servicer } = await sentInvoice();
    await prisma.billingInvoice.update({ where: { id: invoice.id }, data: { sentAt: null } });
    fixture().settle(providerId);
    // The "paid" delivery arrives before the "sent" one.
    const paid = fixture().event("invoice.paid", providerId);
    const sent = fixture().event("invoice.sent", providerId);
    await deliver(paid.body, paid.signature);
    await deliver(sent.body, sent.signature);
    const row = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(row.status).toBe("PAID");
    expect(row.paidAt).not.toBeNull();
    expect(row.sentAt).not.toBeNull();
    const history = await prisma.billingInvoiceTransition.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { at: "asc" },
    });
    expect(history.map((h) => [h.toStatus, h.cause.split(":")[0]])).toEqual([
      ["DRAFT", "staff"],
      ["OPEN", "staff"],
      ["PAID", "event"],
    ]);
    expect((await memberInvoices(servicer.id))[0]).toMatchObject({ standing: "paid" });
  });

  it("ignores what is not about an invoice, and what is about an invoice that is not ours", async () => {
    await sentInvoice();
    const other = fixture().event("customer.updated", null);
    expect((await deliver(other.body, other.signature)).body.outcome).toBe("ignored");
    const stranger = fixture().event("invoice.paid", "in_fixture_nobody");
    expect((await deliver(stranger.body, stranger.signature)).body.outcome).toBe("not_ours");
  });

  it("keeps a delivery it could not act on and the reconciliation finishes it", async () => {
    const { invoice, providerId } = await sentInvoice();
    fixture().settle(providerId);
    fixture().failNext("retrieveInvoice");
    const paid = fixture().event("invoice.paid", providerId, "evt_deferred");
    const deferred = await deliver(paid.body, paid.signature);
    expect(deferred.status).toBe(200);
    expect(deferred.body.outcome).toBe("deferred");
    const inbox = await prisma.billingProviderEvent.findFirstOrThrow();
    expect(inbox.processedAt).toBeNull();
    expect(inbox.attempts).toBe(1);
    expect(inbox.lastError).toMatch(/down/);

    const report = await reconcileInvoices();
    expect(report.events).toEqual({ retried: 1, settled: 1, stillFailing: 0 });
    expect((await prisma.billingProviderEvent.findFirstOrThrow()).outcome).toBe("applied");
    expect(
      (await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).status,
    ).toBe("PAID");
  });

  it("follows a payment that is taken back, because paid is not the end", async () => {
    const { invoice, providerId } = await sentInvoice();
    fixture().settle(providerId);
    await reconcileInvoices();
    expect(
      (await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).status,
    ).toBe("PAID");
    fixture().reopen(providerId);
    const report = await reconcileInvoices();
    expect(report.invoices).toMatchObject({ checked: 1, changed: 1, failed: 0 });
    const row = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(row.status).toBe("OPEN");
    expect(row.paidAt).toBeNull();
    expect(row.paidOutOfBand).toBe(false);
    const synced = await call<{ invoice: InvoiceView }>("POST", `/invoices/${invoice.id}/sync`);
    expect(synced.body.invoice.standing).toBe("sent");
  });
});

describe("a credit note", () => {
  async function sentInvoice() {
    const made = await profiled();
    const invoice = (await draftAugust()).body.invoice;
    await call("POST", `/invoices/${invoice.id}/send`);
    const row = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    return { ...made, invoice, providerId: row.providerInvoiceId!, cents: BigInt(made.cents) };
  }
  const credit = (invoiceId: string, body: Record<string, unknown>) =>
    call<{ creditNote: CreditNoteView; error?: { code: string; message: string } }>(
      "POST",
      `/invoices/${invoiceId}/credit-notes`,
      body,
    );

  it("lowers an open invoice, is on its history, and the servicer's team sees the credit", async () => {
    const { invoice, servicer, cents } = await sentInvoice();
    const r = await credit(invoice.id, {
      amountCents: "1000",
      reason: "order_change",
      memo: "One loan was on the tape twice.",
    });
    expect(r.status).toBe(201);
    expect(r.body.creditNote).toMatchObject({
      standing: "issued",
      atProvider: true,
      amountCents: "1000",
      reason: "order_change",
      settlement: "REDUCES_AMOUNT_DUE",
      createdBy: "staff-admin",
      number: expect.stringMatching(/-CN01$/),
    });
    const after = await call<{ invoices: InvoiceView[] }>("GET", `/servicers/${SLUG}`);
    expect(after.body.invoices[0]).toMatchObject({
      standing: "sent",
      amountCents: cents.toString(),
      amountRemainingCents: (cents - 1000n).toString(),
    });
    const history = await call<{ history: { to: string; note: string | null }[] }>(
      "GET",
      `/invoices/${invoice.id}/history`,
    );
    expect(history.body.history.at(-1)?.note).toMatch(
      /^credit note .* issued for \$10\.00: One loan/,
    );
    const list = await call<{ creditNotes: CreditNoteView[] }>(
      "GET",
      `/invoices/${invoice.id}/credit-notes`,
    );
    expect(list.body.creditNotes).toHaveLength(1);
    const link = await call<{ pdfUrl: string }>(
      "GET",
      `/credit-notes/${r.body.creditNote.id}/link`,
    );
    expect(link.body.pdfUrl).toMatch(/\.pdf$/);
    expect((await memberInvoices(servicer.id))[0]).toMatchObject({ creditedCents: "1000" });
  });

  it("credits an open invoice to nothing, and the invoice is paid", async () => {
    const { invoice, cents } = await sentInvoice();
    const r = await credit(invoice.id, {
      amountCents: cents.toString(),
      reason: "product_unsatisfactory",
      memo: "The month is waived.",
    });
    expect(r.status).toBe(201);
    const row = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(row.status).toBe("PAID");
    expect(row.amountRemainingCents).toBe(0n);
  });

  it("refuses more than is owed, a settlement on an open invoice, and any credit on a draft", async () => {
    const { invoice, cents } = await sentInvoice();
    const over = await credit(invoice.id, {
      amountCents: (cents + 1n).toString(),
      reason: "order_change",
      memo: "Too much.",
    });
    expect(over.status).toBe(409);
    expect(over.body.error?.code).toBe("BAD_CREDIT_AMOUNT");
    const settled = await credit(invoice.id, {
      amountCents: "100",
      reason: "order_change",
      memo: "Wrongly settled.",
      settlement: "refund",
    });
    expect(settled.body.error?.code).toBe("SETTLEMENT_NOT_ALLOWED");
    expect(
      (await credit(invoice.id, { amountCents: "100", reason: "nope", memo: "Bad reason." }))
        .status,
    ).toBe(400);
    expect(await prisma.billingCreditNote.count()).toBe(0);

    await call("POST", `/invoices/${invoice.id}/void`, { reason: "Start over." });
    const draft = (await draftAugust()).body.invoice;
    const onDraft = await credit(draft.id, {
      amountCents: "100",
      reason: "order_change",
      memo: "On a draft.",
    });
    expect(onDraft.status).toBe(409);
    expect(onDraft.body.error?.code).toBe("NOT_CREDITABLE");
  });

  it("settles a credit on a paid invoice the one way asked, and never beyond what was paid", async () => {
    const { invoice, providerId, cents } = await sentInvoice();
    fixture().settle(providerId);
    await reconcileInvoices();
    const unsettled = await credit(invoice.id, {
      amountCents: "500",
      reason: "duplicate",
      memo: "Charged twice.",
    });
    expect(unsettled.status).toBe(409);
    expect(unsettled.body.error?.code).toBe("SETTLEMENT_REQUIRED");
    const balance = await credit(invoice.id, {
      amountCents: "500",
      reason: "duplicate",
      memo: "Charged twice; off the next invoice.",
      settlement: "customer_balance",
    });
    expect(balance.status).toBe(201);
    expect(balance.body.creditNote.settlement).toBe("CUSTOMER_BALANCE");
    // The invoice stays paid, and the credit stands: it cannot be voided now.
    const row = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(row.status).toBe("PAID");
    const voidIt = await call<{ error: { code: string } }>(
      "POST",
      `/credit-notes/${balance.body.creditNote.id}/void`,
      { reason: "Changed my mind." },
    );
    expect(voidIt.status).toBe(409);
    // What was paid, less what has been credited, is the ceiling.
    const rest = await credit(invoice.id, {
      amountCents: cents.toString(),
      reason: "duplicate",
      memo: "All of it.",
      settlement: "out_of_band",
    });
    expect(rest.status).toBe(409);
    expect(rest.body.error?.code).toBe("BAD_CREDIT_AMOUNT");
  });

  it("is voided while the invoice is open, and the invoice's amount comes back", async () => {
    const { invoice, cents } = await sentInvoice();
    const note = (
      await credit(invoice.id, { amountCents: "1000", reason: "order_change", memo: "Oops." })
    ).body.creditNote;
    const voided = await call<{ creditNote: CreditNoteView }>(
      "POST",
      `/credit-notes/${note.id}/void`,
      {
        reason: "Issued against the wrong month.",
      },
    );
    expect(voided.status).toBe(200);
    expect(voided.body.creditNote).toMatchObject({ standing: "void", voidedBy: "staff-admin" });
    const row = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(row.amountRemainingCents).toBe(cents);
    expect((await call("POST", `/credit-notes/${note.id}/void`, { reason: "Again." })).status).toBe(
      409,
    );
  });

  it("stays pending when the provider does not answer, and the reconciliation issues it", async () => {
    const { invoice, cents } = await sentInvoice();
    fixture().failNext("issueCreditNote");
    const failed = await credit(invoice.id, {
      amountCents: "1000",
      reason: "order_change",
      memo: "Pending.",
    });
    expect(failed.status).toBe(502);
    const pending = await prisma.billingCreditNote.findFirstOrThrow();
    expect(pending.status).toBe("PENDING");
    expect(pending.providerCreditNoteId).toBeNull();
    // A pending note counts against the ceiling, so it cannot be issued twice by hand.
    const twice = await credit(invoice.id, {
      amountCents: cents.toString(),
      reason: "order_change",
      memo: "Twice.",
    });
    expect(twice.body.error?.code).toBe("BAD_CREDIT_AMOUNT");

    await prisma.billingCreditNote.update({
      where: { id: pending.id },
      data: { createdAt: new Date(Date.now() - 5 * 60_000) },
    });
    const report = await reconcileInvoices();
    expect(report.creditNotes.retried).toBe(1);
    const issued = await prisma.billingCreditNote.findUniqueOrThrow({ where: { id: pending.id } });
    expect(issued.status).toBe("ISSUED");
    expect(issued.providerCreditNoteId).not.toBeNull();
    expect(fixture().writes.filter((w) => w.endsWith(`${pending.id}-credit-create`))).toHaveLength(
      1,
    );
  });

  it("follows a credit note the provider voided, by its delivery", async () => {
    const { invoice } = await sentInvoice();
    const note = (
      await credit(invoice.id, {
        amountCents: "1000",
        reason: "order_change",
        memo: "Voided at Stripe.",
      })
    ).body.creditNote;
    const row = await prisma.billingCreditNote.findUniqueOrThrow({ where: { id: note.id } });
    await fixture().voidCreditNote(row.providerCreditNoteId!, note.id);
    const inv = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const ev = fixture().event(
      "credit_note.voided",
      inv.providerInvoiceId,
      undefined,
      row.providerCreditNoteId,
    );
    expect((await deliver(ev.body, ev.signature)).body.outcome).toBe("applied");
    const after = await prisma.billingCreditNote.findUniqueOrThrow({ where: { id: note.id } });
    expect(after.status).toBe("VOID");
    expect(after.voidedAt).not.toBeNull();
  });
});

describe("the bank account on file", () => {
  it("is nothing until the provider knows the customer, which a setup link makes before any invoice", async () => {
    await closedAugust();
    const before = await call<{ customer: null; accounts: unknown[] }>("GET", `/servicers/${SLUG}/ach`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ customer: null, accounts: [] });

    // The provider cannot know a customer with no name and no address to mail.
    const early = await call<{ error: { code: string } }>("POST", `/servicers/${SLUG}/ach/setup-link`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("PROFILE_INCOMPLETE");

    await call("PUT", `/servicers/${SLUG}/profile`, { ...PROFILE, netDays: null });
    const link = await call<{ url: string; expiresAt: string }>("POST", `/servicers/${SLUG}/ach/setup-link`);
    expect(link.status).toBe(201);
    expect(link.body.url).toMatch(/^https:\/\/setup\.fixture\.test\/cus_fixture_northlight\?success=/);
    expect(decodeURIComponent(link.body.url)).toContain("/console/portal/billing?ach=done");
    const profile = await prisma.servicerBillingProfile.findFirstOrThrow();
    expect(profile.providerCustomerId).toBe(`cus_fixture_${SLUG}`);
    expect(await prisma.billingInvoice.count()).toBe(0);

    const known = await call<{ customer: { id: string }; accounts: unknown[] }>("GET", `/servicers/${SLUG}/ach`);
    expect(known.body.customer.id).toBe(`cus_fixture_${SLUG}`);
    expect(known.body.accounts).toEqual([]);
  });

  it("lists what the servicer put on file, and makes a lone account the default", async () => {
    await profiled();
    await call("POST", `/servicers/${SLUG}/ach/setup-link`);
    fixture().addBankAccount(`cus_fixture_${SLUG}`, { bankName: "FIRST BANK", last4: "6789" });
    const listed = await call<{ accounts: { id: string; bankName: string; last4: string; isDefault: boolean }[] }>(
      "GET",
      `/servicers/${SLUG}/ach`,
    );
    expect(listed.body.accounts).toEqual([
      expect.objectContaining({ bankName: "FIRST BANK", last4: "6789", isDefault: true }),
    ]);
    // The servicer's own team reads the same, and the invoice is paid from it.
    const servicer = await prisma.servicer.findUniqueOrThrow({ where: { slug: SLUG } });
    void servicer;
    const again = await fixture().listBankAccounts(`cus_fixture_${SLUG}`);
    expect(again[0]!.isDefault).toBe(true);
  });
});
