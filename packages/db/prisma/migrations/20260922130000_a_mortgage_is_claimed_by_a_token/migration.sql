-- A mortgage is claimed by a token the servicer delivers, never by an email match.
--
-- The tape makes an imported_unclaimed loan on a provisional party and
-- carries no email, so nothing can match a sign-in to it and nothing
-- should: a loan appearing in an account without a claim is the oracle the
-- 404 rule suppresses. The claim is a single-use token, minted through the
-- partner key for one loan that is still unclaimed and delivered by the
-- servicer over its own channel. Whoever holds it takes it after signing in;
-- the loan's provisional party folds into theirs, the loan moves to
-- monitoring_only as claim_confirmed, and the review turns on.
--
-- The token lives in the link and here as its hash, like a co-borrower's
-- invitation. Good once and for thirty days; the next mint for the same loan
-- revokes the last.
CREATE TABLE "loan_claims" (
  "id" UUID NOT NULL,
  "loan_id" UUID NOT NULL,
  "party_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "issued_by_principal_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "accepted_by_party_id" UUID,
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "loan_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "loan_claims_token_hash_key" ON "loan_claims"("token_hash");
CREATE INDEX "loan_claims_loan" ON "loan_claims"("loan_id");

ALTER TABLE "loan_claims" ADD CONSTRAINT "loan_claims_loan_id_fkey"
  FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loan_claims" ADD CONSTRAINT "loan_claims_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loan_claims" ADD CONSTRAINT "loan_claims_issued_by_principal_id_fkey"
  FOREIGN KEY ("issued_by_principal_id") REFERENCES "principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "loan_claims" ADD CONSTRAINT "loan_claims_accepted_by_party_id_fkey"
  FOREIGN KEY ("accepted_by_party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Taken is taken: a claim marked accepted names who took it.
ALTER TABLE "loan_claims" ADD CONSTRAINT "loan_claims_taken_names_the_taker"
  CHECK (("accepted_at" IS NULL) = ("accepted_by_party_id" IS NULL));
