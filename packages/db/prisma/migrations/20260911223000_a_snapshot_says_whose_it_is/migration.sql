-- A vendor report has to say whose it is.
--
-- `connector_snapshots` is keyed to the loan file and nothing else. That was
-- sufficient while every file had exactly one borrower, and it stops being
-- sufficient the moment one does not: a bank report, a credit report and a set
-- of tax transcripts on a two-person file would all be evidence about somebody,
-- with nothing on the row saying who. Desktop Underwriter links a verification
-- to a borrower by arc, so a submission cannot be assembled from rows that
-- cannot answer it.
--
-- Cheap now for exactly the reason it is urgent later: every file today has one
-- borrower, so the backfill is unambiguous. It will not be.
ALTER TABLE "connector_snapshots" ADD COLUMN "party_id" UUID;

-- CASCADE, matching the file side. A snapshot is append-only evidence and
-- nothing here rewrites one, so the alternative — SET NULL on a party's
-- deletion — would be this table's only mutation, and it would turn "we removed
-- your data" into a row that still holds the vendor's payload about a person
-- whose name has just been deleted. Account deletion already takes the files
-- first (`users_delete_takes_files`), so by the time a party goes its snapshots
-- are gone with the file; this edge is what covers a party deleted any other
-- way.
ALTER TABLE "connector_snapshots"
    ADD CONSTRAINT "connector_snapshots_party_id_fkey"
    FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "connector_snapshots_party" ON "connector_snapshots" ("party_id");

-- ─── Which kinds are about a person, and which about an address ─────────────
--
-- This is the guard split the connector ports already draw, written down where
-- the evidence lands: anything keyed on an address is unguarded and belongs to
-- no party; anything keyed on a person is guarded and must name one. Screen 1
-- runs before there is a borrower at all, so demanding a party of a property
-- lookup would make the flow unreachable from its own first step.
--
-- Backfill only the person-keyed kinds, from the file's single borrower.
UPDATE "connector_snapshots" s
SET "party_id" = b."party_id"
FROM "borrowers" b
WHERE b."loan_file_id" = s."loan_file_id"
  AND s."kind" IN ('credit', 'bank', 'payroll', 'irs', 'sanctions');

-- And refuse to finish if that left one behind. A person-keyed snapshot with no
-- party is the exact row this migration exists to make impossible, and the
-- trigger below only sees writes — it cannot repair what is already here. Better
-- to stop a deploy than to install a rule the existing rows do not keep.
DO $$
DECLARE orphaned INT;
BEGIN
    SELECT count(*) INTO orphaned
    FROM "connector_snapshots"
    WHERE "kind" IN ('credit', 'bank', 'payroll', 'irs', 'sanctions')
      AND "party_id" IS NULL;
    IF orphaned > 0 THEN
        RAISE EXCEPTION
            '% person-keyed snapshots have no borrower to attribute them to; resolve them before this migration can be applied', orphaned;
    END IF;
END $$;

-- The rule, on writes.
--
-- An unrecognized kind RAISES rather than being waved through. A new kind is a
-- decision about whether it is about a person, and a default of "no party" is
-- the silent wrong answer for every person-keyed one — which is how this table
-- came to hold five kinds of evidence about a borrower with no borrower on it.
-- The cost is that adding a kind takes a migration. That is the intent.
CREATE OR REPLACE FUNCTION "connector_snapshots_say_whose_they_are"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."kind" IN ('credit', 'bank', 'payroll', 'irs', 'sanctions') THEN
        IF NEW."party_id" IS NULL THEN
            RAISE EXCEPTION
                'a % snapshot is evidence about a person and must name the party it is about', NEW."kind";
        END IF;
    ELSIF NEW."kind" IN ('property_record', 'valuation', 'flood', 'lien_search') THEN
        IF NEW."party_id" IS NOT NULL THEN
            RAISE EXCEPTION
                'a % snapshot is keyed on an address, not a person, and must not name a party', NEW."kind";
        END IF;
    ELSE
        RAISE EXCEPTION
            'unrecognized snapshot kind %; decide whether it is about a person or about an address and add it to connector_snapshots_say_whose_they_are', NEW."kind";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "connector_snapshots_say_whose_they_are_insert"
    BEFORE INSERT ON "connector_snapshots"
    FOR EACH ROW
    EXECUTE FUNCTION "connector_snapshots_say_whose_they_are"();

COMMENT ON COLUMN "connector_snapshots"."party_id" IS
    'Whose report this is. Required for person-keyed kinds, forbidden for address-keyed ones, enforced by connector_snapshots_say_whose_they_are.';
