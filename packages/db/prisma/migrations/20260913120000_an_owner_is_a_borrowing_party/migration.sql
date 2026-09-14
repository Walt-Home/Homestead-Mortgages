-- An owner is a borrowing party on this application, and a row without one
-- cannot be emitted.
--
-- The rows landed in 20260913110000 with no arcs and nothing requiring them.
-- This is the other half: the join tables that hold ASSET_IsAssociatedWith_ROLE
-- and its two siblings, the deferred triggers that make ownerlessness a
-- rollback rather than a defect somebody notices at Fannie Mae, and the sweep
-- that keeps account deletion working with all of it in the file.
--
-- Why the arcs are join tables and the endpoint is an application_parties row.
-- Two rows for one asset IS joint ownership: MISMO has no "joint" flag and no
-- place on a RELATIONSHIP to record a share, so a 60/40 split has no wire
-- representation and a second owner is a second arc. And the `to` end of the
-- arc is the ROLE element, which is emitted from the edge rather than from the
-- person -- so pointing these at `parties` would let a party merge, or a
-- borrower dropped on resubmission, leave an arc naming a label the document
-- does not contain. The XSD accepts exactly that, silently.
--
-- Additive. No route writes any of this.

-- ─── The three ownership arcs, and the joint credit report ─────────────────
-- Each carries a role column: DU has exactly one notion here -- the asset
-- belongs to this borrower -- and the column is where a distinction we need
-- and DU does not, such as which borrower supplied the statement, can live
-- without polluting the arc.
CREATE TABLE "du_asset_parties" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "application_party_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OWNER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "du_asset_parties_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "du_liability_parties" (
    "id" UUID NOT NULL,
    "liability_id" UUID NOT NULL,
    "application_party_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OBLIGOR',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "du_liability_parties_pkey" PRIMARY KEY ("id")
);

-- Two EXPENSE arcs in the whole corpus and both of them n:1 -- and a join table
-- anyway, because the wording of the arc role is identical to the asset's and
-- alimony can be joint. A foreign key here would be a bet against a shape
-- nothing forbids, for no saving.
CREATE TABLE "du_expense_parties" (
    "id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "application_party_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'PAYER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "du_expense_parties_pkey" PRIMARY KEY ("id")
);

-- ROLE_SharesJointCreditReportWith_ROLE. A GROUPING, not a flag and not a star:
-- DI-C02 emits BORROWER_3 -> BORROWER_2 while BORROWER_1 stands alone, so the
-- primary of a joint pair is not the application's primary borrower and cannot
-- be derived from PRIMARY_BORROWER versus CO_BORROWER. The direction is
-- load-bearing -- the arc roles put the group's primary under `to` and the
-- additional borrower under `from` -- so a symmetric row would emit it
-- backwards half the time.
CREATE TABLE "du_joint_credit_report_links" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "from_application_party_id" UUID NOT NULL,
    "to_application_party_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "du_joint_credit_report_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "du_asset_parties_asset_id_application_party_id_key"
    ON "du_asset_parties"("asset_id", "application_party_id");

CREATE INDEX "du_asset_parties_application_party_id_idx"
    ON "du_asset_parties"("application_party_id");

CREATE UNIQUE INDEX "du_liability_parties_liability_id_application_party_id_key"
    ON "du_liability_parties"("liability_id", "application_party_id");

CREATE INDEX "du_liability_parties_application_party_id_idx"
    ON "du_liability_parties"("application_party_id");

CREATE UNIQUE INDEX "du_expense_parties_expense_id_application_party_id_key"
    ON "du_expense_parties"("expense_id", "application_party_id");

CREATE INDEX "du_expense_parties_application_party_id_idx"
    ON "du_expense_parties"("application_party_id");

-- One group per additional borrower: a borrower whose credit report is shared
-- with two different primaries is two contradictory groups.
CREATE UNIQUE INDEX "du_joint_credit_links_one_group_per_additional_borrower"
    ON "du_joint_credit_report_links"("application_id", "from_application_party_id");

CREATE INDEX "du_joint_credit_links_by_group_primary"
    ON "du_joint_credit_report_links"("application_id", "to_application_party_id");

