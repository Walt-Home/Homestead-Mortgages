-- A resubmission has to carry the identifier Desktop Underwriter issued, and
-- ours is not it.
--
-- `aus_casefile_id` is stable across resubmissions of one loan, which was the
-- point of the migration before this one. What it is NOT is a value DU will
-- accept: it is a 36-character UUID, and DU has two identifier fields for a
-- casefile, neither of which fits. `AutomatedUnderwritingCaseIdentifier` is a
-- String 30 and DU MINTS IT — it comes back on the response, it is not ours to
-- choose. `LenderLoan` is a String 15 and is the lender's own loan number.
--
-- So there are two identifiers, not one, and they belong to different parties
-- in the exchange. This adds the one DU owns. Ours keeps its column and its
-- meaning: the thing that tells us two submissions are about one loan, before
-- DU has ever answered.
ALTER TABLE "applications" ADD COLUMN "du_casefile_id" VARCHAR(30);

-- Unique, for the same reason ours is: two credit requests sharing one casefile
-- is the confusion this whole pair of columns exists to prevent, and it does not
-- become acceptable because DU is the one that assigned it.
CREATE UNIQUE INDEX "applications_du_casefile_id_key"
    ON "applications" ("du_casefile_id")
    WHERE "du_casefile_id" IS NOT NULL;

-- Write-once, and NOT keyed on anything a writer has to get right.
--
-- Once DU has named a case, that name is what every resubmission of it must
-- carry. Overwriting it silently starts a second case at Fannie while our own
-- records still say one, and clearing it loses the only handle we have on the
-- first. Both are refused here rather than in a service, because the reason a
-- service is not enough is that a second writer is exactly what does this.
--
-- Re-writing the SAME value is allowed: a resubmission that reads the response
-- and stores what it already stored is a no-op, and making that an error would
-- turn an ordinary retry into a failure. This is the lockout rule the repo
-- keeps — a refusal must be keyed on something the requester controls, and a
-- requester always controls whether it is sending the same value back.
CREATE OR REPLACE FUNCTION "applications_du_casefile_is_write_once"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."du_casefile_id" IS NOT NULL
       AND NEW."du_casefile_id" IS DISTINCT FROM OLD."du_casefile_id" THEN
        RAISE EXCEPTION
            'application % already carries DU casefile %; a resubmission carries the case DU named, and a new case is a new application',
            OLD.id, OLD."du_casefile_id";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "applications_du_casefile_is_write_once_update"
    BEFORE UPDATE ON "applications"
    FOR EACH ROW
    EXECUTE FUNCTION "applications_du_casefile_is_write_once"();

COMMENT ON COLUMN "applications"."du_casefile_id" IS
    'AutomatedUnderwritingCaseIdentifier, minted by DU and returned on the response. Write-once. Null until a submission has been answered.';
COMMENT ON COLUMN "applications"."aus_casefile_id" IS
    'Ours, not DUs. Stable across resubmissions of one loan. Does not fit either DU identifier field and is never sent as one.';
