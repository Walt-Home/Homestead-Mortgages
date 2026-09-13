-- The declaration is asked, not derived.
--
-- URLA Section 5 is one container per borrower per credit request. Thirteen of
-- its data points are required by Desktop Underwriter -- twelve of them the NOT
-- NULL columns below, and the thirteenth citizenship, which is a pinned fact
-- rather than an answer to Section 5 -- and the wire format cannot say
-- "unanswered": every element is nillable, and nil is not an answer. So the
-- storage has to make an unanswered declaration unwritable rather than silently
-- completable, and has to make a derived one impossible.
--
-- Where the borrower lives comes with it, for the same reason and one worse:
-- `borrowers.current_housing` is asserted as "rent" by screen 2 and never
-- asked, and that fabrication is what would reach a federally submitted
-- application. This migration gives the real answer somewhere to go. It does
-- not touch `borrowers` -- that column is NOT NULL with a DEFAULT in the
-- database, so dropping either half before the route that asks the question
-- exists turns every borrower insert into a 500.
--
-- Additive. No route writes any of this yet.

-- ─── The enumerated types ──────────────────────────────────────────────────
-- Hand-typed in schema.prisma and diffed against the DU Specification by
-- `npm run du:verify`, which fails on a member either file has and the other
-- does not. A member that cannot be sourced is a file Fannie Mae rejects days
-- later, with no local symptom at all.
CREATE TYPE "DuYesNo" AS ENUM ('Yes', 'No');

CREATE TYPE "DuPropertyUsage" AS ENUM ('Investment', 'PrimaryResidence', 'SecondHome');

CREATE TYPE "DuPriorPropertyTitle" AS ENUM ('Sole', 'JointWithSpouse', 'JointWithOtherThanSpouse');

CREATE TYPE "DuBankruptcyChapter" AS ENUM ('ChapterSeven', 'ChapterEleven', 'ChapterTwelve', 'ChapterThirteen');

CREATE TYPE "DuResidencyType" AS ENUM ('Current', 'Prior');

CREATE TYPE "DuResidencyBasis" AS ENUM ('Own', 'Rent', 'LivingRentFree');

-- ─── The declaration ───────────────────────────────────────────────────────
-- Keyed on the application_parties edge, not on the party: the answer to "have
-- you declared bankruptcy in the past seven years" is different on a different
-- date, and the answer a submission relied on has to stay recoverable after the
-- borrower answers again.
--
-- Twelve of the answers are NOT NULL and that is the point. A nullable one
-- would let a half-answered declaration reach the serializer and be completed
-- with `false` on a document the borrower signs.
CREATE TABLE "du_declarations" (
    "id" UUID NOT NULL,
    "application_party_id" UUID NOT NULL,

    -- Who said it, and when. RESTRICT, and the two sweeps at the foot of this
    -- file are what keep that from making an account undeletable.
    "asserted_by_principal_id" UUID NOT NULL,
    "asserted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- 5a. This property and the money for this loan.
    "intent_to_occupy" "DuYesNo" NOT NULL,
    "homeowner_past_three_years" "DuYesNo",
    "prior_property_usage" "DuPropertyUsage",
    "prior_property_title" "DuPriorPropertyTitle",
    "fha_secondary_residence" BOOLEAN,
    "special_borrower_seller_relationship" BOOLEAN,
    "undisclosed_borrowed_funds" BOOLEAN NOT NULL,
    "undisclosed_borrowed_funds_cents" BIGINT,
    "undisclosed_mortgage_application" BOOLEAN NOT NULL,
    "undisclosed_credit_application" BOOLEAN NOT NULL,
    "property_proposed_clean_energy_lien" BOOLEAN NOT NULL,

    -- 5b. Finances. J, K and L were one question in the legacy dataset and are
    -- three independent required answers now.
    "undisclosed_comaker_of_note" BOOLEAN NOT NULL,
    "outstanding_judgments" BOOLEAN NOT NULL,
    "presently_delinquent" BOOLEAN NOT NULL,
    "party_to_lawsuit" BOOLEAN,
    "prior_property_deed_in_lieu_conveyed" BOOLEAN NOT NULL,
    "prior_property_short_sale_completed" BOOLEAN NOT NULL,
    "prior_property_foreclosure_completed" BOOLEAN NOT NULL,
    "bankruptcy" BOOLEAN NOT NULL,

    -- The borrower's own words. DU consumes no explanation element, so this is
    -- for the 1003, the underwriter and the file's own record.
    "explanations" JSONB,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "du_declarations_pkey" PRIMARY KEY ("id")
);