-- The cascade from `application_parties` is the structural half of "an owner is
-- on this application": dropping a borrower takes their arcs with them, so the
-- dangling endpoint is unreachable rather than merely discouraged.
ALTER TABLE "du_asset_parties" ADD CONSTRAINT "du_asset_parties_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "du_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_asset_parties" ADD CONSTRAINT "du_asset_parties_application_party_id_fkey" FOREIGN KEY ("application_party_id") REFERENCES "application_parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_liability_parties" ADD CONSTRAINT "du_liability_parties_liability_id_fkey" FOREIGN KEY ("liability_id") REFERENCES "du_liabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_liability_parties" ADD CONSTRAINT "du_liability_parties_application_party_id_fkey" FOREIGN KEY ("application_party_id") REFERENCES "application_parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_expense_parties" ADD CONSTRAINT "du_expense_parties_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "du_expenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_expense_parties" ADD CONSTRAINT "du_expense_parties_application_party_id_fkey" FOREIGN KEY ("application_party_id") REFERENCES "application_parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_joint_credit_report_links" ADD CONSTRAINT "du_joint_credit_report_links_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_joint_credit_report_links" ADD CONSTRAINT "du_joint_credit_report_links_from_application_party_id_fkey" FOREIGN KEY ("from_application_party_id") REFERENCES "application_parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "du_joint_credit_report_links" ADD CONSTRAINT "du_joint_credit_report_links_to_application_party_id_fkey" FOREIGN KEY ("to_application_party_id") REFERENCES "application_parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 6. An owner is a borrowing party on THIS application ──────────────────
-- The foreign key says the edge exists and that removing the borrower removes
-- the arc. What it cannot say is that the edge belongs to the SAME application
-- as the row it owns, or that its role is a borrowing one -- a non-borrowing
-- spouse and a guarantor never become DU Borrower elements, so an arc pointing
-- at one points at a ROLE the document does not emit.
CREATE OR REPLACE FUNCTION du_links_stay_inside_the_application() RETURNS trigger AS $$
DECLARE app UUID; ap_app UUID; r "ApplicationPartyRole";
BEGIN
    EXECUTE format('SELECT application_id FROM %I WHERE id = $1', TG_ARGV[0])
        INTO app USING (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
    SELECT application_id, role INTO ap_app, r FROM "application_parties"
        WHERE id = NEW.application_party_id;
    IF ap_app IS DISTINCT FROM app THEN
        RAISE EXCEPTION 'application_party % is on application % but the row it owns is on %; an arc across two applications points at a label this document does not contain',
            NEW.application_party_id, ap_app, app;
    END IF;
    IF r NOT IN ('PRIMARY_BORROWER','CO_BORROWER','NON_OCCUPANT_CO_BORROWER') THEN
        RAISE EXCEPTION 'application_party % is %, which is not a DU Borrower', NEW.application_party_id, r;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER du_asset_parties_stay_inside_the_application
    BEFORE INSERT OR UPDATE ON "du_asset_parties" FOR EACH ROW
    EXECUTE FUNCTION du_links_stay_inside_the_application('du_assets', 'asset_id');

CREATE TRIGGER du_liability_parties_stay_inside_the_application
    BEFORE INSERT OR UPDATE ON "du_liability_parties" FOR EACH ROW
    EXECUTE FUNCTION du_links_stay_inside_the_application('du_liabilities', 'liability_id');

CREATE TRIGGER du_expense_parties_stay_inside_the_application
    BEFORE INSERT OR UPDATE ON "du_expense_parties" FOR EACH ROW
    EXECUTE FUNCTION du_links_stay_inside_the_application('du_expenses', 'expense_id');

-- ─── 7. Nothing emittable is left without an owner, EVER ───────────────────
-- Deferred to COMMIT, because a row and its first owner arc land in one
-- transaction and neither is writable before the other. This is what makes
-- joint ownership structural: a second owner is a second row, and zero owners
-- is a rollback.
--
-- The check has to run on the JOIN tables as well, for DELETE and UPDATE.
-- Firing only on the parent's INSERT would make the promise true at the instant
-- of creation and at no other time: `DELETE FROM du_asset_parties` in a second
-- transaction reports DELETE 1 and leaves an asset standing with no owner.
--
-- And the rule is about rows that will be EMITTED. A row deleted inside this
-- transaction is not one, so creating an asset and dropping it again commits;
-- a row that has been superseded is not one either, so retiring an asset and
-- then removing its last arc commits too. Without the second, dropping a
-- borrower from a file would be refused because of an account a re-pull
-- superseded three days earlier -- which is an ordinary operation made
-- impossible for every borrower whose rows a pull has touched.
--
-- `du_expenses` has no `retired_at` -- an expense is typed by a person and no
-- connector supersedes one -- so liveness cannot be a blind `retired_at IS
-- NULL` inside a shared function. It is a trigger argument, which also puts the
-- asymmetry at every call site instead of hiding it in a WHERE clause.
CREATE OR REPLACE FUNCTION du_rows_have_an_owner() RETURNS trigger AS $$
DECLARE n INT; link_tbl TEXT := TG_ARGV[0]; col TEXT := TG_ARGV[1];
        supersedes BOOLEAN := TG_ARGV[2]::boolean; live BOOLEAN; rid UUID := NEW.id;
BEGIN
    IF supersedes THEN
        EXECUTE format('SELECT true FROM %I WHERE id = $1 AND retired_at IS NULL', TG_TABLE_NAME)
            INTO live USING rid;
    ELSE
        EXECUTE format('SELECT true FROM %I WHERE id = $1', TG_TABLE_NAME) INTO live USING rid;
    END IF;
    IF live IS NOT TRUE THEN RETURN NULL; END IF;
    EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', link_tbl, col) INTO n USING rid;
    IF n = 0 THEN
        RAISE EXCEPTION '% % has no party link and cannot be emitted; every ASSET, LIABILITY and EXPENSE in all eighteen shipped samples carries at least one owner arc',
            TG_TABLE_NAME, rid;
    END IF;
    RETURN NULL;
END; $$ LANGUAGE plpgsql;

-- The mirror side: re-check the PARENT of an arc that was removed or moved.
-- Silent when that parent is gone or superseded, for the reason above --
-- deleting a row together with its arcs is the ordinary case.
CREATE OR REPLACE FUNCTION du_link_removal_rechecks_its_parent() RETURNS trigger AS $$
DECLARE n INT; parent_tbl TEXT := TG_ARGV[0]; col TEXT := TG_ARGV[1];
        supersedes BOOLEAN := TG_ARGV[2]::boolean; pid UUID; still BOOLEAN;
BEGIN
    pid := (to_jsonb(OLD) ->> col)::uuid;
    IF supersedes THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1 AND retired_at IS NULL)', parent_tbl)
            INTO still USING pid;
    ELSE
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE id = $1)', parent_tbl)
            INTO still USING pid;
    END IF;
    IF NOT still THEN RETURN NULL; END IF;
    EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', TG_TABLE_NAME, col) INTO n USING pid;
    IF n = 0 THEN
        RAISE EXCEPTION '% % has no party link left and cannot be emitted; removing the last owner is removing the arc',
            parent_tbl, pid;
    END IF;
    RETURN NULL;
