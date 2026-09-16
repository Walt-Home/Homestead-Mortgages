-- What V1 takes, said where a new route cannot forget it.
--
-- Two scope decisions, both the owner's, both arriving here rather than only in
-- a zod enum: a schema that lives in one route is a promise the next route does
-- not make.
--
--   1. Conventional purchase and simple rate-and-term refinance only. No
--      cash-out.
--   2. A co-signer is a NON_OCCUPANT_CO_BORROWER and not a GUARANTOR.
--
-- They are one migration because they are one sentence about what a V1
-- application may be, and splitting them would leave two halves of a scope
-- nobody can read together.

-- ── 1. No new file may be a cash-out refinance ─────────────────────────────
--
-- A TRIGGER and not a CHECK, and the difference is what happens to a file that
-- already says CASH_OUT_REFINANCE. A CHECK is asserted over every row: adding
-- one would either fail the migration on such a file or have to be written NOT
-- VALID, which is a constraint that says it is not being kept. The trigger
-- refuses a row that ARRIVES in cash-out and a row that MOVES into it, and
-- leaves one already sitting there alone.
--
-- That is the decision about existing files, and it is deliberate. Nobody
-- rewrites a borrower's stated purpose behind their back -- a file saying
-- cash-out is what that person asked us for, and silently turning it into a
-- rate-and-term would be the system putting words in their mouth. Such a file
-- keeps its purpose, it can still be read, and screen 1 will not save it again
-- until the borrower picks a loan we underwrite. No persona is in that state:
-- all eight seeded files are PURCHASE or RATE_TERM_REFINANCE.
--
-- `loan_scenarios.objective` is deliberately NOT given the same trigger. A
-- scenario mirrors the file's purpose, so the door is the file; a second
-- refusal one table down would make an already-cash-out file impossible to
-- edit at all, which is a worse answer than the one above.
--
-- The enum member stays. Cash-out is a later version, and so are
-- `loan_files.cash_to_borrower` and `loan_files.cash_out_purpose`, which is why
-- neither column is dropped: what goes is the offer, not the shape. A file
-- moved OUT of cash-out keeps whatever those two hold, and nothing is cleared:
-- every reader of them is gated on the purpose -- AST-012's applicability, the
-- LTV ceiling and the pricing adjustment all ask `cash_out_refinance` first --
-- so the figures are inert rather than wrong, and erasing what a borrower told
-- us is a larger act than leaving it unread.
CREATE OR REPLACE FUNCTION loan_files_v1_scope() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.purpose = 'CASH_OUT_REFINANCE'
     AND (TG_OP = 'INSERT' OR OLD.purpose IS DISTINCT FROM NEW.purpose) THEN
    RAISE EXCEPTION
      'V1 underwrites a conventional purchase or a rate-and-term refinance. A cash-out refinance is out of scope, so no file may be opened in one or moved into one.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loan_files_v1_scope
  BEFORE INSERT OR UPDATE OF purpose ON "loan_files"
  FOR EACH ROW EXECUTE FUNCTION loan_files_v1_scope();

COMMENT ON COLUMN "loan_files"."purpose" IS
  'What the borrower is asking for. V1 takes PURCHASE and RATE_TERM_REFINANCE; loan_files_v1_scope refuses a row arriving in or moving to CASH_OUT_REFINANCE, and a file already in it keeps what it says.';

