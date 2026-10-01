-- An invoice is approved by one admin and sent by another.
--
-- Joe, 1 October 2026: Drew approves and Doug sends. The console has one
-- role and the servicing app never names a staff member's e-mail, so the
-- rule the database keeps is the structural one — whoever approved an
-- invoice is not the one who sent it — and the names are recorded beside
-- the ids so the history reads as people. The same day settled who issues
-- the invoice (Tomorrow OS Inc. dba Supermortgage) and under which terms;
-- both are copied onto the row at draft time, so what a servicer was sent
-- is kept even if the issuer's data changes. Rows from before this exist
-- on staging with neither an approval nor an issuer, which is why the
-- columns are nullable and the two-person rule is "if approved". See
-- docs/decisions.md, "An invoice is the provider's to collect and ours to
-- decide".
ALTER TABLE "billing_invoices"
    ADD COLUMN "issuer_name" TEXT,
    ADD COLUMN "terms_url" TEXT,
    ADD COLUMN "created_by_name" TEXT,
    ADD COLUMN "approved_at" TIMESTAMP(3),
    ADD COLUMN "approved_by" TEXT,
    ADD COLUMN "approved_by_name" TEXT,
    ADD COLUMN "sent_by_name" TEXT;

-- An approval is whole: when, and by whom.
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_approval_whole"
    CHECK (("approved_at" IS NULL) = ("approved_by" IS NULL));

-- Whoever approved did not send. (That it was approved before it was sent
-- is the service's rule; the rows from before approval existed were sent
-- without one.)
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_two_people"
    CHECK ("approved_by" IS NULL OR "sent_by" IS NULL OR "sent_by" <> "approved_by");

-- The history names the person, not only the id.
ALTER TABLE "billing_invoice_transitions" ADD COLUMN "actor_name" TEXT;
