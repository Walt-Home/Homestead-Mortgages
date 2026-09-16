-- A co-borrower is named before they arrive.
--
-- The applicant names a co-borrower by name and email and nothing else. The
-- co-borrower completes their own profile and gives their own permissions —
-- their date of birth, their address, their Social Security number are theirs
-- to state, in their own session, and the applicant never types them. That is
-- the product's design (a separate, private application per person), and it
-- is also the only shape under which the second person's identity is asserted
-- by the person it is about.
--
-- So a `borrowers` row now exists for a person who has not stated their SSN
-- yet. `ssn_last4` was NOT NULL because every row used to be written by
-- screen 2 in one save; a named co-borrower has no last four until they
-- arrive. Nullable, and the projection reads NULL as "not yet stated" for a
-- party nobody has claimed, and as the invariant violation it always was for
-- a party somebody has.
ALTER TABLE "borrowers" ALTER COLUMN "ssn_last4" DROP NOT NULL;

COMMENT ON COLUMN "borrowers"."ssn_last4" IS
    'Display only; the number itself is in the vault. NULL for a co-borrower who has been named but has not completed their own profile yet.';