-- ─── Which chapters, when the borrower declared a bankruptcy ───────────────
-- A set, not a value and not a list of filings: URLA asks for the type(s), and
-- there are exactly four legal chapters. DU maps one element of the bankruptcy
-- detail and no other -- no date, no case number, no amount -- so there is
-- nothing else to carry.
CREATE TABLE "du_bankruptcy_filings" (
    "id" UUID NOT NULL,
    "declaration_id" UUID NOT NULL,
    "chapter" "DuBankruptcyChapter" NOT NULL,

    CONSTRAINT "du_bankruptcy_filings_pkey" PRIMARY KEY ("id")
);

-- ─── Where they live, and where they lived before ──────────────────────────
-- One current and one former, at most, which is what the unique pair below
-- says. The CURRENT address is not stored here -- it is the pinned
-- `current_address` fact on the party, so there is one storage and two
-- renderings. The PRIOR address is stored here, because no `prior_address`
-- predicate exists to read it from and inventing a durable fact for "where you
-- used to live" would be a new predicate, a new writer and a new pinning rule
-- in the service of one element on one application.
CREATE TABLE "du_residences" (
    "id" UUID NOT NULL,
    "application_party_id" UUID NOT NULL,
    "residency_type" "DuResidencyType" NOT NULL,
    "basis" "DuResidencyBasis" NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "monthly_rent_cents" BIGINT,
    "address_line_text" TEXT,
    "address_unit" TEXT,
    "city_name" TEXT,
    "state_code" TEXT,
    "postal_code" TEXT,
    "country_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "du_residences_pkey" PRIMARY KEY ("id")
);

-- One declaration per borrower per application.
CREATE UNIQUE INDEX "du_declarations_application_party_id_key" ON "du_declarations"("application_party_id");

-- The asserting principal is indexed for the same reason `facts` indexes its
-- own: the two BEFORE DELETE sweeps at the foot of this file key on it, once
-- per principal and once per party deleted, and without an index deleting an
-- account is a sequential scan of every declaration in the database per row.
CREATE INDEX "du_declarations_asserted_by_principal_id_idx" ON "du_declarations"("asserted_by_principal_id");

-- And the 0:4 maximum on chapters needs no constraint of its own: there are
-- exactly four legal chapters and this pair admits each of them once.
CREATE UNIQUE INDEX "du_bankruptcy_filings_declaration_id_chapter_key" ON "du_bankruptcy_filings"("declaration_id", "chapter");

CREATE UNIQUE INDEX "du_residences_application_party_id_residency_type_key" ON "du_residences"("application_party_id", "residency_type");

