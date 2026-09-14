-- Vesting, and the parties who are not borrowers.
--
-- `DEAL/PARTIES/PARTY` is `1:10` with the note "Each Deal must have at least one
-- party (non-Borrower) and no more than 10 Parties", and a submission made only
-- of borrowers satisfies neither half. Measured across the eighteen shipped
-- samples: Borrower 31, LoanOriginationCompany 18 in 18 files, LoanOriginator 18
-- in 18 files, PropertyOwner 12 in 9 files, NotePayTo 9 in 8, and
-- HousingCounselingAgency 6 in 6. Every single file carries an origination
-- company and an originator, so a round trip over this corpus cannot pass
-- without these two tables.
--
-- They are TWO tables and not one because the corpus says they are two kinds of
-- thing. All twelve `PropertyOwner` parties are `INDIVIDUAL`s whose
-- `NAME/FullName` holds a vesting sentence -- "Andy America and Amy America and
-- Ken N Customer JR" in DI-C09 -- with no taxpayer identifier and no arc
-- pointing at them. MISMO does not model co-titleholding relationally, so
-- storing the sentence is closer to the wire than inventing a person; the other
-- four roles are real institutions and one real employee, and they carry a
-- license, which no borrower ever does.
--
-- Additive. Nothing writes either table yet.

-- ─── The enumerated types ──────────────────────────────────────────────────
-- Hand-typed in schema.prisma and diffed against the DU Specification by
-- `npm run du:verify`, which fails on a member either file has and the other
-- does not. `DuDealPartyRole` is `PartyRoleType` minus four values, each named
-- in `DU_DATA_POINT_FOR_ENUM` with the reason it is elsewhere or nowhere.
CREATE TYPE "DuPropertyOwnerStatus" AS ENUM ('Current', 'Proposed');

CREATE TYPE "DuVestingType" AS ENUM ('Individual', 'JointTenantsWithRightOfSurvivorship', 'LifeEstate', 'Other', 'TenantsByTheEntirety', 'TenantsInCommon');

CREATE TYPE "DuLicenseAuthorityLevel" AS ENUM ('Private', 'PublicState');

CREATE TYPE "DuDealPartyRole" AS ENUM ('LoanOriginationCompany', 'LoanOriginator', 'NotePayTo', 'HousingCounselingAgency');

-- ─── 1. How title reads ────────────────────────────────────────────────────
CREATE TABLE "du_vestings" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,

    -- L2.1 is the proposed vesting and L2.2 the current one. Nine samples carry
    -- a proposed, three of those also carry a current, and none carries two of
    -- either -- which is why the unique index below is over the status.
    "status" "DuPropertyOwnerStatus" NOT NULL,

    -- The vesting string, verbatim. Not parsed into names: the moment this is
    -- split on " and " it stops being what will read on title.
    "full_name" TEXT NOT NULL,

    -- L2.4. Null where title names one person and there is no relationship to
    -- state -- three of the twelve sample owners carry no vesting type.
    "vesting_type" "DuVestingType",

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "du_vestings_pkey" PRIMARY KEY ("id")
);

-- A vesting string with nothing in it emits an empty `FullName`, which is the
-- one thing this row exists to carry.
ALTER TABLE "du_vestings"
  ADD CONSTRAINT "du_vestings_name_is_not_blank" CHECK (btrim("full_name") <> '');

CREATE UNIQUE INDEX "du_vestings_one_per_status" ON "du_vestings" ("application_id", "status");

ALTER TABLE "du_vestings" ADD CONSTRAINT "du_vestings_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 2. Everyone on the deal who is not a borrower ─────────────────────────
CREATE TABLE "du_deal_parties" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,

    "role" "DuDealPartyRole" NOT NULL,

    -- A company's `LEGAL_ENTITY/LEGAL_ENTITY_DETAIL/FullName`, or a person's
    -- `INDIVIDUAL/NAME`. Which of the two a row may fill is the CHECK below.
    "legal_entity_name" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,

    -- `ROLE/LICENSES/LICENSE/LICENSE_DETAIL`: the number, and the register it
    -- came from.
    "license_identifier" TEXT,
    "license_authority_type" "DuLicenseAuthorityLevel",

    -- `PARTY_ROLE_IDENTIFIER`, where a role carries its own id rather than a
    -- license.
    "party_role_identifier" TEXT,

    "address_line_text" TEXT,
    "city_name" TEXT,
    "state_code" TEXT,
    "postal_code" TEXT,
    "contact_telephone" TEXT,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "du_deal_parties_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "du_deal_parties_by_application" ON "du_deal_parties" ("application_id");

