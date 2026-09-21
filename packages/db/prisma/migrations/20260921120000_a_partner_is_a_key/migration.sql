-- A partner is a key, not a sign-in.
--
-- A servicer that sends us its book is a machine. It has no Google account,
-- no phone to enroll and no screen to be sent to, so the session and its
-- second step are the wrong shape for it. It gets a bearer key instead, and
-- this table holds the SHA-256 of that key and never the key: the key exists
-- on the one line the minting command printed, the way an invitation token
-- exists only in the emailed link, so a copy of this table is not a way in.
--
-- Revoked is final. A revoked key never comes back, and a row never changes
-- which key it is or which servicer it belongs to — a new key is a new row.
-- The trigger below holds both, because a permission that can be quietly
-- un-revoked is not a permission anybody can reason about.
CREATE TABLE "partner_credentials" (
    "id"           UUID NOT NULL,
    "servicer_id"  UUID NOT NULL,
    "principal_id" UUID NOT NULL,
    "key_hash"     TEXT NOT NULL,
    "label"        TEXT NOT NULL,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at"   TIMESTAMP(3),

    CONSTRAINT "partner_credentials_pkey" PRIMARY KEY ("id"),
    -- A key with no label is a key nobody can tell apart from the others when
    -- it is time to revoke one.
    CONSTRAINT "partner_credentials_label_is_words"
        CHECK (length(btrim("label")) > 0)
);

CREATE UNIQUE INDEX "partner_credentials_key_hash_key"
    ON "partner_credentials" ("key_hash");

CREATE INDEX "partner_credentials_servicer"
    ON "partner_credentials" ("servicer_id");

-- RESTRICT both ways: a servicer with live keys is not deleted by accident,
-- and the principal a key acts as is the one the ledger names, so it stays.
ALTER TABLE "partner_credentials"
    ADD CONSTRAINT "partner_credentials_servicer_id_fkey"
    FOREIGN KEY ("servicer_id") REFERENCES "servicers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "partner_credentials"
    ADD CONSTRAINT "partner_credentials_principal_id_fkey"
    FOREIGN KEY ("principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION partner_credentials_are_what_they_were() RETURNS trigger AS $$
BEGIN
    IF OLD.revoked_at IS NOT NULL
       AND (NEW.revoked_at IS NULL OR NEW.revoked_at <> OLD.revoked_at) THEN
        RAISE EXCEPTION 'partner credential % is revoked and stays revoked', OLD.id;
    END IF;
    IF NEW.key_hash <> OLD.key_hash
       OR NEW.servicer_id <> OLD.servicer_id
       OR NEW.principal_id <> OLD.principal_id THEN
        RAISE EXCEPTION 'partner credential % cannot become another key; mint one', OLD.id;
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER partner_credentials_are_what_they_were
    BEFORE UPDATE ON "partner_credentials"
    FOR EACH ROW EXECUTE FUNCTION partner_credentials_are_what_they_were();
