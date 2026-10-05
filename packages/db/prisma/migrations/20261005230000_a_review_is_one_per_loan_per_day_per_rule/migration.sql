-- A review is one per loan, per day, per rule.
--
-- It was one per loan per day. That is right while the rule stands still,
-- and it meant a day's verdict could not be corrected when the rule was:
-- the first real book on production was reviewed on 5 October 2026 under a
-- rule that excluded 243 loans their servicer reported current, the rule
-- was fixed the same afternoon, and the review could not be run again
-- until the next morning because the day already had its row.
--
-- Nothing is rewritten, as before: the table is append-only and stays so.
-- A review under a changed rule is a NEW row beside the earlier one, each
-- carrying the rule it was made under, and "the day's verdict" is the
-- newest of them. The same rule on the same day is still one row.
DROP INDEX "loan_reviews_one_per_loan_day";
CREATE UNIQUE INDEX "loan_reviews_one_per_loan_day_and_rule"
    ON "loan_reviews"("loan_id", "as_of", "rule_set_version");
