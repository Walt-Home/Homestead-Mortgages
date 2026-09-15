-- A file carries a whole quoted product, or none of one.
--
-- `loan_files` had no CHECK constraint at all, and the three product columns
-- were independently nullable. That let a row exist with a product code, a
-- term, and a NULL note rate — which is not a hypothetical: an adapter that
-- answers without the field, the ordinary vendor-mapping bug, writes exactly
-- that row. It reads back as a product quoted at zero percent, and zero does
-- not read as missing anywhere downstream. It amortizes. The engine records
-- the payment as a derivation with a formula beside it, no input is blocked,
-- and a $332,000 loan at no interest arrives at the decision looking computed.
--
-- The promise this commit is about is that no rate a vendor did not quote
-- reaches a decision. The service refuses such a quote and the repository
-- refuses such a row, and both of those are code that the next writer can
-- forget. The row is written here, so the promise is kept here.
--
-- How the loan amortizes is not in the group and is not on this table. It
-- labels the product rather than being a figure anything computes from, so it
-- sits on `loan_products` with the other six characteristics a submission
-- states about the loan being applied for.
ALTER TABLE "loan_files"
    ADD COLUMN "rate_quote_lock_days" INTEGER,
    ADD COLUMN "rate_quoted_at" TIMESTAMP(3),
    ADD COLUMN "rate_quote_expires_at" TIMESTAMP(3);

COMMENT ON COLUMN "loan_files"."rate_quote_lock_days" IS
    'Which lock column of the sheet the note rate came off. Not a lock: nothing here locks a rate.';
COMMENT ON COLUMN "loan_files"."rate_quoted_at" IS
    'When the vendor published the sheet this rate came off.';
COMMENT ON COLUMN "loan_files"."rate_quote_expires_at" IS
    'When the vendor stops standing behind the rate. Recorded, not enforced.';

-- Nothing has written a partial product — every writer sets all three together
-- — so there is nothing to repair before the constraint goes on. A row that
-- somehow held one would fail the ALTER rather than be quietly corrected,
-- which is the right way round: a half-quoted file is a thing somebody has to
-- look at.
ALTER TABLE "loan_files"
    ADD CONSTRAINT "loan_files_quote_a_whole_product_or_none" CHECK (
        (
            "product_code" IS NULL
            AND "term_months" IS NULL
            AND "note_rate" IS NULL
        )
        OR (
            "product_code" IS NOT NULL
            AND "term_months" IS NOT NULL
            AND "note_rate" IS NOT NULL
            AND "term_months" > 0
            AND "note_rate" > 0
        )
    );
