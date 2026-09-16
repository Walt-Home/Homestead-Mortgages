-- The existing payment says what it is.
--
-- `existing_monthly_payment` has two possible sources and they mean different
-- things. A borrower or a mortgage statement gives principal and interest. A
-- credit bureau gives the SCHEDULED payment, which on an escrowed loan carries
-- taxes and insurance as well — and the net tangible benefit test (APP-019)
-- subtracts the new loan's P&I from this figure, so treating a scheduled
-- payment as P&I overstates the monthly saving by the entire old escrow,
-- understates the recoup, and passes a refinance that fails it.
--
-- Nullable with no backfill on purpose. Nothing in this database knows what an
-- already-written payment was, and inventing a basis for it would be the
-- assumption this column exists to stop. NULL blocks APP-019, which refers the
-- file — the honest state until a statement or the borrower answers.
--
-- `existing_rate` is already nullable and needs no migration; the credit route
-- stops writing 0 into it in the same commit.
ALTER TABLE "loan_files" ADD COLUMN "existing_payment_basis" TEXT;

ALTER TABLE "loan_files"
  ADD CONSTRAINT "loan_files_existing_payment_basis_check"
  CHECK (
    "existing_payment_basis" IS NULL
    OR "existing_payment_basis" IN ('principal_and_interest', 'scheduled_payment')
  );

COMMENT ON COLUMN "loan_files"."existing_payment_basis" IS
  'What existing_monthly_payment is: the principal and interest the borrower stated or a statement shows, or the scheduled payment a credit bureau reported, which may carry escrow. NULL is unknown and blocks APP-019.';
