-- Scoped, expiring, revocable authorizations.
--
-- Additive, and not yet wired to a route. The connector guard still reads
-- `consents` off a loan file; replacing it is the next change, and it is the
-- one that closes the defect this table exists for — see below.

-- CreateEnum
CREATE TYPE "AuthorizationPurpose" AS ENUM ('FCRA_WRITTEN_INSTRUCTION', 'FCRA_ACCOUNT_REVIEW', 'FCRA_PRESCREEN', 'IRS_4506C', 'SSA_89', 'BIOMETRIC_IDV', 'ELECTRONIC_DELIVERY', 'PARTNER_DATA_SHARE', 'MARKETING_CONTACT');

-- CreateEnum
CREATE TYPE "DataCategory" AS ENUM ('CREDIT_REPORT', 'BANK_TRANSACTIONS', 'PAYROLL_INCOME', 'TAX_TRANSCRIPT', 'IDENTITY_DOCUMENT', 'SANCTIONS_SCREENING');

-- CreateTable
CREATE TABLE "authorizations" (
    "id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "purpose" "AuthorizationPurpose" NOT NULL,
    "data_categories" "DataCategory"[],
    "counterparties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "granted_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_principal_id" UUID,
    "revocation_reason" TEXT,
    "disclosure_text_hash" TEXT,
    "signature_envelope_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "authorizations_party_id_purpose_idx" ON "authorizations"("party_id", "purpose");

-- CreateIndex
CREATE INDEX "authorizations_expires_at_idx" ON "authorizations"("expires_at");

-- AddForeignKey
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_revoked_by_principal_id_fkey" FOREIGN KEY ("revoked_by_principal_id") REFERENCES "principals"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── The guarantees, in the database ────────────────────────────────────────

-- 1. At most one live grant per (party, purpose).
--
-- Two live grants for the same thing is not a harmless duplicate: it makes
-- "which disclosure did they actually agree to" ambiguous, and revoking one
-- leaves the other standing, so a borrower who withdrew permission would still
-- be pullable. Expiry is deliberately NOT in the predicate — `now()` is not
-- immutable and cannot be indexed on. A row that has merely lapsed still
-- blocks a duplicate, which is the safe direction: renewing means revoking and
-- re-granting, so the reason a grant ended is always recorded.
CREATE UNIQUE INDEX "authorizations_one_live_per_party_purpose"
  ON "authorizations" ("party_id", "purpose")
  WHERE "revoked_at" IS NULL;

-- 2. No perpetual grants, and none that expire before they start.
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_expiry_after_grant"
  CHECK ("expires_at" > "granted_at");

-- 3. A revocation records who and why, or it is not a revocation.
--
-- `consents.revoked_at` in the old model is read in seven places and written by
-- nothing, so nobody ever had to answer this. Making the three columns move
-- together means a revocation cannot be a bare timestamp with no account of
-- itself.
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_revocation_is_complete"
  CHECK (
    ("revoked_at" IS NULL AND "revoked_by_principal_id" IS NULL AND "revocation_reason" IS NULL)
    OR ("revoked_at" IS NOT NULL AND "revoked_by_principal_id" IS NOT NULL AND "revocation_reason" IS NOT NULL)
  );

-- 4. A grant that permits nothing is a mistake, not a grant.
--
-- `cardinality`, not `array_length`. On an empty array `array_length` returns
-- NULL rather than 0, and a CHECK that evaluates to NULL PASSES — so the
-- obvious spelling of this constraint is silently vacuous and accepts exactly
-- the row it was written to reject. A test against a real database caught it.
ALTER TABLE "authorizations" ADD CONSTRAINT "authorizations_grants_something"
  CHECK (cardinality("data_categories") >= 1);

-- 5. A revocation is one-way.
--
-- Un-revoking would rewrite the borrower's own decision. Granting again is a
-- new row, which is also what keeps the audit trail readable: two grants and
-- one revocation, in order, rather than one row that changed its mind.
CREATE OR REPLACE FUNCTION authorizations_revocation_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'authorization % is already revoked; grant a new one instead of un-revoking', OLD.id;
  END IF;

  IF ROW(NEW.party_id, NEW.purpose, NEW.data_categories, NEW.granted_at, NEW.expires_at,
         NEW.disclosure_text_hash)
     IS DISTINCT FROM
     ROW(OLD.party_id, OLD.purpose, OLD.data_categories, OLD.granted_at, OLD.expires_at,
         OLD.disclosure_text_hash)
  THEN
    RAISE EXCEPTION 'authorization % is immutable except for revocation (party, purpose, categories, dates and disclosure hash may not change)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER authorizations_revocation_is_final_update
  BEFORE UPDATE ON "authorizations"
  FOR EACH ROW EXECUTE FUNCTION authorizations_revocation_is_final();