END; $$ LANGUAGE plpgsql;

-- INSERT OR UPDATE, because a row can become live without being inserted. The
-- supersede cycle reaches a live row with zero owners in four permitted
-- statements: create the asset and its arc, retire the asset, delete the last
-- arc -- allowed, because the mirror above is deliberately silent about
-- superseded parents -- then clear `retired_at`, which is how an account that
-- went away and came back is revived as one account rather than a twin. An
-- INSERT-only trigger sees none of it.
CREATE CONSTRAINT TRIGGER du_assets_have_an_owner AFTER INSERT OR UPDATE ON "du_assets"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION du_rows_have_an_owner('du_asset_parties', 'asset_id', 'true');

CREATE CONSTRAINT TRIGGER du_liabilities_have_an_obligor AFTER INSERT OR UPDATE ON "du_liabilities"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION du_rows_have_an_owner('du_liability_parties', 'liability_id', 'true');

CREATE CONSTRAINT TRIGGER du_expenses_have_a_payer AFTER INSERT OR UPDATE ON "du_expenses"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION du_rows_have_an_owner('du_expense_parties', 'expense_id', 'false');

CREATE CONSTRAINT TRIGGER du_asset_parties_leave_an_owner
    AFTER DELETE OR UPDATE ON "du_asset_parties"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION du_link_removal_rechecks_its_parent('du_assets', 'asset_id', 'true');