ALTER TABLE "du_declarations" ADD CONSTRAINT "du_declarations_application_party_id_fkey" FOREIGN KEY ("application_party_id") REFERENCES "application_parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_declarations" ADD CONSTRAINT "du_declarations_asserted_by_principal_id_fkey" FOREIGN KEY ("asserted_by_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "du_bankruptcy_filings" ADD CONSTRAINT "du_bankruptcy_filings_declaration_id_fkey" FOREIGN KEY ("declaration_id") REFERENCES "du_declarations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_residences" ADD CONSTRAINT "du_residences_application_party_id_fkey" FOREIGN KEY ("application_party_id") REFERENCES "application_parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── A follow-up exists exactly when its trigger question says ─────────────
-- Each of these is a DU conditionality statement, verbatim, as a CHECK. A row
-- carrying a follow-up whose condition is false produces a file that validates
-- and contradicts itself, which is the worst failure available given that the
-- schema objects to none of it.
--
-- PriorPropertyTitleType gets NO CHECK. It is optional for DU with a blank
-- conditionality cell, so binding it to the homeowner question would refuse
-- rows DU accepts -- a constraint with no source behind it, which is the same
-- error as a missing one pointed the other way.
ALTER TABLE "du_declarations"
    ADD CONSTRAINT "du_declarations_homeowner_follows_intent" CHECK (
        (intent_to_occupy = 'Yes') = (homeowner_past_three_years IS NOT NULL)
    ),
    ADD CONSTRAINT "du_declarations_prior_usage_follows_homeowner" CHECK (
        (intent_to_occupy = 'Yes' AND homeowner_past_three_years = 'Yes')
            = (prior_property_usage IS NOT NULL)
    ),
    ADD CONSTRAINT "du_declarations_borrowed_amount_follows_indicator" CHECK (
        undisclosed_borrowed_funds = (undisclosed_borrowed_funds_cents IS NOT NULL)
    ),
    -- Nine integer digits and two decimals is the widest amount the wire takes.
    -- A wider number is rejected at submission, which is the most expensive
    -- moment to find out; this rejects it on write.
    ADD CONSTRAINT "du_declarations_borrowed_amount_fits_amount_9_2" CHECK (
        undisclosed_borrowed_funds_cents IS NULL
            OR undisclosed_borrowed_funds_cents BETWEEN 0 AND 99999999999
    );

-- ─── Chapters exist if and only if the borrower declared a bankruptcy ──────
-- Deferred, and checked at COMMIT, because the declaration row and its chapter
-- rows land in one transaction -- the same idiom as the gapless application
-- ledger. Both directions matter: chapters with no declaration is a
-- contradiction, and a declared bankruptcy with no chapter is a conditionally
-- required field silently omitted. No sample file in the corpus exercises this
-- branch, so there is no reference instance to diff against and this constraint
-- is the only check that exists.
--
-- Two trigger functions rather than one that has to work out which table fired
-- it. On the filings table the row's own id matches no declaration, so a single
-- function keyed on it would look up nothing, find nothing to complain about,
-- and let the transaction commit -- which is exactly the state deleting the
-- last chapter of a declared bankruptcy leaves behind.
--
-- The filings function checks BOTH endpoints rather than whichever one the row
-- has now. An UPDATE that moves a chapter from one declaration to another is
-- two questions, and reading only the new parent answers the easy one: the
-- declaration the chapter LEFT is the one now saying yes with nothing naming a
-- chapter, which is the same hole as the DELETE and reached by the operation
-- next to it.
CREATE OR REPLACE FUNCTION du_bankruptcy_chapters_match(d_id UUID) RETURNS void AS $$
DECLARE says BOOLEAN; n INT;
BEGIN
    SELECT bankruptcy INTO says FROM "du_declarations" WHERE id = d_id;
    IF NOT FOUND THEN RETURN; END IF;   -- the declaration itself was deleted
    SELECT count(*) INTO n FROM "du_bankruptcy_filings" WHERE declaration_id = d_id;
    IF says AND n = 0 THEN
        RAISE EXCEPTION
            'declaration % says bankruptcy but names no chapter; URLA 5b.8.1 asks which type(s)', d_id;
    END IF;
    IF NOT says AND n > 0 THEN
        RAISE EXCEPTION
            'declaration % names % bankruptcy chapter(s) but says no bankruptcy', d_id, n;
    END IF;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION du_bankruptcy_chapters_match_from_declaration() RETURNS trigger AS $$
BEGIN
    PERFORM du_bankruptcy_chapters_match(NEW.id);
    RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION du_bankruptcy_chapters_match_from_filing() RETURNS trigger AS $$
BEGIN
    IF TG_OP <> 'DELETE' THEN PERFORM du_bankruptcy_chapters_match(NEW.declaration_id); END IF;
    IF TG_OP <> 'INSERT' THEN PERFORM du_bankruptcy_chapters_match(OLD.declaration_id); END IF;
    RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER du_bankruptcy_chapters_match_the_indicator_decl
    AFTER INSERT OR UPDATE ON "du_declarations"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION du_bankruptcy_chapters_match_from_declaration();

CREATE CONSTRAINT TRIGGER du_bankruptcy_chapters_match_the_indicator_filing
    AFTER INSERT OR UPDATE OR DELETE ON "du_bankruptcy_filings"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION du_bankruptcy_chapters_match_from_filing();

-- ─── Nobody but the borrower declares ──────────────────────────────────────
-- The shape of the shipped `facts_ai_may_not_verify`, pointed at the one
-- container where an inference is a signature on a federal form. Screen 4 reads
-- these off connector output today, so an unrun credit pull asserts "no
-- bankruptcy" from an absence of evidence. A clean credit report is absence of
-- evidence, not a "no", and there must be no code path that fills a declaration
-- from a snapshot -- including one somebody writes in six months without
-- reading this.
--
-- "Self" is enforced and not merely implied. Refusing only the machine kinds
-- would leave a BORROWER principal belonging to SOMEBODY ELSE able to assert,
-- and that is not hypothetical: screen 4's single signature makes the signed-in
-- primary borrower the obvious asserter for a co-borrower's row. A declaration
-- is a statement the declaring borrower signs; a STAFF principal may record one
-- taken by phone, and nobody else may write one at all.
--
-- The product consequence, stated here rather than discovered as a 500: a
-- co-borrower who has never signed in is a provisional party with no BORROWER
-- principal of their own, so under this trigger their declaration can be
-- written only by a member of staff. Either the second borrower gets their own
-- session before the file is submittable, or somebody takes the answers by
-- phone. That is the correct refusal, and it is a product requirement rather
-- than a side effect.
CREATE OR REPLACE FUNCTION du_declarations_are_self_attested() RETURNS trigger AS $$
DECLARE actor_kind "PrincipalKind"; actor_party UUID; declaring_party UUID;
BEGIN
    SELECT kind, party_id INTO actor_kind, actor_party
      FROM "principals" WHERE id = NEW.asserted_by_principal_id;
    IF actor_kind IN ('AI_AGENT','PARTNER','SERVICE') THEN
        RAISE EXCEPTION
            'a % principal may not declare on a borrower''s behalf; Section 5 is a statement the borrower signs', actor_kind;
    END IF;
    IF actor_kind = 'STAFF' THEN
        RETURN NEW;                     -- taken by phone, recorded by a human
    END IF;
    SELECT party_id INTO declaring_party
      FROM "application_parties" WHERE id = NEW.application_party_id;
    IF actor_party IS DISTINCT FROM declaring_party THEN
        RAISE EXCEPTION
            'principal % belongs to party % and cannot declare for party %; one borrower does not answer Section 5 for another',
            NEW.asserted_by_principal_id, actor_party, declaring_party;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER du_declarations_are_self_attested_write
    BEFORE INSERT OR UPDATE ON "du_declarations"
    FOR EACH ROW EXECUTE FUNCTION du_declarations_are_self_attested();

-- ─── A declaration belongs to a borrowing party ────────────────────────────
-- A non-borrowing spouse and a guarantor do not become DU Borrower elements --
-- DU has no role for either -- so a declaration or a residence on one is a row
-- with nowhere to go.
CREATE OR REPLACE FUNCTION du_borrower_scoped_rows_need_a_borrowing_role() RETURNS trigger AS $$
DECLARE r "ApplicationPartyRole";
BEGIN
    SELECT role INTO r FROM "application_parties" WHERE id = NEW.application_party_id;
    IF r NOT IN ('PRIMARY_BORROWER','CO_BORROWER','NON_OCCUPANT_CO_BORROWER') THEN
        RAISE EXCEPTION 'application_party % is %, which is not a DU Borrower', NEW.application_party_id, r;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER du_declarations_need_a_borrowing_role
    BEFORE INSERT OR UPDATE ON "du_declarations"
    FOR EACH ROW EXECUTE FUNCTION du_borrower_scoped_rows_need_a_borrowing_role();

CREATE TRIGGER du_residences_need_a_borrowing_role
    BEFORE INSERT OR UPDATE ON "du_residences"
    FOR EACH ROW EXECUTE FUNCTION du_borrower_scoped_rows_need_a_borrowing_role();

-- And the other direction, which a trigger on the child tables cannot see:
-- flipping a co-borrower to a non-borrowing spouse after the fact leaves their
-- declaration and their residences in place, which is precisely the condition
-- the two triggers above exist to prevent. The role change is the write that
-- has to be refused.
CREATE OR REPLACE FUNCTION application_parties_keep_their_du_rows_valid() RETURNS trigger AS $$
BEGIN
    IF NEW.role IN ('PRIMARY_BORROWER','CO_BORROWER','NON_OCCUPANT_CO_BORROWER') THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "du_declarations" WHERE application_party_id = NEW.id)
       OR EXISTS (SELECT 1 FROM "du_residences" WHERE application_party_id = NEW.id) THEN
        RAISE EXCEPTION
            'application_party % carries DU borrower rows and cannot become %; remove the declaration and residences first',
            NEW.id, NEW.role;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER application_parties_keep_their_du_rows_valid_update
    BEFORE UPDATE OF role ON "application_parties"
    FOR EACH ROW EXECUTE FUNCTION application_parties_keep_their_du_rows_valid();

