-- A tape is for a month, and the book is billed from it.
--
-- The meter billed a servicer's loan from the day it was loaded — read off
-- `created_at` — because the sheet says "from the day it is loaded". The
-- first real book proved the day it is loaded is not the day it is for:
-- Grander's September tape reached the desk on 5 October 2026, and the
-- September statement had nothing on it. So the start is a column of its
-- own, `watched_from`, set by the tape that creates the row from the month
-- the uploader says the tape is for (its first day), or the load day when
-- nobody says. The rows already on the books keep the day they were loaded,
-- in the creditor's zone, which is exactly what they were billed from.
ALTER TABLE "loans" ADD COLUMN "watched_from" DATE;

UPDATE "loans"
   SET "watched_from" = ("created_at" AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date
 WHERE "servicer_loan_number" IS NOT NULL;

-- Every servicer's loan is watched from a day; a loan we originated is not on a tape.
ALTER TABLE "loans" ADD CONSTRAINT "loans_servicer_loan_is_watched_from_a_day"
  CHECK ("servicer_loan_number" IS NULL OR "watched_from" IS NOT NULL);