-- ── 2. A co-signer is a borrower, so GUARANTOR goes ────────────────────────
--
-- Desktop Underwriter's party vocabulary has eight values -- Borrower,
-- PropertyOwner, HousingCounselingAgency, SubmittingParty, NotePayTo,
-- LoanOriginationCompany, LoanOriginator, Trust -- and none of them is a
-- guarantor. Neither does MISMO: the only "Guarantor" anywhere in the vendored
-- schema chain is a value of ExecutionBase, which is how an investor bought a
-- loan. So a guarantor cannot be conveyed at all.
--
-- What people call a co-signer on an agency conventional loan signs the note,
-- appears on the URLA and reaches DU as a Borrower. That is
-- NON_OCCUPANT_CO_BORROWER, which already exists, already takes a
-- borrower_ordinal and already counts against the four.
--
-- The role is REMOVED rather than refused at the preflight, for two reasons.
-- The preflight would never see one: the assembler loads only parties carrying
-- a borrower_ordinal, application_parties_borrowers_are_numbered guarantees a
-- GUARANTOR has none, and the person is dropped before the gate runs. Making
-- the gate refuse them would mean widening the assembler to load a row in order
-- to reject it. And a role whose only remedy is to delete the edge and re-add
-- the person under a different one is a role that should not have been
-- writable: the invariant belongs here.
--
-- `ImportedPartySchema` in packages/shared keeps GUARANTOR, and that is not an
-- inconsistency. It describes what a servicer may SEND about a loan somebody
-- else originated, where a guarantor is a real thing on their paper. Nothing
-- maps that feed onto these rows yet, and the importer that does will have to
-- decide what a guarantor becomes -- which is exactly the decision this enum
-- not carrying the value forces, instead of letting one land as a party no
-- submission can name.
DO $$
DECLARE bad TEXT;
BEGIN
  SELECT string_agg(DISTINCT application_id::text, ', ') INTO bad
    FROM "application_parties" WHERE "role" = 'GUARANTOR';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'These applications hold a GUARANTOR, who is a non-occupant co-borrower on an agency conventional loan. Move them before this migration can run: %', bad;
  END IF;
  SELECT string_agg(DISTINCT loan_id::text, ', ') INTO bad
    FROM "loan_parties" WHERE "role" = 'GUARANTOR';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'These loans hold a GUARANTOR and nothing here can submit one: %', bad;
  END IF;
END $$;

-- Postgres cannot drop a value from an enum, so the type is rebuilt and both
-- columns are moved onto it. The three trigger functions that DECLARE a local
-- of this type name it by name and resolve it at execution, so they follow the
-- new type without being rewritten; a local variable is not a dependency the
-- catalog tracks, which is what lets the old type be dropped at all.
--
-- The two triggers below ARE dependencies, because both are declared `UPDATE OF
-- role` and one of them tests the column in its WHEN clause. Postgres refuses
-- to retype a column a trigger definition names, so they come off and go back
-- on VERBATIM -- same timing, same events, same condition, same function. A
-- rewrite here would fold a change to the receipt rule into a migration about a
-- role nobody holds.
--
-- And the CHECK that says a borrowing role carries a position is a third
-- dependency, for a subtler reason: its three literals were bound to the OLD
-- type when it was created, and a retyped column compared against them is an
-- operator Postgres does not have. It goes back on verbatim too, so the rule it
-- states -- borrowing role if and only if numbered -- is the same rule.
DROP TRIGGER "application_parties_receipt_write" ON "application_parties";
DROP TRIGGER "application_parties_keep_their_du_rows_valid_update" ON "application_parties";
ALTER TABLE "application_parties" DROP CONSTRAINT "application_parties_borrowers_are_numbered";

ALTER TYPE "ApplicationPartyRole" RENAME TO "ApplicationPartyRole_without_a_guarantor";
CREATE TYPE "ApplicationPartyRole" AS ENUM (
  'PRIMARY_BORROWER', 'CO_BORROWER', 'NON_OCCUPANT_CO_BORROWER', 'NON_BORROWING_SPOUSE'
);
ALTER TABLE "application_parties"
  ALTER COLUMN "role" TYPE "ApplicationPartyRole"
  USING "role"::text::"ApplicationPartyRole";
ALTER TABLE "loan_parties"
  ALTER COLUMN "role" TYPE "ApplicationPartyRole"
  USING "role"::text::"ApplicationPartyRole";
DROP TYPE "ApplicationPartyRole_without_a_guarantor";

ALTER TABLE "application_parties"
  ADD CONSTRAINT "application_parties_borrowers_are_numbered" CHECK (
    ("role" IN ('PRIMARY_BORROWER','CO_BORROWER','NON_OCCUPANT_CO_BORROWER'))
      = ("borrower_ordinal" IS NOT NULL)
  );

CREATE TRIGGER application_parties_receipt_write
  AFTER INSERT OR UPDATE OF role ON "application_parties"
  FOR EACH ROW WHEN (NEW.role = 'PRIMARY_BORROWER')
  EXECUTE FUNCTION application_parties_receipt();

CREATE TRIGGER application_parties_keep_their_du_rows_valid_update
  BEFORE UPDATE OF role ON "application_parties"
  FOR EACH ROW EXECUTE FUNCTION application_parties_keep_their_du_rows_valid();

COMMENT ON COLUMN "application_parties"."role" IS
  'What this person is to the credit request. A co-signer is NON_OCCUPANT_CO_BORROWER: they sign the note and Desktop Underwriter sees a Borrower. There is no guarantor, because no party role in the MISMO chain is one.';
