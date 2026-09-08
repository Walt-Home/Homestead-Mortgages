-- Scenarios, pins, and regulatory clocks — and the TRID receipt as a trigger.
--
-- Additive. Nothing here is wired to a route yet. See docs/states.md.

-- CreateEnum
CREATE TYPE "ScenarioObjective" AS ENUM ('PURCHASE', 'RATE_TERM_REFINANCE', 'CASH_OUT_REFINANCE', 'HELOC_DRAW', 'CLOSED_END_SECOND');

-- CreateEnum
CREATE TYPE "LienPosition" AS ENUM ('FIRST', 'SECOND', 'SUBORDINATE_HELOC');

-- CreateEnum
CREATE TYPE "Occupancy" AS ENUM ('PRIMARY_RESIDENCE', 'SECOND_HOME', 'INVESTMENT');

-- CreateEnum
CREATE TYPE "ScenarioOrigin" AS ENUM ('BORROWER', 'COUNTEROFFER', 'REPRICING', 'STAFF', 'AI_SUGGESTED');

-- CreateEnum
CREATE TYPE "ClockKind" AS ENUM ('TRID_LE_DELIVERY', 'CD_BEFORE_CONSUMMATION', 'RIGHT_OF_RESCISSION_3DAY', 'ECOA_ADVERSE_ACTION_30D', 'REG_B_INCOMPLETE_RESPONSE', 'COUNTEROFFER_RESPONSE');

-- CreateTable
CREATE TABLE "loan_scenarios" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "objective" "ScenarioObjective" NOT NULL,
    "lien_position" "LienPosition" NOT NULL DEFAULT 'FIRST',
    "occupancy" "Occupancy" NOT NULL,
    "loan_amount_cents" BIGINT NOT NULL,
    "down_payment_cents" BIGINT NOT NULL DEFAULT 0,
    "term_months" INTEGER NOT NULL,
    "note_rate_bps" INTEGER,
    "property_address" TEXT,
    "value_estimate_cents" BIGINT,
    "origin" "ScenarioOrigin" NOT NULL DEFAULT 'BORROWER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "superseded_by_seq" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loan_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_evidence_links" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "fact_id" UUID NOT NULL,
    "authorization_id" UUID NOT NULL,
    "predicate" TEXT NOT NULL,
    "borrowed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "as_of" TIMESTAMP(3) NOT NULL,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "application_evidence_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regulatory_clocks" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "kind" "ClockKind" NOT NULL,
    "statute_citation" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "tolled_from" TIMESTAMP(3),
    "tolling_reason" TEXT,
    "satisfied_at" TIMESTAMP(3),
    "breached_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "regulatory_clocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loan_scenarios_application_id_is_active_idx" ON "loan_scenarios"("application_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "loan_scenarios_application_id_seq_key" ON "loan_scenarios"("application_id", "seq");

-- CreateIndex
CREATE INDEX "application_evidence_links_application_id_predicate_idx" ON "application_evidence_links"("application_id", "predicate");

-- CreateIndex
CREATE INDEX "application_evidence_links_fact_id_idx" ON "application_evidence_links"("fact_id");

-- CreateIndex
CREATE INDEX "application_evidence_links_authorization_id_idx" ON "application_evidence_links"("authorization_id");

-- CreateIndex
CREATE INDEX "regulatory_clocks_application_id_kind_idx" ON "regulatory_clocks"("application_id", "kind");

-- CreateIndex
CREATE INDEX "regulatory_clocks_due_at_idx" ON "regulatory_clocks"("due_at");

-- AddForeignKey
ALTER TABLE "loan_scenarios" ADD CONSTRAINT "loan_scenarios_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_evidence_links" ADD CONSTRAINT "application_evidence_links_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_evidence_links" ADD CONSTRAINT "application_evidence_links_fact_id_fkey" FOREIGN KEY ("fact_id") REFERENCES "facts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_evidence_links" ADD CONSTRAINT "application_evidence_links_authorization_id_fkey" FOREIGN KEY ("authorization_id") REFERENCES "authorizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regulatory_clocks" ADD CONSTRAINT "regulatory_clocks_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── The guarantees, in the database ────────────────────────────────────────

-- 0. The actor for a receipt the database stamps by itself.
--
-- A transition must name who caused it, and the receipt is caused by the sixth
-- piece landing, not by a person. A fixed id so every environment — test,
-- staging, production — agrees on which row it is.
INSERT INTO "principals" ("id", "kind", "subject", "created_at")
VALUES ('00000000-0000-4000-8000-000000000001', 'SERVICE', 'trid_receipt', now())
ON CONFLICT ("kind", "subject") DO NOTHING;

