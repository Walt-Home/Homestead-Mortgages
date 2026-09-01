-- CreateEnum
CREATE TYPE "FlowStage" AS ENUM ('PROPERTY_LOAN', 'IDENTITY', 'CREDIT', 'BANK', 'PAYROLL', 'IRS_TRANSCRIPT', 'UPLOAD_FALLBACK', 'DECISION', 'PERSISTENT_CONSENT', 'COMPLETE');

-- CreateEnum
CREATE TYPE "LoanPurpose" AS ENUM ('PURCHASE', 'RATE_TERM_REFINANCE', 'CASH_OUT_REFINANCE');

-- CreateTable
CREATE TABLE "loan_files" (
    "id" UUID NOT NULL,
    "stage" "FlowStage" NOT NULL DEFAULT 'PROPERTY_LOAN',
    "purpose" "LoanPurpose",
    "loan_amount" DECIMAL(14,2),
    "down_payment" DECIMAL(14,2),
    "cash_to_borrower" DECIMAL(14,2),
    "cash_out_purpose" TEXT,
    "junior_lien_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "junior_lien_credit_limit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "interested_party_contributions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "property_line1" TEXT,
    "property_line2" TEXT,
    "property_city" TEXT,
    "property_state" VARCHAR(2),
    "property_postal_code" TEXT,
    "property_type" TEXT,
    "occupancy" TEXT,
    "value_or_price" DECIMAL(14,2),
    "valuation_source" TEXT,
    "address_verified" BOOLEAN NOT NULL DEFAULT false,
    "financed_property_count" INTEGER NOT NULL DEFAULT 1,
    "product_code" TEXT,
    "term_months" INTEGER,
    "amortization" TEXT,
    "note_rate" DECIMAL(6,4),
    "overlays" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "application_received_at" TIMESTAMP(3),
    "application_six_pieces" JSONB,
    "intent_to_proceed_at" TIMESTAMP(3),
    "delivery_method" TEXT NOT NULL DEFAULT 'electronic',
    "sanctions_screen_clear" BOOLEAN,
    "ssn_validated_with_ssa" BOOLEAN,
    "fraud_review_complete" BOOLEAN NOT NULL DEFAULT false,
    "existing_servicer" TEXT,
    "existing_loan_number" TEXT,
    "existing_balance" DECIMAL(14,2),
    "existing_rate" DECIMAL(6,4),
    "existing_monthly_payment" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loan_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "borrowers" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "ssn_last4" VARCHAR(4) NOT NULL,
    "ssn_vault_handle" TEXT NOT NULL,
    "address_line1" TEXT NOT NULL,
    "address_line2" TEXT,
    "address_city" TEXT NOT NULL,
    "address_state" VARCHAR(2) NOT NULL,
    "address_postal_code" TEXT NOT NULL,
    "marital_status" TEXT NOT NULL,
    "non_borrowing_spouse_name" TEXT,
    "non_borrowing_spouse_signature_required" BOOLEAN NOT NULL DEFAULT false,
    "preferred_language" TEXT NOT NULL DEFAULT 'en',
    "demographics" JSONB,
    "first_time_homebuyer" BOOLEAN,
    "is_military" BOOLEAN NOT NULL DEFAULT false,
    "current_housing" TEXT NOT NULL DEFAULT 'rent',
    "monthly_rent" DECIMAL(10,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "borrowers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "borrower_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "envelope_id" TEXT,
    "ip_address" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_links" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "linked_at" TIMESTAMP(3) NOT NULL,
    "last_synced_at" TIMESTAMP(3) NOT NULL,
    "persistent_monitoring_enabled" BOOLEAN NOT NULL DEFAULT false,
    "next_sync_due_at" TIMESTAMP(3),

    CONSTRAINT "connector_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_snapshots" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "raw" JSONB,
    "retrieved_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "income_sources" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "monthly_amount" DECIMAL(12,2) NOT NULL,
    "history_months" INTEGER NOT NULL,
    "continuance_end_date" DATE,
    "continuance_established" BOOLEAN,
    "evidence_document_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "income_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employments" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "employer_name" TEXT NOT NULL,
    "employer_ein" TEXT,
    "position" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" TEXT NOT NULL,
    "is_military" BOOLEAN NOT NULL DEFAULT false,
    "verification_method" TEXT NOT NULL,

    CONSTRAINT "employments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "storage_uri" TEXT NOT NULL,
    "satisfies_requirement_id" TEXT NOT NULL,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disclosures" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "delivered_at" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,

    CONSTRAINT "disclosures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,
    "aus_engine" TEXT NOT NULL,
    "aus_engine_version" TEXT NOT NULL,
    "aus_casefile_id" TEXT NOT NULL,
    "aus_recommendation" TEXT NOT NULL,
    "aus_findings" JSONB NOT NULL,
    "ratios" JSONB NOT NULL,
    "reserves" JSONB NOT NULL,
    "compliance" JSONB NOT NULL,
    "pricing" JSONB NOT NULL,
    "derivations" JSONB NOT NULL,
    "adverse_action_reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loan_conditions" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "requirement_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "owner" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "cleared_at" TIMESTAMP(3),
    "document_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "loan_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_events" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "requirement_id" TEXT,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,

    CONSTRAINT "file_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loan_files_stage_idx" ON "loan_files"("stage");

-- CreateIndex
CREATE INDEX "loan_files_created_at_idx" ON "loan_files"("created_at");

-- CreateIndex
CREATE INDEX "borrowers_loan_file_id_idx" ON "borrowers"("loan_file_id");

-- CreateIndex
CREATE INDEX "consents_loan_file_id_kind_idx" ON "consents"("loan_file_id", "kind");

-- CreateIndex
CREATE INDEX "connector_links_persistent_monitoring_enabled_next_sync_due_idx" ON "connector_links"("persistent_monitoring_enabled", "next_sync_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "connector_links_loan_file_id_kind_key" ON "connector_links"("loan_file_id", "kind");

-- CreateIndex
CREATE INDEX "connector_snapshots_loan_file_id_kind_retrieved_at_idx" ON "connector_snapshots"("loan_file_id", "kind", "retrieved_at");

-- CreateIndex
CREATE INDEX "income_sources_loan_file_id_idx" ON "income_sources"("loan_file_id");

-- CreateIndex
CREATE INDEX "employments_loan_file_id_idx" ON "employments"("loan_file_id");

-- CreateIndex
CREATE INDEX "documents_loan_file_id_satisfies_requirement_id_idx" ON "documents"("loan_file_id", "satisfies_requirement_id");

-- CreateIndex
CREATE INDEX "disclosures_loan_file_id_kind_idx" ON "disclosures"("loan_file_id", "kind");

-- CreateIndex
CREATE INDEX "decisions_loan_file_id_computed_at_idx" ON "decisions"("loan_file_id", "computed_at");

-- CreateIndex
CREATE INDEX "loan_conditions_loan_file_id_status_idx" ON "loan_conditions"("loan_file_id", "status");

-- CreateIndex
CREATE INDEX "file_events_loan_file_id_occurred_at_idx" ON "file_events"("loan_file_id", "occurred_at");

-- CreateIndex
CREATE INDEX "file_events_kind_occurred_at_idx" ON "file_events"("kind", "occurred_at");

-- AddForeignKey
ALTER TABLE "borrowers" ADD CONSTRAINT "borrowers_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_borrower_id_fkey" FOREIGN KEY ("borrower_id") REFERENCES "borrowers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_links" ADD CONSTRAINT "connector_links_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_snapshots" ADD CONSTRAINT "connector_snapshots_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employments" ADD CONSTRAINT "employments_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disclosures" ADD CONSTRAINT "disclosures_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_conditions" ADD CONSTRAINT "loan_conditions_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_events" ADD CONSTRAINT "file_events_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
