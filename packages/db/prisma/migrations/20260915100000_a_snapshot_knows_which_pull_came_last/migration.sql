-- Which of two pulls came last, when the vendor timestamps them the same.
--
-- `connector_snapshots` is append-only and has no `retired_at`, so "the report
-- that stands" is a decision made over the history rather than a filter the
-- table can apply. The decision needs a latest, and `retrieved_at` alone cannot
-- give one: it is the vendor's moment, two pulls in the same millisecond tie,
-- and the only other column that could break the tie is a v4 uuid. A uuid tie
-- break is total and reproducible and it is also arbitrary — it picks the
-- larger random number, not the later report, and the thing being decided is
-- which vendor report a federal submission tells Desktop Underwriter to rely
-- on.
--
-- So the write order becomes a column. A sequence hands out a larger value to
-- whichever insert reaches the table second, which is exactly the question
-- `retrieved_at` cannot answer, and the unique index is what makes it decisive
-- rather than merely usually different.
--
-- `now()` would not have done: it is the transaction's start time, so two rows
-- written by one transaction carry the same one and the tie comes straight
-- back.
CREATE SEQUENCE "connector_snapshots_write_seq_seq" AS BIGINT;

ALTER TABLE "connector_snapshots" ADD COLUMN "write_seq" BIGINT;

-- Existing rows have no recoverable write order — the column is being added
-- after the fact — so they are numbered in the order the old rule already read
-- them. That leaves every selection this table has ever supported deciding
-- exactly as it did before, and every row written from here on carrying the
-- real answer.
UPDATE "connector_snapshots" s
SET "write_seq" = ordered."seq"
FROM (
    SELECT "id", row_number() OVER (ORDER BY "retrieved_at", "id") AS "seq"
    FROM "connector_snapshots"
) ordered
WHERE s."id" = ordered."id";

SELECT setval(
    '"connector_snapshots_write_seq_seq"',
    coalesce((SELECT max("write_seq") FROM "connector_snapshots"), 0) + 1,
    false
);

ALTER TABLE "connector_snapshots"
    ALTER COLUMN "write_seq" SET DEFAULT nextval('"connector_snapshots_write_seq_seq"');
ALTER TABLE "connector_snapshots" ALTER COLUMN "write_seq" SET NOT NULL;
ALTER SEQUENCE "connector_snapshots_write_seq_seq"
    OWNED BY "connector_snapshots"."write_seq";

CREATE UNIQUE INDEX "connector_snapshots_write_seq_key"
    ON "connector_snapshots" ("write_seq");

COMMENT ON COLUMN "connector_snapshots"."write_seq" IS
    'The order this row was written in. Breaks a retrieved_at tie between two pulls, so the later report wins rather than the larger uuid.';