CREATE CONSTRAINT TRIGGER du_liability_parties_leave_an_obligor
    AFTER DELETE OR UPDATE ON "du_liability_parties"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION du_link_removal_rechecks_its_parent('du_liabilities', 'liability_id', 'true');

CREATE CONSTRAINT TRIGGER du_expense_parties_leave_a_payer
    AFTER DELETE OR UPDATE ON "du_expense_parties"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
    EXECUTE FUNCTION du_link_removal_rechecks_its_parent('du_expenses', 'expense_id', 'false');

-- ─── 8. The container maxima, which the XSD does not enforce ───────────────
-- ASSET, LIABILITY and EXPENSE are each 0:50 per DEAL. A 51st row is a file DU
-- rejects, and xmllint accepts it without comment.
--
-- It counts LIVE rows, because the cardinality is a statement about emitted
-- elements. Counting every row ever written, on two tables whose whole re-pull
-- design is to accumulate superseded ones, is a lockout: twelve live deposit
-- accounts reach 48 rows after four pulls, and the fifth pull -- and every pull
-- after it, forever -- is refused while the document those rows would emit
-- carries twelve `<ASSET>` elements against a limit of fifty. A cap on INGEST
-- is a lockout; a cap on EMISSION is the actual rule.
--
-- And it counts at COMMIT, on INSERT OR UPDATE, for the reason the owner check
-- does: a BEFORE INSERT count cannot see a row that becomes live by having
-- `retired_at` cleared, so a revive could carry the live count past fifty. This
-- also lets one transaction retire ten rows and insert ten without tripping on
-- the order the writer chose.
--
-- Two writers inserting concurrently in separate transactions can still both
-- pass. This is a check against a writer that has lost track, not a
-- serialization point; where this repo needs a race to be an error it reaches
-- for a unique index, and no unique index expresses "at most fifty".
CREATE OR REPLACE FUNCTION du_container_fits_fifty() RETURNS trigger AS $$
DECLARE n INT; supersedes BOOLEAN := TG_ARGV[0]::boolean;
BEGIN
    IF supersedes THEN
        EXECUTE format('SELECT count(*) FROM %I WHERE application_id = $1 AND retired_at IS NULL', TG_TABLE_NAME)
            INTO n USING NEW.application_id;
    ELSE
        EXECUTE format('SELECT count(*) FROM %I WHERE application_id = $1', TG_TABLE_NAME)
            INTO n USING NEW.application_id;
    END IF;
    -- `> 50`, not `>= 50`: the row being checked is already in the count.
    IF n > 50 THEN
        RAISE EXCEPTION '% is 0:50 per DEAL and application % would emit % rows',
            TG_TABLE_NAME, NEW.application_id, n;
    END IF;
    RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER du_assets_fit_fifty AFTER INSERT OR UPDATE ON "du_assets"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_container_fits_fifty('true');

CREATE CONSTRAINT TRIGGER du_liabilities_fit_fifty AFTER INSERT OR UPDATE ON "du_liabilities"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_container_fits_fifty('true');

CREATE CONSTRAINT TRIGGER du_expenses_fit_fifty AFTER INSERT OR UPDATE ON "du_expenses"
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION du_container_fits_fifty('false');

-- ─── 9. The joint credit report is a partition, and its `to` end is primary ─
-- A group has exactly one primary, so a party who is a `from` may not also be a
-- `to`, and an arc from a borrower to themselves says nothing.
ALTER TABLE "du_joint_credit_report_links"
    ADD CONSTRAINT "du_joint_credit_links_are_not_reflexive"
        CHECK (from_application_party_id <> to_application_party_id);

