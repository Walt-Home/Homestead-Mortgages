-- What is true of the product, and what is true of the building.
--
-- Eight data points the DU Specification requires with no condition in front of
-- them had no column anywhere, so every casefile this model assembled was
-- refused by its own gate. They are not one kind of thing, and this migration
-- puts them in three places for that reason.
--
-- Five are true of the PRODUCT rather than of the person: whether a loan is
-- conventional, and whether it builds, balloons, pays interest only or
-- amortizes negatively, are facts about `CONF-30-FIXED` itself and the same on
-- every file quoted against it. Before this they had nowhere to be, because a
-- product was three environment variables -- a code, a term and a rate -- and a
-- code is a string rather than a statement that the loan behind it amortizes.
--
-- A seventh moves rather than arrives. `loan_files.amortization` was the string
-- `'fixed'`, written into every row by the create route, and whether a loan is
-- fixed or adjustable is true of the product by exactly the test the five
-- indicators are chosen by. Left on the file it could disagree with them: a
-- product whose `interest_only` and `balloon` are both true, quoted onto a file
-- that says Fixed and fully amortizing, is a casefile that contradicts itself
-- and validates. So it lands on the product row, and there is one place to
-- read it.
--
-- A sixth had to be argued. A prepayment penalty is a term of the note rather
-- than a family of product, which reads as something that belongs beside the
-- rate. Regulation Z makes it structural: a penalty is permitted only on a
-- fixed-rate qualified mortgage that is not higher-priced, it is capped, it
-- expires, and the creditor has to offer an alternative loan WITHOUT one. That
-- alternative is a second product at a second price, not a second checkbox on
-- this one -- so the indicator sits on the product and a product that carries a
-- penalty is another row.
--
-- Two are true of the subject property, and they split on where the answer can
-- come from. `financed_unit_count` is a fact about a building that the county
-- holds and screen 1's assessor lookup already returns. `property_estate_type`
-- is not in any record we retrieve: no assessor record, valuation or flood
-- determination carries it, and the document that settles it is the title
-- commitment, which does not exist when a casefile is submitted. So one is
-- retrieved and one is asked, and both are NULLABLE.
--
-- A third property column is here that no audit named. `AttachmentType` is
-- required the moment a unit count exists -- "Required IF FinancedUnitCount <
-- 5" -- so answering one of the eight opened it, and the preflight said so on
-- the first run. All eighteen shipped samples carry it. It is retrieved beside
-- the unit count, off the same assessor record: it describes the building, and
-- a borrower's word for a fact the county holds is what screen 1 exists to
-- avoid.
--
-- Nullable is the whole point. A column with a plausible default is how
-- `borrowers.current_housing` came to say every borrower rents, and undoing
-- that took a migration, a route change and a screen. An unknown value is null,
-- the preflight refuses the submission, and the refusal is ours instead of
-- Desktop Underwriter's.

-- ─── The enumerated types ──────────────────────────────────────────────────
-- Hand-typed in schema.prisma and diffed against the DU Specification by
-- `npm run du:verify`, which fails on a member either file has and the other
-- does not.
CREATE TYPE "DuMortgageType" AS ENUM ('Conventional', 'FHA', 'USDARuralDevelopment', 'VA');

CREATE TYPE "DuPropertyEstateType" AS ENUM ('FeeSimple', 'Leasehold');

CREATE TYPE "DuAttachmentType" AS ENUM ('Attached', 'Detached');

-- The five DU supports at L3.5. Our two words, `'fixed'` and `'arm'`, were a
-- vocabulary the emitter had to translate; these are the values that go on the
-- wire, so nothing between the column and the element decides anything.
CREATE TYPE "DuAmortizationType" AS ENUM ('AdjustableRate', 'Fixed', 'GEM', 'GPM', 'Other');

