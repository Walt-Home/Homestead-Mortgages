-- A credit note corrects an invoice.
--
-- An invoice that has been sent is never edited, and one that has been
-- paid is never voided: the correction is a credit note, issued by a named
-- admin with a reason the customer reads. On an open invoice it lowers
-- what is due; on a paid one it is settled — to the customer's balance,
-- as a refund through the provider, or by a wire made outside it. PENDING
-- is ours alone: the row is written before the provider is asked, so a
-- provider that did not answer is asked again under the same id. See
-- docs/decisions.md, "An invoice is the provider's to collect and ours to
-- decide".
CREATE TYPE "BillingCreditNoteStatus" AS ENUM ('PENDING', 'ISSUED', 'VOID');
CREATE TYPE "BillingCreditSettlement" AS ENUM ('REDUCES_AMOUNT_DUE', 'CUSTOMER_BALANCE', 'REFUND', 'OUT_OF_BAND');

CREATE TABLE "billing_credit_notes" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "servicer_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "provider_credit_note_id" TEXT,
    "number" TEXT,
    "status" "BillingCreditNoteStatus" NOT NULL DEFAULT 'PENDING',
    "amount_cents" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "memo" TEXT NOT NULL,
    "settlement" "BillingCreditSettlement" NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_at" TIMESTAMP(3),
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,
    "last_synced_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_credit_notes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_credit_notes_provider_credit_note_id_key" ON "billing_credit_notes"("provider_credit_note_id");
CREATE INDEX "billing_credit_notes_invoice" ON "billing_credit_notes"("invoice_id");
CREATE INDEX "billing_credit_notes_servicer" ON "billing_credit_notes"("servicer_id");

ALTER TABLE "billing_credit_notes" ADD CONSTRAINT "billing_credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "billing_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A credit is for something.
ALTER TABLE "billing_credit_notes" ADD CONSTRAINT "billing_credit_notes_amount_positive"
    CHECK ("amount_cents" > 0);
