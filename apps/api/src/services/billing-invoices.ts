/**
 * An invoice is the provider's to collect and ours to decide.
 *
 * A closed statement says what a servicer's book consumed. This turns one
 * into an invoice somebody can pay, and follows it: who the servicer is
 * when it is billed (the profile), the invoice a provider issues for the
 * statement, every change in where that invoice stands, and the inbox for
 * what the provider tells us. The amount is never computed here — it is the
 * statement's — and no status is inferred: every one on a row was read
 * from the provider.
 *
 * What a person does, in order, each its own act:
 *
 *   draft    a closed statement becomes a draft at the provider, with the
 *            statement's lines; nothing has been sent and it can be
 *            discarded
 *   send     somebody has looked at it; the provider finalizes and sends
 *            it, and from here the amount cannot change
 *   void     a sent invoice is cancelled, keeping the paper trail, and the
 *            statement is free to be issued again
 *   paid     a wire that reached us outside the provider is recorded
 *
 * Sending is never automatic. Who approves an invoice before it goes out
 * is a decision still open, so the code keeps the review a separate press
 * by a named admin and records who pressed.
 *
 * Three things that are easy to get wrong, and what is done about each:
 *
 *   - **Two systems, one invoice.** Our row is written first, then the
 *     provider is asked under an idempotency key derived from the row's id.
 *     A provider that times out leaves a row with no provider id; pressing
 *     Draft again resumes that row under the same key, and the adapter
 *     finds the earlier draft rather than making a second.
 *   - **Events arrive late, twice and out of order.** A delivery is
 *     verified, written to the inbox under its event id (so a redelivery is
 *     a no-op), and acted on by reading the invoice again from the
 *     provider — never from the event's own copy. An event that could not
 *     be acted on stays in the inbox and the reconciliation retries it.
 *   - **Paid is not the end.** A payment can be taken back, and the row
 *     follows the provider back to open. The reconciliation re-reads
 *     recently paid invoices for that reason, and every open one because
 *     deliveries are retried for only three days.
 *
 * The hosted link is never stored. It expires, so it is read fresh each
 * time somebody asks for it and handed straight to them.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@hm/db";
import type {
  BillingCreditNote,
  BillingCreditSettlement,
  BillingInvoice,
  BillingInvoiceStatus,
  Prisma,
} from "@hm/db";
import {
  InvoicingProviderError,
  type BankAccountOnFile,
  type BankSetupLink,
  type CreditNoteReason,
  type CreditNoteSettlement,
  type ProviderCreditNote,
  type InvoiceLineInput,
  type InvoicingConnector,
  type InvoicingEvent,
  type ProviderInvoice,
} from "@hm/connectors";
import type { StatementWire } from "@hm/billing";
import { config } from "../config.js";
import { AppError } from "../middleware/error-handler.js";
import { connectors, invoicePaymentMethods } from "./connectors.js";
import type { Db } from "./db.js";
import { assertSlug } from "./tape-desk.js";

/* ── the provider, as this deployment has it ─────────────────────────────── */

/**
 * The provider a row belongs to: sandbox and live are different worlds
 * with different customers, so they are different names.
 */
export function providerKey(invoicing: InvoicingConnector): string {
  switch (invoicing.capabilities.mode) {
    case "fixture":
      return "fixture";
    case "sandbox":
      return "stripe:test";
    case "production":
      return "stripe:live";
  }
}

export interface InvoicingStanding {
  readonly provider: string;
  readonly mode: "fixture" | "sandbox" | "production";
  /** Whether this deployment may issue at all, and why not when it may not. */
  readonly canIssue: boolean;
  readonly cannotIssueBecause: string | null;
  readonly maxInvoiceCents: string;
  readonly paymentMethods: readonly string[];
  /** Whether the provider's deliveries can be verified: a signing secret is held. */
  readonly verifiesEvents: boolean;
}

/**
 * A deployed service does not issue through the fixture: its invoices live
 * in memory and nobody can pay them. `NODE_ENV=production` is staging and
 * production alike.
 */
function cannotIssue(invoicing: InvoicingConnector): string | null {
  if (invoicing.capabilities.mode === "fixture" && config.nodeEnv === "production") {
    return "Invoicing is not connected on this deployment. Set INVOICING_PROVIDER=stripe and a billing key.";
  }
  return null;
}

export function invoicingStanding(): InvoicingStanding {
  const invoicing = connectors().invoicing;
  const why = cannotIssue(invoicing);
  return {
    provider: invoicing.capabilities.provider,
    mode: invoicing.capabilities.mode,
    canIssue: why === null,
    cannotIssueBecause: why,
    maxInvoiceCents: invoicing.maxInvoiceCents.toString(),
    paymentMethods: invoicePaymentMethods(),
    verifiesEvents: invoicing.verifiesEvents,
  };
}

/** The provider's refusal as a 502 carrying its own sentence; anything else as it was. */
async function atProvider<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof InvoicingProviderError) {
      throw new AppError(502, err.message, "INVOICING_PROVIDER", {
        providerCode: err.providerCode,
        providerStatus: err.statusCode,
      });
    }
    throw err;
  }
}

/* ── the billing profile ─────────────────────────────────────────────────── */

