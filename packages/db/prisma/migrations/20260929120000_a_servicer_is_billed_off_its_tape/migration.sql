-- A servicer is billed off its tape.
--
-- The price sheet (version 1.0, 28 September 2026) says a monitored loan on
-- a partner's book consumes the self-improving mortgage row — per $100,000
-- of unpaid principal balance per loan-month — and offer touches, from the
-- day it is loaded. The month-close job meters every servicer's book once
-- the month has ended and keeps one row per servicer per month, never
-- updated: a statement that was invoiced must not change under a later
-- tape. The annual token pool is the sheet's commitment, recorded when
-- somebody sets it. See docs/decisions.md, "A servicer is billed off its
-- tape".
ALTER TABLE "servicers" ADD COLUMN "annual_token_pool" BIGINT;

CREATE TABLE "billing_statements" (
    "id" UUID NOT NULL,
    "servicer_id" UUID NOT NULL,
    "month" DATE NOT NULL,
    "sheet_version" TEXT NOT NULL,
    "loans_billed" INTEGER NOT NULL,
    "loan_months" DECIMAL(12,2) NOT NULL,
    "balance_cents" BIGINT NOT NULL,
    "tokens" BIGINT NOT NULL,
    "cents" BIGINT NOT NULL,
    "statement" JSONB NOT NULL,
    "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by" TEXT NOT NULL,

    CONSTRAINT "billing_statements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "billing_statements_one_per_servicer_month" ON "billing_statements"("servicer_id", "month");
CREATE INDEX "billing_statements_month" ON "billing_statements"("month");

ALTER TABLE "billing_statements" ADD CONSTRAINT "billing_statements_servicer_id_fkey" FOREIGN KEY ("servicer_id") REFERENCES "servicers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A month is billed on the first of the month, and only ever the first: the
-- unique index above is one row per servicer per month only if every row
-- names its month the same way.
ALTER TABLE "billing_statements" ADD CONSTRAINT "billing_statements_month_is_first_day"
    CHECK (EXTRACT(DAY FROM "month") = 1);

-- UPDATE only. DELETE stays open the way it does on du_responses: a servicer
-- removed for good takes its statements with it by hand. The promise kept is
-- the narrower one that matters — a closed statement may not be rewritten
-- in place, because it is what was invoiced.
CREATE OR REPLACE FUNCTION "billing_statements_are_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'billing_statements row % may not be updated; a closed statement is what was invoiced, and a corrected month is a credit on the next one',
        OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "billing_statements_are_append_only_update"
    BEFORE UPDATE ON "billing_statements"
    FOR EACH ROW
    EXECUTE FUNCTION "billing_statements_are_append_only"();
