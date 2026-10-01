/**
 * Walk one invoice through a real Stripe SANDBOX: customer, draft, send,
 * read, void. No database, no server — the adapter against Stripe itself,
 * which is the one thing a stubbed test cannot prove.
 *
 *   STRIPE_BILLING_KEY_SANDBOX=rk_test_… npm run billing:smoke
 *
 * It refuses any key that is not a test key, so it cannot issue a real
 * invoice, and a sandbox mails nobody. What it leaves behind is one voided
 * test invoice and one test customer named as such, which is the evidence.
 * Each step prints what Stripe answered; the first refusal stops the walk
 * and says which payment method or permission the account lacks.
 */

import { randomUUID } from "node:crypto";
import { stripeInvoicingConnector, type InvoicePaymentMethod } from "@hm/connectors";

async function main(): Promise<void> {
  const apiKey = process.env.STRIPE_BILLING_KEY_SANDBOX ?? "";
  if (!/^(sk|rk)_test_/.test(apiKey)) {
    throw new Error("Set STRIPE_BILLING_KEY_SANDBOX to a TEST key (sk_test_… or rk_test_…).");
  }
  const methods = (process.env.BILLING_PAYMENT_METHODS ?? "customer_balance,us_bank_account")
    .split(/[\s,;]+/)
    .filter((m) => m !== "") as InvoicePaymentMethod[];
  const invoicing = stripeInvoicingConnector({ apiKey });
  console.log(`provider: ${invoicing.capabilities.provider}; methods: ${methods.join(", ")}`);

  const run = randomUUID();
  const { customerId } = await invoicing.upsertCustomer(
    {
      servicerId: `smoke-${run}`,
      servicerSlug: "smoke-test",
      legalName: "Supermortgage billing smoke test (safe to delete)",
      email: "billing-smoke@example.test",
      address: {
        line1: "1 Test Street",
        line2: null,
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
      },
      ein: null,
    },
    null,
  );
  console.log(`customer   ${customerId}`);

  const input = {
    invoiceId: run,
    customerId,
    netDays: 30,
    memo: "Smoke test: not a real invoice.",
    footer: "Smoke test: issued by nobody, under no terms, and never sent to a customer.",
    purchaseOrder: "SMOKE-TEST",
    paymentMethods: methods,
    lines: [
      {
        description: "Self-improving mortgage: smoke-test line",
        amountCents: 1234n,
        metadata: { hm_price_row: "A.self_improving_mortgage" },
      },
    ],
    metadata: { hm_smoke_test: "true" },
  };
  const draft = await invoicing.draftInvoice(input);
  console.log(`draft      ${draft.id} ${draft.status} total=${draft.totalCents}`);
  if (draft.status !== "draft" || draft.totalCents !== 1234n) throw new Error("draft is wrong");

  // The retry a timeout would cause: the same draft, found, not a second one.
  const again = await invoicing.draftInvoice(input);
  if (again.id !== draft.id) throw new Error("a retry made a second invoice");
  console.log(`retry      found ${again.id} again, no second invoice`);

  const sent = await invoicing.sendInvoice(draft.id, run);
  console.log(
    `sent       ${sent.status} number=${sent.number} due=${sent.dueAt} ` +
      `hosted=${sent.hostedUrl ? "yes" : "no"} pdf=${sent.pdfUrl ? "yes" : "no"} livemode=${sent.livemode}`,
  );
  if (sent.status !== "open" || !sent.hostedUrl || sent.livemode) throw new Error("sent is wrong");

  const read = await invoicing.retrieveInvoice(draft.id);
  console.log(`read       ${read?.status} remaining=${read?.amountRemainingCents}`);

  // A credit on the open invoice lowers what is due; voided, it comes back.
  const noteId = randomUUID();
  const note = await invoicing.issueCreditNote({
    creditNoteId: noteId,
    providerInvoiceId: draft.id,
    amountCents: 234n,
    reason: "order_change",
    memo: "Smoke test: a credit.",
    description: "Credit against the smoke-test invoice",
    settlement: null,
    metadata: { hm_smoke_test: "true" },
  });
  console.log(
    `credit     ${note.id} ${note.status} number=${note.number} amount=${note.amountCents} pdf=${note.pdfUrl ? "yes" : "no"}`,
  );
  if (note.status !== "issued" || note.amountCents !== 234n) throw new Error("credit is wrong");
  const lessDue = await invoicing.retrieveInvoice(draft.id);
  if (lessDue?.amountRemainingCents !== 1000n)
    throw new Error(`remaining should be 1000, is ${lessDue?.amountRemainingCents}`);
  console.log(`less due   remaining=${lessDue.amountRemainingCents}`);
  const noteAgain = await invoicing.issueCreditNote({
    creditNoteId: noteId,
    providerInvoiceId: draft.id,
    amountCents: 234n,
    reason: "order_change",
    memo: "Smoke test: a credit.",
    description: "Credit against the smoke-test invoice",
    settlement: null,
    metadata: { hm_smoke_test: "true" },
  });
  if (noteAgain.id !== note.id) throw new Error("a retry made a second credit note");
  console.log(`retry      found ${noteAgain.id} again, no second credit note`);
  const noteVoided = await invoicing.voidCreditNote(note.id, noteId);
  const backDue = await invoicing.retrieveInvoice(draft.id);
  console.log(`credit void ${noteVoided.status}; remaining=${backDue?.amountRemainingCents}`);
  if (noteVoided.status !== "void" || backDue?.amountRemainingCents !== 1234n)
    throw new Error("credit void is wrong");

  const voided = await invoicing.voidInvoice(draft.id, run);
  console.log(`voided     ${voided.status} at ${voided.voidedAt}`);
  if (voided.status !== "void") throw new Error("void is wrong");

  console.log(
    "the walk held: customer, draft, idempotent retry, send, read, credit, idempotent retry, credit void, void",
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
