-- A claim mailed from the tape desk says where it went.
--
-- The partner door still hands a token back for the servicer to deliver;
-- the tape desk in the console mints the same token and mails it to the
-- address the supplement carried, once, and keeps nothing of that address
-- but this: the recipient of a link we sent, when the mailer accepted it,
-- and what the mailer answered. See docs/decisions.md, "The tape desk".
ALTER TABLE "loan_claims" ADD COLUMN "delivered_to" TEXT;
ALTER TABLE "loan_claims" ADD COLUMN "delivered_at" TIMESTAMP(3);
ALTER TABLE "loan_claims" ADD COLUMN "delivery" JSONB;
