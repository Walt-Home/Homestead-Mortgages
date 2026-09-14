-- An asset has an owner, a liability has an obligor, and neither is a shape the
-- serializer gets to discover.
--
-- Measured across the eighteen shipped sample files: 110 assets, 110
-- liabilities, and not one of them without an owner arc. The DU Map repeats the
-- rule on AssetType, LiabilityType, ExpenseType and LoanRoleType -- "if a value
-- is present in this data point, an arc role value should be provided to
-- indicate a relationship between the corresponding parties". So a row with no
-- owner is not untidy, it is a row that cannot be emitted.
--
-- What lands here is the ROWS: the four DEAL-level tables, the shapes each kind
-- of asset may take, and the two derivations nothing may write by hand. The arcs
-- themselves -- the join tables and the deferred triggers that make an ownerless
-- row impossible at COMMIT -- are a separate migration, because a constraint
-- that fires at the end of a transaction is only testable through a writer that
-- intends to satisfy it, and there is no writer yet. An asset written today has
-- no owner and nothing here requires it to.
--
-- Additive. No route writes any of this.

-- ─── The enumerated types ──────────────────────────────────────────────────
-- Hand-typed in schema.prisma and diffed against the DU Specification by
-- `npm run du:verify`, which fails on a member either file has and the other
-- does not.
CREATE TYPE "DuAssetKind" AS ENUM ('DEPOSIT_ACCOUNT', 'OTHER_ASSET', 'GIFT_OR_GRANT', 'OWNED_PROPERTY');

CREATE TYPE "DuAssetType" AS ENUM ('Bond', 'BridgeLoanNotDeposited', 'CertificateOfDepositTimeDeposit', 'CheckingAccount', 'IndividualDevelopmentAccount', 'LifeInsurance', 'MoneyMarketFund', 'MutualFund', 'RetirementFund', 'SavingsAccount', 'Stock', 'StockOptions', 'TrustAccount', 'CashOnHand', 'Other', 'PendingNetSaleProceedsFromRealEstateAssets', 'ProceedsFromSaleOfNonRealEstateAsset', 'ProceedsFromSecuredLoan', 'ProceedsFromUnsecuredLoan', 'GiftOfCash', 'GiftOfPropertyEquity', 'Grant');

-- Two members, and a type rather than a string with a width. Held as text, a
-- borrower's "Coin collection" passes every check this repo has -- the XSD
-- types the element as a plain string -- and DU rejects the casefile.
CREATE TYPE "DuAssetTypeOtherDescription" AS ENUM ('OtherLiquidAsset', 'OtherNonLiquidAsset');

CREATE TYPE "DuFundsSourceType" AS ENUM ('CommunityNonProfit', 'Employer', 'FederalAgency', 'Lender', 'LocalAgency', 'Other', 'Parent', 'Relative', 'ReligiousNonProfit', 'StateAgency', 'UnmarriedPartner', 'UnrelatedFriend');

CREATE TYPE "DuLiabilityType" AS ENUM ('CollectionsJudgmentsAndLiens', 'Installment', 'LeasePayment', 'Open30DayChargeAccount', 'Other', 'Revolving', 'Taxes', 'TaxLien', 'HELOC', 'MortgageLoan');

CREATE TYPE "DuLiabilityMortgageType" AS ENUM ('FHA');

CREATE TYPE "DuExpenseType" AS ENUM ('Alimony', 'ChildSupport', 'JobRelatedExpenses', 'Other', 'SeparateMaintenanceExpense');

CREATE TYPE "DuOwnedPropertyDisposition" AS ENUM ('PendingSale', 'Retain', 'Sold');

CREATE TYPE "DuIntendedPropertyUsage" AS ENUM ('Investment', 'Other', 'PrimaryResidence', 'SecondHome');

CREATE TYPE "DuPropertyUsageOtherDescription" AS ENUM ('Chattel', 'Commercial', 'Farm', 'Land', 'Multifamily', 'Timeshare');

