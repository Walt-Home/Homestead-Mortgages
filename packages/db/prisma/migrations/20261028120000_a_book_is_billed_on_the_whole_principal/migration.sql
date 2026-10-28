-- A book is billed on the whole principal, deferred included.
--
-- The meter billed `principal_balance_cents`, which is the tape's "Interest
-- Bearing UPB" column, on the 29 September reading that a servicer's own fee
-- is earned on that figure. The revenue tracker the company runs on uses the
-- tape's Total UPB — interest-bearing plus deferred — and the two differ by
-- the deferred principal a modification or a partial claim left behind.
--
-- Measured on production the same day: Grander's September tape carries
-- $66,024,686.13 interest-bearing and $141,521.62 deferred, and the tracker's
-- figure for that cohort is $66,166,208 — the sum, to the cent. Two later
-- cohorts match their Total UPB exactly ($83,891,302.45 and $91,192,288.93).
-- Across the book it is $389,393,880.02 against $389,641,033.83, which is
-- $51.49 a month at 25 basis points over twelve.
--
-- The figure is derived rather than read: interest-bearing plus deferred,
-- both of which every row already carries in `facts`. The tape's own Total
-- column is not trusted over the sum, because the sum cannot disagree with
-- the parts. A row from before this column is read as the interest-bearing
-- figure alone, which is what it was billed on.
ALTER TABLE "servicing_observations" ADD COLUMN "total_principal_balance_cents" BIGINT;

-- The table is append-only by trigger, and the backfill below is an UPDATE,
-- so the guard has to come off for it. That is sound rather than a loophole:
-- the guard exists because "your situation changed" is a difference between
-- two observations and you cannot diff against a row you overwrote, and this
-- writes a column that did not exist until a moment ago, derived from two
-- the row already carries. Nothing a tape said is rewritten. The guard goes
-- straight back on, inside this migration's own transaction, which holds an
-- exclusive lock throughout, so there is no window another writer can use.
--
-- (This is what the first attempt got wrong, on production, 28 October 2026:
-- the backfill was written without the DISABLE and the migration failed on
-- `servicing_observations is append-only`. It passed in development only
-- because the table was empty there, so the UPDATE touched no row and the
-- trigger never fired. A backfill proves nothing against an empty table.)
ALTER TABLE "servicing_observations"
  DISABLE TRIGGER "servicing_observations_append_only_update";

UPDATE "servicing_observations"
   SET "total_principal_balance_cents" =
         "principal_balance_cents"
         + COALESCE(NULLIF("facts"->>'deferred_upb_cents', '')::bigint, 0);

ALTER TABLE "servicing_observations"
  ENABLE TRIGGER "servicing_observations_append_only_update";

-- The whole principal is never less than the part of it that bears interest.
ALTER TABLE "servicing_observations"
  ADD CONSTRAINT "servicing_observations_total_covers_interest_bearing"
  CHECK ("total_principal_balance_cents" IS NULL
         OR "total_principal_balance_cents" >= "principal_balance_cents");
