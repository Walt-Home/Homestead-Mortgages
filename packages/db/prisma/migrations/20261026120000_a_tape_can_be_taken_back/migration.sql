-- A tape can be taken back, and the taking back is a record.
--
-- On 26 October 2026 a re-exported copy of a tape already on production's
-- book was loaded beside it. Its loan numbers had been stored in scientific
-- notation ("1.002027994E9"), so none matched the loans the first copy made
-- and 245 loans were made twice. The only duplicate check was the files'
-- own bytes, which a re-export changes. Two things land here:
--
--   partner_book_imports.tape_filename        the names the files were loaded
--   partner_book_imports.supplement_filename  under, so a person reading the
--                                             book's tapes can say which file
--                                             each one was; null for a row
--                                             from before the columns
--   partner_book_removals                     one row per tape taken back:
--                                             what it was, what went with it
--                                             and who said so, and why;
--                                             append-only, because the import
--                                             row it describes is gone
--
-- The removal names the import by id with no foreign key: the import row is
-- deleted in the same transaction that writes this one, and a key to it
-- would refuse the deletion it records. See docs/decisions.md, "A tape can
-- be taken back, and a loan number is digits".

ALTER TABLE "partner_book_imports"
    ADD COLUMN "tape_filename" TEXT,
    ADD COLUMN "supplement_filename" TEXT;

CREATE TABLE "partner_book_removals" (
    "id"                   UUID NOT NULL,
    "servicer_id"          UUID NOT NULL,
    "import_id"            UUID NOT NULL,
    "as_of"                DATE NOT NULL,
    "tape_sha256"          TEXT NOT NULL,
    "tape_filename"        TEXT,
    "rows_total"           INTEGER NOT NULL,
    "loans_created"        INTEGER NOT NULL,
    "loans_removed"        INTEGER NOT NULL,
    "observations_removed" INTEGER NOT NULL,
    "reviews_removed"      INTEGER NOT NULL,
    "parties_removed"      INTEGER NOT NULL,
    "balance_cents"        BIGINT NOT NULL,
    "reason"               TEXT NOT NULL,
    "removed_by"           TEXT NOT NULL,
    "removed_by_name"      TEXT,
    "removed_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_book_removals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "partner_book_removals_counts_not_negative"
        CHECK ("rows_total" >= 0 AND "loans_created" >= 0 AND "loans_removed" >= 0
               AND "observations_removed" >= 0 AND "reviews_removed" >= 0
               AND "parties_removed" >= 0 AND "balance_cents" >= 0),
    CONSTRAINT "partner_book_removals_reason_is_said"
        CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);

-- A tape is taken back once: its import row is gone after the first.
CREATE UNIQUE INDEX "partner_book_removals_once_per_import"
    ON "partner_book_removals" ("import_id");

CREATE INDEX "partner_book_removals_servicer_removed_at"
    ON "partner_book_removals" ("servicer_id", "removed_at");

ALTER TABLE "partner_book_removals"
    ADD CONSTRAINT "partner_book_removals_servicer_id_fkey"
    FOREIGN KEY ("servicer_id") REFERENCES "servicers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- UPDATE and DELETE both, the way apor_fetches is: the row is the only
-- trace of the tape it describes, so nothing may rewrite it or take it away.
CREATE OR REPLACE FUNCTION partner_book_removals_are_a_record() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'partner_book_removals is a record (% on %); a tape taken back stays taken back', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER partner_book_removals_are_a_record
  BEFORE UPDATE OR DELETE ON "partner_book_removals"
  FOR EACH ROW EXECUTE FUNCTION partner_book_removals_are_a_record();
