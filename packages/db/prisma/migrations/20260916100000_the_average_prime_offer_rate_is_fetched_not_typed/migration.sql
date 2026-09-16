-- The average prime offer rate is fetched, not typed.
--
-- Three of the verdicts on a decision — General QM, HPML, HOEPA — are
-- comparisons against the average prime offer rate for the week the loan's rate
-- was set, and that rate is a weekly publication. Until now the engine compared
-- against rows typed into a source file. They were fixture data and said so,
-- and they were also wrong by fifty-five basis points the week this was
-- written, because a table nobody fetches is a table that was current on the
-- day somebody last typed it.
--
-- Two tables, both append-only, both in the shape of the thing they record.
--
-- `apor_fetches` is one row per document the CFPB served, of either kind: the
-- PUBLISHED fixed-rate table (YieldTableFixed.txt — the file the CFPB's own
-- rate-spread calculator reads, and the figure in force), and the weekly
-- survey the table is computed from (the cross-check). The body is stored
-- verbatim with the headers the server sent and a hash. A re-fetch of an
-- unchanged document inserts nothing, which is what makes a daily ingest safe.
--
-- `apor_weeks` is the published table on the terms this engine models: one
-- rate per (week, term) per fetch, taken from the published file and NOT
-- computed. Beside each rate, when the survey reaches that week, sit the survey
-- figures and what Appendix J makes of them — so the row itself says whether
-- the CFPB's published figure agrees with the CFPB's published method, and by
-- how much when it does not. It does not, by announcement, a few weeks a year;
-- `divergence_bps` is where that shows.
--
-- The CFPB updates the published file in place and it holds the figure in
-- force, so the latest fetch is the latest publication — and the ingest refuses
-- a document older than the newest one held, so that a stale copy served after
-- a newer one cannot walk the table backwards.
CREATE TABLE "apor_fetches" (
    "id"            UUID NOT NULL,
    "kind"          TEXT NOT NULL,
    "retrieved_at"  TIMESTAMP(3) NOT NULL,
    "provider"      TEXT NOT NULL,
    "source_url"    TEXT NOT NULL,
    "last_modified" TIMESTAMP(3),
    "etag"          TEXT,
    "sha256"        TEXT NOT NULL,
    "row_count"     INTEGER NOT NULL,
    "body"          TEXT NOT NULL,
    "write_seq"     BIGSERIAL NOT NULL,

    CONSTRAINT "apor_fetches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "apor_fetches_write_seq_key" UNIQUE ("write_seq"),
    CONSTRAINT "apor_fetches_are_one_of_two_kinds" CHECK ("kind" IN ('yield_table_fixed', 'survey')),
    CONSTRAINT "apor_fetches_have_rows" CHECK ("row_count" > 0)
);

COMMENT ON TABLE "apor_fetches" IS
    'One row per CFPB document served, verbatim: the published fixed-rate APOR table, or the weekly survey it is computed from. Append-only.';
COMMENT ON COLUMN "apor_fetches"."sha256" IS
    'Of the body as served. The identity of a publication; the same bytes are the same publication whatever the headers said.';

-- Not unique: the CFPB can restore an earlier file, and when it does that
-- file is the publication in force again. "Already held" means the same bytes
-- as the NEWEST fetch of the kind, which the ingest checks; the index is for
-- that lookup.
CREATE INDEX "apor_fetches_kind_and_sha" ON "apor_fetches"("kind", "sha256");

CREATE TABLE "apor_weeks" (
    "id"             UUID NOT NULL,
    "fetch_id"       UUID NOT NULL,
    "week_of"        DATE NOT NULL,
    "term_years"     INTEGER NOT NULL,
    "rate"           DECIMAL(6,3) NOT NULL,
    "survey_date"    DATE,
    "survey_rate"    DECIMAL(14,10),
    "survey_points"  DECIMAL(14,10),
    "computed_rate"  DECIMAL(6,3),
    "divergence_bps" INTEGER,
    "write_seq"      BIGSERIAL NOT NULL,

    CONSTRAINT "apor_weeks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "apor_weeks_fetch_id_fkey" FOREIGN KEY ("fetch_id")
        REFERENCES "apor_fetches"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "apor_weeks_one_rate_per_week_and_term_per_fetch" UNIQUE ("fetch_id", "week_of", "term_years"),
    CONSTRAINT "apor_weeks_write_seq_key" UNIQUE ("write_seq"),
    -- The FFIEC's week begins on a Monday. A survey, when one is recorded
    -- beside the rate, is dated on a Thursday and takes effect four days on.
    CONSTRAINT "apor_weeks_begin_on_a_monday" CHECK (EXTRACT(ISODOW FROM "week_of") = 1),
    CONSTRAINT "apor_weeks_survey_is_a_thursday" CHECK ("survey_date" IS NULL OR EXTRACT(ISODOW FROM "survey_date") = 4),
    CONSTRAINT "apor_weeks_survey_takes_effect_the_monday_after" CHECK ("survey_date" IS NULL OR "week_of" = "survey_date" + 4),
    -- The survey columns come as a set: the figures, what they compute to, and
    -- how far that is from what was published.
    CONSTRAINT "apor_weeks_survey_columns_come_together" CHECK (
        ("survey_date" IS NULL) = ("survey_rate" IS NULL)
        AND ("survey_date" IS NULL) = ("survey_points" IS NULL)
        AND ("survey_date" IS NULL) = ("computed_rate" IS NULL)
        AND ("survey_date" IS NULL) = ("divergence_bps" IS NULL)
    ),
    CONSTRAINT "apor_weeks_divergence_is_published_minus_computed" CHECK (
        "divergence_bps" IS NULL OR "divergence_bps" = ROUND(("rate" - "computed_rate") * 100)
    ),
    CONSTRAINT "apor_weeks_have_a_term" CHECK ("term_years" > 0),
    CONSTRAINT "apor_weeks_have_a_rate_that_is_a_rate" CHECK ("rate" >= 0.01 AND "rate" <= 25)
);

CREATE INDEX "apor_weeks_week_and_term" ON "apor_weeks"("week_of", "term_years");

COMMENT ON TABLE "apor_weeks" IS
    'The published APOR, one rate per (week, term) per fetch of the published table. The highest write_seq for a (week, term) is the rate in force. Append-only.';
COMMENT ON COLUMN "apor_weeks"."rate" IS
    'From the CFPB''s published table, not computed. The figure in force.';
COMMENT ON COLUMN "apor_weeks"."divergence_bps" IS
    'Published minus what Appendix J makes of the survey, in basis points. Zero on every week the CFPB followed its own method; the announced exceptions show here.';

-- Append-only is a fact the database keeps, not a comment. A decision cites the
-- fetch it read, and a row that could be edited is a citation to nothing.
CREATE OR REPLACE FUNCTION "apor_rows_are_a_record"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: a published rate is a record, and a correction is a new fetch', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "apor_fetches_are_a_record"
    BEFORE UPDATE OR DELETE ON "apor_fetches"
    FOR EACH ROW EXECUTE FUNCTION "apor_rows_are_a_record"();

CREATE TRIGGER "apor_weeks_are_a_record"
    BEFORE UPDATE OR DELETE ON "apor_weeks"
    FOR EACH ROW EXECUTE FUNCTION "apor_rows_are_a_record"();
