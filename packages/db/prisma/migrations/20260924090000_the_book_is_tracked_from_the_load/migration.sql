-- The book is tracked from the day it is loaded, and the claim is the door.
--
-- A borrower has a Supermortgage account from the day their servicer joins;
-- the tape is what starts the watching, and the claim is when the person
-- can see it. So an imported loan is monitored from birth, and the rule
-- that held the review off until somebody claimed comes out. See
-- docs/decisions.md, "The book is tracked from the day it is loaded".
ALTER TABLE "loans" DROP CONSTRAINT "loans_unclaimed_is_not_monitored";
UPDATE "loans"
   SET "monitoring_enabled" = true,
       "next_review_due_at" = COALESCE("next_review_due_at", now())
 WHERE "status" = 'IMPORTED_UNCLAIMED';

-- An offer is made when the review finds it, and delivered when the person
-- can see it. Its thirty days and its place in the two-a-year cap count from
-- delivery, so an offer nobody could see never lapses unseen and never
-- spends the cap. An offer made before this migration was made to somebody
-- who could see it, so it was delivered when it was offered.
ALTER TABLE "refi_offers" ADD COLUMN "delivered_at" TIMESTAMP(3);
ALTER TABLE "refi_offers" ALTER COLUMN "valid_until" DROP NOT NULL;
UPDATE "refi_offers" SET "delivered_at" = "offered_at" WHERE "delivered_at" IS NULL;
ALTER TABLE "refi_offers" ADD CONSTRAINT "refi_offers_delivery_has_validity"
  CHECK (("delivered_at" IS NULL) = ("valid_until" IS NULL));

-- Delivered once: the trigger that keeps what was offered as offered now
-- keeps the delivery too.
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
  IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
    RAISE EXCEPTION 'refi offer % was delivered once, at %', OLD.id, OLD.delivered_at;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'OFFERED' THEN
    RAISE EXCEPTION 'refi offer % already ended as %', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
