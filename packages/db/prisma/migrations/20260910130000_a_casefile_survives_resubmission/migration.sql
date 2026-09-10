-- Desktop Underwriter recognizes a resubmission by its casefile identifier: the
-- same loan submitted three to six times carries the same one, and a different
-- one opens a different case. Ours was minted per run in the decision route, so
-- every recomputation of one loan reached DU as a loan DU had never seen.
--
-- It lives on the application because a casefile identifies the CREDIT REQUEST
-- and the application is the credit request. 20260909100000 put the join on
-- loan_files' side so the column leaves with loan_files when the strangler
-- finishes; an identifier that must outlive that move cannot live on the row
-- that does not.
--
-- Minted when the application is born rather than on first submission. A
-- nullable column filled in by the first decision run makes that run a
-- read-modify-write on a table four triggers guard, and two concurrent runs
-- both read NULL under READ COMMITTED and both mint — leaving the loser's
-- decision row recording a casefile its own application does not carry.
ALTER TABLE "applications" ADD COLUMN "aus_casefile_id" TEXT;

-- Existing rows get one each. This is not a status write: every trigger on this
-- table watches `status` (two are BEFORE UPDATE and return early when status and
-- status_seq are unchanged; applications_intake_needs_a_borrower_write is
-- BEFORE INSERT OR UPDATE OF status and does not fire at all). The deferred
-- applications_status_has_a_ledger_row_check this UPDATE does queue is satisfied
-- by the transition row that moved each row to where it already is.
UPDATE "applications" SET "aus_casefile_id" = gen_random_uuid()::text
 WHERE "aus_casefile_id" IS NULL;

-- Fails loudly rather than guessing if the backfill missed a row.
ALTER TABLE "applications" ALTER COLUMN "aus_casefile_id" SET NOT NULL;

-- Two credit requests sharing a casefile is DU reading one as a resubmission of
-- the other — the same confusion in the opposite direction.
CREATE UNIQUE INDEX "applications_aus_casefile_id_key"
  ON "applications"("aus_casefile_id");

-- NOT NULL alone admits the empty string, which reaches a vendor as a missing
-- field rather than as a failed insert.
ALTER TABLE "applications" ADD CONSTRAINT "applications_casefile_is_not_blank"
  CHECK (length(btrim("aus_casefile_id")) > 0);

-- decisions.aus_casefile_id is deliberately untouched. Those rows record what
-- was actually submitted under; rewriting them would make the audit trail claim
-- a submission that never happened. A file decided before this migration shows
-- one identifier per old run and one stable identifier from the next run on.
