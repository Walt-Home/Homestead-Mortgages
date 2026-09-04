-- The relationship layer: parties, principals, and the fact ledger.
--
-- Additive. Nothing here is wired into a route yet and no existing table is
-- touched, so the four screens keep running on `loan_files` until the
-- application layer exists to move them. See docs/states.md.

-- CreateEnum
CREATE TYPE "FactSubjectType" AS ENUM ('PARTY', 'PROPERTY', 'LOAN');

-- CreateEnum
CREATE TYPE "FactSourceKind" AS ENUM ('SELF_ATTESTED', 'STAFF_ENTERED', 'VENDOR_RETRIEVED', 'PUBLIC_RECORD', 'DOCUMENT_EXTRACTED', 'PARTNER_SHARED', 'AI_INFERRED', 'DERIVED');

-- CreateEnum
CREATE TYPE "ConfidenceTier" AS ENUM ('ATTESTED', 'UNVERIFIED', 'INFERRED', 'ESTIMATED', 'CORROBORATED', 'VERIFIED', 'VALIDATED_D1C');

-- CreateEnum
CREATE TYPE "PrincipalKind" AS ENUM ('BORROWER', 'STAFF', 'SERVICE', 'PARTNER', 'AI_AGENT');

-- CreateEnum
CREATE TYPE "PartyKind" AS ENUM ('PERSON', 'ENTITY');

-- CreateEnum
CREATE TYPE "PartyClaimStatus" AS ENUM ('PROVISIONAL', 'CLAIM_PENDING', 'CLAIMED', 'MERGED');