-- ─── A rent amount needs a rent basis; a rent basis needs no amount ────────
-- DU's condition is "basis is Rent AND the amount exists". The second half is
-- the half a biconditional would drop, and with it a prior residence rented
-- eight years ago whose rent nobody remembers -- a legal file -- becomes an
-- unwritable row.
ALTER TABLE "du_residences"
    ADD CONSTRAINT "du_residences_rent_amount_needs_a_rent_basis" CHECK (
        monthly_rent_cents IS NULL OR basis = 'Rent'
    ),
    ADD CONSTRAINT "du_residences_rent_fits_amount_9_2" CHECK (
        monthly_rent_cents IS NULL OR monthly_rent_cents BETWEEN 0 AND 99999999999
    ),
    -- The duration is Numeric 3 on the wire. A thousand months is not a longer
    -- tenancy, it is a rejected file.
    ADD CONSTRAINT "du_residences_duration_fits_numeric_3" CHECK (
        duration_months BETWEEN 0 AND 999
    ),
    -- A Current residence reads its address from the pinned `current_address`
    -- fact and stores none; a Prior residence stores its own, because there is
    -- no predicate to read it from. Both directions, so neither a Current row
    -- carrying an address that will go stale nor a Prior row with nowhere to
    -- get one is writable.
    ADD CONSTRAINT "du_residences_current_borrows_the_pinned_address" CHECK (
        residency_type <> 'Current' OR (
            address_line_text IS NULL AND address_unit IS NULL AND city_name IS NULL
            AND state_code IS NULL AND postal_code IS NULL AND country_code IS NULL
        )
    ),
    ADD CONSTRAINT "du_residences_prior_carries_its_own_address" CHECK (
        residency_type <> 'Prior' OR (
            address_line_text IS NOT NULL AND city_name IS NOT NULL
            AND state_code IS NOT NULL AND postal_code IS NOT NULL
        )
    ),
    -- The wire widths, per address element.
    ADD CONSTRAINT "du_residences_address_fits_the_wire" CHECK (
        char_length(COALESCE(address_line_text, '')) <= 50
        AND char_length(COALESCE(address_unit, '')) <= 11
        AND char_length(COALESCE(city_name, '')) <= 35
        AND char_length(COALESCE(state_code, '')) <= 2
        AND char_length(COALESCE(country_code, '')) <= 2
        AND (postal_code IS NULL OR postal_code ~ '^([0-9]{5}|[0-9]{9})$')
    );

