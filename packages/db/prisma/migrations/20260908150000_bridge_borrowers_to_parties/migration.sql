-- The bridge: every borrower row and every sign-in can now name a party.
--
-- The strangler's first move. Screen 2 keeps writing `borrowers` exactly as
-- before and ALSO writes the party and its facts, in one transaction; every
-- consent keeps writing `consents` and is mirrored to `authorizations` by the
-- trigger below. Nothing reads the new rows on the four screens yet. Both
-- columns are nullable: rows written before this exist, and demo files exist.

-- AlterTable
ALTER TABLE "borrowers" ADD COLUMN     "party_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "party_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "users_party_id_key" ON "users"("party_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "borrowers" ADD CONSTRAINT "borrowers_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Consents mirror to authorizations ──────────────────────────────────────
--
-- Three routes write a consent row today, and a fourth would be written by
-- somebody who had not read the other three. A trigger catches all of them and
-- cannot be forgotten. It mirrors only when the borrower has a party — a legacy
-- row has nothing to mirror to — and only for kinds that permit a retrieval:
-- econsent and sms_contact grant no data category, and an authorization must
-- grant at least one.
--
-- expires_at is 120 days from grant. That is the origination grant the model
-- specifies, and it is a real change from the legacy row, which never expires:
-- once a party holds an authorization, the minter treats it as authoritative
-- and a pull on a file older than 120 days is refused. Recorded in
-- docs/decisions.md. The legacy fallback in tokenFor() keeps the old
-- no-expiry semantics for files with no party, so a refusal is attributable to
-- exactly one table.
CREATE OR REPLACE FUNCTION consents_mirror_to_authorizations() RETURNS trigger AS $$
DECLARE
  pid uuid;
  purpose_ "AuthorizationPurpose";
  cats "DataCategory"[];
BEGIN
  SELECT party_id INTO pid FROM "borrowers" WHERE id = NEW.borrower_id;
  IF pid IS NULL THEN
    RETURN NULL;
  END IF;

  CASE NEW.kind
    WHEN 'verification_authorization' THEN
      purpose_ := 'FCRA_WRITTEN_INSTRUCTION';
      cats := ARRAY['CREDIT_REPORT','BANK_TRANSACTIONS','PAYROLL_INCOME','SANCTIONS_SCREENING','PUBLIC_RECORD_LIENS']::"DataCategory"[];
    WHEN 'form_4506c' THEN
      purpose_ := 'IRS_4506C';
      cats := ARRAY['TAX_TRANSCRIPT']::"DataCategory"[];
    WHEN 'persistent_monitoring' THEN
      purpose_ := 'FCRA_ACCOUNT_REVIEW';
      cats := ARRAY['CREDIT_REPORT','BANK_TRANSACTIONS']::"DataCategory"[];
    ELSE
      RETURN NULL;
  END CASE;

  -- A second live consent of the same kind is refused by the route as
  -- "already signed"; if one slips through, the partial unique index on
  -- (party_id, purpose) WHERE revoked_at IS NULL turns it into a no-op here
  -- rather than a duplicate grant.
  INSERT INTO "authorizations"
    (id, party_id, purpose, data_categories, granted_at, expires_at,
     signature_envelope_id, ip_address, user_agent, created_at)
  VALUES
    (gen_random_uuid(), pid, purpose_, cats, NEW.granted_at, NEW.granted_at + interval '120 days',
     NEW.envelope_id, NEW.ip_address, NEW.user_agent, now())
  ON CONFLICT DO NOTHING;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consents_mirror_to_authorizations_insert
  AFTER INSERT ON "consents"
  FOR EACH ROW EXECUTE FUNCTION consents_mirror_to_authorizations();

-- A revoked consent revokes its mirror. Nothing writes consents.revoked_at
-- today — it is read in seven places and written by nothing — so this is the
-- first writer of authorizations.revoked_at from the legacy side, ready for
-- the day a revoke route exists.
CREATE OR REPLACE FUNCTION consents_mirror_revocation() RETURNS trigger AS $$
DECLARE
  pid uuid;
  actor uuid;
  purpose_ "AuthorizationPurpose";
BEGIN
  IF NEW.revoked_at IS NULL OR OLD.revoked_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  SELECT party_id INTO pid FROM "borrowers" WHERE id = NEW.borrower_id;
  IF pid IS NULL THEN
    RETURN NULL;
  END IF;
  purpose_ := CASE NEW.kind
    WHEN 'verification_authorization' THEN 'FCRA_WRITTEN_INSTRUCTION'::"AuthorizationPurpose"
    WHEN 'form_4506c' THEN 'IRS_4506C'::"AuthorizationPurpose"
    WHEN 'persistent_monitoring' THEN 'FCRA_ACCOUNT_REVIEW'::"AuthorizationPurpose"
    ELSE NULL
  END;
  IF purpose_ IS NULL THEN
    RETURN NULL;
  END IF;
  -- The party's own principal is who revoked: a consent is withdrawn by the
  -- person who gave it.
  SELECT id INTO actor FROM "principals" WHERE kind = 'BORROWER' AND party_id = pid LIMIT 1;
  IF actor IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE "authorizations"
     SET revoked_at = NEW.revoked_at,
         revoked_by_principal_id = actor,
         revocation_reason = 'consent revoked'
   WHERE party_id = pid AND purpose = purpose_ AND revoked_at IS NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consents_mirror_revocation_update
  AFTER UPDATE OF revoked_at ON "consents"
  FOR EACH ROW EXECUTE FUNCTION consents_mirror_revocation();
