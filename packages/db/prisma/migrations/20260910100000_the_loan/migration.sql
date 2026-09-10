-- The loan: a mortgage that exists in the world.
--
-- It outlives the application that made it, and it may have had no application
-- at all — a servicer's portfolio record is a mortgage somebody is paying with
-- nothing of ours behind it. That is why `originating_application_id` is
-- nullable, why party composition is a join table rather than a column, and why
-- its ledger keeps a rule an application's has no need of: a loan outlives the
-- people on it, so nothing here may name a principal that dies with one.
--
-- Additive. Nothing writes a loan yet. See docs/states.md.

-- ─── Servicers: integration depth is configuration, never a lifecycle fact ──
-- Deep link, then API, then acting as the subservicer is a connection detail.
-- On the servicer row it is a configuration change; as a loan state it would be
-- a migration, and a borrower-visible lifecycle fact that says nothing about
-- their mortgage.
CREATE TYPE "IntegrationDepth" AS ENUM ('NONE', 'DEEP_LINK', 'API', 'SUBSERVICED');

CREATE TABLE "servicers" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "integration_depth" "IntegrationDepth" NOT NULL DEFAULT 'NONE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "servicers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "servicers_slug_key" ON "servicers"("slug");

-- ─── The eleven states, the source, the rate type, the program ─────────────
CREATE TYPE "LoanState" AS ENUM ('PENDING_BOARDING', 'BOARDING', 'IMPORTED_UNCLAIMED', 'ACTIVE', 'MONITORING_ONLY', 'IN_SERVICING_TRANSFER', 'PAID_OFF', 'REFINANCED_INTERNALLY', 'TRANSFERRED_OUT', 'CHARGED_OFF', 'MATURED');

CREATE TYPE "LoanSource" AS ENUM ('ORIGINATION', 'PARTNER_IMPORT');

CREATE TYPE "LoanRateType" AS ENUM ('FIXED', 'ARM');

-- Program is an axis in its own right. docs/states.md: "May not: Be inferred
-- from objective or from channel." So it is a column, and it is nullable,
-- because a feed that did not say must not be answered with a guess.
CREATE TYPE "LoanProgram" AS ENUM ('CONVENTIONAL', 'HIGH_BALANCE', 'JUMBO', 'FHA', 'VA', 'USDA', 'NON_QM', 'AGRICULTURAL');