-- ─── Deleting a PARTY still works, and that is where the hazard is ─────────
-- `du_declarations.asserted_by_principal_id` is RESTRICT, the same shape as
-- `facts_asserted_by_principal_id_fkey`. This repo has paid for that lesson
-- once already: `users_delete_takes_party`
-- (20260908170000_borrowers_are_records_about_parties) deletes the facts naming
-- a departing party's principals before deleting the party.
--
-- Copying that fix onto `users` would not be enough here. Postgres fires the
-- `principals` cascade BEFORE the `application_parties` cascade and checks
-- RESTRICT immediately, so a plain `DELETE FROM parties` raises even for a
-- borrower's own self-attested row -- and `DELETE /api/auth/me` is not the only
-- thing that deletes a party. The persona seed's drift repair and its orphan
-- sweep go straight at the table, and so do several tests. So the sweep is
-- BEFORE DELETE, where the foreign key actually bites.
--
-- This one, on `principals`, is what covers a path no party is on. A member of
-- staff who took a co-borrower's answers by phone is the only cross-party
-- asserter this file allows, their principal belongs to no party at all, and
-- deleting it hits the RESTRICT from the other side, where no party-scoped
-- sweep can see it.
--
-- Deleting a principal can therefore delete a declaration belonging to a
-- borrower who is NOT leaving: the member of staff who took it by phone
-- departs, and the answers they recorded go with the principal that vouches for
-- them. That is the right outcome -- an unattributed Section 5 is not a
-- declaration and this repo will not hold one -- but it is a fact about
-- somebody else's file, so it is written to `file_events` rather than happening
-- quietly. The borrower is asked again.
CREATE OR REPLACE FUNCTION principals_delete_takes_their_declarations() RETURNS trigger AS $$
BEGIN
    INSERT INTO "file_events" (id, loan_file_id, kind, requirement_id, payload, actor, occurred_at)
    SELECT gen_random_uuid(), a.loan_file_id, 'du_declaration_removed', NULL,
           jsonb_build_object('applicationId', a.id,
                              'applicationPartyId', d.application_party_id,
                              'assertedByPrincipalId', d.asserted_by_principal_id,
                              'reason', 'the principal that asserted it was deleted'),
           'system', now()
      FROM "du_declarations" d
      JOIN "application_parties" ap ON ap.id = d.application_party_id
      JOIN "applications" a ON a.id = ap.application_id
     WHERE d.asserted_by_principal_id = OLD.id
       AND ap.party_id IS DISTINCT FROM OLD.party_id;   -- somebody else's answer

    DELETE FROM "du_declarations" WHERE asserted_by_principal_id = OLD.id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER principals_delete_takes_their_declarations_before
    BEFORE DELETE ON "principals"
    FOR EACH ROW EXECUTE FUNCTION principals_delete_takes_their_declarations();

