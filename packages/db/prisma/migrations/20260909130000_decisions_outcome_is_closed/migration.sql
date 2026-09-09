-- decisions.outcome and aus_recommendation were bare TEXT cast back unvalidated.
-- A closed set in the database is what makes DecisionOutcome real rather than a
-- TS convention: a misspelled 'referred' is a failed insert, not a pill that
-- renders nothing. The list equals DECISION_OUTCOMES / AUS_RECOMMENDATIONS in
-- @hm/shared; a test reads pg_constraint and asserts it.
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_outcome_known"
  CHECK (outcome IN ('pending', 'referred', 'approved_with_conditions', 'clear_to_close', 'counteroffer', 'denied'));
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_recommendation_known"
  CHECK (aus_recommendation IN ('approve_eligible', 'approve_ineligible', 'refer', 'refer_with_caution', 'out_of_scope'));