-- ─── 1. A product, and what is true of it ──────────────────────────────────
-- The code is the key rather than a uuid beside it, because the code is what
-- `config.defaultProduct` names, what a rate sheet is keyed on, and what
-- `loan_files.product_code` has held as free text all along.
CREATE TABLE "loan_products" (
    "code" TEXT NOT NULL,
    "mortgage_type" "DuMortgageType" NOT NULL,
    "amortization" "DuAmortizationType" NOT NULL,
    "construction_loan" BOOLEAN NOT NULL,
    "balloon" BOOLEAN NOT NULL,
    "interest_only" BOOLEAN NOT NULL,
    "negative_amortization" BOOLEAN NOT NULL,
    "prepayment_penalty" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_products_pkey" PRIMARY KEY ("code")
);

COMMENT ON TABLE "loan_products" IS
    'A product this lender quotes, and what is true of it before anybody is quoted against it. The rate and the term stay on the file: they are quoted per borrower from a rate sheet, and these seven are not.';

-- The one product this system quotes. Every characteristic below is definitional
-- for a conforming thirty-year fixed rather than chosen for it: it is
-- conventional, it does not fund construction, it fully amortizes over its term,
-- it charges principal from the first payment, and it carries no penalty for
-- paying it off early.
INSERT INTO "loan_products" (
    "code",
    "mortgage_type",
    "amortization",
    "construction_loan",
    "balloon",
    "interest_only",
    "negative_amortization",
    "prepayment_penalty"
) VALUES (
    'CONF-30-FIXED',
    'Conventional',
    'Fixed',
    false,
    false,
    false,
    false,
    false
);

-- ─── 2. The file points at it ──────────────────────────────────────────────
-- The foreign key is what stops a file being quoted against a product whose
-- characteristics nobody holds. If this migration fails here, some file carries
-- a `product_code` this table has no row for -- which is the failure working:
-- there is no honest way to invent the seven answers for that product, and a
-- file quoted against it can be emitted only by guessing them.
--
-- RESTRICT on both sides, and the UPDATE half matters as much as the DELETE
-- half. A quoted file does not lose the row it was quoted under, and it does
-- not silently follow a renamed one either: a cascading rename re-points every
-- historical file at whatever the new code means, which is the same loss with
-- a different spelling.
ALTER TABLE "loan_files"
    ADD CONSTRAINT "loan_files_product_code_fkey"
    FOREIGN KEY ("product_code") REFERENCES "loan_products"("code")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The file stops carrying the word, because the product now says it.
ALTER TABLE "loan_files" DROP COLUMN "amortization";

-- Neither key protects a file from the row being REWRITTEN under it, and that
-- is the loss this trigger closes. `connector_snapshots` and `decisions` are
-- append-only in this schema because a fact you overwrote is a fact you cannot
-- diff against; a product is the same kind of thing the moment somebody has
-- been quoted on it. Flipping `prepayment_penalty` on `CONF-30-FIXED` restates
-- what every casefile sent last week told Desktop Underwriter, with no row
-- appended and nothing to compare. So the prose this migration already carries
-- -- a product that carries a penalty is another row -- is the rule rather
-- than the advice.
--
-- The price is quoted per file and stays there, so nothing a rate desk does
-- daily touches this table. Correcting a genuine mistake means moving the files
-- to a corrected row, which is a migration somebody writes deliberately.
CREATE FUNCTION "loan_products_refuse_restatement"() RETURNS trigger AS $$
DECLARE
    quoted bigint;
BEGIN
    SELECT count(*) INTO quoted FROM "loan_files" WHERE "product_code" = OLD."code";
    IF quoted > 0 THEN
        RAISE EXCEPTION
            'loan_products_is_not_restated: % is what % loan file(s) were quoted under. A product on different terms is another row.',
            OLD."code", quoted;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "loan_products_is_not_restated"
    BEFORE UPDATE OF
        "mortgage_type",
        "amortization",
        "construction_loan",
        "balloon",
        "interest_only",
        "negative_amortization",
        "prepayment_penalty"
    ON "loan_products"
    FOR EACH ROW
    WHEN (
        OLD."mortgage_type" IS DISTINCT FROM NEW."mortgage_type"
        OR OLD."amortization" IS DISTINCT FROM NEW."amortization"
        OR OLD."construction_loan" IS DISTINCT FROM NEW."construction_loan"
        OR OLD."balloon" IS DISTINCT FROM NEW."balloon"
        OR OLD."interest_only" IS DISTINCT FROM NEW."interest_only"
        OR OLD."negative_amortization" IS DISTINCT FROM NEW."negative_amortization"
        OR OLD."prepayment_penalty" IS DISTINCT FROM NEW."prepayment_penalty"
    )
    EXECUTE FUNCTION "loan_products_refuse_restatement"();

