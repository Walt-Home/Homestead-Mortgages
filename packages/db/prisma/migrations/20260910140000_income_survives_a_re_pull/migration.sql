-- Desktop Underwriter expects to recognize the same income across resubmissions
-- of one loan, and it links income items to employers as first-class entities.
-- Ours were keyed to the loan file and nothing else, deleted wholesale and
-- recreated on every pull, so every income source took a new primary key each
-- time and nothing could be matched across two submissions.
--
-- No vendor gives us a stable per-item identifier on any path we ship: the port
-- carries one id and it is per REPORT; Plaid's CRA income product exposes no
-- income-stream id the adapter declares, and its employer identity is a name
-- string — a scrubbed, three-word transaction memo in Assets mode. So identity
-- is DERIVED, the rule that derived it is recorded on the row, and the ways a
-- derived key collides are written down beside the function that builds it.

-- ─── Employers: party-keyed, because an employer is a thing in the world ────
--
-- Not file-keyed. The same person's second application is about the same job,
-- and identity in this product belongs to the party — a borrower row "holds
-- nothing that identifies anyone". Income and employment rows stay per file
-- because continuance is a judgment about THIS loan and evidence documents are
-- on THIS file; only the employer they point at is shared.
CREATE TABLE "employers" (
    "id" UUID NOT NULL,
    "party_id" UUID NOT NULL,

    -- What two pulls compare to decide they mean the same employer:
    -- 'ein:<digits>' when a vendor gave one, 'name:<normalized>' otherwise.
    "identity_key" TEXT NOT NULL,
    -- Which rule produced the key, so a row derived from a bank memo is
    -- identifiable as one without re-deriving it. 'ein' or 'name'.
    "derived_from" TEXT NOT NULL,
    -- The 'name:' key this employer would have had with no EIN in hand,
    -- written once and never rewritten. Matching has to work in BOTH
    -- directions across the promotion: payroll moves 'identity_key' to the
    -- 'ein:' form, and a bank pull afterwards derives only a name — which
    -- would find nothing and open a second row for one job, giving the income
    -- and employment rows behind it new primary keys on a resubmission. So an
    -- EIN improves a row's key; it does not hide the row from the path that
    -- has no EIN.
    "name_key" TEXT NOT NULL,

    "ein" TEXT,
    "display_name" TEXT NOT NULL,

    "first_seen_snapshot_id" UUID,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "employers_party_identity_key" ON "employers"("party_id", "identity_key");
CREATE INDEX "employers_party" ON "employers"("party_id");
-- Deliberately NOT unique. Two employers under one party can share a name key
-- and still be two employers — two EINs filed under one trade name — and a
-- unique index here would make the pull that reports the second one fail
-- rather than record it. The lookup takes the oldest row instead, which is
-- stable across pulls; only 'identity_key' is a promise of uniqueness.
CREATE INDEX "employers_party_name" ON "employers"("party_id", "name_key");

-- CASCADE from the party: an employer row is a record about a person's job and
-- goes when they close their account.
ALTER TABLE "employers" ADD CONSTRAINT "employers_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL, not CASCADE: erasing the report we first learned of an employer
-- from must not erase the employer. Nothing deletes an individual snapshot
-- today; a whole-file cascade removes both regardless of the order it picks.
ALTER TABLE "employers" ADD CONSTRAINT "employers_first_seen_snapshot_id_fkey"
  FOREIGN KEY ("first_seen_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "employers" ADD CONSTRAINT "employers_derived_from_known"
  CHECK ("derived_from" IN ('ein', 'name'));
-- An 'ein:' key without an EIN, or an EIN filed under a name key, is a row
-- whose identity does not match its own evidence.
ALTER TABLE "employers" ADD CONSTRAINT "employers_key_matches_its_rule"
  CHECK (("derived_from" = 'ein' AND "ein" IS NOT NULL AND "identity_key" LIKE 'ein:%')
      OR ("derived_from" = 'name' AND "identity_key" LIKE 'name:%'));
-- An unpromoted row's two keys are the same key, and promotion is the only
-- thing that makes them differ. That is what lets 'name_key' be trusted as the
-- fallback: a row found by it is the row a lookup by 'identity_key' would have
-- found before the EIN arrived.
ALTER TABLE "employers" ADD CONSTRAINT "employers_name_key_survives_promotion"
  CHECK ("name_key" LIKE 'name:%'
     AND ("derived_from" = 'ein' OR "identity_key" = "name_key"));

-- ─── The person, on both derived tables ─────────────────────────────────────
--
-- Whose income this is. The rows stay per file, but the person they are about
-- is the party — which is what lets a re-pull recognize the same person's
-- income, and what stops a co-borrower's pull from deleting the primary
-- borrower's rows the way `deleteMany({ where: { loanFileId } })` did.
ALTER TABLE "income_sources" ADD COLUMN "party_id" UUID;
ALTER TABLE "employments"    ADD COLUMN "party_id" UUID;

-- The file's first borrower, ordered the way every route that reads
-- `borrowers[0]` and means "the person whose request this is" already orders
-- them. That is who wrote every one of these rows: both pull routes name
-- `file.borrowers[0]?.partyId`.
UPDATE "income_sources" s SET "party_id" = (
  SELECT b."party_id" FROM "borrowers" b
   WHERE b."loan_file_id" = s."loan_file_id"
   ORDER BY b."created_at" ASC, b."id" ASC LIMIT 1);
UPDATE "employments" e SET "party_id" = (
  SELECT b."party_id" FROM "borrowers" b
   WHERE b."loan_file_id" = e."loan_file_id"
   ORDER BY b."created_at" ASC, b."id" ASC LIMIT 1);

-- Fails loudly rather than guessing, if any row's file has no borrower on it.
ALTER TABLE "income_sources" ALTER COLUMN "party_id" SET NOT NULL;
ALTER TABLE "employments"    ALTER COLUMN "party_id" SET NOT NULL;

ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "employments" ADD CONSTRAINT "employments_party_id_fkey"
  FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "income_sources_party" ON "income_sources"("party_id");
CREATE INDEX "employments_party"    ON "employments"("party_id");

-- ─── What a re-pull matches on ──────────────────────────────────────────────
--
-- Rows written before matching existed carry a 'legacy:' key nothing will ever
-- match. That is deliberate and it is what makes this commit behavior-preserving
-- on the day it ships: the first pull afterwards reports none of those keys, so
-- it retires every legacy row — exactly what the DELETE it replaces did — and
-- writes matched rows in their place. Identity begins at that pull.
ALTER TABLE "income_sources" ADD COLUMN "identity_key" TEXT;
UPDATE "income_sources" SET "identity_key" = 'legacy:' || "id"::text WHERE "identity_key" IS NULL;
ALTER TABLE "income_sources" ALTER COLUMN "identity_key" SET NOT NULL;

-- An employment's identity IS its employer, so it needs no key of its own.
-- NULL on legacy rows, and NULLs are distinct in a Postgres unique index, so
-- those rows conflict with nothing while they wait to be retired.
ALTER TABLE "employments" ADD COLUMN "employer_id" UUID;
ALTER TABLE "employments" ADD CONSTRAINT "employments_employer_id_fkey"
  FOREIGN KEY ("employer_id") REFERENCES "employers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "employments_employer" ON "employments"("employer_id");

ALTER TABLE "income_sources" ADD COLUMN "employer_id" UUID;
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_employer_id_fkey"
  FOREIGN KEY ("employer_id") REFERENCES "employers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "income_sources_employer" ON "income_sources"("employer_id");

-- The match. It spans retired rows on purpose: an income that goes away and
-- comes back is one income, so the second pull that reports it REVIVES the row
-- rather than inserting a twin, and this index is what forces that.
CREATE UNIQUE INDEX "income_sources_file_party_identity_key"
  ON "income_sources"("loan_file_id", "party_id", "identity_key");
CREATE UNIQUE INDEX "employments_file_party_employer_key"
  ON "employments"("loan_file_id", "party_id", "employer_id");

-- ─── Which report each number came from ─────────────────────────────────────
--
-- connector_snapshots.external_id is the vendor's own report id, written by one
-- function and until now read by nothing. These columns give it its first
-- reader: a figure on a decision names the report behind it in one join.
--
-- NULLABLE because it must be. Every row already in these tables was written
-- before this commit and genuinely has no traceable report; NOT NULL would
-- force the migration to invent a provenance or to delete data. The guarantee
-- is enforced where it can be true — at the writers, by a test.
--
-- `first_seen` answers when we first saw this income; `last_seen` answers which
-- report the numbers on the row come from NOW, and moves on every matched pull
-- even when the numbers are identical. One column would answer half the
-- question.
ALTER TABLE "income_sources" ADD COLUMN "first_seen_snapshot_id" UUID;
ALTER TABLE "income_sources" ADD COLUMN "last_seen_snapshot_id"  UUID;
ALTER TABLE "employments"    ADD COLUMN "first_seen_snapshot_id" UUID;
ALTER TABLE "employments"    ADD COLUMN "last_seen_snapshot_id"  UUID;

-- ─── Superseded, not deleted ────────────────────────────────────────────────
--
-- A pull retires the rows for that (file, party) it did not report. Keeping
-- them rather than deleting them is what makes "your situation changed" a diff
-- for income the way it already is for snapshots — and you cannot diff against
-- a row you deleted.
--
-- The reader must filter on this IN THE QUERY. Seven applicability predicates
-- are shaped `length === 0 ? null : some(...)`, so a retired row visible to the
-- projection turns a "cannot know yet" into a definite "yes" and makes the
-- satisfied count go backwards.
ALTER TABLE "income_sources" ADD COLUMN "retired_at" TIMESTAMP(3);
ALTER TABLE "income_sources" ADD COLUMN "retired_by_snapshot_id" UUID;
ALTER TABLE "employments"    ADD COLUMN "retired_at" TIMESTAMP(3);
ALTER TABLE "employments"    ADD COLUMN "retired_by_snapshot_id" UUID;

-- SET NULL on all six snapshot edges, and never CASCADE: erasing a report must
-- not erase the income an underwriter already read. The whole-file cascade
-- removes both sides regardless of the order Postgres picks.
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_first_seen_snapshot_id_fkey"
  FOREIGN KEY ("first_seen_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_last_seen_snapshot_id_fkey"
  FOREIGN KEY ("last_seen_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_retired_by_snapshot_id_fkey"
  FOREIGN KEY ("retired_by_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "employments" ADD CONSTRAINT "employments_first_seen_snapshot_id_fkey"
  FOREIGN KEY ("first_seen_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "employments" ADD CONSTRAINT "employments_last_seen_snapshot_id_fkey"
  FOREIGN KEY ("last_seen_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "employments" ADD CONSTRAINT "employments_retired_by_snapshot_id_fkey"
  FOREIGN KEY ("retired_by_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NO CHECK that a retirement names its cause, and that is deliberate rather
-- than an omission. `retired_by_snapshot_id` is ON DELETE SET NULL, and a
-- referential action is an UPDATE — the same fact loans_refinanced_names_its_
-- successor is a trigger on the MOVE rather than a CHECK on the row for. A
-- CHECK here would refuse that write from inside somebody else's DELETE and
-- make the row undeletable by any path. The writer sets both together in one
-- statement inside the pull's transaction, and a test asserts it.

-- ─── Timestamps, so "which row is this file's first" stops depending on the
-- planner ───────────────────────────────────────────────────────────────────
-- DEFAULT then DROP DEFAULT is the only way to add a NOT NULL updated_at to a
-- table that already has rows; Prisma writes the value from the client and
-- expects no database default.
ALTER TABLE "income_sources" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "income_sources" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "income_sources" ALTER COLUMN "updated_at" DROP DEFAULT;
ALTER TABLE "employments" ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "employments" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "employments" ALTER COLUMN "updated_at" DROP DEFAULT;

-- ─── The report id gets its first reader, in both directions ────────────────
-- Joining a row to its snapshot uses the primary key. This index answers the
-- other question — which numbers came out of vendor report X — which is the one
-- an underwriter asks when a vendor issues a correction.
CREATE INDEX "connector_snapshots_external_id" ON "connector_snapshots"("external_id");
