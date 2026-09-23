-- An offer is a row and a card.
--
-- The daily review finds a candidate; this is what the candidate becomes.
-- One refi_offers row per candidate, carrying the review's benefit
-- disclosure as its own figures, open for thirty days from the moment it is
-- made — page-only delivery means the card on the person's loan page is the
-- notice, so there is no gap between ready and delivered. The person answers
-- once: yes opens a refinance application born from the loan, not now starts
-- the program's ninety-day cooldown, never is a standing "do not solicit".
-- Two per loan per twelve months, as his program has it; the engine reads
-- the offers to know. See docs/decisions.md, "An offer is a row and a card".

CREATE TYPE "RefiOfferStatus" AS ENUM ('OFFERED', 'ENGAGED', 'DECLINED', 'OPTED_OUT', 'EXPIRED');

CREATE TABLE "refi_offers" (
  "id" UUID NOT NULL,
  "loan_id" UUID NOT NULL,
  "review_id" UUID NOT NULL,
  "status" "RefiOfferStatus" NOT NULL DEFAULT 'OFFERED',
  "detected_on" DATE NOT NULL,
  "offered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "valid_until" TIMESTAMP(3) NOT NULL,
  "disclosure" JSONB NOT NULL,
  "candidate_rate_pct" DECIMAL(6,3) NOT NULL,
  "rate_source" TEXT,
  "answered_at" TIMESTAMP(3),
  "application_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "refi_offers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refi_offers_application_id_key" ON "refi_offers"("application_id");
CREATE INDEX "refi_offers_loan_offered" ON "refi_offers"("loan_id", "offered_at");
CREATE INDEX "refi_offers_status_valid_until" ON "refi_offers"("status", "valid_until");

ALTER TABLE "refi_offers" ADD CONSTRAINT "refi_offers_loan_id_fkey"
  FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT: an offer's figures are a review's, and the review stays.
ALTER TABLE "refi_offers" ADD CONSTRAINT "refi_offers_review_id_fkey"
  FOREIGN KEY ("review_id") REFERENCES "loan_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refi_offers" ADD CONSTRAINT "refi_offers_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One open offer per loan. Partial, so an ended offer stands beside the next
-- one; Prisma cannot model it, which is why it is here and not in the schema.
CREATE UNIQUE INDEX "refi_offers_one_open_per_loan" ON "refi_offers"("loan_id") WHERE "status" = 'OFFERED';

-- An answer is dated; an open or expired offer has none.
ALTER TABLE "refi_offers" ADD CONSTRAINT "refi_offers_answered_when_answered"
  CHECK (("status" IN ('OFFERED', 'EXPIRED')) = ("answered_at" IS NULL));
-- Only a yes opens an application.
ALTER TABLE "refi_offers" ADD CONSTRAINT "refi_offers_application_means_yes"
  CHECK ("application_id" IS NULL OR "status" = 'ENGAGED');
ALTER TABLE "refi_offers" ADD CONSTRAINT "refi_offers_open_for_a_while"
  CHECK ("valid_until" > "offered_at");

-- The figures are the review's, copied once; and an offer ends once. A row
-- may move out of OFFERED and nowhere else, and nothing about what was
-- offered may change under an answer.
CREATE OR REPLACE FUNCTION refi_offers_settle_once() RETURNS trigger AS $$
BEGIN
  IF NEW.loan_id IS DISTINCT FROM OLD.loan_id
     OR NEW.review_id IS DISTINCT FROM OLD.review_id
     OR NEW.detected_on IS DISTINCT FROM OLD.detected_on
     OR NEW.offered_at IS DISTINCT FROM OLD.offered_at
     OR NEW.disclosure IS DISTINCT FROM OLD.disclosure
     OR NEW.candidate_rate_pct IS DISTINCT FROM OLD.candidate_rate_pct
     OR NEW.rate_source IS DISTINCT FROM OLD.rate_source THEN
    RAISE EXCEPTION 'refi offer % is what was offered; it does not change', OLD.id;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'OFFERED' THEN
    RAISE EXCEPTION 'refi offer % already ended as %', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refi_offers_settle_once_update
  BEFORE UPDATE ON "refi_offers"
  FOR EACH ROW EXECUTE FUNCTION refi_offers_settle_once();

-- An application born from an offer names the loan it refinances.
ALTER TABLE "applications" ADD COLUMN "prior_loan_id" UUID;
ALTER TABLE "applications" ADD CONSTRAINT "applications_prior_loan_id_fkey"
  FOREIGN KEY ("prior_loan_id") REFERENCES "loans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "applications_prior_loan" ON "applications"("prior_loan_id");

-- At most one open refinance of a loan at a time. Partial over the states an
-- application can still move out of; the ended ones stand beside the next.
CREATE UNIQUE INDEX "applications_one_open_refinance_per_loan" ON "applications"("prior_loan_id")
  WHERE "prior_loan_id" IS NOT NULL
    AND "status" NOT IN ('FUNDED', 'DENIED', 'INCOMPLETE_CLOSED', 'WITHDRAWN', 'CANCELED', 'EXPIRED');

COMMENT ON COLUMN "applications"."prior_loan_id" IS
  'The loan of ours this application refinances, set at birth from an offer and never after; the funding move names it as the successor on the prior loan.';

-- The analyst's turn rides on the review row, written with it: the row is
-- append-only, so there is no later write to put it on.
ALTER TABLE "loan_reviews" ADD COLUMN "analyst" JSONB;
COMMENT ON COLUMN "loan_reviews"."analyst" IS
  'Doug''s 33.2 rule 4, ported: {rationale, flags, confidence, model, prompt_version, ...} with every figure as a {{facts.<key>}} token, or {skipped: <reason>}; null on a review recorded before the analyst existed.';
