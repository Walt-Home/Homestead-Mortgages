-- A ratio is eight figures, or nothing.
--
-- `decisions.ratios` and `decisions.reserves` are the shadow AUS's figures:
-- what we compute to show a borrower where they stand, and what Desktop
-- Underwriter derives for itself from the inputs we send. They are written as
-- one object, appended as one and diffed as one, which is why they are two
-- JSON columns rather than twelve typed ones — and until now nothing held the
-- shape of either. The engine always wrote every key, and three test fixtures
-- wrote `{}`, and a reader that trusted the column could not tell the two
-- apart.
--
-- The rule the writer and the reader now parse by, held by the table as well:
-- an object, exactly these keys, each a JSON number or null (null is "could
-- not compute"; the derivation log says what was missing). No subquery and no
-- function, because a CHECK that reads another table is a CHECK Postgres
-- cannot promise.
--
-- NOT VALID, and validated in a later migration once every deployment's rows
-- have been read back through the parser: a constraint that refuses an old
-- row on staging aborts the deploy that carries it, and that is a worse
-- outcome than one that holds for every row written from here on.
ALTER TABLE "decisions"
  ADD CONSTRAINT "decisions_ratios_are_the_eight_figures" CHECK (
    jsonb_typeof("ratios") = 'object'
    AND "ratios" ?& ARRAY['dtiFront','dtiBack','ltv','cltv','hcltv','housingPitia','totalMonthlyDebt','totalQualifyingIncome']
    AND ("ratios" - ARRAY['dtiFront','dtiBack','ltv','cltv','hcltv','housingPitia','totalMonthlyDebt','totalQualifyingIncome']) = '{}'::jsonb
    AND jsonb_typeof("ratios"->'dtiFront') IN ('number','null')
    AND jsonb_typeof("ratios"->'dtiBack') IN ('number','null')
    AND jsonb_typeof("ratios"->'ltv') IN ('number','null')
    AND jsonb_typeof("ratios"->'cltv') IN ('number','null')
    AND jsonb_typeof("ratios"->'hcltv') IN ('number','null')
    AND jsonb_typeof("ratios"->'housingPitia') IN ('number','null')
    AND jsonb_typeof("ratios"->'totalMonthlyDebt') IN ('number','null')
    AND jsonb_typeof("ratios"->'totalQualifyingIncome') IN ('number','null')
  ) NOT VALID,
  ADD CONSTRAINT "decisions_reserves_are_the_four_figures" CHECK (
    jsonb_typeof("reserves") = 'object'
    AND "reserves" ?& ARRAY['requiredMonths','actualMonths','eligiblePostCloseAssets','satisfied']
    AND ("reserves" - ARRAY['requiredMonths','actualMonths','eligiblePostCloseAssets','satisfied']) = '{}'::jsonb
    AND jsonb_typeof("reserves"->'requiredMonths') IN ('number','null')
    AND jsonb_typeof("reserves"->'actualMonths') IN ('number','null')
    AND jsonb_typeof("reserves"->'eligiblePostCloseAssets') IN ('number','null')
    AND jsonb_typeof("reserves"->'satisfied') IN ('boolean','null')
  ) NOT VALID;
