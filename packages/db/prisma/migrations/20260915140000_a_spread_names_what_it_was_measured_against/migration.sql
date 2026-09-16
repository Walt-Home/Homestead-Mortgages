-- A decision that reports a spread names what it was measured against.
--
-- `decisions` is append-only and is the audit record: a recomputation writes a
-- new row precisely so the old one keeps saying what was concluded at the time.
-- Three of the verdicts on it — General QM, HPML and HOEPA — are comparisons
-- against the average prime offer rate for the week the loan's rate was set,
-- and the fourth is a ratio against a fee schedule. Both of those inputs MOVE.
-- The FFIEC publishes a new week every Monday, and a fee schedule is replaced
-- rather than edited.
--
-- So a row saying `"isHighCost": false` with nothing naming the week and the
-- schedule behind it is a legal determination whose inputs cannot be recovered.
-- Recomputing it a year later answers the same question differently and nothing
-- on the stored row says why. The engine already writes both into the
-- derivation log; a CHECK cannot read a JSON array — Postgres forbids the
-- subquery that would take — so the two facts are promoted to columns and the
-- constraint is stated on them.
ALTER TABLE "decisions"
    ADD COLUMN "apor_week_of" DATE,
    ADD COLUMN "apor_source" TEXT,
    ADD COLUMN "fee_schedule_version" TEXT;

COMMENT ON COLUMN "decisions"."apor_week_of" IS
    'The FFIEC week the APOR was read from. Null when a caller stated the rate.';
COMMENT ON COLUMN "decisions"."apor_source" IS
    'Which table answered, or "stated" when a caller supplied the rate instead.';
COMMENT ON COLUMN "decisions"."fee_schedule_version" IS
    'Which fee schedule priced the totals, or "stated".';

-- Existing rows are the reason these are nullable, written as implications
-- rather than as NOT NULL, and added NOT VALID.
--
-- An earlier draft of this migration asserted that every decision recorded
-- before it "was computed with no APR and no APOR at all, so its `compliance`
-- carries a null `hpmlSpread`". That is true of every file a borrower walked
-- and false of the one caller that has always supplied market figures: the
-- persona seed. Three stories state an APR and an APOR, so three rows on
-- staging — and on any developer database where `seed:personas` has run —
-- carry a non-null `hpmlSpread` and `pointsAndFeesRatio` with these three
-- columns null beneath them. A validated CHECK is checked against existing
-- rows, so `ADD CONSTRAINT` aborted:
--
--   ERROR: check constraint "decisions_a_spread_names_its_week" of relation
--          "decisions" is violated by some row
--
-- which fails `prisma migrate deploy` and stops the deploy. Reproduced against
-- a database holding one seeded row before this was written.
--
-- NOT VALID is the honest way past it, and the two alternatives are not. The
-- rows cannot be deleted: `decisions` is append-only and is the audit record.
-- They cannot be backfilled either — not because "stated" would be untrue of
-- them, it is exactly true, but because an UPDATE against this table is the one
-- thing nothing in this repository does. What those rows were measured against
-- is still recoverable: the pre-existing UW-008 derivation records the `apr`
-- and `apor` values in its metadata, and before these columns existed a caller
-- stating them was the only way either figure could reach the engine.
--
-- NOT VALID means unchecked against the rows already here, and enforced for
-- every row written from now on. `decisions` is insert-only, so that is every
-- decision this engine will ever record.
ALTER TABLE "decisions"
    ADD CONSTRAINT "decisions_a_spread_names_its_week" CHECK (
        ("compliance" ->> 'hpmlSpread') IS NULL
        OR "apor_source" IS NOT NULL
    ) NOT VALID,
    ADD CONSTRAINT "decisions_a_fee_ratio_names_its_schedule" CHECK (
        ("compliance" ->> 'pointsAndFeesRatio') IS NULL
        OR "fee_schedule_version" IS NOT NULL
    ) NOT VALID,
    -- A week with nothing saying which series it came off is half a provenance:
    -- two tables can both hold a row for the week of the 15th and disagree
    -- about what it says, which is exactly what will happen the day the fixture
    -- series is replaced with the published one.
    ADD CONSTRAINT "decisions_a_week_has_a_source" CHECK (
        "apor_week_of" IS NULL
        OR "apor_source" IS NOT NULL
    );