-- 1. Business days, weekends only, in the creditor's calendar zone.
--
-- Optimistic in a holiday week, which on a regulatory clock is the wrong
-- direction — so clocks open tolled until the calendar table exists. The zone
-- is a configuration in a later slice; one value for now. Nothing here reads a
-- session setting, so IMMUTABLE is true — the first version advanced a
-- timestamptz by '1 day' in the SESSION zone and tested the weekday in UTC,
-- which drifted an hour across a DST change and judged a Friday-evening
-- Pacific receipt as Saturday. A test holds this in step with
-- addBusinessDays() in @hm/shared.
CREATE OR REPLACE FUNCTION add_business_days(from_ts timestamptz, days int, tz text DEFAULT 'America/New_York')
RETURNS timestamptz AS $$
DECLARE
  d date := (from_ts AT TIME ZONE tz)::date;
  left_ int := days;
BEGIN
  WHILE left_ > 0 LOOP
    d := d + 1;
    IF EXTRACT(ISODOW FROM d) < 6 THEN
      left_ := left_ - 1;
    END IF;
  END LOOP;
  -- "Not later than the third business day" is the END of that day: the
  -- instant before the next local midnight.
  RETURN ((d + 1)::timestamp AT TIME ZONE tz) - interval '1 millisecond';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 2. Exactly one active scenario per application.
CREATE UNIQUE INDEX "loan_scenarios_one_active"
  ON "loan_scenarios" ("application_id")
  WHERE "is_active";

-- 3. A scenario is immutable. A change of terms is a NEW scenario.
--
-- The two supersession columns are the only ones that may move, and only in
-- the retiring direction: a scenario can be made inactive and told what
-- replaced it, and it cannot come back.
CREATE OR REPLACE FUNCTION loan_scenarios_immutable() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.id, NEW.application_id, NEW.seq, NEW.objective, NEW.lien_position, NEW.occupancy,
         NEW.loan_amount_cents, NEW.down_payment_cents, NEW.term_months, NEW.note_rate_bps,
         NEW.property_address, NEW.value_estimate_cents, NEW.origin, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.application_id, OLD.seq, OLD.objective, OLD.lien_position, OLD.occupancy,
         OLD.loan_amount_cents, OLD.down_payment_cents, OLD.term_months, OLD.note_rate_bps,
         OLD.property_address, OLD.value_estimate_cents, OLD.origin, OLD.created_at)
  THEN
    RAISE EXCEPTION 'loan_scenarios are immutable: a change of terms is a new scenario (scenario % seq %)', OLD.id, OLD.seq;
  END IF;
  IF OLD.is_active = false AND NEW.is_active = true THEN
    RAISE EXCEPTION 'scenario % seq % was superseded and cannot be reactivated', OLD.id, OLD.seq;
  END IF;
  IF OLD.superseded_by_seq IS NOT NULL AND NEW.superseded_by_seq IS DISTINCT FROM OLD.superseded_by_seq THEN
    RAISE EXCEPTION 'scenario % seq % already names its successor', OLD.id, OLD.seq;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loan_scenarios_immutable_update
  BEFORE UPDATE ON "loan_scenarios"
  FOR EACH ROW EXECUTE FUNCTION loan_scenarios_immutable();

ALTER TABLE "loan_scenarios" ADD CONSTRAINT "loan_scenarios_amounts_sane"
  CHECK ("loan_amount_cents" > 0 AND "down_payment_cents" >= 0 AND "term_months" > 0
         AND ("value_estimate_cents" IS NULL OR "value_estimate_cents" > 0)
         AND ("note_rate_bps" IS NULL OR "note_rate_bps" >= 0));

-- '' is not an address. An HTML form posts '' for an unfilled field, and the
-- receipt must never be stamped on a request that names no property.
ALTER TABLE "loan_scenarios" ADD CONSTRAINT "loan_scenarios_address_not_blank"
  CHECK ("property_address" IS NULL OR btrim("property_address") <> '');

ALTER TABLE "loan_scenarios" ADD CONSTRAINT "loan_scenarios_seq_positive" CHECK ("seq" >= 1);
-- Only a retired scenario names a successor, and the successor is later.
ALTER TABLE "loan_scenarios" ADD CONSTRAINT "loan_scenarios_supersession_sane"
  CHECK ("superseded_by_seq" IS NULL OR ("is_active" = false AND "superseded_by_seq" > "seq"));