-- CreateTable
CREATE TABLE "parties" (
    "id" UUID NOT NULL,
    "kind" "PartyKind" NOT NULL DEFAULT 'PERSON',
    "claim_status" "PartyClaimStatus" NOT NULL DEFAULT 'PROVISIONAL',
    "merged_into_party_id" UUID,
    "source_first_seen" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "principals" (
    "id" UUID NOT NULL,
    "kind" "PrincipalKind" NOT NULL,
    "subject" TEXT NOT NULL,
    "party_id" UUID,
    "model_id" TEXT,
    "model_version" TEXT,
    "deprovisioned_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "principals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facts" (
    "id" UUID NOT NULL,
    "subject_type" "FactSubjectType" NOT NULL,
    "subject_id" UUID NOT NULL,
    "party_id" UUID,
    "predicate" TEXT NOT NULL,
    "subject_key" TEXT NOT NULL DEFAULT '',
    "value" JSONB NOT NULL,
    "source_kind" "FactSourceKind" NOT NULL,
    "confidence" "ConfidenceTier" NOT NULL,
    "asserted_by_principal_id" UUID NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "superseded_by_id" UUID,
    "retracted_at" TIMESTAMP(3),
    "retraction_reason" TEXT,

    CONSTRAINT "facts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parties_claim_status_idx" ON "parties"("claim_status");

-- CreateIndex
CREATE INDEX "parties_merged_into_party_id_idx" ON "parties"("merged_into_party_id");

-- CreateIndex
CREATE INDEX "principals_party_id_idx" ON "principals"("party_id");

-- CreateIndex
CREATE UNIQUE INDEX "principals_kind_subject_key" ON "principals"("kind", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "facts_superseded_by_id_key" ON "facts"("superseded_by_id");

-- CreateIndex
CREATE INDEX "facts_subject_type_subject_id_predicate_subject_key_observe_idx" ON "facts"("subject_type", "subject_id", "predicate", "subject_key", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "facts_party_id_idx" ON "facts"("party_id");

-- CreateIndex
CREATE INDEX "facts_asserted_by_principal_id_idx" ON "facts"("asserted_by_principal_id");

-- CreateIndex
CREATE INDEX "facts_expires_at_idx" ON "facts"("expires_at");

-- AddForeignKey
ALTER TABLE "parties" ADD CONSTRAINT "parties_merged_into_party_id_fkey" FOREIGN KEY ("merged_into_party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "principals" ADD CONSTRAINT "principals_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facts" ADD CONSTRAINT "facts_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facts" ADD CONSTRAINT "facts_asserted_by_principal_id_fkey" FOREIGN KEY ("asserted_by_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "facts" ADD CONSTRAINT "facts_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "facts"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── The guarantees, in the database ────────────────────────────────────────
--
-- These are triggers rather than role grants on purpose, for now. A
-- column-level REVOKE is the better long-term shape, but it does nothing
-- against the table owner, and the application still connects as the owner —
-- so a REVOKE today would be a guarantee that only looks like one. Triggers
-- bind the owner too. When the runtime gets its own least-privilege role, add
-- the grants alongside these; do not replace them.

-- 1. `facts` is append-only, which is a rule about UPDATE and not about DELETE.
--
-- The ledger is the answer to "what did the borrower tell us, and when". An
-- UPDATE that rewrites `value` does not correct history, it destroys it — the
-- correction is a NEW row with an earlier `observed_at` and a later
-- `recorded_at`. Three columns are exempt because they are how a row is
-- retired rather than how it is edited.
--
-- There is deliberately NO delete trigger. The first version had one, and it
-- made `DELETE FROM parties` fail: the cascade that keeps "we remove your data
-- for good — there is no archive and no undo" true on the privacy page runs
-- through this table. Blocking row deletion would have traded a promise the
-- product makes today for one nobody asked for. Controlling erasure is the
-- retention design's job — retention bases, legal holds, and shredding a key
-- rather than a row — and that does not exist yet. Until it does, a stray
-- `deleteMany` here is a real risk and an accepted one.
CREATE OR REPLACE FUNCTION facts_append_only() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.subject_type, NEW.subject_id, NEW.party_id, NEW.predicate,
         NEW.subject_key, NEW.value, NEW.source_kind, NEW.confidence,
         NEW.asserted_by_principal_id, NEW.observed_at, NEW.recorded_at,
         NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.subject_type, OLD.subject_id, OLD.party_id, OLD.predicate,
         OLD.subject_key, OLD.value, OLD.source_kind, OLD.confidence,
         OLD.asserted_by_principal_id, OLD.observed_at, OLD.recorded_at,
         OLD.expires_at)
  THEN
    RAISE EXCEPTION 'facts is append-only: only superseded_by_id, retracted_at and retraction_reason may change (fact %)', OLD.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER facts_append_only_update
  BEFORE UPDATE ON "facts"
  FOR EACH ROW EXECUTE FUNCTION facts_append_only();

-- 2. An AI agent may not assert that something is verified.
--
-- This is the central AI-safety rule of the whole model, expressed as a
-- constraint instead of a policy. An agent that fills a gap with a plausible
-- value turns "we do not know" into "we checked and you passed", which is the
-- single failure this product exists to prevent. VERIFIED and VALIDATED_D1C
-- are claims about evidence somebody else produced; an agent may infer, it may
-- estimate, and it may not certify.
--
-- It cannot be a CHECK constraint because the principal's kind lives in
-- another table.
CREATE OR REPLACE FUNCTION facts_ai_may_not_verify() RETURNS trigger AS $$
DECLARE
  actor_kind "PrincipalKind";
BEGIN
  IF NEW.confidence NOT IN ('VERIFIED', 'VALIDATED_D1C') THEN
    RETURN NEW;
  END IF;

  SELECT kind INTO actor_kind FROM "principals" WHERE id = NEW.asserted_by_principal_id;

  IF actor_kind = 'AI_AGENT' THEN
    RAISE EXCEPTION 'an AI principal may not assert confidence % (fact on predicate %)', NEW.confidence, NEW.predicate;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER facts_ai_may_not_verify_ins
  BEFORE INSERT ON "facts"
  FOR EACH ROW EXECUTE FUNCTION facts_ai_may_not_verify();

-- 3. `party_id` is set exactly when the subject is a party.
--
-- Without it the foreign key is decorative: a fact about a property could
-- carry a party id, and a fact about a party could carry none and escape the
-- cascade that makes account deletion total.
ALTER TABLE "facts" ADD CONSTRAINT "facts_party_id_matches_subject"
  CHECK (
    (subject_type = 'PARTY' AND party_id IS NOT NULL AND party_id = subject_id)
    OR (subject_type <> 'PARTY' AND party_id IS NULL)
  );

-- 4. A borrower principal names a party; nothing else does.
ALTER TABLE "principals" ADD CONSTRAINT "principals_party_id_matches_kind"
  CHECK ((kind = 'BORROWER') = (party_id IS NOT NULL));
