-- An invoice is issued and followed.
--
-- A closed statement says what a servicer's book consumed. This is what
-- turns it into money: who the servicer is when it is billed, the invoice
-- a payment provider issues for the statement, the history of where that
-- invoice has stood, and the inbox for what the provider tells us. Our
-- meter stays the source of truth for the amount; every status here was
-- read from the provider. See docs/decisions.md, "An invoice is the
-- provider's to collect and ours to decide".

-- Who a servicer is when it is invoiced. Every detail nullable: nothing is
-- guessed, and an invoice cannot be drafted until what it needs is there.
CREATE TABLE "servicer_billing_profiles" (
    "servicer_id" UUID NOT NULL,
    "legal_name" TEXT,
    "billing_email" TEXT,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "city" TEXT,
    "state" VARCHAR(2),
    "postal_code" TEXT,
    "country" VARCHAR(2) NOT NULL DEFAULT 'US',
    "ein" TEXT,
    "net_days" INTEGER,
    "purchase_order" TEXT,
    "provider" TEXT,
    "provider_customer_id" TEXT,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servicer_billing_profiles_pkey" PRIMARY KEY ("servicer_id")
);

CREATE UNIQUE INDEX "servicer_billing_profiles_provider_customer_id_key" ON "servicer_billing_profiles"("provider_customer_id");

ALTER TABLE "servicer_billing_profiles" ADD CONSTRAINT "servicer_billing_profiles_servicer_id_fkey" FOREIGN KEY ("servicer_id") REFERENCES "servicers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A customer id names the provider that minted it, and a provider is named
-- only with the id it minted.
ALTER TABLE "servicer_billing_profiles" ADD CONSTRAINT "servicer_billing_profiles_provider_pair"
    CHECK (("provider" IS NULL) = ("provider_customer_id" IS NULL));

-- Terms are a number of days a contract could say, never a negative one.
ALTER TABLE "servicer_billing_profiles" ADD CONSTRAINT "servicer_billing_profiles_net_days_sane"
    CHECK ("net_days" IS NULL OR ("net_days" >= 0 AND "net_days" <= 365));

CREATE TYPE "BillingInvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');

CREATE TABLE "billing_invoices" (
    "id" UUID NOT NULL,
    "statement_id" UUID NOT NULL,
    "servicer_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "provider_customer_id" TEXT NOT NULL,
    "provider_invoice_id" TEXT,
    "number" TEXT,
    "status" "BillingInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "amount_cents" BIGINT NOT NULL,
    "amount_due_cents" BIGINT NOT NULL,
    "amount_paid_cents" BIGINT NOT NULL DEFAULT 0,
    "amount_remaining_cents" BIGINT NOT NULL,
    "net_days" INTEGER NOT NULL,
    "due_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "sent_by" TEXT,
    "paid_at" TIMESTAMP(3),
    "paid_out_of_band" BOOLEAN NOT NULL DEFAULT false,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,
    "uncollectible_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_invoices_provider_invoice_id_key" ON "billing_invoices"("provider_invoice_id");
CREATE UNIQUE INDEX "billing_invoices_statement_attempt" ON "billing_invoices"("statement_id", "attempt");
CREATE INDEX "billing_invoices_servicer" ON "billing_invoices"("servicer_id");
CREATE INDEX "billing_invoices_status" ON "billing_invoices"("status");

-- One live invoice per statement. A voided invoice frees the statement to
-- be issued again; anything else holds it, so two people pressing the
-- button is one invoice and an insert conflict.
CREATE UNIQUE INDEX "billing_invoices_one_live_per_statement" ON "billing_invoices"("statement_id") WHERE "status" <> 'VOID';

ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "billing_statements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_servicer_id_fkey" FOREIGN KEY ("servicer_id") REFERENCES "servicers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An invoice is for something. A month that consumed nothing has no invoice.
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_amount_positive"
    CHECK ("amount_cents" > 0 AND "attempt" >= 1);

CREATE TABLE "billing_invoice_transitions" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "from_status" "BillingInvoiceStatus",
    "to_status" "BillingInvoiceStatus" NOT NULL,
    "cause" TEXT NOT NULL,
    "note" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_invoice_transitions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "billing_invoice_transitions_invoice_at" ON "billing_invoice_transitions"("invoice_id", "at");

ALTER TABLE "billing_invoice_transitions" ADD CONSTRAINT "billing_invoice_transitions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "billing_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The history is what happened; it is added to and never rewritten.
CREATE OR REPLACE FUNCTION "billing_invoice_transitions_are_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'billing_invoice_transitions row % may not be updated; the history of an invoice is added to, never rewritten',
        OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "billing_invoice_transitions_are_append_only_update"
    BEFORE UPDATE ON "billing_invoice_transitions"
    FOR EACH ROW
    EXECUTE FUNCTION "billing_invoice_transitions_are_append_only"();

CREATE TABLE "billing_provider_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "api_version" TEXT,
    "provider_created_at" TIMESTAMP(3) NOT NULL,
    "provider_invoice_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "outcome" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "billing_provider_events_pkey" PRIMARY KEY ("id")
);

-- One row per event, which is what makes a redelivery a no-op.
CREATE UNIQUE INDEX "billing_provider_events_once" ON "billing_provider_events"("provider", "event_id");
CREATE INDEX "billing_provider_events_unprocessed" ON "billing_provider_events"("processed_at");