-- 4. A pin may only borrow what it is allowed to.
--
-- Three checks nothing in the old model could make, because the old model had
-- no subject: the fact's party must be on the application; the authorization
-- must belong to that same party and be live right now; and the predicate and
-- as-of are copied from the fact by the trigger rather than trusted from the
-- caller, so a pin cannot claim to be something it is not.
CREATE OR REPLACE FUNCTION application_evidence_links_guard() RETURNS trigger AS $$
DECLARE
  f record;
  a record;
BEGIN
  SELECT subject_type, party_id, predicate, observed_at, retracted_at, expires_at, superseded_by_id, value
    INTO f FROM "facts" WHERE id = NEW.fact_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pin names a fact that does not exist: %', NEW.fact_id;
  END IF;
  IF f.subject_type <> 'PARTY' THEN
    RAISE EXCEPTION 'only party facts may be pinned in this slice (fact % is %)', NEW.fact_id, f.subject_type;
  END IF;
  IF f.retracted_at IS NOT NULL THEN
    RAISE EXCEPTION 'fact % was retracted and may not be pinned', NEW.fact_id;
  END IF;
  IF f.expires_at IS NOT NULL AND f.expires_at <= now() THEN
    RAISE EXCEPTION 'fact % expired at % and may not be pinned; assert a fresh one', NEW.fact_id, f.expires_at;
  END IF;
  IF f.superseded_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'fact % was superseded by % and may not be pinned; pin the successor', NEW.fact_id, f.superseded_by_id;
  END IF;
  -- A predicate with nothing in it is not one of the six.
  IF jsonb_typeof(f.value) = 'null'
     OR (jsonb_typeof(f.value) = 'string' AND btrim(f.value #>> '{}') = '') THEN
    RAISE EXCEPTION 'fact % carries no value and may not be pinned', NEW.fact_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "application_parties"
    WHERE application_id = NEW.application_id AND party_id = f.party_id
  ) THEN
    RAISE EXCEPTION 'fact % belongs to a party who is not on application %', NEW.fact_id, NEW.application_id;
  END IF;

  SELECT party_id, revoked_at, expires_at, purpose INTO a
    FROM "authorizations" WHERE id = NEW.authorization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pin names an authorization that does not exist: %', NEW.authorization_id;
  END IF;
  IF a.party_id <> f.party_id THEN
    RAISE EXCEPTION 'authorization % was granted by a different party than fact % is about', NEW.authorization_id, NEW.fact_id;
  END IF;
  IF a.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'authorization % is revoked; the fact may be retained but not borrowed', NEW.authorization_id;
  END IF;
  IF a.expires_at <= now() THEN
    RAISE EXCEPTION 'authorization % has expired; the fact may be retained but not borrowed', NEW.authorization_id;
  END IF;
  -- "Covering that request": an account-review, prescreen or marketing grant
  -- is a permission for something other than a credit request, and the
  -- FCRA_ACCOUNT_REVIEW enum comment says so outright. A deny-list until the
  -- origination purposes settle into an allow-list.
  IF a.purpose IN ('FCRA_ACCOUNT_REVIEW', 'FCRA_PRESCREEN', 'MARKETING_CONTACT') THEN
    RAISE EXCEPTION 'authorization % is a % grant and does not cover a credit request', NEW.authorization_id, a.purpose;
  END IF;

  -- Copied, not trusted.
  NEW.predicate := f.predicate;
  NEW.as_of := f.observed_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_evidence_links_guard_insert
  BEFORE INSERT ON "application_evidence_links"
  FOR EACH ROW EXECUTE FUNCTION application_evidence_links_guard();

-- A pin is released, never edited or deleted.
CREATE OR REPLACE FUNCTION application_evidence_links_release_only() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.application_id, NEW.fact_id, NEW.authorization_id, NEW.predicate,
         NEW.borrowed_at, NEW.as_of)
     IS DISTINCT FROM
     ROW(OLD.application_id, OLD.fact_id, OLD.authorization_id, OLD.predicate,
         OLD.borrowed_at, OLD.as_of)
  THEN
    RAISE EXCEPTION 'a pin is released, never edited (pin %)', OLD.id;
  END IF;
  IF OLD.released_at IS NOT NULL AND NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'pin % was already released', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_evidence_links_release_only_update
  BEFORE UPDATE ON "application_evidence_links"
  FOR EACH ROW EXECUTE FUNCTION application_evidence_links_release_only();

-- One live pin per (application, fact).
CREATE UNIQUE INDEX "application_evidence_links_one_live_per_fact"
  ON "application_evidence_links" ("application_id", "fact_id")
  WHERE "released_at" IS NULL;