-- ─── The tables ────────────────────────────────────────────────────────────
-- All four hang off the APPLICATION. `DEAL/ASSETS/ASSET` is a sibling of
-- `PARTIES` on the wire, and whose asset it is is an arc between the two, so an
-- owner column of any kind on these tables would be the wrong shape.
CREATE TABLE "du_assets" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,

    -- Which URLA section this row is. One container serves four of them, and
    -- this is what says which fields the row may fill and which AssetType
    -- values it may take -- both below, as CHECKs.
    "kind" "DuAssetKind" NOT NULL,

    "asset_type" "DuAssetType",
    "asset_type_other_description" "DuAssetTypeOtherDescription",
    "cash_or_market_value_cents" BIGINT,
    "holder_name" TEXT,
    "account_identifier" TEXT,
    "funds_source_type" "DuFundsSourceType",
    "funds_source_type_other_description" TEXT,
    "included_in_asset_account" BOOLEAN,

    -- Which vendor report a figure came from, so a number on the wire can be
    -- traced to the pull that produced it. Null for a row a person typed.
    "source_snapshot_id" UUID,

    -- Re-pull identity, the same five columns as `income_sources`. Without them
    -- a second bank pull can only insert a twin or delete and recreate, and both
    -- renumber every ASSET_n on the wire.
    "identity_key" TEXT NOT NULL,
    "first_seen_snapshot_id" UUID,
    "last_seen_snapshot_id" UUID,
    "retired_at" TIMESTAMP(3),
    "retired_by_snapshot_id" UUID,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "du_assets_pkey" PRIMARY KEY ("id")
);

-- URLA 3a. A child OF an asset and never a sibling: moving <OWNED_PROPERTY> to
-- a DEAL-level position beside <COLLATERALS> fails MISMO schema validation, and
-- there is no other legal location for it.
CREATE TABLE "du_owned_properties" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,

    -- Denormalized from the asset and written only by a trigger, because the
    -- partial unique index below cannot see through the asset to the
    -- application. That is the whole reason it is here.
    "application_id" UUID NOT NULL,

    "disposition_status" "DuOwnedPropertyDisposition" NOT NULL,
    "is_subject" BOOLEAN NOT NULL DEFAULT false,

    "address_line_text" TEXT,
    "address_unit" TEXT,
    "city_name" TEXT,
    "state_code" TEXT,
    "postal_code" TEXT,
    "country_code" TEXT,

    "current_usage" "DuPropertyUsage",
    "intended_usage" "DuIntendedPropertyUsage",
    "intended_usage_other_description" "DuPropertyUsageOtherDescription",
    "estimated_value_cents" BIGINT,

    -- Derived by the two triggers at the foot of this file. No caller writes it.
    "lien_upb_cents" BIGINT,

    "maintenance_expense_cents" BIGINT,
    "rental_income_gross_cents" BIGINT,
    "rental_income_net_cents" BIGINT,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "du_owned_properties_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "du_liabilities" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "liability_type" "DuLiabilityType" NOT NULL,
    "liability_type_other_description" TEXT,
    "holder_name" TEXT NOT NULL,
    "account_identifier" TEXT,
    "mortgage_type" "DuLiabilityMortgageType",
    "unpaid_balance_cents" BIGINT NOT NULL,
    "monthly_payment_cents" BIGINT NOT NULL,
    "remaining_term_months" INTEGER,
    "payoff_status" BOOLEAN NOT NULL,
    "exclusion_indicator" BOOLEAN NOT NULL DEFAULT false,
    "heloc_maximum_balance_cents" BIGINT,
    "payment_includes_taxes_insurance" BOOLEAN,

    -- The one arc in this design that is a foreign key rather than a join table.
    -- Across the eighteen samples there are 23 ASSET_IsAssociatedWith_LIABILITY
    -- arcs and no liability is the target of more than one asset; one property
    -- with two liens is ordinary, and that is the direction this expresses.
    "secured_by_owned_property_id" UUID,

    "source_snapshot_id" UUID,
    "identity_key" TEXT NOT NULL,
    "first_seen_snapshot_id" UUID,
    "last_seen_snapshot_id" UUID,
    "retired_at" TIMESTAMP(3),
    "retired_by_snapshot_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "du_liabilities_pkey" PRIMARY KEY ("id")
);

-- Two instances in the entire corpus, and EXPENSE is the one container here
-- with no `_DETAIL` child -- the fields hang directly off it.
CREATE TABLE "du_expenses" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "expense_type" "DuExpenseType" NOT NULL,
    "expense_other_description" TEXT,
    "monthly_payment_cents" BIGINT NOT NULL,
    "remaining_term_months" INTEGER,
    -- Ours. The EXPENSE container carries four data points and this is none of
    -- them, so the serializer must never go looking for somewhere to put it.
    "alimony_owed_to_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "du_expenses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "du_assets_application_id_idx" ON "du_assets"("application_id");

CREATE UNIQUE INDEX "du_owned_properties_asset_id_key" ON "du_owned_properties"("asset_id");