export interface BillingProfile {
  readonly legalName: string | null;
  readonly billingEmail: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string;
  readonly ein: string | null;
  readonly netDays: number | null;
  readonly purchaseOrder: string | null;
  /** The provider's customer, once one has been made. */
  readonly customer: { readonly provider: string; readonly id: string } | null;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export interface BillingProfileInput {
  readonly legalName: string | null;
  readonly billingEmail: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string;
  readonly ein: string | null;
  readonly netDays: number | null;
  readonly purchaseOrder: string | null;
}

/** What an invoice cannot be drafted without. Nothing here has a default. */
export type ProfileGap = "legal_name" | "billing_email" | "net_days" | "address";

const EMPTY_PROFILE: BillingProfile = {
  legalName: null,
  billingEmail: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  postalCode: null,
  country: "US",
  ein: null,
  netDays: null,
  purchaseOrder: null,
  customer: null,
  updatedAt: null,
  updatedBy: null,
};

type ProfileRow = NonNullable<Awaited<ReturnType<typeof prisma.servicerBillingProfile.findUnique>>>;

const profileOf = (r: ProfileRow | null): BillingProfile =>
  r === null
    ? EMPTY_PROFILE
    : {
        legalName: r.legalName,
        billingEmail: r.billingEmail,
        addressLine1: r.addressLine1,
        addressLine2: r.addressLine2,
        city: r.city,
        state: r.state,
        postalCode: r.postalCode,
        country: r.country,
        ein: r.ein,
        netDays: r.netDays,
        purchaseOrder: r.purchaseOrder,
        customer:
          r.provider && r.providerCustomerId
            ? { provider: r.provider, id: r.providerCustomerId }
            : null,
        updatedAt: r.updatedAt.toISOString(),
        updatedBy: r.updatedBy,
      };

/**
 * What is missing before an invoice can be drafted: the legal name, where
 * it is sent, and the terms. An address is optional, but half of one is a
 * gap — an invoice should not print a city with no street.
 */
export function profileGaps(p: BillingProfile): ProfileGap[] {
  const gaps: ProfileGap[] = [];
  if (!p.legalName) gaps.push("legal_name");
  if (!p.billingEmail) gaps.push("billing_email");
  if (p.netDays === null) gaps.push("net_days");
  const address = [p.addressLine1, p.city, p.state, p.postalCode];
  const some = address.some((v) => v) || Boolean(p.addressLine2);
  if (some && !address.every((v) => v)) gaps.push("address");
  return gaps;
}

async function servicerFor(slug: string, db: Db) {
  const servicer = await db.servicer.findUnique({
    where: { slug: assertSlug(slug) },
    select: { id: true, slug: true, displayName: true, billingProfile: true },
  });
  if (!servicer) throw new AppError(404, "No servicer by that name.", "NOT_FOUND");
  return servicer;
}

export async function billingProfile(
  slug: string,
  db: Db = prisma,
): Promise<{ profile: BillingProfile; gaps: ProfileGap[] }> {
  const profile = profileOf((await servicerFor(slug, db)).billingProfile);
  return { profile, gaps: profileGaps(profile) };
}

const blank = (v: string | null): string | null => {
  const t = v?.trim() ?? "";
  return t === "" ? null : t;
};

/**
 * Save the profile. Ours only: the provider's customer is brought in line
 * when the next invoice is drafted, so a typo corrected here never mails
 * anything by itself.
 */
export async function saveBillingProfile(
  args: { readonly slug: string; readonly input: BillingProfileInput; readonly staffId: string },
  db: Db = prisma,
): Promise<{ profile: BillingProfile; gaps: ProfileGap[] }> {
  const servicer = await servicerFor(args.slug, db);
  const i = args.input;
  const data = {
    legalName: blank(i.legalName),
    billingEmail: blank(i.billingEmail)?.toLowerCase() ?? null,
    addressLine1: blank(i.addressLine1),
    addressLine2: blank(i.addressLine2),
    city: blank(i.city),
    state: blank(i.state)?.toUpperCase() ?? null,
    postalCode: blank(i.postalCode),
    country: i.country.toUpperCase(),
    ein: blank(i.ein),
    netDays: i.netDays,
    purchaseOrder: blank(i.purchaseOrder),
    updatedBy: args.staffId,
  };
  const row = await db.servicerBillingProfile.upsert({
    where: { servicerId: servicer.id },
    create: { servicerId: servicer.id, ...data },
    update: data,
  });
  const profile = profileOf(row);
  return { profile, gaps: profileGaps(profile) };
}

/* ── an invoice, as a person reads it ────────────────────────────────────── */

/**
 * Where an invoice stands, in the words a person uses. "Sent" and "past
 * due" are not the provider's statuses: both are an open invoice, one that
 * has been sent and one whose due date is behind us.
 */
export type InvoiceStandingWord =
  "draft" | "open" | "sent" | "past_due" | "paid" | "void" | "uncollectible";

export function invoiceStanding(
  row: Pick<BillingInvoice, "status" | "sentAt" | "dueAt">,
  now: Date = new Date(),
): InvoiceStandingWord {
  switch (row.status) {
    case "DRAFT":
      return "draft";
    case "OPEN":
      if (row.dueAt !== null && row.dueAt < now) return "past_due";
      return row.sentAt !== null ? "sent" : "open";
    case "PAID":
      return "paid";
    case "VOID":
      return "void";
    case "UNCOLLECTIBLE":
      return "uncollectible";
  }
}

export interface InvoiceView {
  readonly id: string;
  readonly statementId: string;
  /** "YYYY-MM". */
  readonly month: string;
  readonly attempt: number;
  readonly number: string | null;
  readonly standing: InvoiceStandingWord;
  readonly provider: string;
  readonly livemode: boolean;
  /** False while our row waits for the provider to answer; Draft again resumes it. */
  readonly atProvider: boolean;
  /** The provider's own id, for the link into its dashboard. */
  readonly providerInvoiceId: string | null;
  readonly currency: string;
  readonly amountCents: string;
  readonly amountDueCents: string;
  readonly amountPaidCents: string;
  readonly amountRemainingCents: string;
  readonly netDays: number;
  readonly dueAt: string | null;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly finalizedAt: string | null;
  readonly sentAt: string | null;
  readonly sentBy: string | null;
  readonly paidAt: string | null;
  readonly paidOutOfBand: boolean;
  readonly voidedAt: string | null;
  readonly voidedBy: string | null;
  readonly uncollectibleAt: string | null;
  readonly lastSyncedAt: string | null;
}

type InvoiceWithMonth = BillingInvoice & { statement: { month: Date } };

const day = (d: Date | null): string | null => d?.toISOString() ?? null;

function viewOf(row: InvoiceWithMonth, now: Date = new Date()): InvoiceView {
  return {
    id: row.id,
    statementId: row.statementId,
    month: row.statement.month.toISOString().slice(0, 7),
    attempt: row.attempt,
    number: row.number,
    standing: invoiceStanding(row, now),
    provider: row.provider,
    livemode: row.livemode,
    atProvider: row.providerInvoiceId !== null,
    providerInvoiceId: row.providerInvoiceId,
    currency: row.currency,
    amountCents: row.amountCents.toString(),
    amountDueCents: row.amountDueCents.toString(),
    amountPaidCents: row.amountPaidCents.toString(),
    amountRemainingCents: row.amountRemainingCents.toString(),
    netDays: row.netDays,
    dueAt: day(row.dueAt),
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    finalizedAt: day(row.finalizedAt),
    sentAt: day(row.sentAt),
    sentBy: row.sentBy,
    paidAt: day(row.paidAt),
    paidOutOfBand: row.paidOutOfBand,
    voidedAt: day(row.voidedAt),
    voidedBy: row.voidedBy,
    uncollectibleAt: day(row.uncollectibleAt),
    lastSyncedAt: day(row.lastSyncedAt),
  };
}

const WITH_MONTH = { statement: { select: { month: true } } } as const;

/** A servicer's invoices, newest month first, a reissue after its original. */
export async function listInvoices(slug: string, db: Db = prisma): Promise<InvoiceView[]> {
  const servicer = await servicerFor(slug, db);
  const rows = await db.billingInvoice.findMany({
    where: { servicerId: servicer.id },
    include: WITH_MONTH,
    orderBy: [{ statement: { month: "desc" } }, { attempt: "desc" }],
  });
  return rows.map((r) => viewOf(r));
}

export interface InvoiceHistoryEntry {
  readonly from: string | null;
  readonly to: string;
  readonly cause: string;
  readonly note: string | null;
  readonly at: string;
}

/** Every change in where an invoice has stood, oldest first. */
export async function invoiceHistory(
  invoiceId: string,
  db: Db = prisma,
): Promise<InvoiceHistoryEntry[]> {
  const rows = await db.billingInvoiceTransition.findMany({
    where: { invoiceId },
    orderBy: { at: "asc" },
  });
  return rows.map((t) => ({
    from: t.fromStatus?.toLowerCase() ?? null,
    to: t.toStatus.toLowerCase(),
    cause: t.cause,
    note: t.note,
    at: t.at.toISOString(),
  }));
}

async function invoiceRow(invoiceId: string, db: Db): Promise<InvoiceWithMonth> {
  const row = await db.billingInvoice.findUnique({ where: { id: invoiceId }, include: WITH_MONTH });
  if (!row) throw new AppError(404, "No such invoice.", "NOT_FOUND");
  return row;
}

/* ── bringing a row in line with the provider ────────────────────────────── */

const instant = (s: string | null): Date | null => (s === null ? null : new Date(s));

/**
 * Write what the provider says onto our row, and the change of status into
 * the history. The one place a status is set from a provider's invoice, so
 * the staff acts, the events and the reconciliation cannot disagree about
 * what a status means.
 */
async function apply(
  row: BillingInvoice,
  p: ProviderInvoice,
  cause: string,
  extra: Prisma.BillingInvoiceUpdateInput = {},
  note: string | null = null,
  db: Db = prisma,
): Promise<InvoiceWithMonth> {
  const next = p.status.toUpperCase() as BillingInvoiceStatus;
  const data: Prisma.BillingInvoiceUpdateInput = {
    providerInvoiceId: p.id,
    number: p.number,
    status: next,
    livemode: p.livemode,
    amountDueCents: p.amountDueCents,
    amountPaidCents: p.amountPaidCents,
    amountRemainingCents: p.amountRemainingCents,
    dueAt: instant(p.dueAt),
    finalizedAt: instant(p.finalizedAt),
    // Null again when a payment is taken back: the row says what is true now.
    paidAt: instant(p.paidAt),
    voidedAt: instant(p.voidedAt),
    uncollectibleAt: instant(p.markedUncollectibleAt),
    lastSyncedAt: new Date(),
    ...(next !== "PAID" ? { paidOutOfBand: false } : {}),
    ...extra,
  };
  const write = async (tx: Db) => {
    const updated = await tx.billingInvoice.update({
      where: { id: row.id },
      data,
      include: WITH_MONTH,
    });
    if (row.status !== next) {
      await tx.billingInvoiceTransition.create({
        data: { invoiceId: row.id, fromStatus: row.status, toStatus: next, cause, note },
      });
    }
    return updated;
  };
  return db === (prisma as unknown as Db) ? prisma.$transaction((tx) => write(tx)) : write(db);
}

/* ── the acts ────────────────────────────────────────────────────────────── */

const dollars = (cents: string | bigint): string => {
  const n = BigInt(cents);
  const whole = (n / 100n).toLocaleString("en-US");
  return `$${whole}.${(n % 100n).toString().padStart(2, "0")}`;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const monthWords = (key: string): string => {
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1] ?? key} ${y ?? ""}`.trim();
};

/**
 * The statement's lines as the invoice's: one per priced row that charged
 * something, in the sheet's words, with the quantity it was charged on.
 */
export function invoiceLines(statement: StatementWire): InvoiceLineInput[] {
  const lines: InvoiceLineInput[] = [];
  for (const l of statement.lines) {
    const cents = BigInt(l.cents);
    if (cents <= 0n) continue;
    const name = l.action.split(":")[0]!.trim();
    const quantity =
      l.quantity.kind === "loan_months"
        ? `${l.quantity.loanMonths} loan-months on ${dollars(l.quantity.balanceCents)} of unpaid principal across ${l.quantity.loans.toLocaleString("en-US")} loans, at ${l.tokensEach.toLocaleString("en-US")} tokens per $100,000 per loan-month`
        : `${l.quantity.count.toLocaleString("en-US")} at ${l.tokensEach.toLocaleString("en-US")} tokens each`;
    lines.push({
      description: `${name}: ${quantity}`,
      amountCents: cents,
      metadata: { hm_price_row: l.code, hm_tokens: l.tokens },
    });
  }
  return lines;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2002";
}

/**
 * The provider's customer for a servicer, made from the profile or brought
 * in line with it, and remembered. A customer made in the sandbox is not
 * one in live, and the reverse, so the remembered id counts only under the
 * provider this deployment runs.
 */
async function ensureCustomer(
  servicer: { readonly id: string; readonly slug: string },
  profile: BillingProfile,
  db: Db,
): Promise<string> {
  if (!profile.legalName || !profile.billingEmail) {
    throw new AppError(
      409,
      "The billing profile needs the legal name and where the invoice goes before the provider can know the customer.",
      "PROFILE_INCOMPLETE",
      { gaps: profileGaps(profile).filter((g) => g === "legal_name" || g === "billing_email") },
    );
  }
  const invoicing = connectors().invoicing;
  const provider = providerKey(invoicing);
  const { customerId } = await atProvider(() =>
    invoicing.upsertCustomer(
      {
        servicerId: servicer.id,
        servicerSlug: servicer.slug,
        legalName: profile.legalName!,
        email: profile.billingEmail!,
        address:
          profile.addressLine1 && profile.city && profile.state && profile.postalCode
            ? {
                line1: profile.addressLine1,
                line2: profile.addressLine2,
                city: profile.city,
                state: profile.state,
                postalCode: profile.postalCode,
                country: profile.country,
              }
            : null,
        ein: profile.ein,
      },
      profile.customer?.provider === provider ? profile.customer.id : null,
    ),
  );
  await db.servicerBillingProfile.update({
    where: { servicerId: servicer.id },
    data: { provider, providerCustomerId: customerId },
  });
  return customerId;
}

/* ── ACH: the bank account on file ───────────────────────────────────────── */

export interface BankAccountsAnswer {
  /** Null until the provider knows the servicer as a customer. */
  readonly customer: { readonly provider: string; readonly id: string } | null;
  readonly accounts: readonly BankAccountOnFile[];
}

/**
 * The bank accounts a servicer has put on file for ACH debit, read from
 * the provider. One account and no default is made the default here, so
 * the hosted page pays from it without asking again.
 */
export async function bankAccounts(slug: string, db: Db = prisma): Promise<BankAccountsAnswer> {
  const servicer = await servicerFor(slug, db);
  const profile = profileOf(servicer.billingProfile);
  const invoicing = connectors().invoicing;
  if (!profile.customer || profile.customer.provider !== providerKey(invoicing)) {
    return { customer: null, accounts: [] };
  }
  const customerId = profile.customer.id;
  let accounts = await atProvider(() => invoicing.listBankAccounts(customerId));
  if (accounts.length > 0 && !accounts.some((a) => a.isDefault)) {
    const first = [...accounts].sort((a, b) => a.addedAt.localeCompare(b.addedAt))[0]!;
    await atProvider(() => invoicing.setDefaultBankAccount(customerId, first.id));
    accounts = accounts.map((a) => ({ ...a, isDefault: a.id === first.id }));
  }
  return { customer: profile.customer, accounts };
}

/**
 * A hosted page where the servicer puts a bank account on file, good for a
 * day. The provider has to know the customer first, so the profile's
 * legal name and e-mail are needed; an invoice is not.
 */
export async function bankSetupLink(
  args: { readonly slug: string; readonly successUrl: string; readonly cancelUrl: string },
  db: Db = prisma,
): Promise<BankSetupLink> {
  const invoicing = connectors().invoicing;
  const why = cannotIssue(invoicing);
  if (why) throw new AppError(409, why, "INVOICING_NOT_CONNECTED");
  const servicer = await servicerFor(args.slug, db);
  const customerId = await ensureCustomer(servicer, profileOf(servicer.billingProfile), db);
  return atProvider(() =>
    invoicing.createBankSetupLink({
      customerId,
      servicerId: servicer.id,
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
    }),
  );
}

/**
 * Draft an invoice for a closed month: our row, then the provider's draft
 * with the statement's lines. Nothing is sent. A row an earlier attempt
 * left without a provider id is resumed, not remade.
 */
export async function draftInvoice(
  args: { readonly slug: string; readonly month: Date; readonly staffId: string },
  db: Db = prisma,
): Promise<InvoiceView> {
  const invoicing = connectors().invoicing;
  const why = cannotIssue(invoicing);
  if (why) throw new AppError(409, why, "INVOICING_NOT_CONNECTED");
  const methods = invoicePaymentMethods();
  const servicer = await servicerFor(args.slug, db);

  const statement = await db.billingStatement.findUnique({
    where: { servicerId_month: { servicerId: servicer.id, month: args.month } },
  });
  if (!statement) {
    throw new AppError(
      409,
      "That month has not been closed. An invoice is drafted from a closed statement.",
      "MONTH_NOT_CLOSED",
    );
  }
  if (statement.cents <= 0n) {
    throw new AppError(
      409,
      "That month consumed nothing; there is nothing to invoice.",
      "NOTHING_TO_INVOICE",
    );
  }
  if (statement.cents > invoicing.maxInvoiceCents) {
    throw new AppError(
      409,
      `The month is ${dollars(statement.cents)}, above the ${dollars(invoicing.maxInvoiceCents)} a single bank payment can carry. It cannot be issued as one invoice.`,
      "ABOVE_PAYMENT_CEILING",
      { cents: statement.cents.toString(), maxInvoiceCents: invoicing.maxInvoiceCents.toString() },
    );
  }
  const profile = profileOf(servicer.billingProfile);
  const gaps = profileGaps(profile);
  if (gaps.length > 0 || !profile.legalName || !profile.billingEmail || profile.netDays === null) {
    throw new AppError(
      409,
      `The billing profile is missing ${gaps.join(", ").replace(/_/g, " ")}.`,
      "PROFILE_INCOMPLETE",
      { gaps },
    );
  }

  const live = await db.billingInvoice.findFirst({
    where: { statementId: statement.id, status: { not: "VOID" } },
  });
  if (live?.providerInvoiceId) {
    throw new AppError(409, "That month already has an invoice.", "ALREADY_INVOICED", {
      invoiceId: live.id,
    });
  }

  const provider = providerKey(invoicing);
  const customerId = await ensureCustomer(servicer, profile, db);

  let row = live;
  if (!row) {
    const attempt = (await db.billingInvoice.count({ where: { statementId: statement.id } })) + 1;
    const id = randomUUID();
    try {
      row = await db.billingInvoice.create({
        data: {
          id,
          statementId: statement.id,
          servicerId: servicer.id,
          attempt,
          provider,
          livemode: invoicing.capabilities.mode === "production",
          providerCustomerId: customerId,
          status: "DRAFT",
          amountCents: statement.cents,
          amountDueCents: statement.cents,
          amountRemainingCents: statement.cents,
          netDays: profile.netDays,
          createdBy: args.staffId,
          transitions: {
            create: { fromStatus: null, toStatus: "DRAFT", cause: `staff:${args.staffId}` },
          },
        },
      });
    } catch (err) {
      // Two people pressed Draft: the index lets one row in.
      if (isUniqueViolation(err)) {
        throw new AppError(409, "That month already has an invoice.", "ALREADY_INVOICED");
      }
      throw err;
    }
  }

  const wire = statement.statement as unknown as StatementWire;
  const month = statement.month.toISOString().slice(0, 7);
  const resumed = row;
  const drafted = await atProvider(() =>
    invoicing.draftInvoice({
      invoiceId: resumed.id,
      customerId,
      netDays: resumed.netDays,
      memo: `Supermortgage usage for ${monthWords(month)}, ${wire.from} through ${wire.to}. Price sheet ${statement.sheetVersion}; one token is one cent.`,
      purchaseOrder: profile.purchaseOrder,
      paymentMethods: methods,
      lines: invoiceLines(wire),
      metadata: {
        hm_statement_id: statement.id,
        hm_servicer_slug: servicer.slug,
        hm_month: month,
        hm_sheet_version: statement.sheetVersion,
        hm_tokens: statement.tokens.toString(),
      },
    }),
  );
  return viewOf(await apply(resumed, drafted, `staff:${args.staffId}`, {}, null, db));
}

/** Finalize and send a draft somebody has looked at. From here the amount cannot change. */
export async function sendInvoice(
  args: { readonly invoiceId: string; readonly staffId: string },
  db: Db = prisma,
): Promise<InvoiceView> {
  const row = await invoiceRow(args.invoiceId, db);
  if (!row.providerInvoiceId) {
    throw new AppError(
      409,
      "The provider never answered for this draft. Draft it again first.",
      "NOT_AT_PROVIDER",
    );
  }
  if (row.status !== "DRAFT" && !(row.status === "OPEN" && row.sentAt === null)) {
    throw new AppError(
      409,
      `An invoice that is ${invoiceStanding(row)} cannot be sent.`,
      "NOT_SENDABLE",
    );
  }
  const invoicing = connectors().invoicing;
  const sent = await atProvider(() => invoicing.sendInvoice(row.providerInvoiceId!, row.id));
  return viewOf(
    await apply(
      row,
      sent,
      `staff:${args.staffId}`,
      { sentAt: new Date(), sentBy: args.staffId },
      null,
      db,
    ),
  );
}

/**
 * Cancel an invoice. A draft is discarded outright; a sent one is voided at
 * the provider, keeping the paper trail. Either way the statement is free
 * to be issued again. A paid invoice is not voided: that is a refund and a
 * credit note, which are not built.
 */
export async function voidInvoice(
  args: { readonly invoiceId: string; readonly staffId: string; readonly reason: string },
  db: Db = prisma,
): Promise<InvoiceView> {
  const row = await invoiceRow(args.invoiceId, db);
  const invoicing = connectors().invoicing;
  const cause = `staff:${args.staffId}`;
  if (row.status === "DRAFT") {
    if (row.providerInvoiceId) {
      await atProvider(() => invoicing.deleteDraft(row.providerInvoiceId!));
    }
    const [updated] = await prisma.$transaction([
      prisma.billingInvoice.update({
        where: { id: row.id },
        data: { status: "VOID", voidedAt: new Date(), voidedBy: args.staffId },
        include: WITH_MONTH,
      }),
      prisma.billingInvoiceTransition.create({
        data: {
          invoiceId: row.id,
          fromStatus: "DRAFT",
          toStatus: "VOID",
          cause,
          note: `draft discarded: ${args.reason}`,
        },
      }),
    ]);
    return viewOf(updated);
  }
  if (row.status !== "OPEN" && row.status !== "UNCOLLECTIBLE") {
    throw new AppError(
      409,
      row.status === "PAID"
        ? "A paid invoice is corrected with a credit note, not voided."
        : `An invoice that is ${invoiceStanding(row)} cannot be voided.`,
      "NOT_VOIDABLE",
    );
  }
  const voided = await atProvider(() => invoicing.voidInvoice(row.providerInvoiceId!, row.id));
  return viewOf(await apply(row, voided, cause, { voidedBy: args.staffId }, args.reason, db));
}

/** Record a payment that reached us outside the provider. No charge is made. */
export async function markInvoicePaid(
  args: { readonly invoiceId: string; readonly staffId: string; readonly note: string },
  db: Db = prisma,
): Promise<InvoiceView> {
  const row = await invoiceRow(args.invoiceId, db);
  if (row.status !== "OPEN" && row.status !== "UNCOLLECTIBLE") {
    throw new AppError(
      409,
      `An invoice that is ${invoiceStanding(row)} cannot be marked paid.`,
      "NOT_PAYABLE",
    );
  }
  const invoicing = connectors().invoicing;
  const paid = await atProvider(() => invoicing.markPaidOutOfBand(row.providerInvoiceId!, row.id));
  return viewOf(
    await apply(row, paid, `staff:${args.staffId}`, { paidOutOfBand: true }, args.note, db),
  );
}

/** Write an open invoice off as bad debt. It can still be paid afterwards. */
export async function markInvoiceUncollectible(
  args: { readonly invoiceId: string; readonly staffId: string; readonly note: string },
  db: Db = prisma,
): Promise<InvoiceView> {
  const row = await invoiceRow(args.invoiceId, db);
  if (row.status !== "OPEN") {
    throw new AppError(
      409,
      `An invoice that is ${invoiceStanding(row)} cannot be written off.`,
      "NOT_OPEN",
    );
  }
  const invoicing = connectors().invoicing;
  const marked = await atProvider(() =>
    invoicing.markUncollectible(row.providerInvoiceId!, row.id),
  );
  return viewOf(await apply(row, marked, `staff:${args.staffId}`, {}, args.note, db));
}

/** Read the invoice again from the provider and bring our row in line. */
export async function syncInvoice(
  args: { readonly invoiceId: string; readonly cause: string },
  db: Db = prisma,
): Promise<InvoiceView> {
  const row = await invoiceRow(args.invoiceId, db);
  if (!row.providerInvoiceId) {
    throw new AppError(
      409,
      "The provider never answered for this draft. Draft it again first.",
      "NOT_AT_PROVIDER",
    );
  }
  const invoicing = connectors().invoicing;
  const p = await atProvider(() => invoicing.retrieveInvoice(row.providerInvoiceId!));
  if (!p) {
    throw new AppError(502, "The provider holds no such invoice.", "INVOICING_PROVIDER", {
      providerCode: "resource_missing",
    });
  }
  return viewOf(await apply(row, p, args.cause, {}, null, db));
}

export interface InvoiceLink {
  readonly hostedUrl: string;
  readonly pdfUrl: string | null;
}

/**
 * Where the invoice is viewed and paid, read fresh. `servicerId` narrows
 * it to one servicer's own invoices; an id that belongs to another is a
 * 404 like one that belongs to nobody.
 */
export async function invoiceLink(
  args: { readonly invoiceId: string; readonly servicerId?: string },
  db: Db = prisma,
): Promise<InvoiceLink> {
  const row = await db.billingInvoice.findUnique({ where: { id: args.invoiceId } });
  if (!row || (args.servicerId !== undefined && row.servicerId !== args.servicerId)) {
    throw new AppError(404, "No such invoice.", "NOT_FOUND");
  }
  if (row.status === "DRAFT" || row.status === "VOID" || !row.providerInvoiceId) {
    // To a servicer a draft does not exist yet; to staff it has no page.
    if (args.servicerId !== undefined) throw new AppError(404, "No such invoice.", "NOT_FOUND");
    throw new AppError(409, "A draft has no page to open. Send it first.", "NO_LINK");
  }
  const invoicing = connectors().invoicing;
  const p = await atProvider(() => invoicing.retrieveInvoice(row.providerInvoiceId!));
  if (!p?.hostedUrl) {
    throw new AppError(502, "The provider has no page for this invoice.", "INVOICING_PROVIDER");
  }
  return { hostedUrl: p.hostedUrl, pdfUrl: p.pdfUrl };
}

/* ── what the servicer's own team sees ───────────────────────────────────── */

export interface MemberInvoice {
  readonly id: string;
  readonly month: string;
  readonly number: string | null;
  readonly standing: Exclude<InvoiceStandingWord, "draft" | "void">;
  readonly amountCents: string;
  readonly amountRemainingCents: string;
  /** What has been credited back against it, summed over the notes issued. */
  readonly creditedCents: string;
  readonly dueAt: string | null;
  readonly sentAt: string | null;
  readonly paidAt: string | null;
}

/**
 * The invoices a servicer has actually been issued, by month. A draft is
 * ours until it is sent and a voided one was withdrawn, so neither is
 * theirs to see.
 */
export async function memberInvoices(
  servicerId: string,
  db: Db = prisma,
): Promise<MemberInvoice[]> {
  const rows = await db.billingInvoice.findMany({
    where: { servicerId, status: { in: ["OPEN", "PAID", "UNCOLLECTIBLE"] } },
    include: {
      ...WITH_MONTH,
      creditNotes: { where: { status: "ISSUED" }, select: { amountCents: true } },
    },
    orderBy: { statement: { month: "desc" } },
  });
  return rows.map((r) => {
    const v = viewOf(r);
    return {
      id: v.id,
      month: v.month,
      number: v.number,
      standing: v.standing as MemberInvoice["standing"],
      amountCents: v.amountCents,
      amountRemainingCents: v.amountRemainingCents,
      creditedCents: r.creditNotes.reduce((n, c) => n + c.amountCents, 0n).toString(),
      dueAt: v.dueAt,
      sentAt: v.sentAt,
      paidAt: v.paidAt,
    };
  });
}

/* ── credit notes ────────────────────────────────────────────────────────── */

export type CreditNoteStandingWord = "pending" | "issued" | "void";

export interface CreditNoteView {
  readonly id: string;
  readonly invoiceId: string;
  readonly number: string | null;
  readonly standing: CreditNoteStandingWord;
  /** False while our row waits for the provider to answer. */
  readonly atProvider: boolean;
  readonly providerCreditNoteId: string | null;
  readonly amountCents: string;
  readonly reason: CreditNoteReason;
  readonly memo: string;
  readonly settlement: BillingCreditSettlement;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly issuedAt: string | null;
  readonly voidedAt: string | null;
  readonly voidedBy: string | null;
}

const noteView = (n: BillingCreditNote): CreditNoteView => ({
  id: n.id,
  invoiceId: n.invoiceId,
  number: n.number,
  standing: n.status.toLowerCase() as CreditNoteStandingWord,
  atProvider: n.providerCreditNoteId !== null,
  providerCreditNoteId: n.providerCreditNoteId,
  amountCents: n.amountCents.toString(),
  reason: n.reason as CreditNoteReason,
  memo: n.memo,
  settlement: n.settlement,
  createdAt: n.createdAt.toISOString(),
  createdBy: n.createdBy,
  issuedAt: day(n.issuedAt),
  voidedAt: day(n.voidedAt),
  voidedBy: n.voidedBy,
});

const CREDIT_REASONS: readonly CreditNoteReason[] = [
  "duplicate",
  "fraudulent",
  "order_change",
  "product_unsatisfactory",
];

const SETTLEMENT_OF: Record<CreditNoteSettlement, BillingCreditSettlement> = {
  customer_balance: "CUSTOMER_BALANCE",
  refund: "REFUND",
  out_of_band: "OUT_OF_BAND",
};
const SETTLEMENT_WORD: Partial<Record<BillingCreditSettlement, CreditNoteSettlement>> = {
  CUSTOMER_BALANCE: "customer_balance",
  REFUND: "refund",
  OUT_OF_BAND: "out_of_band",
};

/** Every credit note on an invoice, newest first. */
export async function listCreditNotes(
  invoiceId: string,
  db: Db = prisma,
): Promise<CreditNoteView[]> {
  const rows = await db.billingCreditNote.findMany({
    where: { invoiceId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(noteView);
}

/** What the provider says onto our note. */
async function applyCreditNote(
  note: BillingCreditNote,
  p: ProviderCreditNote,
  db: Db,
): Promise<BillingCreditNote> {
  return db.billingCreditNote.update({
    where: { id: note.id },
    data: {
      providerCreditNoteId: p.id,
      number: p.number,
      status: p.status === "void" ? "VOID" : "ISSUED",
      livemode: p.livemode,
      issuedAt: note.issuedAt ?? new Date(p.createdAt),
      voidedAt: instant(p.voidedAt),
      lastSyncedAt: new Date(),
    },
  });
}

/** Ask the provider for a note our row already describes, and write back what it answered. */
async function issueAtProvider(
  note: BillingCreditNote,
  invoice: BillingInvoice,
  db: Db,
): Promise<BillingCreditNote> {
  const invoicing = connectors().invoicing;
  const p = await invoicing.issueCreditNote({
    creditNoteId: note.id,
    providerInvoiceId: invoice.providerInvoiceId!,
    amountCents: note.amountCents,
    reason: note.reason as CreditNoteReason,
    memo: note.memo,
    description: `Credit against invoice ${invoice.number ?? invoice.id}`,
    settlement: SETTLEMENT_WORD[note.settlement] ?? null,
    metadata: { hm_invoice_id: invoice.id, hm_servicer_id: invoice.servicerId },
  });
  return applyCreditNote(note, p, db);
}

/** Bring every note we hold on an invoice in line with the provider. */
async function syncCreditNotesOf(invoiceId: string, cause: string, db: Db): Promise<void> {
  void cause;
  const invoicing = connectors().invoicing;
  const notes = await db.billingCreditNote.findMany({
    where: { invoiceId, providerCreditNoteId: { not: null } },
  });
  for (const note of notes) {
    const p = await invoicing.retrieveCreditNote(note.providerCreditNoteId!);
    if (p) await applyCreditNote(note, p, db);
  }
}

/** A line in the invoice's history that is not a change of status: a credit issued or voided. */
async function noteInHistory(
  invoice: BillingInvoice,
  cause: string,
  note: string,
  db: Db,
): Promise<void> {
  await db.billingInvoiceTransition.create({
    data: {
      invoiceId: invoice.id,
      fromStatus: invoice.status,
      toStatus: invoice.status,
      cause,
      note,
    },
  });
}

export interface IssueCreditNoteArgs {
  readonly invoiceId: string;
  readonly amountCents: bigint;
  readonly reason: CreditNoteReason;
  readonly memo: string;
  /** Required on a paid invoice; must be absent on an open one. */
  readonly settlement: CreditNoteSettlement | null;
  readonly staffId: string;
}

/**
 * Issue a credit note. On an open invoice it lowers what is due, and at
 * nothing the invoice is paid; on a paid invoice it is settled the one way
 * asked. Our row is written first, then the provider is asked under the
 * row's id; a provider that does not answer leaves the row pending, and
 * the reconciliation asks again.
 */
export async function issueCreditNote(
  args: IssueCreditNoteArgs,
  db: Db = prisma,
): Promise<CreditNoteView> {
  const invoice = await invoiceRow(args.invoiceId, db);
  if (!invoice.providerInvoiceId || invoice.status === "DRAFT" || invoice.status === "VOID") {
    throw new AppError(
      409,
      `An invoice that is ${invoiceStanding(invoice)} cannot be credited; a credit corrects one that was sent.`,
      "NOT_CREDITABLE",
    );
  }
  if (!CREDIT_REASONS.includes(args.reason)) {
    throw new AppError(400, `A reason is one of ${CREDIT_REASONS.join(", ")}.`, "BAD_REASON");
  }
  const paid = invoice.status === "PAID";
  if (paid && args.settlement === null) {
    throw new AppError(
      409,
      "A credit on a paid invoice has to say how it is settled: the customer's balance, a refund, or a wire made outside Stripe.",
      "SETTLEMENT_REQUIRED",
    );
  }
  if (!paid && args.settlement !== null) {
    throw new AppError(
      409,
      "A credit on an open invoice lowers what is due; it is not settled.",
      "SETTLEMENT_NOT_ALLOWED",
    );
  }
  // What is already credited: an issued note is in the provider's own
  // figures for an open invoice and not for a paid one; a pending note is
  // in neither yet, and counts against both.
  const [issued, pending] = await Promise.all([
    db.billingCreditNote.aggregate({
      where: { invoiceId: invoice.id, status: "ISSUED" },
      _sum: { amountCents: true },
    }),
    db.billingCreditNote.aggregate({
      where: { invoiceId: invoice.id, status: "PENDING" },
      _sum: { amountCents: true },
    }),
  ]);
  const pendingCents = pending._sum.amountCents ?? 0n;
  const ceiling = paid
    ? invoice.amountPaidCents - (issued._sum.amountCents ?? 0n) - pendingCents
    : invoice.amountRemainingCents - pendingCents;
  if (args.amountCents <= 0n || args.amountCents > ceiling) {
    throw new AppError(
      409,
      `A credit on this invoice is between $0.01 and ${dollars(ceiling)}.`,
      "BAD_CREDIT_AMOUNT",
      { ceilingCents: ceiling.toString() },
    );
  }
  const row = await db.billingCreditNote.create({
    data: {
      invoiceId: invoice.id,
      servicerId: invoice.servicerId,
      provider: invoice.provider,
      livemode: invoice.livemode,
      status: "PENDING",
      amountCents: args.amountCents,
      reason: args.reason,
      memo: args.memo,
      settlement: args.settlement === null ? "REDUCES_AMOUNT_DUE" : SETTLEMENT_OF[args.settlement],
      createdBy: args.staffId,
    },
  });
  const cause = `staff:${args.staffId}`;
  const issuedNote = await atProvider(() => issueAtProvider(row, invoice, db));
  await noteInHistory(
    invoice,
    cause,
    `credit note ${issuedNote.number ?? issuedNote.id} issued for ${dollars(args.amountCents)}: ${args.memo}`,
    db,
  );
  // The invoice follows: less due, or paid at nothing.
  await syncInvoice({ invoiceId: invoice.id, cause }, db);
  return noteView(issuedNote);
}

/** Void a credit note. The provider allows it only while the invoice is still open. */
export async function voidCreditNote(
  args: { readonly creditNoteId: string; readonly staffId: string; readonly reason: string },
  db: Db = prisma,
): Promise<CreditNoteView> {
  const note = await db.billingCreditNote.findUnique({
    where: { id: args.creditNoteId },
    include: { invoice: true },
  });
  if (!note) throw new AppError(404, "No such credit note.", "NOT_FOUND");
  if (note.status !== "ISSUED" || !note.providerCreditNoteId) {
    throw new AppError(
      409,
      `A credit note that is ${note.status.toLowerCase()} cannot be voided.`,
      "NOT_VOIDABLE",
    );
  }
  if (note.invoice.status !== "OPEN") {
    throw new AppError(
      409,
      "A credit note can be voided only while its invoice is open; once the invoice is paid, the credit stands.",
      "NOT_VOIDABLE",
    );
  }
  const invoicing = connectors().invoicing;
  const p = await atProvider(() => invoicing.voidCreditNote(note.providerCreditNoteId!, note.id));
  const updated = await db.billingCreditNote.update({
    where: { id: note.id },
    data: {
      status: p.status === "void" ? "VOID" : "ISSUED",
      voidedAt: instant(p.voidedAt) ?? new Date(),
      voidedBy: args.staffId,
      lastSyncedAt: new Date(),
    },
  });
  const cause = `staff:${args.staffId}`;
  await noteInHistory(
    note.invoice,
    cause,
    `credit note ${note.number ?? note.id} voided: ${args.reason}`,
    db,
  );
  await syncInvoice({ invoiceId: note.invoiceId, cause }, db);
  return noteView(updated);
}

/** The note's PDF, read fresh. `servicerId` narrows it to a servicer's own; a stranger's is a 404. */
export async function creditNoteLink(
  args: { readonly creditNoteId: string; readonly servicerId?: string },
  db: Db = prisma,
): Promise<{ readonly pdfUrl: string }> {
  const note = await db.billingCreditNote.findUnique({ where: { id: args.creditNoteId } });
  if (
    !note ||
    (args.servicerId !== undefined && note.servicerId !== args.servicerId) ||
    !note.providerCreditNoteId
  ) {
    throw new AppError(404, "No such credit note.", "NOT_FOUND");
  }
  const invoicing = connectors().invoicing;
  const p = await atProvider(() => invoicing.retrieveCreditNote(note.providerCreditNoteId!));
  if (!p?.pdfUrl)
    throw new AppError(502, "The provider has no PDF for this credit note.", "INVOICING_PROVIDER");
  return { pdfUrl: p.pdfUrl };
}

/* ── the provider's deliveries ───────────────────────────────────────────── */

export type EventOutcome = "applied" | "duplicate" | "not_ours" | "ignored" | "deferred";

/**
 * Act on one inbox row: read the invoice it is about from the provider and
 * bring ours in line. A failure is written on the row and left for the
 * reconciliation; it is never thrown at the provider, which would only
 * redeliver what we already hold.
 */
async function processEvent(
  row: {
    id: string;
    eventId: string;
    type: string;
    providerInvoiceId: string | null;
    providerCreatedAt: Date;
  },
  db: Db,
): Promise<EventOutcome> {
  const done = (outcome: EventOutcome) =>
    db.billingProviderEvent
      .update({
        where: { id: row.id },
        data: { processedAt: new Date(), outcome, lastError: null },
      })
      .then(() => outcome);
  try {
    if (!row.providerInvoiceId) return await done("ignored");
    const invoicing = connectors().invoicing;
    const p = await invoicing.retrieveInvoice(row.providerInvoiceId);
    if (!p) return await done("not_ours");
    // Ours by the provider's id, or by the id we stamped on it when the
    // provider's id never made it back to our row.
    const ours =
      (await db.billingInvoice.findUnique({ where: { providerInvoiceId: p.id } })) ??
      (p.metadata.hm_invoice_id
        ? await db.billingInvoice.findFirst({
            where: { id: p.metadata.hm_invoice_id, providerInvoiceId: null },
          })
        : null);
    if (!ours) return await done("not_ours");
    const extra: Prisma.BillingInvoiceUpdateInput =
      row.type === "invoice.sent" && ours.sentAt === null ? { sentAt: row.providerCreatedAt } : {};
    await apply(ours, p, `event:${row.eventId}`, extra, row.type, db);
    // A credit note's event: bring every note we hold on the invoice in line too.
    if (row.type.startsWith("credit_note."))
      await syncCreditNotesOf(ours.id, `event:${row.eventId}`, db);
    return await done("applied");
  } catch (err) {
    await db.billingProviderEvent.update({
      where: { id: row.id },
      data: {
        attempts: { increment: 1 },
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      },
    });
    return "deferred";
  }
}

const EVENT_SELECT = {
  id: true,
  eventId: true,
  type: true,
  providerInvoiceId: true,
  providerCreatedAt: true,
  processedAt: true,
} as const;

/**
 * Take a delivery: verify it, keep it, act on it. The verification throws
 * (`InvoicingSignatureError`, `InvoicingNotConfiguredError`) and the route
 * answers those; everything after the row is written answers 2xx, because
 * the event is ours now and a redelivery would add nothing.
 */
export async function receiveProviderEvent(
  rawBody: Buffer,
  signature: string | undefined,
  db: Db = prisma,
): Promise<{ readonly eventId: string; readonly outcome: EventOutcome }> {
  const invoicing = connectors().invoicing;
  const event: InvoicingEvent = invoicing.readEvent(rawBody, signature);
  const provider = providerKey(invoicing);
  let row;
  try {
    row = await db.billingProviderEvent.create({
      data: {
        provider,
        eventId: event.id,
        type: event.type,
        livemode: event.livemode,
        apiVersion: event.apiVersion,
        providerCreatedAt: new Date(event.createdAt),
        providerInvoiceId: event.invoiceId,
      },
      select: EVENT_SELECT,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const held = await db.billingProviderEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider, eventId: event.id } },
      select: EVENT_SELECT,
    });
    // Seen and done: a redelivery is a no-op. Seen and not done: try again.
    if (held.processedAt !== null) return { eventId: event.id, outcome: "duplicate" };
    row = held;
  }
  return { eventId: event.id, outcome: await processEvent(row, db) };
}

/* ── the reconciliation ──────────────────────────────────────────────────── */

export interface ReconcileReport {
  readonly events: {
    readonly retried: number;
    readonly settled: number;
    readonly stillFailing: number;
  };
  readonly invoices: {
    readonly checked: number;
    readonly changed: number;
    readonly failed: number;
  };
  /** Pending notes asked for again, and issued notes on open invoices re-read. */
  readonly creditNotes: { readonly retried: number; readonly checked: number };
  /** Rows the provider never answered for, older than a quarter of an hour. */
  readonly stranded: readonly string[];
}

/** A paid invoice is re-read for this long, because a payment can be taken back. */
const PAID_WATCH_DAYS = 35;
/** An event that has failed this many times is left for a person. */
const MAX_EVENT_ATTEMPTS = 20;

/**
 * The backstop for everything a delivery can miss: retry the inbox, then
 * read every invoice that can still move and bring its row in line.
 * Deliveries are retried by the provider for three days; this is what
 * makes the fourth day safe.
 */
export async function reconcileInvoices(
  opts: { readonly now?: Date } = {},
  db: Db = prisma,
): Promise<ReconcileReport> {
  const now = opts.now ?? new Date();
  const pending = await db.billingProviderEvent.findMany({
    where: { processedAt: null, attempts: { lt: MAX_EVENT_ATTEMPTS } },
    orderBy: { receivedAt: "asc" },
    select: EVENT_SELECT,
  });
  let settled = 0;
  for (const row of pending) if ((await processEvent(row, db)) !== "deferred") settled += 1;

  const since = new Date(now.getTime() - PAID_WATCH_DAYS * 86_400_000);
  const moving = await db.billingInvoice.findMany({
    where: {
      providerInvoiceId: { not: null },
      OR: [
        { status: { in: ["DRAFT", "OPEN", "UNCOLLECTIBLE"] } },
        { status: "PAID", paidAt: { gte: since } },
      ],
    },
  });
  const invoicing = connectors().invoicing;
  let changed = 0;
  let failed = 0;
  for (const row of moving) {
    try {
      const p = await invoicing.retrieveInvoice(row.providerInvoiceId!);
      if (!p) {
        failed += 1;
        continue;
      }
      const before = row.status;
      const after = await apply(row, p, "reconcile", {}, null, db);
      if (after.status !== before) changed += 1;
    } catch {
      failed += 1;
    }
  }

  // Credit notes: a pending one is asked for again under the same id, and
  // an issued one on an invoice still open is re-read, since it could have
  // been voided at the provider.
  let notesRetried = 0;
  const pendingNotes = await db.billingCreditNote.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(now.getTime() - 60_000) } },
    include: { invoice: true },
  });
  for (const note of pendingNotes) {
    try {
      await issueAtProvider(note, note.invoice, db);
      notesRetried += 1;
    } catch {
      failed += 1;
    }
  }
  const openNotes = await db.billingCreditNote.findMany({
    where: { status: "ISSUED", providerCreditNoteId: { not: null }, invoice: { status: "OPEN" } },
  });
  for (const note of openNotes) {
    try {
      const p = await invoicing.retrieveCreditNote(note.providerCreditNoteId!);
      if (p) await applyCreditNote(note, p, db);
    } catch {
      failed += 1;
    }
  }

  const stranded = await db.billingInvoice.findMany({
    where: {
      providerInvoiceId: null,
      status: "DRAFT",
      createdAt: { lt: new Date(now.getTime() - 15 * 60_000) },
    },
    select: { id: true },
  });
  return {
    events: { retried: pending.length, settled, stillFailing: pending.length - settled },
    invoices: { checked: moving.length, changed, failed },
    creditNotes: { retried: notesRetried, checked: openNotes.length },
    stranded: stranded.map((r) => r.id),
  };
}