CREATE TABLE "loans" (
    "id" UUID NOT NULL,

    "status" "LoanState" NOT NULL,
    "status_seq" INTEGER NOT NULL DEFAULT 0,
    "status_entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    "source" "LoanSource" NOT NULL,
    -- The application that created this loan. NULLABLE and load-bearing: an
    -- imported mortgage has no application behind it. SET NULL, not CASCADE:
    -- deleting a stale application cannot erase a mortgage somebody is paying.
    "originating_application_id" UUID,
    "servicer_id" UUID,

    -- The four axes. NULL means the feed did not say. Nothing may infer one.
    "objective" "ScenarioObjective",
    "program" "LoanProgram",
    "lien_position" "LienPosition",
    "occupancy" "Occupancy",

    -- Terms AT ORIGINATION. Everything that moves month to month is an
    -- observation, never a column here.
    "rate_type" "LoanRateType" NOT NULL,
    "note_rate_bps" INTEGER NOT NULL,
    "term_months" INTEGER NOT NULL,
    "original_principal_cents" BIGINT NOT NULL,
    "originated_on" DATE,
    "first_payment_on" DATE,
    "maturity_on" DATE,

    -- BRIDGE, in the same words loan_scenarios uses: there is no properties
    -- table yet. These move when it lands, and the readers move with them.
    "property_line1" TEXT,
    "property_line2" TEXT,
    "property_city" TEXT,
    "property_state" VARCHAR(2),
    "property_postal_code" TEXT,
    "property_apn" TEXT,

    -- The attributable chain the monitoring loop exists to produce.
    "refinanced_by_loan_id" UUID,

    -- The monitoring seam. Same idiom and same index shape as connector_links'
    -- (persistent_monitoring_enabled, next_sync_due_at), so a scheduler claims
    -- from one shape and not two. Ships here, unread, because four lines of
    -- shipped copy already promise the borrower an off switch.
    "monitoring_enabled" BOOLEAN NOT NULL DEFAULT false,
    "next_review_due_at" TIMESTAMP(3),

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "loans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "loans_originating_application_id_key" ON "loans"("originating_application_id");
CREATE INDEX "loans_status_entered" ON "loans"("status", "status_entered_at");
CREATE INDEX "loans_review_due" ON "loans"("monitoring_enabled", "next_review_due_at");
CREATE INDEX "loans_originating_app" ON "loans"("originating_application_id");

ALTER TABLE "loans" ADD CONSTRAINT "loans_originating_application_id_fkey" FOREIGN KEY ("originating_application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "loans" ADD CONSTRAINT "loans_servicer_id_fkey" FOREIGN KEY ("servicer_id") REFERENCES "servicers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "loans" ADD CONSTRAINT "loans_refinanced_by_loan_id_fkey" FOREIGN KEY ("refinanced_by_loan_id") REFERENCES "loans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "loans" ADD CONSTRAINT "loans_status_seq_not_negative"
  CHECK (status_seq >= 0);
-- We know our own loans' axes. An imported record records what it was told.
ALTER TABLE "loans" ADD CONSTRAINT "loans_we_know_our_own_axes"
  CHECK (source <> 'ORIGINATION' OR (objective IS NOT NULL AND program IS NOT NULL
         AND lien_position IS NOT NULL AND occupancy IS NOT NULL));
-- An unclaimed loan is never monitored: there is nobody to show a result to,
-- and the toggle is a person's choice.
ALTER TABLE "loans" ADD CONSTRAINT "loans_unclaimed_is_not_monitored"
  CHECK (NOT (monitoring_enabled AND status = 'IMPORTED_UNCLAIMED'));

-- ─── Who is on it. Plural from the start, mirroring application_parties ────
CREATE TABLE "loan_parties" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "party_id" UUID NOT NULL,
    "role" "ApplicationPartyRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_parties_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "loan_parties_one_per_loan_party" ON "loan_parties"("loan_id", "party_id");
CREATE INDEX "loan_parties_party" ON "loan_parties"("party_id");

ALTER TABLE "loan_parties" ADD CONSTRAINT "loan_parties_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- CASCADE: a person's LINK to a mortgage is personal data and goes with them.
-- The loan row itself is not, and goes only when the last party leaves — see
-- users_delete_takes_loans below.
ALTER TABLE "loan_parties" ADD CONSTRAINT "loan_parties_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── The ledger ────────────────────────────────────────────────────────────
CREATE TABLE "loan_transitions" (
    "id" UUID NOT NULL,
    "loan_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "from_state" "LoanState",
    "to_state" "LoanState" NOT NULL,
    "event" TEXT NOT NULL,
    -- RESTRICT, exactly as application_transitions. SET NULL is not merely
    -- undesirable but impossible: the RI action is an UPDATE, and the
    -- append-only trigger RAISEs on every UPDATE. Which is exactly why no row
    -- here may name a principal that cascades from a party — a loan outlives
    -- its parties, and this edge would then outlive the principal it points
    -- at. See loan_transitions_actor_outlives_people below.
    "actor_principal_id" UUID NOT NULL,
    "reason_code" TEXT,
    "caused_by" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_transitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "loan_transitions_loan_seq" ON "loan_transitions"("loan_id", "seq");
CREATE INDEX "loan_transitions_loan_occurred" ON "loan_transitions"("loan_id", "occurred_at");

ALTER TABLE "loan_transitions" ADD CONSTRAINT "loan_transitions_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "loan_transitions" ADD CONSTRAINT "loan_transitions_actor_principal_id_fkey" FOREIGN KEY ("actor_principal_id") REFERENCES "principals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "loan_transitions" ADD CONSTRAINT "loan_transitions_seq_positive"
  CHECK (seq >= 1);

-- ─── One rule, for both aggregates, from one text ──────────────────────────
--
-- A status change with no ledger row fails at COMMIT rather than at the
-- statement: that is the only point at which "did this transaction also record
-- why" is answerable, because the update and the insert can happen in either
-- order and both are legitimate.
--
-- It gains a second early return here, and BOTH tables get it, because a row
-- that is GONE at COMMIT has no status left to explain. That is not
-- hypothetical: deleting an account removes the person's file, which cascades
-- to the application, which sets `loans.originating_application_id` to NULL —
-- an UPDATE, which queues this check — and then users_delete_takes_loans
-- removes the loan itself as an orphan. Postgres still fires the queued check
-- at COMMIT, it looks for a ledger row that went with the loan, and without
-- this guard it refuses the whole deletion. A mortgage we funded would make
-- its sole borrower's account undeletable, and the refusal would name a
-- missing transition row.
--
-- Applications are written from the same text rather than left alone, because
-- the two families being one rule is the property loan-triggers.test.ts holds
-- them to; fixing one and not the other is exactly the drift it exists to
-- catch. Nothing about application behavior changes: no shipped path updates a
-- status and deletes the row in one transaction.
DO $do$
DECLARE
  rule TEXT := $tpl$
CREATE OR REPLACE FUNCTION %TABLE%_status_has_a_ledger_row() RETURNS trigger AS $$
BEGIN
  IF NEW.status_seq = 0 THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "%TABLE%" WHERE id = NEW.id) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "%LEDGER%"
    WHERE %NOUN%_id = NEW.id AND seq = NEW.status_seq AND to_state = NEW.status
  ) THEN
    RAISE EXCEPTION '%NOUN% % is at % (seq %) with no matching transition row; the move was never explained', NEW.id, NEW.status, NEW.status_seq;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
$tpl$;
  noun TEXT;
BEGIN
  FOREACH noun IN ARRAY ARRAY['loan', 'application'] LOOP
    EXECUTE replace(replace(replace(
      rule,
      '%LEDGER%', noun || '_transitions'),
      '%TABLE%', noun || 's'),
      '%NOUN%', noun);
  END LOOP;
END
$do$;

-- ─── The other four, generated from ONE template ───────────────────────────
--
-- Every guarantee that makes the application ledger trustworthy is written per
-- table — two BEFORE UPDATE triggers on the state-carrying row, the deferred
-- constraint trigger above, an append-only trigger on the ledger — because a
-- polymorphic `transitions(aggregate_type, aggregate_id, seq)` table can carry
-- a declared foreign key to neither aggregate, and the deferred check fires on
-- the aggregate rather than on the ledger anyway. So the SQL is per table and
-- the TypeScript is shared, and the cost of that choice — near-identical
-- plpgsql — is paid here, once, by substituting into the text 20260904180000
-- already uses rather than by retyping it, plus the two rules below that have
-- no counterpart there:
--
--   %TABLE%    = loans              %NOUN%     = loan
--   %LEDGER%   = loan_transitions   %TERMINAL% = the five endings
--   %BIRTH%    = the two beginnings
--
-- ONE SENTENCE IS NOT A SUBSTITUTION, and it is named here rather than left to
-- be discovered. The application's terminal refusal ends '; start a new
-- application', which is advice a loan cannot be given: nobody starts a new
-- mortgage because the old one paid off, and a substituted noun would put a
-- false instruction in the message a person eventually reads. So
-- loans_terminal_is_final's RAISE stops at 'cannot be reopened', that clause is
-- the one place the two texts diverge, and loan-triggers.test.ts strips it from
-- the APPLICATION's side only — so a loan trigger that ever grows an
-- application-flavored clause is red rather than normalized away.
--
-- A future migration that patches applications_terminal_is_final without
-- patching loans_terminal_is_final is the exact failure this arrangement is
-- exposed to, and loan-triggers.test.ts is what catches it: it reads both
-- families out of pg_get_functiondef, undoes these substitutions, and requires
-- what is left to be identical.
DO $do$
DECLARE
  template TEXT;
  templates TEXT[] := ARRAY[
    -- 1. A status change advances the seq and stamps the time. This is what
    --    makes `prisma.loan.update({ data: { status } })` fail.
    $tpl$
CREATE OR REPLACE FUNCTION %TABLE%_status_moves_with_seq() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status_seq <> OLD.status_seq + 1 THEN
      RAISE EXCEPTION '%NOUN% % changed status without advancing status_seq (% -> %); use the transition service', OLD.id, OLD.status, NEW.status;
    END IF;
    IF NEW.status_entered_at IS NOT DISTINCT FROM OLD.status_entered_at THEN
      RAISE EXCEPTION '%NOUN% % changed status without stamping status_entered_at', OLD.id;
    END IF;
  ELSIF NEW.status_seq IS DISTINCT FROM OLD.status_seq THEN
    RAISE EXCEPTION '%NOUN% % advanced status_seq without changing status', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
$tpl$,
    $tpl$
CREATE TRIGGER %TABLE%_status_moves_with_seq_update
  BEFORE UPDATE ON "%TABLE%"
  FOR EACH ROW EXECUTE FUNCTION %TABLE%_status_moves_with_seq();
$tpl$,
    -- 2. An ending is an ending, at the storage layer too. Five of eleven.
    $tpl$
CREATE OR REPLACE FUNCTION %TABLE%_terminal_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN (%TERMINAL%)
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION '%NOUN% % is % and cannot be reopened', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
$tpl$,
    $tpl$
CREATE TRIGGER %TABLE%_terminal_is_final_update
  BEFORE UPDATE ON "%TABLE%"
  FOR EACH ROW EXECUTE FUNCTION %TABLE%_terminal_is_final();
$tpl$,
    -- 3. A loan is BORN in one of exactly two states, at seq 0. This is the
    --    guard a bulk importer most wants to skip, and the reason it is a
    --    trigger. The one member of the template with no application twin —
    --    an application has a single beginning and a column default — so its
    --    words name the two beginnings rather than a substituted list.
    $tpl$
CREATE OR REPLACE FUNCTION %TABLE%_is_born_not_placed() RETURNS trigger AS $$
BEGIN
  IF NEW.status NOT IN (%BIRTH%) THEN
    RAISE EXCEPTION 'a loan is created at pending_boarding (we funded it) or imported_unclaimed (a feed brought it), not at %; every later state is a move somebody caused', NEW.status;
  END IF;
  IF NEW.status_seq <> 0 THEN
    RAISE EXCEPTION 'a new %NOUN% starts at seq 0';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
$tpl$,
    $tpl$
CREATE TRIGGER %TABLE%_is_born_not_placed_insert
  BEFORE INSERT ON "%TABLE%"
  FOR EACH ROW EXECUTE FUNCTION %TABLE%_is_born_not_placed();
$tpl$,
    -- 4. The deferred ledger check hangs on the loan here; the rule it runs
    --    is the one written above, once, for both aggregates.
    $tpl$
CREATE CONSTRAINT TRIGGER %TABLE%_status_has_a_ledger_row_check
  AFTER INSERT OR UPDATE ON "%TABLE%"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION %TABLE%_status_has_a_ledger_row();
$tpl$,
    -- 5. The ledger is append-only. No DELETE trigger, for the same reason
    --    application_transitions has none: the cascade is what keeps the
    --    deletion promise true.
    $tpl$
CREATE OR REPLACE FUNCTION %LEDGER%_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%LEDGER% is append-only (% on %)', TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;
$tpl$,
    $tpl$
CREATE TRIGGER %LEDGER%_append_only_update
  BEFORE UPDATE ON "%LEDGER%"
  FOR EACH ROW EXECUTE FUNCTION %LEDGER%_append_only();
$tpl$
  ];
BEGIN
  FOREACH template IN ARRAY templates LOOP
    EXECUTE replace(replace(replace(replace(replace(
      template,
      '%TERMINAL%', $lit$'PAID_OFF','REFINANCED_INTERNALLY','TRANSFERRED_OUT','CHARGED_OFF','MATURED'$lit$),
      '%BIRTH%', $lit$'PENDING_BOARDING','IMPORTED_UNCLAIMED'$lit$),
      '%LEDGER%', 'loan_transitions'),
      '%TABLE%', 'loans'),
      '%NOUN%', 'loan');
  END LOOP;
END
$do$;

-- ─── 6. Claiming refinanced_internally means naming the loan that did it ───
--
-- Not part of the template: an application has no such column and no such
-- claim. And a rule about the MOVE rather than about the row, which is the
-- difference between a rule and a deadlock here.
--
-- As a CHECK it would also refuse an UPDATE nobody asked for.
-- `refinanced_by_loan_id` is ON DELETE SET NULL, and a referential action is
-- an UPDATE — the same fact `loan_transitions.actor_principal_id` is on
-- RESTRICT for, carried to the second SET NULL edge this migration adds.
-- Erasing the successor therefore rewrites the predecessor's pointer, a CHECK
-- on the row refuses that write from inside somebody else's DELETE, and the
-- person on both loans of a refinance chain could never delete their account:
-- users_delete_takes_loans aborts, the predecessor is terminal so it cannot be
-- moved off REFINANCED_INTERNALLY, and the pointer cannot be cleared either.
-- Scoped to the status change, the unfalsifiable claim is still refused at the
-- moment it is made, and a predecessor whose successor has been erased says so
-- with a NULL instead of holding an account hostage.
CREATE OR REPLACE FUNCTION loans_refinanced_names_its_successor() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'REFINANCED_INTERNALLY'
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.refinanced_by_loan_id IS NULL THEN
    RAISE EXCEPTION 'loan % cannot become refinanced_internally without naming the loan that did it', NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loans_refinanced_names_its_successor_update
  BEFORE UPDATE ON "loans"
  FOR EACH ROW EXECUTE FUNCTION loans_refinanced_names_its_successor();

-- ─── 7. A loan's ledger never names a principal that dies with a person ────
--
-- Not part of the template, and it must not be: it states a difference between
-- the aggregates, not a shared rule.
--
-- Loans outlive people on purpose. A two-party mortgage survives one borrower
-- closing their account, so the ledger row explaining how it got where it is is
-- still standing when that person's party — and, through the CASCADE from
-- parties to their BORROWER principal — is deleted. With actor_principal_id on
-- RESTRICT and SET NULL impossible, a BORROWER actor on a surviving loan is an
-- account that cannot be deleted at all, and no ordering of BEFORE triggers
-- rescues it: the row is meant to survive.
--
-- The one loan move a person makes — borrower_claimed — therefore runs under
-- the `claim_flow` SERVICE principal, and the person is recorded where the
-- schema already records them: loan_parties.
CREATE OR REPLACE FUNCTION loan_transitions_actor_outlives_people() RETURNS trigger AS $$
DECLARE actor_party UUID;
BEGIN
  SELECT party_id INTO actor_party FROM "principals" WHERE id = NEW.actor_principal_id;
  IF actor_party IS NOT NULL THEN
    RAISE EXCEPTION 'loan_transitions may not name principal %: it belongs to party % and dies with them, and a loan outlives its parties; write this move under a SERVICE, STAFF or PARTNER principal', NEW.actor_principal_id, actor_party;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loan_transitions_actor_outlives_people_insert
  BEFORE INSERT ON "loan_transitions"
  FOR EACH ROW EXECUTE FUNCTION loan_transitions_actor_outlives_people();

-- ─── The two service principals this slice acts as ─────────────────────────
-- `claim_flow` will write borrower_claimed; `retention` is the actor the reaper
-- runs under. Fixed rows for a fresh database only: servicePrincipal() finds or
-- creates at runtime, because the test harness truncates principals and a
-- migration's row is a convenience, never a promise.
INSERT INTO "principals" ("id", "kind", "subject")
VALUES (gen_random_uuid(), 'SERVICE', 'claim_flow'),
       (gen_random_uuid(), 'SERVICE', 'retention')
ON CONFLICT ("kind", "subject") DO NOTHING;

-- ─── Account deletion: a third BEFORE step, in the order that works ────────
--
-- Ordering this from the AFTER-DELETE users_delete_takes_party() does not
-- work: a nested cascade queues its own AFTER events BEHIND the party trigger,
-- so a row that has to be gone before the party is deleted is still standing
-- when it is. Anything that must happen in a stated order at account deletion
-- is therefore a BEFORE DELETE trigger on `users`, and Postgres fires those in
-- NAME order:
--
--   users_delete_takes_files  (shipped)  the ledger before the principal
--   users_delete_takes_loans  (here)     the orphan sweep
--
-- BEFORE DELETE on users is the only place an ordered step at account deletion
-- can live: a nested cascade queues its own AFTER events behind the party
-- trigger, so by the time an AFTER step ran the ledger would be gone. Postgres
-- fires BEFORE DELETE triggers in name order. These two do not yet depend on
-- each other -- renaming either so it fires second leaves the deletion tests
-- green -- and the moment one does, that dependence goes in its own comment
-- rather than being inferred from the names.
--
-- ORPHAN-ONLY, and that is the whole resolution of "we remove your data for
-- good" against "deleting a stale application cannot erase the record of a
-- mortgage somebody is paying". The loan survives a deleted APPLICATION. It
-- does not survive the last PERSON on it. A two-party mortgage survives one
-- borrower closing their account; a sole borrower's does not. What makes that
-- defensible rather than reckless is that the creditor keeps its own record:
-- deleting this row erases OUR COPY of a mortgage, not the mortgage.
CREATE OR REPLACE FUNCTION users_delete_takes_loans() RETURNS trigger AS $$
DECLARE touched UUID[];
BEGIN
  IF OLD.party_id IS NULL THEN RETURN OLD; END IF;

  -- The party's own links, and the links of every party folded into theirs by
  -- a claim. Without the merged-from half, a partner's facts about a claimed
  -- person survive a deletion that promised there is no archive.
  WITH gone AS (
    DELETE FROM "loan_parties"
     WHERE party_id = OLD.party_id
        OR party_id IN (SELECT id FROM "parties" WHERE merged_into_party_id = OLD.party_id)
    RETURNING loan_id
  )
  SELECT array_agg(DISTINCT loan_id) INTO touched FROM gone;

  -- A mortgage with nobody left on it is not a record about anybody. Scoped to
  -- the loans this deletion just touched, deliberately: an unscoped anti-join
  -- would delete ANY parentless loan in the database — a half-finished import
  -- retry, a boarding script that commits its loan before its parties — on an
  -- unrelated person's deletion path, and take the ledger explaining it along.
  IF touched IS NOT NULL THEN
    DELETE FROM "loans" l
     WHERE l.id = ANY(touched)
       AND NOT EXISTS (SELECT 1 FROM "loan_parties" lp WHERE lp.loan_id = l.id);
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_delete_takes_loans_before
  BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_delete_takes_loans();

-- ─── And the merged-from party itself goes with its survivor ───────────────
--
-- Until now users_delete_takes_party deleted only OLD.party_id, so a party
-- merged into a signed-in person's own party was unreachable by every deletion
-- path in the product: the row stayed, and the facts asserted against it with
-- it.
--
-- Two shipped functions are edited in this slice, and this is the second of
-- them. The first is applications_status_has_a_ledger_row, re-created far
-- above so the early return for a row that is already gone at COMMIT reads
-- the same in both families; the argument for writing it there rather than
-- patching one family is beside that block. This one widens what an account
-- deletion can reach.
--
-- BOTH HALVES OF THE FACT SWEEP NAME THE MERGED-FROM PARTIES, and they have to
-- say the same thing. A fact ABOUT a party goes with the party through
-- facts.party_id's CASCADE. A fact about a property or a loan carries no
-- party_id at all, and the only edge holding it is asserted_by_principal_id,
-- which is RESTRICT. Principals cascade from their party, so with the
-- asserted-by clause scoped to the survivor's own principals, the very next
-- statement here — deleting the merged-from parties — walks into that
-- restrict, and the account can then be deleted by no path at all.
CREATE OR REPLACE FUNCTION users_delete_takes_party() RETURNS trigger AS $$
BEGIN
  IF OLD.party_id IS NOT NULL THEN
    DELETE FROM "facts"
     WHERE party_id = OLD.party_id
        OR party_id IN (SELECT id FROM "parties" WHERE merged_into_party_id = OLD.party_id)
        OR asserted_by_principal_id IN
           (SELECT id FROM "principals"
             WHERE party_id = OLD.party_id
                OR party_id IN
                   (SELECT id FROM "parties" WHERE merged_into_party_id = OLD.party_id));
    DELETE FROM "parties" WHERE merged_into_party_id = OLD.party_id;
    DELETE FROM "parties" WHERE id = OLD.party_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
