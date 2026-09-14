-- Four borrowers, in order, and a position that survives a round trip.
--
-- BORROWER is 1:4, and DU conveys Borrower 1 through 4 by document order and
-- label ordinal: no element states the position. Without a column the position
-- is whatever the serializer happened to iterate, it can differ between two
-- submissions of the same file, and `LOAN_DETAIL/BorrowerCount` has nothing to
-- agree with. Every route in the product puts exactly one borrowing party on an
-- application today, and only the seeded two-borrower household has a second,
-- so nothing has been wrong yet -- and nothing could have said which borrower
-- is Borrower 1 either.
--
-- The writer lands in this same commit, and it has to. `ensureApplicationParty`
-- inserted a role and nothing else, so from the moment the second CHECK below
-- exists every application creation -- every `POST /api/files`, every consent
-- that joins a party to an application, every persona seeded -- fails with
--
--   new row for relation "application_parties" violates check constraint
--   "application_parties_borrowers_are_numbered"
--
-- An earlier plan put the writer four commits later, which is four commits of
-- exactly that. A constraint and the code that can satisfy it are one change.

ALTER TABLE "application_parties" ADD COLUMN "borrower_ordinal" INTEGER;

-- Backfilled BEFORE the constraints, because they are not satisfiable without
-- it: every borrowing edge in the table carries a NULL ordinal and no
-- application has a Borrower 1. Shipping the constraints alone would leave the
-- label ordering resting on application convention, in the one design whose
-- thesis is that an invariant held by application code does not survive a new
-- route.
--
-- The primary borrower sorts first and the rest follow in the order they
-- joined -- which is the order every reader of this table has been using
-- without saying so.
UPDATE "application_parties" ap
   SET borrower_ordinal = o.n
  FROM (
    SELECT id, row_number() OVER (
             PARTITION BY application_id
             ORDER BY (role <> 'PRIMARY_BORROWER'), created_at, id
           ) AS n
      FROM "application_parties"
     WHERE role IN ('PRIMARY_BORROWER','CO_BORROWER','NON_OCCUPANT_CO_BORROWER')
  ) o
 WHERE ap.id = o.id;

-- An application already holding five borrowing parties took a 5 from the
-- backfill, and the CHECK below would then refuse it with a message naming no
-- row and no application -- on a migration, where the only thing to act on is
-- the message. Say which applications instead.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(DISTINCT application_id::text, ', ') INTO bad
    FROM "application_parties" WHERE borrower_ordinal > 4;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'BORROWER is 1:4 and these applications have more borrowing parties: %', bad;
  END IF;
END $$;

ALTER TABLE "application_parties"
  ADD CONSTRAINT "application_parties_borrower_ordinal_is_one_to_four" CHECK (
    "borrower_ordinal" IS NULL OR "borrower_ordinal" BETWEEN 1 AND 4
  ),
  -- Both directions, and the second half is the one with teeth. A
  -- non-borrowing role has no DU Borrower position because it emits no BORROWER
  -- element at all; a borrowing role MUST have one, because the label allocator
  -- and `BorrowerCount` read it and a NULL there is a borrower with no position
  -- in the document.
  ADD CONSTRAINT "application_parties_borrowers_are_numbered" CHECK (
    ("role" IN ('PRIMARY_BORROWER','CO_BORROWER','NON_OCCUPANT_CO_BORROWER'))
      = ("borrower_ordinal" IS NOT NULL)
  );

-- There is exactly one Borrower 1, and this index is created BEFORE the general
-- one below on purpose: a second Borrower 1 violates both, Postgres reports
-- whichever index it reaches first and it walks them in OID order, so the
-- message names the rule that was broken rather than a position collision that
-- could have been any of the four.
CREATE UNIQUE INDEX "application_parties_one_first_borrower"
  ON "application_parties" ("application_id") WHERE "borrower_ordinal" = 1;

-- And no two parties share a position. Partial rather than leaning on NULLs
-- being distinct from each other: the index is over positions, and a
-- non-borrowing edge has no position to put in it.
CREATE UNIQUE INDEX "application_parties_one_party_per_ordinal"
  ON "application_parties" ("application_id", "borrower_ordinal")
  WHERE "borrower_ordinal" IS NOT NULL;

COMMENT ON COLUMN "application_parties"."borrower_ordinal" IS
  'DU Borrower 1..4. A POSITION in one submitted document, not an identity -- application_parties.id is the identity -- which is why a freed ordinal is reused and the survivors are never renumbered.';
