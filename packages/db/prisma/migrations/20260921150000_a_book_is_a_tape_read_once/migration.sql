-- A book is a tape, read once.
--
-- The first writer the loan model has had. A servicer's tape becomes one
-- import row, and every loan on it becomes either a new imported_unclaimed
-- loan or a new observation on the loan the last tape made. Three things
-- land here:
--
--   loans.servicer_loan_number    how the next tape finds a row again, unique
--                                 per servicer, null for a loan we originated
--   partner_book_imports          one row per tape read; the same two files
--                                 land once; append-only
--   servicing_observations        what the servicer said a loan looked like on
--                                 a date; append-only, like a snapshot, and
--                                 for the same reason: "your situation
--                                 changed" is a diff between two of these
--
-- Delinquency is a column on the observation and never a loan state. The rate
-- is kept to the thousandth of a percent, because a note is quoted in eighths
-- and the loan's integer-bps column cannot hold one; that column rounds.

ALTER TABLE "loans" ADD COLUMN "servicer_loan_number" TEXT;

CREATE UNIQUE INDEX "loans_one_per_servicer_number"
    ON "loans" ("servicer_id", "servicer_loan_number");

CREATE TYPE "ServicingStatus" AS ENUM ('CURRENT', 'DELINQUENT', 'PAID_OFF', 'CHARGED_OFF', 'MATURED', 'TRANSFERRED');

CREATE TABLE "partner_book_imports" (
    "id"                UUID NOT NULL,
    "servicer_id"       UUID NOT NULL,
    "principal_id"      UUID NOT NULL,
    "as_of"             DATE NOT NULL,
    "profile"           TEXT NOT NULL,
    "tape_sha256"       TEXT NOT NULL,
    "supplement_sha256" TEXT NOT NULL DEFAULT '',
    "rows_total"        INTEGER NOT NULL,
    "rows_loaded"       INTEGER NOT NULL,
    "rows_rejected"     INTEGER NOT NULL,
    "loans_created"     INTEGER NOT NULL,
    "loans_updated"     INTEGER NOT NULL,
    "loans_unchanged"   INTEGER NOT NULL,
    "parties_created"   INTEGER NOT NULL,
    "report"            JSONB NOT NULL,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_book_imports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "partner_book_imports_counts_add_up"
        CHECK ("rows_loaded" + "rows_rejected" <= "rows_total"
               AND "loans_created" + "loans_updated" + "loans_unchanged" = "rows_loaded")
);

CREATE UNIQUE INDEX "partner_book_imports_same_files_once"
    ON "partner_book_imports" ("servicer_id", "tape_sha256", "supplement_sha256");

CREATE INDEX "partner_book_imports_servicer_as_of"
    ON "partner_book_imports" ("servicer_id", "as_of");

ALTER TABLE "partner_book_imports"
    ADD CONSTRAINT "partner_book_imports_servicer_id_fkey"
    FOREIGN KEY ("servicer_id") REFERENCES "servicers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "partner_book_imports"
    ADD CONSTRAINT "partner_book_imports_principal_id_fkey"
    FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "servicing_observations" (
    "id"                      UUID NOT NULL,
    "loan_id"                 UUID NOT NULL,
    "import_id"               UUID NOT NULL,
    "as_of"                   DATE NOT NULL,
    "status"                  "ServicingStatus" NOT NULL,
    "principal_balance_cents" BIGINT NOT NULL,
    "escrow_balance_cents"    BIGINT,
    "scheduled_payment_cents" BIGINT,
    "current_rate_pct"        DECIMAL(6,3),
    "next_payment_due_on"     DATE,
    "delinquency_days"        INTEGER,
    "facts"                   JSONB NOT NULL,
    "record_hash"             TEXT NOT NULL,
    "recorded_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "servicing_observations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "servicing_observations_balance_not_negative"
        CHECK ("principal_balance_cents" >= 0),
    CONSTRAINT "servicing_observations_delinquency_not_negative"
        CHECK ("delinquency_days" IS NULL OR "delinquency_days" >= 0)
);

CREATE UNIQUE INDEX "servicing_observations_one_per_import"
    ON "servicing_observations" ("import_id", "loan_id");

CREATE INDEX "servicing_observations_loan_as_of"
    ON "servicing_observations" ("loan_id", "as_of");

-- CASCADE from the loan, as every row about a loan does; RESTRICT from the
-- import, because an observation that names an import that is gone is a
-- figure with no provenance.
ALTER TABLE "servicing_observations"
    ADD CONSTRAINT "servicing_observations_loan_id_fkey"
    FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "servicing_observations"
    ADD CONSTRAINT "servicing_observations_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "partner_book_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Both append-only, the way application_transitions is. No DELETE trigger on
-- the observation, deliberately: the cascade from a party through its loan is
-- what keeps "we remove your data for good" true, and it runs through here.
CREATE OR REPLACE FUNCTION partner_book_imports_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'partner_book_imports is append-only (% on %)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER partner_book_imports_append_only_update
  BEFORE UPDATE ON "partner_book_imports"
  FOR EACH ROW EXECUTE FUNCTION partner_book_imports_append_only();

CREATE OR REPLACE FUNCTION servicing_observations_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'servicing_observations is append-only (% on %)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER servicing_observations_append_only_update
  BEFORE UPDATE ON "servicing_observations"
  FOR EACH ROW EXECUTE FUNCTION servicing_observations_append_only();