ALTER TABLE "application_evidence_links" ADD CONSTRAINT "application_evidence_links_release_after_borrow"
  CHECK ("released_at" IS NULL OR "released_at" >= "borrowed_at");

-- 5. One Loan Estimate clock per application, ever.
CREATE UNIQUE INDEX "regulatory_clocks_one_le_clock"
  ON "regulatory_clocks" ("application_id")
  WHERE "kind" = 'TRID_LE_DELIVERY';

ALTER TABLE "regulatory_clocks" ADD COLUMN "tolled_until" TIMESTAMP(3);

ALTER TABLE "regulatory_clocks" ADD CONSTRAINT "regulatory_clocks_due_after_start"
  CHECK ("due_at" > "started_at");

-- A clock ends one way, and neither ending precedes its start.
ALTER TABLE "regulatory_clocks" ADD CONSTRAINT "regulatory_clocks_one_ending"
  CHECK ("satisfied_at" IS NULL OR "breached_at" IS NULL);
ALTER TABLE "regulatory_clocks" ADD CONSTRAINT "regulatory_clocks_endings_after_start"
  CHECK (("satisfied_at" IS NULL OR "satisfied_at" >= "started_at")
     AND ("breached_at" IS NULL OR "breached_at" >= "started_at"));

-- A tolled clock says why, '' is not a why, and a toll ends by recording when
-- — tolled_from and the reason are never cleared.
ALTER TABLE "regulatory_clocks" ADD CONSTRAINT "regulatory_clocks_tolling_has_reason"
  CHECK (("tolled_from" IS NULL AND "tolling_reason" IS NULL AND "tolled_until" IS NULL)
      OR ("tolled_from" IS NOT NULL AND NULLIF(btrim("tolling_reason"), '') IS NOT NULL
          AND ("tolled_until" IS NULL OR "tolled_until" >= "tolled_from")));

-- What a clock is, the statute sets when it opens. Tolling suspends the
-- breach-writer, not the deadline: TRID has no tolling, so due_at never moves.
-- Each ending is written once and never cleared — the schema comment says "a
-- breach is never tidied away", and the first version held nothing of it.
CREATE OR REPLACE FUNCTION regulatory_clocks_set_once() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.id, NEW.application_id, NEW.kind, NEW.statute_citation, NEW.started_at, NEW.due_at,
         NEW.tolled_from, NEW.tolling_reason, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.application_id, OLD.kind, OLD.statute_citation, OLD.started_at, OLD.due_at,
         OLD.tolled_from, OLD.tolling_reason, OLD.created_at)
  THEN
    RAISE EXCEPTION 'a regulatory clock is set once: what it is, when it opened and when it is due do not move (clock %)', OLD.id;
  END IF;
  IF OLD.satisfied_at IS NOT NULL AND NEW.satisfied_at IS DISTINCT FROM OLD.satisfied_at THEN
    RAISE EXCEPTION 'clock % was already satisfied', OLD.id;
  END IF;
  IF OLD.breached_at IS NOT NULL AND NEW.breached_at IS DISTINCT FROM OLD.breached_at THEN
    RAISE EXCEPTION 'clock % was breached and a breach is never tidied away', OLD.id;
  END IF;
  IF OLD.tolled_until IS NOT NULL AND NEW.tolled_until IS DISTINCT FROM OLD.tolled_until THEN
    RAISE EXCEPTION 'the toll on clock % already ended', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER regulatory_clocks_set_once_update
  BEFORE UPDATE ON "regulatory_clocks"
  FOR EACH ROW EXECUTE FUNCTION regulatory_clocks_set_once();

-- 6. THE RECEIPT.
--
-- The moment all six TRID pieces are present on a DRAFT application, it
-- becomes an application. This is a database trigger rather than a function
-- somebody has to remember to call, because relationship-first RAISES the
-- accidental-receipt risk: a returning or portfolio member already has name,
-- SSN and income on file, and six pieces can complete on one careless insert.
-- The highest-stakes clock in the system should not depend on discipline.
--
-- It performs a real transition — status, sequence, ledger row — so the
-- deferred "every move is explained" constraint is satisfied by the trigger
-- itself. And it opens the Loan Estimate clock TOLLED, because there is no
-- delivery channel yet and a clock that cannot be satisfied must not be
-- allowed to breach on schedule.
CREATE OR REPLACE FUNCTION trid_receipt_if_complete(app_id uuid) RETURNS void AS $$
DECLARE
  app record;
  scenario record;
  pinned int;
  next_seq int;
  actor_id uuid;
  now_ts timestamptz := now();