-- Both endpoints belong to THIS application and are borrowing roles. The
-- foreign keys tie each end to some edge and nothing ties either to the row's
-- own `application_id`, so without this a link could name an edge on a
-- different application entirely -- on the one arc whose DIRECTION is
-- load-bearing, where a wrong endpoint makes DU read the wrong borrower as the
-- group's primary.
CREATE OR REPLACE FUNCTION du_joint_credit_groups_have_one_primary() RETURNS trigger AS $$
DECLARE from_app UUID; to_app UUID; from_role "ApplicationPartyRole"; to_role "ApplicationPartyRole";
BEGIN
    SELECT application_id, role INTO from_app, from_role
        FROM "application_parties" WHERE id = NEW.from_application_party_id;
    SELECT application_id, role INTO to_app, to_role
        FROM "application_parties" WHERE id = NEW.to_application_party_id;
    IF from_app IS DISTINCT FROM NEW.application_id OR to_app IS DISTINCT FROM NEW.application_id THEN
        RAISE EXCEPTION 'joint credit link on application % names edges on % and %; an arc across two applications points at a label this document does not contain',
            NEW.application_id, from_app, to_app;
    END IF;
    IF from_role NOT IN ('PRIMARY_BORROWER','CO_BORROWER','NON_OCCUPANT_CO_BORROWER')
       OR to_role NOT IN ('PRIMARY_BORROWER','CO_BORROWER','NON_OCCUPANT_CO_BORROWER') THEN
        RAISE EXCEPTION 'a joint credit report is shared between two DU Borrowers; this link names a % and a %',
            from_role, to_role;
    END IF;
    IF EXISTS (SELECT 1 FROM "du_joint_credit_report_links"
                WHERE application_id = NEW.application_id
                  AND from_application_party_id = NEW.to_application_party_id) THEN
        RAISE EXCEPTION 'application_party % is already an additional borrower on this application and cannot also be a group primary',
            NEW.to_application_party_id;
    END IF;
    IF EXISTS (SELECT 1 FROM "du_joint_credit_report_links"
                WHERE application_id = NEW.application_id
                  AND to_application_party_id = NEW.from_application_party_id) THEN
        RAISE EXCEPTION 'application_party % is already a group primary on this application and cannot also be an additional borrower',
            NEW.from_application_party_id;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER du_joint_credit_groups_have_one_primary_write
    BEFORE INSERT OR UPDATE ON "du_joint_credit_report_links"
    FOR EACH ROW EXECUTE FUNCTION du_joint_credit_groups_have_one_primary();

