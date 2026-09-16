-- An invitation is a hash and a deadline.
--
-- The applicant names a co-borrower; this is how the named person is reached.
-- One row per invitation sent, holding the SHA-256 of the token that went out
-- in the emailed link and never the token itself: the link is the only place
-- the token exists, so a copy of this table is not a way in. Seven days, then
-- it is nothing; accepted or revoked, it is history. A re-send revokes the
-- last one and mints another, which is why the uniqueness below is partial —
-- one LIVE invitation per named person, and as many dead ones as it took.
--
-- The party is on the row as well as the borrower, because accepting is a
-- merge: the named PROVISIONAL party folds into the party the person's own
-- sign-in created, and the row has to say which party it was minted against
-- so a claim cannot be replayed against the survivor.
CREATE TABLE "co_borrower_invitations" (
    "id"                      UUID NOT NULL,
    "loan_file_id"            UUID NOT NULL,
    "borrower_id"             UUID NOT NULL,
    "party_id"                UUID NOT NULL,
    "token_hash"              TEXT NOT NULL,
    "sent_to_email"           TEXT NOT NULL,
    "invited_by_principal_id" UUID,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"              TIMESTAMP(3) NOT NULL,
    "accepted_at"             TIMESTAMP(3),
    "accepted_by_party_id"    UUID,
    "revoked_at"              TIMESTAMP(3),

    CONSTRAINT "co_borrower_invitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "co_borrower_invitations_expire_after_they_are_made"
        CHECK ("expires_at" > "created_at"),
    -- Accepted names who accepted; revoked and accepted are two endings, not one.
    CONSTRAINT "co_borrower_invitations_end_once"
        CHECK (NOT ("accepted_at" IS NOT NULL AND "revoked_at" IS NOT NULL)),
    CONSTRAINT "co_borrower_invitations_accepted_names_who"
        CHECK (("accepted_at" IS NULL) = ("accepted_by_party_id" IS NULL))
);

CREATE UNIQUE INDEX "co_borrower_invitations_token_hash_key"
    ON "co_borrower_invitations" ("token_hash");

-- One live invitation per named person. Dead ones stay.
CREATE UNIQUE INDEX "co_borrower_invitations_one_live_per_borrower"
    ON "co_borrower_invitations" ("borrower_id")
    WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

CREATE INDEX "co_borrower_invitations_loan_file"
    ON "co_borrower_invitations" ("loan_file_id");

ALTER TABLE "co_borrower_invitations"
    ADD CONSTRAINT "co_borrower_invitations_loan_file_id_fkey"
    FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "co_borrower_invitations"
    ADD CONSTRAINT "co_borrower_invitations_borrower_id_fkey"
    FOREIGN KEY ("borrower_id") REFERENCES "borrowers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "co_borrower_invitations"
    ADD CONSTRAINT "co_borrower_invitations_party_id_fkey"
    FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "co_borrower_invitations"
    ADD CONSTRAINT "co_borrower_invitations_accepted_by_party_id_fkey"
    FOREIGN KEY ("accepted_by_party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "co_borrower_invitations"
    ADD CONSTRAINT "co_borrower_invitations_invited_by_principal_id_fkey"
    FOREIGN KEY ("invited_by_principal_id") REFERENCES "principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
