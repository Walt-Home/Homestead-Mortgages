-- The daily refinance review, written here.
--
-- One row per monitored loan per day: the verdict the ported engine
-- (@hm/refi-review, Doug's 33.2 over his 20.1) reached from the newest
-- servicing observation and the rate the pricing port quoted, with the
-- engine's facts and, for a candidate, the benefit disclosure. Append-only
-- like the observation it read: a day's verdict is a fact about that day.
CREATE TYPE "ReviewVerdict" AS ENUM ('CANDIDATE', 'WATCHING', 'NOT_NOW', 'EXCLUDED');

CREATE TABLE "loan_reviews" (
  "id" UUID NOT NULL,
  "loan_id" UUID NOT NULL,
  "as_of" DATE NOT NULL,
  "observation_id" UUID,
  "verdict" "ReviewVerdict" NOT NULL,
  "reasons" JSONB NOT NULL,
  "facts" JSONB NOT NULL,
  "offer" JSONB,
  "candidate_rate_pct" DECIMAL(6,3),
  "rate_source" TEXT,
  "rule_set_version" TEXT NOT NULL,
  "explanation" TEXT NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "loan_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "loan_reviews_one_per_loan_day" ON "loan_reviews"("loan_id", "as_of");
CREATE INDEX "loan_reviews_as_of" ON "loan_reviews"("as_of");

ALTER TABLE "loan_reviews" ADD CONSTRAINT "loan_reviews_loan_id_fkey"
  FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loan_reviews" ADD CONSTRAINT "loan_reviews_observation_id_fkey"
  FOREIGN KEY ("observation_id") REFERENCES "servicing_observations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A candidate carries its offer; nothing else does.
ALTER TABLE "loan_reviews" ADD CONSTRAINT "loan_reviews_offer_belongs_to_a_candidate"
  CHECK (("verdict" = 'CANDIDATE') = ("offer" IS NOT NULL));

-- Append-only, the way servicing_observations is.
CREATE OR REPLACE FUNCTION loan_reviews_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'loan_reviews is append-only (% on %)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loan_reviews_append_only_update
  BEFORE UPDATE ON "loan_reviews"
  FOR EACH ROW EXECUTE FUNCTION loan_reviews_append_only();
