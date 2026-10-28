-- A billed balance is never a guess.
--
-- `total_principal_balance_cents` arrived nullable, with the readers falling
-- back to the interest-bearing figure for a row written before the column.
-- That fallback was reasonable for an hour and dangerous after it: the
-- migration before this one backfills every row, and every write since sets
-- it, so a null can only mean a backfill that did not finish. And a null read
-- through that fallback bills the old basis on every loan while reporting
-- success — no error, no clue, a servicer quietly undercharged.
--
-- Nearly walked into exactly that on 28 October 2026: the first attempt at
-- the previous migration added the column and failed before its backfill, so
-- production sat with 1,866 observations and 1,866 nulls. Promoting then would
-- have deployed, reported healthy, and billed the figure we had just decided
-- was wrong.
--
-- So the database refuses it instead. Not null, and the readers stop guessing.
ALTER TABLE "servicing_observations"
  ALTER COLUMN "total_principal_balance_cents" SET NOT NULL;
