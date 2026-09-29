-- A review names the observation it read (SET NULL when that goes), and the
-- column had no index: removing a loan's observations scanned every review,
-- thirty milliseconds a row, and was the whole cost of removing a book.
-- IF NOT EXISTS because staging got it by hand while a cleanup waited on it.
CREATE INDEX IF NOT EXISTS "loan_reviews_observation" ON "loan_reviews"("observation_id");