-- ─── 10. The role-flip guard now covers the arcs as well ───────────────────
-- 20260912100000 created this function with the declaration and residence
-- clauses, which were the only DU rows a party could carry: the three join
-- tables and the joint credit link did not exist. Now they do, and without
-- these clauses a CO_BORROWER holding an asset, a liability and an expense can
-- be flipped to NON_BORROWING_SPOUSE and keep every one of them -- the
-- dangling-arc state the foreign keys above exist to make unreachable, reached
-- through the one write that touches neither end of an arc.
--
-- Replaced here rather than edited there: an applied migration is history and
-- `prisma migrate` checksums it.
CREATE OR REPLACE FUNCTION application_parties_keep_their_du_rows_valid() RETURNS trigger AS $$
BEGIN
    IF NEW.role IN ('PRIMARY_BORROWER','CO_BORROWER','NON_OCCUPANT_CO_BORROWER') THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM "du_declarations"       WHERE application_party_id = NEW.id)
       OR EXISTS (SELECT 1 FROM "du_residences"      WHERE application_party_id = NEW.id)
       OR EXISTS (SELECT 1 FROM "du_asset_parties"     WHERE application_party_id = NEW.id)
       OR EXISTS (SELECT 1 FROM "du_liability_parties" WHERE application_party_id = NEW.id)
       OR EXISTS (SELECT 1 FROM "du_expense_parties"   WHERE application_party_id = NEW.id)
       OR EXISTS (SELECT 1 FROM "du_joint_credit_report_links"
                   WHERE from_application_party_id = NEW.id OR to_application_party_id = NEW.id) THEN
        RAISE EXCEPTION
            'application_party % carries DU borrower rows and cannot become %; remove the declaration, residences, ownership links and joint-credit links first',
            NEW.id, NEW.role;
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- ─── 11. Deleting an ACCOUNT still works, with all of this in the file ─────
-- The promise on the privacy page is that a person's data goes for good, and
-- the owner check above is the first thing in these tables capable of breaking
-- it. It breaks it for exactly one person: a co-borrower on a file somebody
-- ELSE owns who is the sole owner of an asset, a liability or an expense.
-- `users_delete_takes_files` removes only the files the departing user owns, so
-- the application, the rows and the other borrowers all outlive the party --
-- and the party's cascade prunes their arcs, leaving a live row with no owner
-- for the deferred check to refuse at COMMIT. The check is right; until now
-- there was nothing to do the tidying.
--
-- So the sweep runs here, beside the declaration sweep, where the hazard
-- already lives. It deletes the departing party's `application_parties` rows --
-- which takes their declaration, their residences, their joint-credit links and
-- their ownership arcs by cascade -- and then deletes any LIVE asset, liability
-- or expense on those applications that this has left with no owner at all.
--
-- Deleted, not retired: a superseded row exists so a later pull can revive it
-- as the same account, and the person whose account it was is gone, so there is
-- nothing it could be revived as. Retired rows that lose their last arc are
-- left where they are -- they emit nothing, the check above is silent about
-- them, and they are the history of a file that still belongs to somebody.
--
-- A row vanishing from a surviving borrower's file is a fact about that file,
-- so it is written to `file_events` rather than happening quietly. Their
-- co-borrower left and took their own bank account with them; the file is a
-- person short, and the requirements engine will say so on the next evaluation.
CREATE OR REPLACE FUNCTION parties_delete_takes_their_du_rows() RETURNS trigger AS $$
DECLARE apps UUID[];
BEGIN
    SELECT coalesce(array_agg(DISTINCT application_id), '{}') INTO apps
        FROM "application_parties" WHERE party_id = OLD.id;
    IF coalesce(array_length(apps, 1), 0) = 0 THEN RETURN OLD; END IF;

    DELETE FROM "application_parties" WHERE party_id = OLD.id;

    WITH gone_assets AS (
        DELETE FROM "du_assets" a
         WHERE a.application_id = ANY(apps) AND a.retired_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM "du_asset_parties" l WHERE l.asset_id = a.id)
        RETURNING a.id, a.application_id
    ), gone_liabilities AS (
        DELETE FROM "du_liabilities" l
         WHERE l.application_id = ANY(apps) AND l.retired_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM "du_liability_parties" p WHERE p.liability_id = l.id)
        RETURNING l.id, l.application_id
    ), gone_expenses AS (
        DELETE FROM "du_expenses" e
         WHERE e.application_id = ANY(apps)
           AND NOT EXISTS (SELECT 1 FROM "du_expense_parties" p WHERE p.expense_id = e.id)
        RETURNING e.id, e.application_id
    ), gone AS (
        SELECT 'du_assets' AS tbl, id, application_id FROM gone_assets
        UNION ALL SELECT 'du_liabilities', id, application_id FROM gone_liabilities
        UNION ALL SELECT 'du_expenses',    id, application_id FROM gone_expenses
    )
    INSERT INTO "file_events" (id, loan_file_id, kind, requirement_id, payload, actor, occurred_at)
    SELECT gen_random_uuid(), app.loan_file_id, 'du_rows_left_with_no_owner', NULL,
           jsonb_build_object('applicationId', app.id,
                              'departingPartyId', OLD.id,
                              'removed', jsonb_agg(jsonb_build_object('table', g.tbl, 'id', g.id))),
           'system', now()
      FROM gone g JOIN "applications" app ON app.id = g.application_id
     GROUP BY app.id, app.loan_file_id;

    RETURN OLD;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER parties_delete_takes_their_du_rows_before
    BEFORE DELETE ON "parties"
    FOR EACH ROW EXECUTE FUNCTION parties_delete_takes_their_du_rows();

COMMENT ON TABLE "du_asset_parties" IS
    'ASSET_IsAssociatedWith_ROLE. Two rows for one asset is joint ownership; MISMO has no joint flag and nowhere to record a share.';

COMMENT ON TABLE "du_joint_credit_report_links" IS
    'ROLE_SharesJointCreditReportWith_ROLE. Directed: `to` is the group''s primary, `from` the additional borrower, and reversing it makes DU read the wrong borrower as primary.';
