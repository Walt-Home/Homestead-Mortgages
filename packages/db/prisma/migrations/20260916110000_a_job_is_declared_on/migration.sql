-- A job is declared on, by the person whose job it is.
--
-- Desktop Underwriter requires three things about every current employment
-- that `employments` did not hold: whether the borrower is self-employed or
-- owns the business (URLA 1b.9), whether they are employed by a family member,
-- the property seller, a real estate agent or another party to the transaction
-- (URLA 1b.8), and whether the job is their primary or a secondary one. The
-- third is derived — the current job carrying the most employment income is
-- primary — and needs no column. The first two are the borrower's own
-- statements, the same class of answer as Section 5, and they get the same
-- treatment: asked, stored with who said it and when, never derived. A payroll
-- pull can say what a job pays; it cannot say whether the employer is the
-- seller.
--
-- Null is unasked. Both answers and the time come together, held by a CHECK,
-- so a row cannot carry half a declaration. The principal who said it is
-- nullable on its own: a deleted account takes its principal row, and the
-- answers a real person gave about a real job outlive the sign-in that gave
-- them, the same way `assets_asserted_by_principal_id` is swept rather than
-- restricted. A job that a later pull adds arrives unasked, which is right —
-- nobody has answered for it yet.
ALTER TABLE "employments"
    ADD COLUMN "self_employed" BOOLEAN,
    ADD COLUMN "employed_by_party_to_transaction" BOOLEAN,
    ADD COLUMN "declared_by_principal_id" UUID,
    ADD COLUMN "declared_at" TIMESTAMP(3);

ALTER TABLE "employments"
    ADD CONSTRAINT "employments_declared_by_principal_id_fkey"
        FOREIGN KEY ("declared_by_principal_id") REFERENCES "principals"("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT "employments_a_declaration_is_whole" CHECK (
        ("self_employed" IS NULL) = ("employed_by_party_to_transaction" IS NULL)
        AND ("self_employed" IS NULL) = ("declared_at" IS NULL)
        AND ("declared_by_principal_id" IS NULL OR "declared_at" IS NOT NULL)
    );

CREATE INDEX "employments_declared_by" ON "employments"("declared_by_principal_id");

COMMENT ON COLUMN "employments"."self_employed" IS
    'URLA 1b.9, the borrower''s own answer. Null is unasked, never no.';
COMMENT ON COLUMN "employments"."employed_by_party_to_transaction" IS
    'URLA 1b.8: employed by a family member, the property seller, a real estate agent or another party to the transaction. Null is unasked, never no.';
