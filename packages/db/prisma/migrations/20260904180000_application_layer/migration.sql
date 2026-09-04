-- The application layer: applications, their parties, and the transition ledger.
--
-- Additive. The four screens still run on `loan_files`; nothing here is wired
-- to a route yet. See docs/states.md.

-- CreateEnum
CREATE TYPE "ApplicationState" AS ENUM ('DRAFT', 'INTAKE_RECEIVED', 'IN_PROCESSING', 'AWAITING_BORROWER', 'SUSPENDED', 'IN_UNDERWRITING', 'COUNTEROFFER_OUTSTANDING', 'CONDITIONALLY_APPROVED', 'APPROVED', 'CLEAR_TO_CLOSE', 'CLOSING', 'RESCISSION_PENDING', 'FUNDED', 'ADVERSE_ACTION_PENDING', 'DENIED', 'INCOMPLETE_CLOSED', 'WITHDRAWN', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApplicationPartyRole" AS ENUM ('PRIMARY_BORROWER', 'CO_BORROWER', 'NON_OCCUPANT_CO_BORROWER', 'NON_BORROWING_SPOUSE', 'GUARANTOR');

-- CreateTable
CREATE TABLE "applications" (
    "id" UUID NOT NULL,
    "status" "ApplicationState" NOT NULL DEFAULT 'DRAFT',
    "status_seq" INTEGER NOT NULL DEFAULT 0,
    "status_entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_parties" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "role" "ApplicationPartyRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_transitions" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "from_state" "ApplicationState",
    "to_state" "ApplicationState" NOT NULL,
    "event" TEXT NOT NULL,
    "actor_principal_id" UUID NOT NULL,
    "reason_code" TEXT,
    "caused_by" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "applications_status_status_entered_at_idx" ON "applications"("status", "status_entered_at");

-- CreateIndex
CREATE INDEX "application_parties_party_id_idx" ON "application_parties"("party_id");

-- CreateIndex
CREATE UNIQUE INDEX "application_parties_application_id_party_id_key" ON "application_parties"("application_id", "party_id");

-- CreateIndex
CREATE INDEX "application_transitions_application_id_occurred_at_idx" ON "application_transitions"("application_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "application_transitions_application_id_seq_key" ON "application_transitions"("application_id", "seq");

-- AddForeignKey
ALTER TABLE "application_parties" ADD CONSTRAINT "application_parties_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_parties" ADD CONSTRAINT "application_parties_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_transitions" ADD CONSTRAINT "application_transitions_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_transitions" ADD CONSTRAINT "application_transitions_actor_principal_id_fkey" FOREIGN KEY ("actor_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── The guarantees, in the database ────────────────────────────────────────

-- 1. A status change must advance the sequence.
--
-- This is what makes `prisma.application.update({ data: { status: 'APPROVED' }})`
-- fail. Without it that call typechecks, lints clean, passes every unit test
-- that mocks the database, and moves a file to approved with no record of who
-- did it or why — which is the failure the whole ledger exists to prevent.
CREATE OR REPLACE FUNCTION applications_status_moves_with_seq() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status_seq <> OLD.status_seq + 1 THEN
      RAISE EXCEPTION 'application % changed status without advancing status_seq (% -> %); use the transition service', OLD.id, OLD.status, NEW.status;
    END IF;
    IF NEW.status_entered_at IS NOT DISTINCT FROM OLD.status_entered_at THEN
      RAISE EXCEPTION 'application % changed status without stamping status_entered_at', OLD.id;
    END IF;
  ELSIF NEW.status_seq IS DISTINCT FROM OLD.status_seq THEN
    RAISE EXCEPTION 'application % advanced status_seq without changing status', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER applications_status_moves_with_seq_update
  BEFORE UPDATE ON "applications"
  FOR EACH ROW EXECUTE FUNCTION applications_status_moves_with_seq();

-- 2. An ending is an ending, at the storage layer too.
--
-- The machine in packages/shared already refuses to leave a terminal state, and
-- this says the same thing where a raw SQL fix-up would otherwise land. Belt
-- and braces on purpose: the two enforce it for different callers.
CREATE OR REPLACE FUNCTION applications_terminal_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('FUNDED','DENIED','INCOMPLETE_CLOSED','WITHDRAWN','CANCELED','EXPIRED')
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'application % is % and cannot be reopened; start a new application', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER applications_terminal_is_final_update
  BEFORE UPDATE ON "applications"
  FOR EACH ROW EXECUTE FUNCTION applications_terminal_is_final();

-- 3. A status change that does not write its ledger row fails at COMMIT.
--
-- DEFERRABLE INITIALLY DEFERRED, so the check runs at the end of the
-- transaction rather than at the statement. That is the only point at which
-- "did this transaction also record why" is answerable — the update and the
-- insert can happen in either order, and both are legitimate.
--
-- Trigger 1 forces a caller to advance the sequence; this one forces them to
-- explain it. Together they mean the ledger cannot drift from the column.
CREATE OR REPLACE FUNCTION applications_status_has_a_ledger_row() RETURNS trigger AS $$
BEGIN
  IF NEW.status_seq = 0 THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "application_transitions"
    WHERE application_id = NEW.id AND seq = NEW.status_seq AND to_state = NEW.status
  ) THEN
    RAISE EXCEPTION 'application % is at % (seq %) with no matching transition row; the move was never explained', NEW.id, NEW.status, NEW.status_seq;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER applications_status_has_a_ledger_row_check
  AFTER INSERT OR UPDATE ON "applications"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION applications_status_has_a_ledger_row();

-- 4. The ledger is append-only.
CREATE OR REPLACE FUNCTION application_transitions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'application_transitions is append-only (% on %)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_transitions_append_only_update
  BEFORE UPDATE ON "application_transitions"
  FOR EACH ROW EXECUTE FUNCTION application_transitions_append_only();

-- No DELETE trigger, deliberately, and for the same reason `facts` has none:
-- the cascade from a party is what keeps "we remove your data for good" true,
-- and it runs through this table.

-- 5. The sequence starts at 1 and the ledger agrees with the column.
ALTER TABLE "application_transitions" ADD CONSTRAINT "application_transitions_seq_positive"
  CHECK (seq >= 1);
ALTER TABLE "applications" ADD CONSTRAINT "applications_status_seq_not_negative"
  CHECK (status_seq >= 0);

-- 6. An application has at least one party by the time it is an application.
--
-- Not enforceable as a CHECK across tables, and a draft legitimately has none
-- for a moment. The transition INTO intake_received is where it belongs, and it
-- is a guard in the transition service rather than a constraint here.
