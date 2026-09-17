-- A link belongs to a person.
--
-- `connector_links` said which sources a FILE had connected — one row per
-- (file, kind) — which was true for as long as a file held one borrower. A
-- co-borrower connecting their own bank is a second link of the same kind on
-- the same file, and the unique index refused it, so a co-borrower could not
-- link a bank at all. The snapshots a link produces already say whose they
-- are (`connector_snapshots.party_id`); this gives the link the same column.
--
-- Backfilled from Borrower 1 — the party at the lowest position on the
-- file's application, or the oldest borrower row where there is no
-- application — because every link written so far was the applicant's: the
-- routes resolved the subject by the session, and the applicant held the only
-- session on a joint file. Nullable, because a link keyed on an address would
-- have no person, though none exists today.
ALTER TABLE "connector_links" ADD COLUMN "party_id" UUID;

UPDATE "connector_links" l
   SET "party_id" = COALESCE(
     (SELECT ap."party_id"
        FROM "application_parties" ap
        JOIN "applications" a ON a."id" = ap."application_id"
       WHERE a."loan_file_id" = l."loan_file_id" AND ap."borrower_ordinal" IS NOT NULL
       ORDER BY ap."borrower_ordinal" ASC
       LIMIT 1),
     (SELECT b."party_id"
        FROM "borrowers" b
       WHERE b."loan_file_id" = l."loan_file_id"
       ORDER BY b."created_at" ASC, b."id" ASC
       LIMIT 1)
   );

ALTER TABLE "connector_links"
  ADD CONSTRAINT "connector_links_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "connector_links_loan_file_id_kind_key";
CREATE UNIQUE INDEX "connector_links_one_per_person_and_kind"
    ON "connector_links" ("loan_file_id", "kind", "party_id");
CREATE INDEX "connector_links_party" ON "connector_links" ("party_id");