BEGIN
  -- The lock-then-recount below needs the recount to take a fresh snapshot
  -- after the lock wait. READ COMMITTED does; SERIALIZABLE aborts one side
  -- with 40001 (retryable); REPEATABLE READ does neither, and two concurrent
  -- pins each count the other as absent with no error. Refuse rather than
  -- miss a receipt.
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'trid_receipt_if_complete cannot run under REPEATABLE READ: a concurrent pin would be counted as absent and the receipt silently missed';
  END IF;

  SELECT status, status_seq, status_entered_at INTO app FROM "applications" WHERE id = app_id FOR UPDATE;
  IF NOT FOUND OR app.status <> 'DRAFT' THEN
    RETURN;
  END IF;

  -- The three party-side pieces, as live pins. Vocabulary in @hm/shared/trid.ts.
  SELECT count(DISTINCT predicate) INTO pinned
    FROM "application_evidence_links"
   WHERE application_id = app_id
     AND released_at IS NULL
     AND predicate IN ('legal_name', 'ssn_token', 'monthly_income');
  IF pinned < 3 THEN
    RETURN;
  END IF;

  -- The three request-side pieces, on the active scenario.
  SELECT property_address, value_estimate_cents, loan_amount_cents INTO scenario
    FROM "loan_scenarios" WHERE application_id = app_id AND is_active;
  IF NOT FOUND
     OR NULLIF(btrim(scenario.property_address), '') IS NULL
     OR scenario.value_estimate_cents IS NULL THEN
    RETURN;
  END IF;

  next_seq := app.status_seq + 1;

  -- now() is the transaction start, which is also the DEFAULT the draft row
  -- took when application and sixth piece land in ONE transaction — the
  -- returning-member case this trigger exists for. The status trigger reads an
  -- unchanged stamp as "not stamped" and the whole intake rolls back; via
  -- Prisma the client-side stamp can even be LATER than now(), recording the
  -- receipt before the draft. The receipt is stamped strictly after the state
  -- it leaves, and everything downstream — ledger, clock — uses that instant.
  now_ts := GREATEST(now_ts, (app.status_entered_at AT TIME ZONE 'UTC') + interval '1 millisecond');

  -- The receipt guarantees its own actor. The row is seeded above, but a
  -- test harness truncates tables and an operator may tidy one away; a
  -- transition that cannot name who caused it must never be the reason a
  -- receipt fails to stamp. Idempotent on (kind, subject).
  INSERT INTO "principals" ("id", "kind", "subject", "created_at")
  VALUES ('00000000-0000-4000-8000-000000000001', 'SERVICE', 'trid_receipt', now_ts)
  ON CONFLICT ("kind", "subject") DO NOTHING;
  -- Looked up, not assumed: if the row already existed under another id the
  -- insert above was a no-op, and the ledger row must name the id that is
  -- actually there.
  SELECT id INTO actor_id FROM "principals" WHERE kind = 'SERVICE' AND subject = 'trid_receipt';

  UPDATE "applications"
     SET status = 'INTAKE_RECEIVED', status_seq = next_seq,
         status_entered_at = now_ts, updated_at = now_ts
   WHERE id = app_id;

  INSERT INTO "application_transitions"
    (id, application_id, seq, from_state, to_state, event, actor_principal_id, reason_code, occurred_at, recorded_at)
  VALUES
    (gen_random_uuid(), app_id, next_seq, 'DRAFT', 'INTAKE_RECEIVED', 'intake_completed',
     actor_id, 'six_pieces_received', now_ts, now_ts);

  INSERT INTO "regulatory_clocks"
    (id, application_id, kind, statute_citation, started_at, due_at, tolled_from, tolling_reason, created_at)
  VALUES
    (gen_random_uuid(), app_id, 'TRID_LE_DELIVERY', '12 CFR 1026.19(e)(1)(iii)',
     now_ts, add_business_days(now_ts, 3), now_ts, 'no_delivery_channel_configured', now_ts);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION application_evidence_links_receipt() RETURNS trigger AS $$
BEGIN
  PERFORM trid_receipt_if_complete(NEW.application_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_evidence_links_receipt_insert
  AFTER INSERT ON "application_evidence_links"
  FOR EACH ROW EXECUTE FUNCTION application_evidence_links_receipt();

-- The sixth piece can just as easily be the scenario.
CREATE OR REPLACE FUNCTION loan_scenarios_receipt() RETURNS trigger AS $$
BEGIN
  IF NEW.is_active THEN
    PERFORM trid_receipt_if_complete(NEW.application_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loan_scenarios_receipt_insert
  AFTER INSERT ON "loan_scenarios"
  FOR EACH ROW EXECUTE FUNCTION loan_scenarios_receipt();
