-- A suggestion is computed, never stored (13 October 2026). Two things are
-- stored beside it, neither of them a suggestion.

-- What the adapter certified to the bureau when it ordered a report. Null on
-- every row written before today and on a pull that is not a consumer
-- report; a reader that would use a report checks this and refuses null.
ALTER TABLE "connector_snapshots" ADD COLUMN "permissible_purpose" TEXT;

-- An inference may not certify. `facts_ai_may_not_verify` keys on the
-- principal's kind and refuses only an AI principal, so a SERVICE principal
-- writing a DERIVED fact at VERIFIED passed. Nothing writes such a row yet;
-- this is for the first thing that does. A derived fact tops out at
-- ESTIMATED, an AI's inference at INFERRED, whoever asserts it.
CREATE OR REPLACE FUNCTION facts_inference_may_not_verify() RETURNS trigger AS $$
BEGIN
  IF NEW.source_kind = 'DERIVED' AND NEW.confidence IN ('CORROBORATED', 'VERIFIED', 'VALIDATED_D1C') THEN
    RAISE EXCEPTION 'a derived fact may not assert confidence % (fact on predicate %)', NEW.confidence, NEW.predicate;
  END IF;
  IF NEW.source_kind = 'AI_INFERRED' AND NEW.confidence IN ('ESTIMATED', 'CORROBORATED', 'VERIFIED', 'VALIDATED_D1C') THEN
    RAISE EXCEPTION 'an inferred fact may not assert confidence % (fact on predicate %)', NEW.confidence, NEW.predicate;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER facts_inference_may_not_verify_ins
  BEFORE INSERT ON "facts"
  FOR EACH ROW EXECUTE FUNCTION facts_inference_may_not_verify();
