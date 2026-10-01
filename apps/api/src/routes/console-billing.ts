/**
 * Billing's door, for the console.
 *
 * Mounted on the servicing hostname beside the tape desk, under
 * `/console/hm/billing` — ours, answered by this API and never forwarded.
 * Its gate is the servicing app's own session, checked with it
 * (`console-staff.ts`), and the role is admin: billing is the one thing in
 * the console an analyst never opens. A borrower's session opens nothing
 * here.
 */

import express, { Router } from "express";
import { z } from "zod";
import { AppError, asyncRoute } from "../middleware/error-handler.js";
import { consoleStaffGate, type ConsoleStaffGateOptions } from "../services/console-staff.js";
import {
  BILLING_ROLES,
  billingServicers,
  closeBillingMonth,
  listStatements,
  monthFromKey,
  setAnnualTokenPool,
  statementFor,
} from "../services/billing.js";
import {
  approveInvoice,
  bankAccounts,
  bankSetupLink,
  billingProfile,
  creditNoteLink,
  draftInvoice,
  issueCreditNote,
  listCreditNotes,
  voidCreditNote,
  invoiceHistory,
  invoiceLink,
  invoicingStanding,
  listInvoices,
  markInvoicePaid,
  markInvoiceUncollectible,
  saveBillingProfile,
  sendInvoice,
  syncInvoice,
  voidInvoice,
  withdrawApproval,
  type StaffActor,
} from "../services/billing-invoices.js";
import { PRICE_SHEET } from "@hm/billing";
import { config } from "../config.js";
import { dayEt } from "../services/refi-offers.js";
import { startOfMonth } from "@hm/kernel/calendar";

/**
 * Where the servicer's own portal is, for the page the provider sends a
 * person back to: the servicing host once there is one, the console's dev
 * server before that.
 */
export function portalOrigin(): string {
  return config.servicing.publicHost
    ? `https://${config.servicing.publicHost}`
    : "http://localhost:5174";
}

const PoolBody = z
  .object({
    /** Tokens, as a decimal string; null clears it. */
    annualTokenPool: z
      .string()
      .regex(/^\d{1,18}$/)
      .nullable(),
  })
  .strict();

const CloseBody = z.object({ month: z.string().optional() }).strict();

/** An empty box is "not given", never an empty string kept as a value. */
const optional = (inner: z.ZodString) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), inner.nullable());

/**
 * Who a servicer is when it is invoiced. Every field may be left out; what
 * an invoice cannot be drafted without is named back as `gaps`.
 */
const ProfileBody = z
  .object({
    legalName: optional(z.string().max(200)),
    billingEmail: optional(z.string().email().max(254)),
    addressLine1: optional(z.string().max(200)),
    addressLine2: optional(z.string().max(200)),
    city: optional(z.string().max(100)),
    state: optional(z.string().regex(/^[A-Za-z]{2}$/, "A state is two letters.")),
    postalCode: optional(z.string().regex(/^\d{5}(-\d{4})?$/, "A ZIP code is five digits.")),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .default("US"),
    ein: optional(z.string().regex(/^\d{2}-\d{7}$/, "An EIN is written 12-3456789.")),
    netDays: z.number().int().min(0).max(365).nullable(),
    // The provider prints it as a custom field, which holds 140 characters.
    purchaseOrder: optional(z.string().max(140)),
  })
  .strict();

const ReasonBody = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/** A credit against a sent or paid invoice: how much, why, what the customer reads, and how a paid one is settled. */
const CreditNoteBody = z
  .object({
    amountCents: z.string().regex(/^\d{1,12}$/),
    reason: z.enum(["duplicate", "fraudulent", "order_change", "product_unsatisfactory"]),
    memo: z.string().trim().min(3).max(500),
    settlement: z.enum(["customer_balance", "refund", "out_of_band"]).nullable().default(null),
  })
  .strict();
const NoteBody = z.object({ note: z.string().trim().min(3).max(500) }).strict();
const InvoiceId = z.string().uuid();

function staffOf(req: express.Request): StaffActor {
  if (!req.staff) {
    throw new AppError(401, "Sign in to the console to continue.", "STAFF_SIGN_IN_REQUIRED");
  }
  return { id: req.staff.id, legalName: req.staff.legalName };
}