ALTER TABLE "du_deal_parties" ADD CONSTRAINT "du_deal_parties_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A person's name and an entity's name are different elements, and the role
-- decides which one the emitter reaches for. `LoanOriginator` is the one
-- individual among these four -- all eighteen samples emit it as an INDIVIDUAL
-- and the other three as LEGAL_ENTITYs -- so a row holding both names, or the
-- wrong one, is a row the emitter cannot place.
--
-- Both sides stay nullable rather than requiring a name, because two of the
-- eighteen origination companies carry no name element at all. This says which
-- name a row may have, not that it must have one.
--
-- `NotePayTo` is the one role the specification does not settle, and this CHECK
-- settles it anyway. DU Map 4b.1 "Creditor Name" gives it BOTH containers --
-- `PARTY/LEGAL_ENTITY/LEGAL_ENTITY_DETAIL/FullName` and
-- `PARTY/INDIVIDUAL/NAME/FullName` -- and the Enumerations tab defines the role
-- as "The individual or legal entity whose name appears on a note to whom the
-- repayment of the obligation is due". So the seller carryback and the private
-- second, which are the concurrent subordinate financing this role exists for,
-- have a person as the note holder, and this table refuses to record one.
--
-- That is a decision rather than an oversight. DU's individual slot at 4b.1 is
-- an UNPARSED `NAME/FullName`, which the parsed first/last columns above cannot
-- express, and all nine NotePayTo parties in the corpus are institutions. What
-- a private note holder needs is that unparsed name -- the shape `du_vestings`
-- already holds -- and not a relaxation of this CHECK.
ALTER TABLE "du_deal_parties"
  ADD CONSTRAINT "du_deal_parties_name_matches_the_role" CHECK (
    CASE WHEN "role" = 'LoanOriginator'
      THEN "legal_entity_name" IS NULL
      ELSE "first_name" IS NULL AND "last_name" IS NULL
    END
  );

-- The two origination roles carry a license and the other two do not, which is
-- the same shape as the connector guard split: required here, refused there,
-- rather than a nullable column that means nothing in particular. All eighteen
-- samples carry exactly one license on the company and one on the originator,
-- and zero on the nine NotePayTo and six HousingCounselingAgency parties -- the
-- DU form has no license field for either, so a number stored on one would be
-- emitted nowhere.
ALTER TABLE "du_deal_parties"
  ADD CONSTRAINT "du_deal_parties_origination_roles_are_licensed" CHECK (
    ("role" IN ('LoanOriginationCompany','LoanOriginator')) = ("license_identifier" IS NOT NULL)
  ),
  -- And a number without a register does not say which register it is from.
  -- All thirty-six licenses in the corpus carry a `LicenseAuthorityLevelType`.
  ADD CONSTRAINT "du_deal_parties_a_license_says_which_register" CHECK (
    ("license_identifier" IS NULL) = ("license_authority_type" IS NULL)
  );