-- ─── 3. The subject property ───────────────────────────────────────────────
ALTER TABLE "loan_files" ADD COLUMN "financed_unit_count" INTEGER;
ALTER TABLE "loan_files" ADD COLUMN "property_attachment_type" "DuAttachmentType";
ALTER TABLE "loan_files" ADD COLUMN "property_estate_type" "DuPropertyEstateType";

-- One to four dwelling units is the whole of what DU will underwrite here; five
-- is a commercial loan and zero is not a house. The CHECK is on the column
-- rather than in a route because a unit count arrives from a vendor as well as
-- from a person.
ALTER TABLE "loan_files"
    ADD CONSTRAINT "loan_files_financed_unit_count_is_one_to_four"
    CHECK ("financed_unit_count" IS NULL OR "financed_unit_count" BETWEEN 1 AND 4);

COMMENT ON COLUMN "loan_files"."financed_unit_count" IS
    'How many dwelling units the subject property has, retrieved from the assessor record. Not financed_property_count, which counts properties the borrower finances elsewhere.';

COMMENT ON COLUMN "loan_files"."property_attachment_type" IS
    'Whether the dwelling shares a wall with another one, retrieved from the assessor record. Required by DU the moment financed_unit_count is answered.';

COMMENT ON COLUMN "loan_files"."property_estate_type" IS
    'Fee simple, or a leasehold on land somebody else owns. Asked on screen 3: nothing we retrieve carries it.';

-- ─── 4. The building facts belong to the address they were answered about ──
-- A borrower who mistypes the address, sees the county's card, and corrects it
-- leaves three columns behind that describe the building they are no longer
-- buying: a unit count and an attachment the assessor answered for the old one,
-- and an estate type the borrower stated about the old one. None of them is
-- null, so nothing downstream can tell -- the preflight can only refuse what is
-- absent, and a submission would pair the new address with the old building.
-- That is `borrowers.current_housing` again in a different column: not a
-- default, but a value standing where an answer should be.
--
-- Here rather than in the route, for the reason the unit-count CHECK is here:
-- these arrive from a vendor as well as from a person, and the route that moves
-- an address today is not the only door there will ever be.
--
-- A fact this same statement RESTATED survives, which is the difference between
-- forgetting the old building and refusing to let anybody describe the new one:
-- moving the address and writing the new county record together is one write,
-- and only the columns it left alone are the old building's.
CREATE FUNCTION "loan_files_forget_the_old_building"() RETURNS trigger AS $$
BEGIN
    IF NEW."financed_unit_count" IS NOT DISTINCT FROM OLD."financed_unit_count" THEN
        NEW."financed_unit_count" := NULL;
    END IF;
    IF NEW."property_attachment_type" IS NOT DISTINCT FROM OLD."property_attachment_type" THEN
        NEW."property_attachment_type" := NULL;
    END IF;
    IF NEW."property_estate_type" IS NOT DISTINCT FROM OLD."property_estate_type" THEN
        NEW."property_estate_type" := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "loan_files_building_follows_the_address"
    BEFORE UPDATE OF
        "property_line1",
        "property_line2",
        "property_city",
        "property_state",
        "property_postal_code"
    ON "loan_files"
    FOR EACH ROW
    WHEN (
        OLD."property_line1" IS DISTINCT FROM NEW."property_line1"
        OR OLD."property_line2" IS DISTINCT FROM NEW."property_line2"
        OR OLD."property_city" IS DISTINCT FROM NEW."property_city"
        OR OLD."property_state" IS DISTINCT FROM NEW."property_state"
        OR OLD."property_postal_code" IS DISTINCT FROM NEW."property_postal_code"
    )
    EXECUTE FUNCTION "loan_files_forget_the_old_building"();