export function consoleBillingRouter(gate: ConsoleStaffGateOptions): Router {
  const router = Router();
  router.use(express.json({ limit: "64kb" }));
  router.use(consoleStaffGate({ ...gate, roles: BILLING_ROLES, what: "Billing" }));

  /** Every servicer, with this month so far and what was last closed. */
  router.get(
    "/servicers",
    asyncRoute(async (_req, res) => {
      res.json({
        sheet: { version: PRICE_SHEET.version, date: PRICE_SHEET.date },
        today: dayEt(new Date()),
        servicers: await billingServicers(),
      });
    }),
  );

  /** One servicer: this month so far, and every closed statement. */
  router.get(
    "/servicers/:slug",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.params.slug);
      const current = await statementFor({ slug, month: startOfMonth(dayEt(new Date())) });
      const [statements, profile, invoices] = await Promise.all([
        listStatements(slug),
        billingProfile(slug),
        listInvoices(slug),
      ]);
      res.json({
        sheet: { version: PRICE_SHEET.version, date: PRICE_SHEET.date },
        today: dayEt(new Date()),
        servicer: current.servicer,
        current,
        statements,
        profile: profile.profile,
        profileGaps: profile.gaps,
        invoices,
        invoicing: await invoicingStanding(),
      });
    }),
  );

  /** Who the servicer is when it is invoiced. Saved here; the provider hears at the next draft. */
  router.put(
    "/servicers/:slug/profile",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.params.slug);
      const input = ProfileBody.parse(req.body);
      const saved = await saveBillingProfile({ slug, input, staffId: staffOf(req).id });
      res.json({ profile: saved.profile, profileGaps: saved.gaps });
    }),
  );

  /** Draft an invoice for a closed month. Nothing is sent. */
  router.post(
    "/servicers/:slug/statements/:month/invoice",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.params.slug);
      const month = monthFromKey(z.string().parse(req.params.month));
      const invoice = await draftInvoice({
        slug,
        month: new Date(`${month}T00:00:00.000Z`),
        staff: staffOf(req),
      });
      res.status(201).json({ invoice });
    }),
  );

  /** One admin has read the draft as the servicer will and says it may go. */
  router.post(
    "/invoices/:id/approve",
    asyncRoute(async (req, res) => {
      const invoiceId = InvoiceId.parse(req.params.id);
      res.json({ invoice: await approveInvoice({ invoiceId, staff: staffOf(req) }) });
    }),
  );

  /** The approval is taken back, with the reason. */
  router.post(
    "/invoices/:id/approval/withdraw",
    asyncRoute(async (req, res) => {
      const invoiceId = InvoiceId.parse(req.params.id);
      const { reason } = ReasonBody.parse(req.body);
      res.json({ invoice: await withdrawApproval({ invoiceId, staff: staffOf(req), reason }) });
    }),
  );

  /** Finalize and send an approved draft — by a different admin than the one who approved it. */
  router.post(
    "/invoices/:id/send",
    asyncRoute(async (req, res) => {
      const invoiceId = InvoiceId.parse(req.params.id);
      res.json({ invoice: await sendInvoice({ invoiceId, staff: staffOf(req) }) });
    }),
  );

  /** Discard a draft, or void a sent invoice, with the reason. */
  router.post(
    "/invoices/:id/void",
    asyncRoute(async (req, res) => {
      const invoiceId = InvoiceId.parse(req.params.id);
      const { reason } = ReasonBody.parse(req.body);
      res.json({ invoice: await voidInvoice({ invoiceId, staff: staffOf(req), reason }) });
    }),
  );

  /** Record a payment that reached us outside the provider. */
  router.post(
    "/invoices/:id/paid",
    asyncRoute(async (req, res) => {
      const invoiceId = InvoiceId.parse(req.params.id);
      const { note } = NoteBody.parse(req.body);
      res.json({ invoice: await markInvoicePaid({ invoiceId, staff: staffOf(req), note }) });
    }),
  );

  /** Write an open invoice off. */
  router.post(
    "/invoices/:id/uncollectible",
    asyncRoute(async (req, res) => {
      const invoiceId = InvoiceId.parse(req.params.id);
      const { note } = NoteBody.parse(req.body);
      res.json({
        invoice: await markInvoiceUncollectible({ invoiceId, staff: staffOf(req), note }),
      });
    }),
  );

  /** Read the invoice again from the provider. */
  router.post(
    "/invoices/:id/sync",
    asyncRoute(async (req, res) => {
      const invoiceId = InvoiceId.parse(req.params.id);
      res.json({
        invoice: await syncInvoice({
          invoiceId,
          cause: { cause: `staff:${staffOf(req).id}`, actorName: staffOf(req).legalName },
        }),
      });
    }),
  );

  /** Where the invoice is viewed and paid, read fresh: the link expires, so it is never kept. */
  router.get(
    "/invoices/:id/link",
    asyncRoute(async (req, res) => {
      res.json(await invoiceLink({ invoiceId: InvoiceId.parse(req.params.id) }));
    }),
  );

  /** The bank accounts the servicer has on file for ACH debit. */
  router.get(
    "/servicers/:slug/ach",
    asyncRoute(async (req, res) => {
      res.json(await bankAccounts(z.string().min(1).parse(req.params.slug)));
    }),
  );

  /**
   * A link, good for a day, where the servicer puts a bank account on file.
   * Made here to hand over; the portal has its own button for the same page.
   */
  router.post(
    "/servicers/:slug/ach/setup-link",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.params.slug);
      const back = `${portalOrigin()}/console/portal/billing`;
      res
        .status(201)
        .json(
          await bankSetupLink({
            slug,
            successUrl: `${back}?ach=done`,
            cancelUrl: `${back}?ach=left`,
          }),
        );
    }),
  );

  /** The credit notes on an invoice, newest first. */
  router.get(
    "/invoices/:id/credit-notes",
    asyncRoute(async (req, res) => {
      res.json({ creditNotes: await listCreditNotes(InvoiceId.parse(req.params.id)) });
    }),
  );

  /** Issue a credit note: less due on an open invoice, a settlement on a paid one. */
  router.post(
    "/invoices/:id/credit-notes",
    asyncRoute(async (req, res) => {
      const invoiceId = InvoiceId.parse(req.params.id);
      const body = CreditNoteBody.parse(req.body);
      const creditNote = await issueCreditNote({
        invoiceId,
        amountCents: BigInt(body.amountCents),
        reason: body.reason,
        memo: body.memo,
        settlement: body.settlement,
        staff: staffOf(req),
      });
      res.status(201).json({ creditNote });
    }),
  );

  /** Void a credit note, while its invoice is still open. */
  router.post(
    "/credit-notes/:id/void",
    asyncRoute(async (req, res) => {
      const creditNoteId = InvoiceId.parse(req.params.id);
      const { reason } = ReasonBody.parse(req.body);
      res.json({
        creditNote: await voidCreditNote({ creditNoteId, staff: staffOf(req), reason }),
      });
    }),
  );

  /** The credit note's PDF, read fresh. */
  router.get(
    "/credit-notes/:id/link",
    asyncRoute(async (req, res) => {
      res.json(await creditNoteLink({ creditNoteId: InvoiceId.parse(req.params.id) }));
    }),
  );

  /** Every change in where the invoice has stood, and what caused it. */
  router.get(
    "/invoices/:id/history",
    asyncRoute(async (req, res) => {
      res.json({ history: await invoiceHistory(InvoiceId.parse(req.params.id)) });
    }),
  );

  /** A servicer's statement for a month: closed, or the meter run live. */
  router.get(
    "/servicers/:slug/statements/:month",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.params.slug);
      const month = monthFromKey(z.string().parse(req.params.month));
      res.json(await statementFor({ slug, month }));
    }),
  );

  /** The annual token pool the servicer committed to. */
  router.put(
    "/servicers/:slug/pool",
    asyncRoute(async (req, res) => {
      const slug = z.string().min(1).parse(req.params.slug);
      const body = PoolBody.parse(req.body);
      const tokens = body.annualTokenPool === null ? null : BigInt(body.annualTokenPool);
      res.json({ servicer: await setAnnualTokenPool({ slug, tokens }) });
    }),
  );

  /** Close a month by hand — the month before this one unless named — under the staff id that asked. */
  router.post(
    "/close",
    asyncRoute(async (req, res) => {
      const body = CloseBody.parse(req.body ?? {});
      const staff = staffOf(req);
      const month = body.month === undefined ? undefined : monthFromKey(body.month);
      res.status(201).json(await closeBillingMonth({ month, closedBy: staff.id }));
    }),
  );

  return router;
}
