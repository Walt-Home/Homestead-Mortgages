-- A housing basis has one home, and it is not this column.
--
-- `du_residences` is the source of truth for where a borrower lives, on what
-- basis, and for what rent. These two columns on `borrowers` become derived
-- copies of it.
--
-- The DEFAULT and the NOT NULL come off together, in the same commit that stops
-- the three writers manufacturing `'rent'`. Either half on its own is worse than
-- neither: dropping the default over a NOT NULL column turns every borrower
-- insert that stops supplying a value into a 500, and dropping neither leaves
-- Postgres supplying an answer to a question the four screens never ask.
ALTER TABLE "borrowers"
    ALTER COLUMN "current_housing" DROP NOT NULL,
    ALTER COLUMN "current_housing" DROP DEFAULT;

-- Rows that already carry the fabrication KEEP it.
--
-- Every existing value was asserted rather than asked, so blanking them would be
-- truer. It would also change what `packages/requirements` sees on files already
-- in flight, which is a question about the engine and not a question a migration
-- gets to answer on its way past. What this migration stops is NEW rows being
-- fabricated.

-- The mapping is explicit and there is no ELSE.
--
-- `lower(basis::text)` would produce 'livingrentfree', which is in no vocabulary
-- this codebase has: `currentHousing` is "rent" | "own" | "rent_free", the route
-- enum says the same, and the engine tests only `=== "own"` — so a rent-free
-- borrower would be filed here as a renter and then have their next save
-- rejected there. A future `DuResidencyBasis` member must stop this migration
-- rather than write a word nothing downstream understands.
DO $$
DECLARE stray TEXT;
BEGIN
    SELECT string_agg(DISTINCT basis::text, ', ') INTO stray FROM "du_residences"
     WHERE basis::text NOT IN ('Own', 'Rent', 'LivingRentFree');
    IF stray IS NOT NULL THEN
        RAISE EXCEPTION
            'du_residences carries a basis this migration cannot map to borrowers.current_housing: %', stray;
    END IF;
END $$;

UPDATE "borrowers" b
   SET current_housing = CASE r.basis::text
                             WHEN 'Own'            THEN 'own'
                             WHEN 'Rent'           THEN 'rent'
                             WHEN 'LivingRentFree' THEN 'rent_free'
                         END,
       monthly_rent    = (r.monthly_rent_cents::numeric / 100)
  FROM "du_residences" r
  JOIN "application_parties" ap ON ap.id = r.application_party_id
  JOIN "applications" a ON a.id = ap.application_id
 WHERE a.loan_file_id = b.loan_file_id
   AND ap.party_id = b.party_id
   AND r.residency_type = 'Current';

COMMENT ON COLUMN "borrowers"."current_housing" IS
    'DERIVED from du_residences.basis, which is the source of truth. NULL means nobody has been asked yet.';

COMMENT ON COLUMN "borrowers"."monthly_rent" IS
    'DERIVED from du_residences.monthly_rent_cents. Cents are the storage; this is a display copy in dollars.';

-- ─── A borrower with any residence row has a CURRENT one ───────────────────
--
-- The column above is derived from the Current residence. Without this, a set
-- carrying only a Prior residence is legal: the writer replaces the whole set,
-- finds no current row to derive from, and leaves `borrowers.current_housing`
-- stating a basis whose source row no longer exists. That is the drift this
-- table was added to end, arriving through the table itself.
--
-- DEFERRABLE, checked at COMMIT, for the same reason the bankruptcy-chapter
-- trigger is: answering again deletes every row and writes the new set, so
-- there is an instant mid-transaction when the borrower has no residence at
-- all. A row-immediate check would refuse the correction rather than the error.
--
-- A borrower with NO residence rows is untouched -- that is a borrower who has
-- not answered, which is the state every file is in today.
CREATE OR REPLACE FUNCTION du_residences_current_home_present(edge UUID) RETURNS void AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "du_residences" WHERE application_party_id = edge)
       AND NOT EXISTS (
           SELECT 1 FROM "du_residences"
            WHERE application_party_id = edge AND residency_type = 'Current'
       ) THEN
        RAISE EXCEPTION
            'application_party % carries residences but none is Current; borrowers.current_housing is derived from that row',
            edge;
    END IF;
END; $$ LANGUAGE plpgsql;

-- Both edges, because an UPDATE can move a row from one borrower to another and
-- strip the Current row off the one it left.
CREATE OR REPLACE FUNCTION du_residences_keep_a_current_home() RETURNS trigger AS $$
BEGIN
    IF TG_OP <> 'DELETE' THEN PERFORM du_residences_current_home_present(NEW.application_party_id); END IF;
    IF TG_OP <> 'INSERT' THEN PERFORM du_residences_current_home_present(OLD.application_party_id); END IF;
    RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER du_residences_keep_a_current_home
    AFTER INSERT OR UPDATE OR DELETE ON "du_residences"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION du_residences_keep_a_current_home();