CREATE INDEX "du_liabilities_application_id_idx" ON "du_liabilities"("application_id");

CREATE INDEX "du_liabilities_secured_by_owned_property_id_idx" ON "du_liabilities"("secured_by_owned_property_id");

CREATE INDEX "du_expenses_application_id_idx" ON "du_expenses"("application_id");

ALTER TABLE "du_assets" ADD CONSTRAINT "du_assets_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_assets" ADD CONSTRAINT "du_assets_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "du_assets" ADD CONSTRAINT "du_assets_first_seen_snapshot_id_fkey" FOREIGN KEY ("first_seen_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "du_assets" ADD CONSTRAINT "du_assets_last_seen_snapshot_id_fkey" FOREIGN KEY ("last_seen_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "du_assets" ADD CONSTRAINT "du_assets_retired_by_snapshot_id_fkey" FOREIGN KEY ("retired_by_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "du_owned_properties" ADD CONSTRAINT "du_owned_properties_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "du_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_owned_properties" ADD CONSTRAINT "du_owned_properties_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_liabilities" ADD CONSTRAINT "du_liabilities_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_liabilities" ADD CONSTRAINT "du_liabilities_secured_by_owned_property_id_fkey" FOREIGN KEY ("secured_by_owned_property_id") REFERENCES "du_owned_properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "du_liabilities" ADD CONSTRAINT "du_liabilities_source_snapshot_id_fkey" FOREIGN KEY ("source_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "du_liabilities" ADD CONSTRAINT "du_liabilities_first_seen_snapshot_id_fkey" FOREIGN KEY ("first_seen_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "du_liabilities" ADD CONSTRAINT "du_liabilities_last_seen_snapshot_id_fkey" FOREIGN KEY ("last_seen_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "du_liabilities" ADD CONSTRAINT "du_liabilities_retired_by_snapshot_id_fkey" FOREIGN KEY ("retired_by_snapshot_id") REFERENCES "connector_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "du_expenses" ADD CONSTRAINT "du_expenses_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 1. The four asset kinds have disjoint fields, and disjoint types ──────
-- One XML container serves four URLA sections, and an REO asset carries no
-- ASSET_DETAIL at all: 21 REO assets in the corpus, none with one. The XSD
-- permits an ASSET with both, so this CHECK is the only thing stopping an REO
-- row from acquiring an account number, and DU Map record 189 says outright
-- that a property "can't be listed as both".
ALTER TABLE "du_assets"
    ADD CONSTRAINT "du_assets_owned_property_carries_no_asset_detail" CHECK (
        kind <> 'OWNED_PROPERTY' OR (
            asset_type IS NULL AND asset_type_other_description IS NULL
            AND cash_or_market_value_cents IS NULL AND holder_name IS NULL
            AND account_identifier IS NULL AND funds_source_type IS NULL
            AND funds_source_type_other_description IS NULL
            AND included_in_asset_account IS NULL
        )
    ),
    -- Each kind names the AssetType values its URLA section holds, and not only
    -- which columns must be null.
    --
    -- `kind` is what says which section a row belongs to, and it is what the
    -- emitter keys conditionality on. With `kind = OTHER_ASSET` and
    -- `asset_type = 'CheckingAccount'` the 2b shape rule applies to a 2a row:
    -- the holder name and the account identifier are permitted to be null, and
    -- the emitted checking account carries neither -- both of which DU requires
    -- once an amount exists. Nothing downstream can catch it, because a check
    -- keyed on the form field id cannot see a row whose discriminator lies.
    --
    -- The three lists are the partition the DU Enumerations tab already draws by
    -- Form Field ID -- thirteen values at 2a.1, six at 2b.1, three at 4d.1 --
    -- and `npm run du:verify` diffs them against it on every build, so a spec
    -- revision that moves a value between sections fails rather than widening a
    -- CHECK by accident.
    --
    -- `asset_type IS NOT NULL` is spelled out beside each list because the list
    -- alone does not say it. `NULL IN (...)` is NULL, `NULL AND TRUE` is NULL,
    -- and a CHECK passes on NULL -- so without this a row of any of the three
    -- kinds could carry an amount and no AssetType at all, which is the one
    -- shape these CHECKs exist to refuse: 2a.1, 2b.1 and 4d.1 are each
    -- conditional-required once `AssetCashOrMarketValueAmount` exists, and all
    -- three kinds require the amount two lines down.
    ADD CONSTRAINT "du_assets_deposit_account_shape" CHECK (
        kind <> 'DEPOSIT_ACCOUNT' OR (
            asset_type IS NOT NULL
            AND asset_type IN ('Bond','BridgeLoanNotDeposited','CertificateOfDepositTimeDeposit',
                           'CheckingAccount','IndividualDevelopmentAccount','LifeInsurance',
                           'MoneyMarketFund','MutualFund','RetirementFund','SavingsAccount',
                           'Stock','StockOptions','TrustAccount')
            AND cash_or_market_value_cents IS NOT NULL
            AND holder_name IS NOT NULL
            AND funds_source_type IS NULL AND included_in_asset_account IS NULL
        )
    ),
    ADD CONSTRAINT "du_assets_other_asset_shape" CHECK (
        kind <> 'OTHER_ASSET' OR (
            asset_type IS NOT NULL
            AND asset_type IN ('CashOnHand','Other','PendingNetSaleProceedsFromRealEstateAssets',
                           'ProceedsFromSaleOfNonRealEstateAsset','ProceedsFromSecuredLoan',
                           'ProceedsFromUnsecuredLoan')
            AND cash_or_market_value_cents IS NOT NULL
            AND account_identifier IS NULL AND funds_source_type IS NULL
        )
    ),
    ADD CONSTRAINT "du_assets_gift_or_grant_shape" CHECK (
        kind <> 'GIFT_OR_GRANT' OR (
            asset_type IS NOT NULL
            AND asset_type IN ('GiftOfCash','GiftOfPropertyEquity','Grant')
            AND cash_or_market_value_cents IS NOT NULL
            AND funds_source_type IS NOT NULL
            AND account_identifier IS NULL
        )
    ),
    -- `IncludedInAssetAccountIndicator` is 4d.2, conditional on the type being
    -- GiftOfCash or Grant -- and not GiftOfPropertyEquity, which is a credit in
    -- the transaction and was never in an account to be included in. The shape
    -- CHECK above admits all three, so this narrows it.
    ADD CONSTRAINT "du_assets_included_in_account_needs_cash_or_grant" CHECK (
        included_in_asset_account IS NULL OR asset_type IN ('GiftOfCash','Grant')
    ),
    -- `AssetTypeOtherDescription` is 2b.1, conditional on the type being
    -- `Other`, in both directions. `IS NOT DISTINCT FROM` rather than `=`
    -- because `asset_type` is nullable and `(NULL = 'Other') = TRUE` is NULL,
    -- which a CHECK does not treat as a violation -- the plain equality would
    -- admit a description with no type to describe.
    ADD CONSTRAINT "du_assets_other_description_needs_other" CHECK (
        (asset_type IS NOT DISTINCT FROM 'Other') = (asset_type_other_description IS NOT NULL)
    ),
    -- `FundsSourceTypeOtherDescription` is 4d.3, the same NULL-safe idiom on the
    -- gift: a deposit account leaves `funds_source_type` null, and a plain
    -- equality would let it carry a gift's 4d.3 description anyway.
    ADD CONSTRAINT "du_assets_funds_source_description_needs_other" CHECK (
        (funds_source_type IS NOT DISTINCT FROM 'Other') = (funds_source_type_other_description IS NOT NULL)
    ),
    ADD CONSTRAINT "du_assets_value_fits_amount_9_2" CHECK (
        cash_or_market_value_cents IS NULL
            OR cash_or_market_value_cents BETWEEN 0 AND 99999999999
    ),
    -- String N on the wire: ASSET_HOLDER/NAME/FullName is 150 (2a.2),
    -- AssetAccountIdentifier is 30 (2a.3), FundsSourceTypeOtherDescription is 80
    -- (4d.3). `asset_type_other_description` is not in this list and its absence
    -- is the point: it is an enumeration rather than a string with a width, and
    -- a length bound on an enum column is a bound that can only be satisfied,
    -- which reads as a check and is not one.
    ADD CONSTRAINT "du_assets_strings_fit_the_wire" CHECK (
        char_length(COALESCE(holder_name, '')) <= 150
        AND char_length(COALESCE(account_identifier, '')) <= 30
        AND char_length(COALESCE(funds_source_type_other_description, '')) <= 80
    );

-- ─── 1b. A re-pull matches a row rather than replacing it ──────────────────
-- The identity columns exist so a second bank or credit pull can update a row in
-- place, and this index is what makes the match deterministic.
--
-- It SPANS retired rows, word for word the reasoning
-- `income_sources_file_party_identity_key` carries: an asset that goes away and
-- comes back is one asset, so a later pull revives the row rather than inserting
-- a twin. Add `WHERE retired_at IS NULL` and a retired row and a live row may
-- share a key, the revive becomes a twin, and the twin renumbers every ASSET_n
-- after it on the wire.
--
-- Nothing computes a key yet. What this index alone holds is uniqueness across
-- retired rows; the matcher that derives a key from a vendor payload, and every
-- claim about what a re-pull does, arrive with the writer.
CREATE UNIQUE INDEX "du_assets_application_identity_key" ON "du_assets"("application_id", "identity_key");

CREATE UNIQUE INDEX "du_liabilities_application_identity_key" ON "du_liabilities"("application_id", "identity_key");

-- ─── 2. OWNED_PROPERTY nests inside an asset, and only inside an REO one ───
-- The unique `asset_id` is the 0:1, the cascade is the nesting, and the
-- composite foreign key is what makes "inside an REO asset" true rather than
-- intended. MISMO enforces the nesting itself; this is the relational spelling
-- of the same rule.
--
-- `asset_kind` is a generated column holding the one value it can hold, so the
-- pair (asset_id, asset_kind) can only match an asset whose kind is
-- OWNED_PROPERTY. Prisma has no representation for a generated column, so it is
-- declared there with `@ignore` and a comment pointing at this step: without the
-- declaration the next `prisma migrate dev` sees drift, proposes DROP COLUMN and
-- takes the foreign key with it, leaving the nesting true only by convention.
-- The column is left nullable, because a STORED generated column is nullable in
-- the catalog and the declaration has to match what is actually here.
CREATE UNIQUE INDEX "du_assets_id_kind" ON "du_assets"("id", "kind");

ALTER TABLE "du_owned_properties"
    ADD COLUMN "asset_kind" "DuAssetKind" GENERATED ALWAYS AS ('OWNED_PROPERTY'::"DuAssetKind") STORED,
    ADD CONSTRAINT "du_owned_properties_attach_to_an_reo_asset"
        FOREIGN KEY ("asset_id", "asset_kind") REFERENCES "du_assets"("id", "kind") ON DELETE CASCADE;

-- ─── 3. At most one REO is the subject property ────────────────────────────
-- `OwnedPropertySubjectIndicator` is how DU links the REO schedule to
-- COLLATERALS/SUBJECT_PROPERTY; there is no arc. Two of them would name two
-- subject properties on one deal.
--
-- A partial unique index is the instrument, and it cannot see through the asset
-- to the application -- which is why `application_id` is denormalized onto this
-- table and a trigger holds it equal to its asset's. It exists for the index and
-- for nothing else, so nothing is allowed to set it by hand.
CREATE OR REPLACE FUNCTION du_owned_properties_inherit_their_application() RETURNS trigger AS $$
BEGIN
    NEW.application_id := (SELECT application_id FROM "du_assets" WHERE id = NEW.asset_id);
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER du_owned_properties_inherit_their_application_write
    BEFORE INSERT OR UPDATE ON "du_owned_properties"
    FOR EACH ROW EXECUTE FUNCTION du_owned_properties_inherit_their_application();

CREATE UNIQUE INDEX "du_owned_properties_one_subject_per_application"
    ON "du_owned_properties"("application_id") WHERE is_subject;

-- ─── 4. The REO address, where nothing else knows it ───────────────────────
-- A non-subject REO must carry its own address. A subject REO may carry one:
-- null means "render the subject property's value here", and a value means this
-- REO's address is recorded as different.
--
-- The two destinations are not the same width. AddressLineText is String 50
-- under COLLATERALS/COLLATERAL/SUBJECT_PROPERTY/ADDRESS (4a.3.1) and String 35
-- under ASSETS/ASSET/OWNED_PROPERTY/PROPERTY/ADDRESS (3a.2.1), so a legal
-- 41-character street line is valid at one and invalid at the other and the two
-- renderings cannot be required to be byte-identical. Fannie also ships a
-- divergence: DI-C04 emits "1234 Main St" inside the REO against "1234 Main"
-- under COLLATERALS, and a model with nowhere to put that cannot round-trip a
-- shipped sample.
ALTER TABLE "du_owned_properties"
    ADD CONSTRAINT "du_owned_properties_non_subject_carries_its_own_address" CHECK (
        is_subject OR (
            address_line_text IS NOT NULL AND city_name IS NOT NULL
            AND state_code IS NOT NULL AND postal_code IS NOT NULL
        )
    ),
    -- A subject REO overrides the whole address or none of it. Half an override
    -- is the drift this exists to prevent, so every column is named on both
    -- sides -- `country_code` included, which is otherwise a subject REO with a
    -- country and no address.
    ADD CONSTRAINT "du_owned_properties_subject_override_is_whole" CHECK (
        NOT is_subject OR (
            (address_line_text IS NULL AND address_unit IS NULL AND city_name IS NULL
             AND state_code IS NULL AND postal_code IS NULL AND country_code IS NULL)
            OR
            (address_line_text IS NOT NULL AND city_name IS NOT NULL
             AND state_code IS NOT NULL AND postal_code IS NOT NULL)
        )
    ),
    -- String N at THIS destination: 35 / 11 / 35 / 2, narrower than the subject
    -- property's 50 on the street line.
    ADD CONSTRAINT "du_owned_properties_address_fits_the_wire" CHECK (
        char_length(COALESCE(address_line_text, '')) <= 35
        AND char_length(COALESCE(address_unit, '')) <= 11
        AND char_length(COALESCE(city_name, '')) <= 35
        AND char_length(COALESCE(state_code, '')) <= 2
        AND char_length(COALESCE(country_code, '')) <= 2
    ),
    -- MISMO 3.4 does not separate the five-digit zip from zip+4. Five digits or
    -- nine, no dash -- and the XSD accepts a dash, so this is the only place it
    -- is caught.
    ADD CONSTRAINT "du_owned_properties_postal_code_has_no_dash" CHECK (
        postal_code IS NULL OR postal_code ~ '^([0-9]{5}|[0-9]{9})$'
    ),
    ADD CONSTRAINT "du_owned_properties_intended_usage_needs_retain" CHECK (
        intended_usage IS NULL OR disposition_status = 'Retain'
    ),
    -- `PropertyUsageTypeOtherDescription` describes `Other` and nothing else.
    -- This is what makes a retained farm or an undeveloped lot expressible:
    -- without it the only writable values are the three occupancy words, and a
    -- farm has to be filed as an investment property, which is a different fact.
    -- `intended_usage` is null on every property not being retained, so the
    -- equality is the NULL-safe one: `Farm` with nothing to describe would
    -- otherwise emit a `PropertyUsageTypeOtherDescription` with no
    -- `PropertyUsageType` beside it.
    ADD CONSTRAINT "du_owned_properties_other_description_needs_other" CHECK (
        (intended_usage IS NOT DISTINCT FROM 'Other') = (intended_usage_other_description IS NOT NULL)
    ),
    -- Zero is an acceptable rental figure: a property can be retained as a
    -- second home and not rented out.
    ADD CONSTRAINT "du_owned_properties_amounts_fit_amount_9_2" CHECK (
        COALESCE(estimated_value_cents, 0) BETWEEN 0 AND 99999999999
        AND COALESCE(lien_upb_cents, 0) BETWEEN 0 AND 99999999999
        AND COALESCE(maintenance_expense_cents, 0) BETWEEN 0 AND 99999999999
        AND COALESCE(rental_income_gross_cents, 0) BETWEEN 0 AND 99999999999
    ),
    -- And the one that is signed, deliberately and separately. A net rental
    -- figure is income minus expenses and is negative when the property loses
    -- money: DI-C08's ASSET_7 emits -678.00. Amount 9.2 bounds the magnitude and
    -- not the sign. It is its own constraint rather than an omission from the
    -- list above, so that folding it into that list reads as the mistake it is.
    ADD CONSTRAINT "du_owned_properties_rental_net_fits_signed_amount_9_2" CHECK (
        rental_income_net_cents IS NULL
            OR rental_income_net_cents BETWEEN -99999999999 AND 99999999999
    ),
    -- 3a.8 is conditional on the disposition being Retain and the figure
    -- existing. One-directional, because "and exists" means a retained property
    -- may report no net figure. 3a.7, the gross amount, carries no
    -- conditionality statement at all and so gets no constraint: a rule the
    -- extract does not state is not enforced here either.
    ADD CONSTRAINT "du_owned_properties_rental_net_needs_retain" CHECK (
        rental_income_net_cents IS NULL OR disposition_status = 'Retain'
    );

-- ─── 5. Only a mortgage is secured by a property ───────────────────────────
-- Only the REO mortgage variant participates in
-- ASSET_IsAssociatedWith_LIABILITY, and only it carries HELOCMaximumBalanceAmount
-- and the taxes-and-insurance indicator.
ALTER TABLE "du_liabilities"
    ADD CONSTRAINT "du_liabilities_only_a_mortgage_is_secured" CHECK (
        secured_by_owned_property_id IS NULL
            OR liability_type IN ('MortgageLoan','HELOC')
    ),
    ADD CONSTRAINT "du_liabilities_heloc_maximum_needs_a_heloc" CHECK (
        heloc_maximum_balance_cents IS NULL OR liability_type = 'HELOC'
    ),
    ADD CONSTRAINT "du_liabilities_taxes_indicator_needs_a_mortgage" CHECK (
        payment_includes_taxes_insurance IS NULL
            OR liability_type IN ('MortgageLoan','HELOC')
    ),
    -- `MortgageType` on LIABILITY_DETAIL (3a.14) belongs to the REO mortgage
    -- variant like the two above. Exactly one LIABILITY_DETAIL in the corpus
    -- carries it -- DI-FHA02 line 138, on LIABILITY_1 -- and the same file's
    -- line 294 is the loan-level MortgageType on TERMS_OF_LOAN, a different data
    -- point with a wider set.
    ADD CONSTRAINT "du_liabilities_mortgage_type_needs_a_mortgage" CHECK (
        mortgage_type IS NULL OR liability_type IN ('MortgageLoan','HELOC')
    ),
    -- `LiabilityTypeOtherDescription` (2c.1, String 80) describes `Other`.
    ADD CONSTRAINT "du_liabilities_other_description_needs_other" CHECK (
        (liability_type = 'Other') = (liability_type_other_description IS NOT NULL)
    ),
    ADD CONSTRAINT "du_liabilities_amounts_fit_amount_9_2" CHECK (
        unpaid_balance_cents BETWEEN 0 AND 99999999999
        AND monthly_payment_cents BETWEEN 0 AND 99999999999
        AND COALESCE(heloc_maximum_balance_cents, 0) BETWEEN 0 AND 99999999999
    ),
    -- LIABILITY_HOLDER/NAME/FullName is String 150 (2c.2 / 3a.9) and
    -- LiabilityAccountIdentifier is String 30 (2c.3 / 3a.10).
    ADD CONSTRAINT "du_liabilities_strings_fit_the_wire" CHECK (
        char_length(holder_name) <= 150
        AND char_length(COALESCE(account_identifier, '')) <= 30
        AND char_length(COALESCE(liability_type_other_description, '')) <= 80
    ),
    -- `LiabilityRemainingTermMonthsCount` is Numeric 3, exactly like
    -- `BorrowerResidencyDurationMonthsCount`. 1200 months writes cleanly and is
    -- rejected by DU, which is the most expensive moment to find out.
    ADD CONSTRAINT "du_liabilities_remaining_term_fits_numeric_3" CHECK (
        remaining_term_months IS NULL OR remaining_term_months BETWEEN 0 AND 999
    );

ALTER TABLE "du_expenses"
    -- `ExpenseTypeOtherDescription` is 2d.1, conditional `IF ExpenseType =
    -- "Other"` -- which is a requirement as much as a permission, so this reads
    -- in both directions like its siblings on `du_assets` and `du_liabilities`.
    -- An expense filed as `Other` with nothing said about it emits an
    -- `ExpenseType` DU cannot act on. `expense_type` is NOT NULL, so a plain
    -- equality is enough here.
    ADD CONSTRAINT "du_expenses_other_description_needs_other" CHECK (
        (expense_type = 'Other') = (expense_other_description IS NOT NULL)
    ),
    ADD CONSTRAINT "du_expenses_amount_fits_amount_9_2" CHECK (
        monthly_payment_cents BETWEEN 0 AND 99999999999
    ),
    -- `ExpenseRemainingTermMonthsCount` is Numeric 3, same as the liability's.
    ADD CONSTRAINT "du_expenses_remaining_term_fits_numeric_3" CHECK (
        remaining_term_months IS NULL OR remaining_term_months BETWEEN 0 AND 999
    ),
    -- `alimony_owed_to_name` is ours and has no DU data point behind it, so it
    -- gets a bound of our own choosing rather than a cited one, and this comment
    -- says which it is.
    ADD CONSTRAINT "du_expenses_alimony_name_is_bounded" CHECK (
        char_length(COALESCE(alimony_owed_to_name, '')) <= 150
    );

-- ─── 5b. The one arc that is a foreign key stays inside the application ────
-- A liability on one application secured by an owned property on another emits
-- an `xlink:from` naming the other application's asset label, and the XSD
-- accepts a dangling endpoint silently. The three arcs that are join tables get
-- the same guard when they land; this is the one that is a foreign key, and a
-- foreign key that can cross an application boundary is not one.
CREATE OR REPLACE FUNCTION du_liabilities_are_secured_inside_the_application() RETURNS trigger AS $$
DECLARE op_app UUID;
BEGIN
    IF NEW.secured_by_owned_property_id IS NULL THEN RETURN NEW; END IF;
    SELECT application_id INTO op_app FROM "du_owned_properties"
        WHERE id = NEW.secured_by_owned_property_id;
    IF op_app IS DISTINCT FROM NEW.application_id THEN
        RAISE EXCEPTION 'liability % is on application % but the owned property securing it is on %; an arc across two applications points at a label this document does not contain',
            NEW.id, NEW.application_id, op_app;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER du_liabilities_stay_inside_the_application
    BEFORE INSERT OR UPDATE ON "du_liabilities"
    FOR EACH ROW EXECUTE FUNCTION du_liabilities_are_secured_inside_the_application();

-- ─── 5c. The lien balance is a TOTAL, and it is derived ────────────────────
-- DU Map record 193 (3a.12) defines OwnedPropertyLienUPBAmount as "the total
-- amount of all remaining mortgages and liens against the owned real property",
-- and the corpus agrees twice: DI-C04 emits 206,514.00 for 198,514.00 plus
-- 8,000.00, and DI-VA01, DI-VA02 and DI-VA03 emit 420,306.00 for 210,279.00 plus
-- 210,027.00. A property with a first mortgage and a HELOC is the shape the
-- asset-to-liability foreign key exists to express, and the balance of either
-- lien alone understates it.
--
-- Derived rather than asserted. There is no fact here the writer knows and the
-- database does not, an asserted total is a check the writer can fail, and a
-- credit re-pull that adds a second lien would leave a correct-looking row stale
-- until somebody recomputed it. So it is computed on both sides of the
-- relationship and nothing sets it by hand -- a value passed to a create or an
-- update is overwritten rather than refused. Null when no live liability points
-- at the row, which is a property owned free and clear.
CREATE OR REPLACE FUNCTION du_owned_properties_total_their_liens() RETURNS trigger AS $$
BEGIN
    NEW.lien_upb_cents := (
        SELECT sum(unpaid_balance_cents) FROM "du_liabilities"
         WHERE secured_by_owned_property_id = NEW.id AND retired_at IS NULL
    );
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER du_owned_properties_total_their_liens_write
    BEFORE INSERT OR UPDATE ON "du_owned_properties"
    FOR EACH ROW EXECUTE FUNCTION du_owned_properties_total_their_liens();

-- The other side: a lien written, retired, repointed or deleted re-totals the
-- property it left and the one it joined. The UPDATE below re-enters the BEFORE
-- trigger above, which recomputes the same value and stops; there is no second
-- write to recurse on.
CREATE OR REPLACE FUNCTION du_liabilities_retotal_their_property() RETURNS trigger AS $$
DECLARE op UUID;
BEGIN
    FOREACH op IN ARRAY ARRAY[
            CASE WHEN TG_OP <> 'INSERT' THEN OLD.secured_by_owned_property_id END,
            CASE WHEN TG_OP <> 'DELETE' THEN NEW.secured_by_owned_property_id END]
    LOOP
        IF op IS NOT NULL THEN
            UPDATE "du_owned_properties" SET lien_upb_cents = (
                SELECT sum(unpaid_balance_cents) FROM "du_liabilities"
                 WHERE secured_by_owned_property_id = op AND retired_at IS NULL
            ) WHERE id = op;
        END IF;
    END LOOP;
    RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER du_liabilities_retotal_their_property_write
    AFTER INSERT OR UPDATE OR DELETE ON "du_liabilities"
    FOR EACH ROW EXECUTE FUNCTION du_liabilities_retotal_their_property();

COMMENT ON TABLE "du_assets" IS
    'URLA 2a, 2b, 3a and 4d, which are one XML container. `kind` says which section a row is, and the per-kind CHECKs give each one the AssetType values and the columns that section carries.';

COMMENT ON TABLE "du_owned_properties" IS
    'URLA 3a, a 0:1 child of an OWNED_PROPERTY asset and never a sibling. lien_upb_cents is derived from the live liabilities securing the row and is never written by a caller.';
