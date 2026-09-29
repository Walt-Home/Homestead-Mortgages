-- The loans self-reference had a foreign key and no index, so deleting one
-- loan scanned the whole table for loans that name it as their refinance,
-- and removing a servicer's book of fourteen thousand took the better part
-- of an hour on staging. IF NOT EXISTS because staging got it by hand first,
-- while that cleanup was waiting on it.
CREATE INDEX IF NOT EXISTS "loans_refinanced_by" ON "loans"("refinanced_by_loan_id");
