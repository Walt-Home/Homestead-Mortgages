-- Two kinds of income under one element name, and the arc that tells them apart.
--
-- CURRENT_INCOME_ITEM carries employment income and everything else in the same
-- element, discriminated by EmploymentIncomeIndicator, and only the employment
-- kind is associated with an EMPLOYER. We had the arc -- `employer_id` -- and no
-- discriminator, so the two facts could never disagree because only one of them
-- was written down. This column writes the other one and the CHECK below binds
-- them, which is what makes the association derivable from the row rather than
-- separately stored, and what makes employment income with no employer to point
-- at impossible to write.

ALTER TABLE "income_sources"
  ADD COLUMN "employment_income" BOOLEAN NOT NULL DEFAULT false;
UPDATE "income_sources" SET "employment_income" = ("employer_id" IS NOT NULL);

-- The CHECK is incompatible with the ON DELETE SET NULL this edge carried.
-- Deleting an employer made Postgres run `UPDATE ONLY income_sources SET
-- employer_id = NULL WHERE $1 = employer_id`, which violates the CHECK and
-- aborts the delete from inside the referential update -- with a check-
-- constraint error naming neither the employer nor whoever was trying to remove
-- it. Narrowing the edge rather than weakening the CHECK is what keeps the
-- biconditional, and the biconditional is the whole reason the discriminator
-- exists: a one-directional `NOT employment_income OR employer_id IS NOT NULL`
-- would survive the SET NULL and leave a row free to say it is not employment
-- income while pointing at an employer.
--
-- THE WAY OUT OF RESTRICT IS REPOINT, NOT RETIREMENT. RESTRICT tests for the
-- EXISTENCE of a referencing row and `retired_at` never clears `employer_id`,
-- so retiring an income row and then deleting its employer still raises.
-- Whoever dedups two employer rows, merges two parties (`parties`.
-- `merged_into_party_id` exists) or applies a vendor correction does it in ONE
-- transaction: UPDATE every `income_sources.employer_id` AND every
-- `employments.employer_id` naming the losing employer -- live and retired rows
-- alike, because RESTRICT does not care which -- onto the survivor, and only
-- then DELETE the loser. Retired rows move too, on purpose: a retired income is
-- still evidence about a job, and a job that turned out to be one employer
-- under two names is one job in the history as well. `employments.employer_id`
-- is still ON DELETE SET NULL and would not raise, which is exactly why it has
-- to be in the writer's list rather than left to referential integrity -- the
-- delete would succeed and quietly blank the employer on every employment row
-- that named the loser. Its unique key `employments_file_party_employer_key`
-- is what a repoint can collide with, one person holding two rows for what
-- turns out to be one employer, so the repoint merges those two rows rather
-- than updating both.
--
-- DELETING A PERSON IS NOT A REPOINT AND DOES NOT NEED ONE. A party is the
-- parent of both tables -- `employers.party_id` and `income_sources.party_id`
-- are each ON DELETE CASCADE -- so one DELETE fires both, and RESTRICT is
-- checked at the end of the statement that fired them rather than inside the
-- cascade that deleted the employer. Measured on Postgres 16.13, both ways
-- round: the employers cascade fires FIRST here, and the delete still succeeds,
-- because the check is queued behind the sibling cascade that removes the
-- income; recreating the employers foreign key so its trigger sorts last
-- reverses the firing order and changes nothing. So this does not rest on
-- trigger-name ordering, and the deletion promise does not need a trigger to
-- state an order. What RESTRICT does refuse on that path is a party whose
-- employer SOMEBODY ELSE's income still names -- a row no writer here makes,
-- and one that should refuse, because the alternative is another person's
-- income with no employer. `deletion.test.ts` holds both halves.
ALTER TABLE "income_sources"
  DROP CONSTRAINT "income_sources_employer_id_fkey",
  ADD CONSTRAINT "income_sources_employer_id_fkey"
    FOREIGN KEY ("employer_id") REFERENCES "employers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "income_sources_employment_income_has_an_employer" CHECK (
    "employment_income" = ("employer_id" IS NOT NULL)
  );

-- ─── What is NOT enforced here, and why ─────────────────────────────────────
--
-- Two constraints this migration does NOT add, on one rule: a uniqueness or
-- count constraint keyed on something the writer does not control is a lockout.
-- Both would have been keyed on vendor output.
--
-- (a) A partial unique index on (loan_file_id, party_id, type) for
-- non-employment rows. DU supports a single instance of an IncomeType per
-- borrower, but that is a rule about the SERIALIZED IncomeType, after mapping,
-- not about these ingest rows: our `type` vocabulary includes `rental`,
-- `investment`, `dividend` and `retirement`, and two rental properties or two
-- brokerage accounts are two rows of one type for one party on one file, from a
-- payload we do not choose. The second insert would be refused on a table whose
-- unique key (loan_file_id, party_id, identity_key) was picked precisely so a
-- re-pull MATCHES rather than collides. The collapse to DU IncomeTypes is where
-- that rule can be applied and where the aggregation DU wants is expressible.
--
-- (b) A count trigger capping employers at ten. The wire cap is ten per
-- borrower PER SUBMISSION, and `employers` is keyed to the PARTY on purpose --
-- an employer is a thing in the world, and the same person's second application
-- is about the same job. The table accumulates over a lifetime, has no
-- `retired_at`, and is written by vendor pulls through name-key matching that
-- can collide, so the eleventh job a person ever holds -- or eleven rows from
-- three name collisions -- would make the payroll ingest throw. A cap on INGEST
-- is a lockout; the cap belongs on what is emitted.

COMMENT ON COLUMN "income_sources"."employment_income" IS
    'EmploymentIncomeIndicator. True exactly when the row names an employer, so the association DU reads is derivable from the row and cannot disagree with it.';