-- ─── 3. Ten parties, counted across all three sources ──────────────────────
-- `PARTY` is `1:10` per DEAL, and the ten is not ten of each: four borrowers,
-- two vestings, an origination company, an originator, a NotePayTo and a
-- counseling agency is exactly ten, and it is an ordinary file. The corpus's
-- fullest is DI-C09 at eight.
--
-- **It does not fire on `application_parties`, and that is the whole design
-- rather than an omission.** A count constraint keyed on rows the writer cannot
-- see is a lockout: the only writer that adds a borrowing party is
-- `ensureApplicationParty`, which runs inside every `POST /api/files` and every
-- consent, and knows nothing about vestings or deal parties. Refusing a
-- co-borrower because somebody recorded a counseling agency would be a failure
-- in the borrower flow caused by a table the borrower flow has never heard of.
--
-- The borrower side needs no ceiling of its own in any case:
-- `application_parties_borrower_ordinal_is_one_to_four` already caps it at
-- four, and borrowers are the first parties on a file -- an application is
-- created with its borrower before any of this exists. So the side that can
-- grow without a bound is the non-borrower side, and it is the side whose
-- writer is adding a party on purpose. That is where the check belongs.
--
-- The cost of that exemption is that a file CAN sit over ten, and such a file
-- has to stay editable. It is a write that ADDS a party which is refused here,
-- never an edit to a row already counted -- see the first line of the function
-- -- because refusing a correction to the vesting sentence on the grounds that
-- somebody else added a fourth borrower is the lockout this whole arrangement
-- is avoiding. The honest over-ten file is the preflight's to refuse, before
-- anything reaches DU, the same division of labor the fifty-row container caps
-- already make.
--
-- It is not a serialization point, and it errs in both directions. Two
-- transactions inserting concurrently can both pass, because each counts at its
-- own COMMIT and neither sees the other's uncommitted row. The same snapshot
-- cuts the other way: a swap split across two writers -- one deleting the
-- counseling agency, the other recording its replacement -- can be refused even
-- though the committed end state would have been ten, because the count taken
-- at COMMIT cannot see an uncommitted delete. The refusal is retryable, and a
-- swap that runs in ONE transaction is the supported shape.
--
-- AFTER INSERT OR UPDATE and DEFERRABLE INITIALLY DEFERRED, so that one
-- transaction may delete a deal party and insert another without tripping on
-- the order the writer chose, and so that moving a row to another application
-- is counted where it lands.
CREATE OR REPLACE FUNCTION du_parties_fit_ten() RETURNS trigger AS $$
DECLARE borrowing INT; vesting INT; deal INT;
BEGIN
    -- An UPDATE that leaves the row on the application it was already on cannot
    -- be what took the file over ten: the row is in the count either way. Not
    -- an optimization -- without this line every later write to these two
    -- tables is refused on any file that is already over, and Prisma stamps
    -- `updated_at` on every save, so "every later write" means every save.
    IF TG_OP = 'UPDATE' AND NEW.application_id IS NOT DISTINCT FROM OLD.application_id THEN
        RETURN NULL;
    END IF;

    SELECT count(*) INTO borrowing FROM "application_parties"
        WHERE application_id = NEW.application_id
          AND role IN ('PRIMARY_BORROWER','CO_BORROWER','NON_OCCUPANT_CO_BORROWER');
    SELECT count(*) INTO vesting FROM "du_vestings" WHERE application_id = NEW.application_id;
    SELECT count(*) INTO deal FROM "du_deal_parties" WHERE application_id = NEW.application_id;
    -- `> 10`, not `>= 10`: the row being checked is already in one of the three
    -- counts.
    IF borrowing + vesting + deal > 10 THEN
        RAISE EXCEPTION 'DEAL/PARTIES/PARTY is 1:10 and application % would emit % parties: % borrowing, % vesting, % other',
            NEW.application_id, borrowing + vesting + deal, borrowing, vesting, deal;
    END IF;
    RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER du_vestings_fit_the_party_ceiling
    AFTER INSERT OR UPDATE ON "du_vestings"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_parties_fit_ten();

CREATE CONSTRAINT TRIGGER du_deal_parties_fit_the_party_ceiling
    AFTER INSERT OR UPDATE ON "du_deal_parties"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_parties_fit_ten();

COMMENT ON TABLE "du_vestings" IS
  'URLA L2.1 and L2.2. A vesting STRING as it will read on title -- DU emits it as a PropertyOwner party whose FullName is a sentence -- not a person and not a row anything arcs to.';

COMMENT ON TABLE "du_deal_parties" IS
  'DEAL/PARTIES/PARTY for everyone who is not a borrower, which is the MIN-1 the borrower rows do not satisfy. Counts against the same ten-party ceiling they do.';