-- The party-level sweep names both endpoints, and on every path that exists
-- today it is belt over braces: a departing party's own principals cascade into
-- the trigger above, and the edge cascade takes the subject half. It is here
-- because it runs BEFORE those cascades rather than inside them, so a party
-- deletion never reaches the RESTRICT at all, and because the subject half is
-- otherwise a bet on `du_declarations.application_party_id` still cascading in
-- a schema file this migration does not own. It costs one indexed delete per
-- party deleted.
CREATE OR REPLACE FUNCTION parties_delete_takes_their_declarations() RETURNS trigger AS $$
BEGIN
    DELETE FROM "du_declarations"
     WHERE asserted_by_principal_id IN
           (SELECT id FROM "principals" WHERE party_id = OLD.id)
        OR application_party_id IN
           (SELECT id FROM "application_parties" WHERE party_id = OLD.id);
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER parties_delete_takes_their_declarations_before
    BEFORE DELETE ON "parties"
    FOR EACH ROW EXECUTE FUNCTION parties_delete_takes_their_declarations();

COMMENT ON TABLE "du_declarations" IS
    'URLA Section 5 as of one credit request. Asked of the borrower and never derived: du_declarations_are_self_attested refuses every principal but the declaring borrower and staff.';

COMMENT ON TABLE "du_residences" IS
    'Where a borrower lives and lived, per credit request. A Current row takes its address from the party''s pinned current_address fact; only a Prior row carries its own.';
