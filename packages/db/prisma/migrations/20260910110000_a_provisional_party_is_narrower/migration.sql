-- A provisional party is narrower, and the database now says so.
--
-- `PartyClaimStatus` has shipped with four values, an index, and no writer that
-- ever sets anything but CLAIMED. So the enum distinguishes nothing today, and
-- the schema comment beside it -- "the things you may do with a provisional
-- party are narrower" -- has no code behind it. This gives it code.
--
-- Additive, and no shipped path changes behavior: every party this product
-- currently makes is born CLAIMED, nothing updates the column, and no partner
-- principal asserts a fact. The three rules below refuse things nothing does
-- yet, which is the point of writing them before the writers arrive.

-- ─── 1. Claim status moves forward, and MERGED keeps its survivor ──────────
CREATE OR REPLACE FUNCTION parties_claim_status_moves_forward() RETURNS trigger AS $$
BEGIN
  -- Above the short-circuit below, because this rule is not about a status
  -- CHANGING. Naming a survivor is only checked on the way into MERGED, so
  -- once the status has stopped moving an UPDATE that touched nothing but the
  -- pointer would return unexamined -- and repoint one person's imported
  -- record at an account holder who never claimed it, or null it and leave a
  -- stranger's date of birth that no reader reaches and no deletion takes.
  --
  -- It also turns merged_into_party_id's ON DELETE SET NULL into a refusal,
  -- which is the answer we want: a survivor may not be deleted while merged-
  -- from rows still point at it, so whoever erases one has to take them
  -- explicitly. Account deletion already does, in that order.
  IF OLD.claim_status = 'MERGED'
     AND NEW.merged_into_party_id IS DISTINCT FROM OLD.merged_into_party_id THEN
    RAISE EXCEPTION 'party % is merged into %; a merged party keeps the survivor it named',
      OLD.id, OLD.merged_into_party_id;
  END IF;
  IF NEW.claim_status IS NOT DISTINCT FROM OLD.claim_status THEN RETURN NEW; END IF;
  IF NOT ( (OLD.claim_status = 'PROVISIONAL'   AND NEW.claim_status IN ('CLAIM_PENDING','MERGED'))
        OR (OLD.claim_status = 'CLAIM_PENDING' AND NEW.claim_status IN ('MERGED','PROVISIONAL')) ) THEN
    RAISE EXCEPTION 'party % cannot go % -> %', OLD.id, OLD.claim_status, NEW.claim_status;
  END IF;
  -- CLAIM_PENDING -> PROVISIONAL is the only backward edge, and it is here
  -- with no caller. Parking a party at CLAIM_PENDING while somebody looks at a
  -- screen, and moving it back when the last of them closes the tab, is a
  -- request writing to an object keyed on the LOAN rather than on the person
  -- asking -- the shape that lets one stranger's presses stall the owner. The
  -- claim moves an imported party exactly once instead, PROVISIONAL ->
  -- MERGED, inside the transaction that completes it. The edge stays in the
  -- trigger because removing an enum value is a different slice's migration,
  -- and because a state nothing ENTERS is the honest answer to a state nothing
  -- leaves.
  IF NEW.claim_status = 'MERGED' AND NEW.merged_into_party_id IS NULL THEN
    RAISE EXCEPTION 'a merged party names the party it merged into';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER parties_claim_status_moves_forward_update BEFORE UPDATE ON "parties"
  FOR EACH ROW EXECUTE FUNCTION parties_claim_status_moves_forward();

-- ─── 2. A party who has never contacted us has authorized NOTHING ──────────
--
-- This is what turns "nothing person-keyed may be retrieved for an imported,
-- unclaimed loan" from a promise in copy into a property of the database.
-- `tokenFor` reads `authorizations` and nothing else, and the connector guard
-- takes a PurposeToken only `tokenFor` can mint -- so a party that structurally
-- cannot hold a grant is a party no adapter can pull on, by any route,
-- including one somebody writes in six months without reading this.
--
-- Unconditional, with no carve-out, and it can be: an identity check run to
-- claim an imported mortgage runs on the CLAIMANT's own (CLAIMED) party under
-- the claimant's own grant, never on the imported one. Nothing is ever
-- retrieved about the imported person.
CREATE OR REPLACE FUNCTION authorizations_require_a_claimed_party() RETURNS trigger AS $$
DECLARE cs "PartyClaimStatus";
BEGIN
  SELECT claim_status INTO cs FROM "parties" WHERE id = NEW.party_id;
  IF cs IN ('PROVISIONAL','CLAIM_PENDING') THEN
    RAISE EXCEPTION 'party % is % and has authorized nothing; an imported record is not a consent', NEW.party_id, cs;
  END IF;
  IF cs = 'MERGED' THEN
    RAISE EXCEPTION 'party % was merged; grant on % instead',
      NEW.party_id, (SELECT merged_into_party_id FROM "parties" WHERE id = NEW.party_id);
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER authorizations_require_a_claimed_party_insert BEFORE INSERT ON "authorizations"
  FOR EACH ROW EXECUTE FUNCTION authorizations_require_a_claimed_party();

-- ─── 3. A partner shared it; nobody checked it ─────────────────────────────
-- The exact shape of the shipped `facts_ai_may_not_verify`, pointed at the
-- other principal kind that asserts things nobody verified. docs/states.md
-- names a claim flow explicitly among the things that may not upgrade a
-- confidence tier; this makes that structural instead of a service behaving
-- well. A servicer's spelling of somebody's name is worth having and is not
-- evidence, and the tier is where that distinction is kept.
CREATE OR REPLACE FUNCTION facts_partner_may_not_verify() RETURNS trigger AS $$
DECLARE actor_kind "PrincipalKind";
BEGIN
  IF NEW.confidence IN ('INFERRED','ESTIMATED','CORROBORATED','VERIFIED','VALIDATED_D1C') THEN
    SELECT kind INTO actor_kind FROM "principals" WHERE id = NEW.asserted_by_principal_id;
    IF actor_kind = 'PARTNER' THEN
      RAISE EXCEPTION 'a partner principal may not assert confidence % (predicate %); a partner shared it, nobody checked it', NEW.confidence, NEW.predicate;
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER facts_partner_may_not_verify_insert BEFORE INSERT ON "facts"
  FOR EACH ROW EXECUTE FUNCTION facts_partner_may_not_verify();
