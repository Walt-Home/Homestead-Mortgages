-- ─── 1. An application is born from exactly one file, and dies with it ──────
--
-- NOT NULL: an application without a file is unrepresentable in this slice,
-- so account deletion (users -> loan_files -> applications -> ledger, scenarios,
-- pins, clocks) is declarative. UNIQUE: "which application is this file's" is a
-- lookup, not a person-path join that is ambiguous when one party holds several
-- files. The FK points FROM the new layer AT the old row so the column leaves
-- with loan_files when the strangler finishes. There are no production
-- applications rows (no production writer has ever existed), so NOT NULL with
-- no DEFAULT is safe; if a row exists the ALTER fails loudly, which is correct.
ALTER TABLE "applications" ADD COLUMN "loan_file_id" UUID NOT NULL;
CREATE UNIQUE INDEX "applications_loan_file_id_key" ON "applications"("loan_file_id");
ALTER TABLE "applications" ADD CONSTRAINT "applications_loan_file_id_fkey"
  FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 2. Two guards the docs promised and the code lacked ─────────────────────
--
-- 2a. An application cannot be received with no primary borrower on it.
-- 20260904180000 said this guard lives in the transition service; it never
-- did. It lives here so the invariant does not depend on which writer moved the
-- row. The receipt path already satisfies it (a pin needs a party on the
-- application), so in practice only a hand-driven transition can trip it.
--
-- INSERT as well as UPDATE, or the guard is only as good as the writers that
-- happen to move a row through DRAFT: every other trigger on this table is
-- UPDATE-only, so a single INSERT that names INTAKE_RECEIVED outright — with a
-- matching ledger row, which the COMMIT check is happy with — would be born
-- received with nobody on it. TG_OP is read first because OLD does not exist
-- on an INSERT.
--
-- And the state a row is born in is the one state no ledger row explains:
-- application_transitions_actor_kind only reads rows somebody INSERTs into the
-- ledger, and applications_status_has_a_ledger_row returns early at status_seq
-- 0, so an application inserted straight into WITHDRAWN — or APPROVED, or
-- DENIED — is a state nothing caused and nothing checked. Every guard on this
-- table watches a move; the insert has to be guarded too, or a writer can skip
-- the whole machine by starting where it wanted to end up.
CREATE OR REPLACE FUNCTION applications_intake_needs_a_borrower() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'INTAKE_RECEIVED'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'INTAKE_RECEIVED')
     AND NOT EXISTS (
       SELECT 1 FROM "application_parties"
        WHERE application_id = NEW.id AND role = 'PRIMARY_BORROWER'
     ) THEN
    RAISE EXCEPTION 'application % cannot be received with no primary borrower on it', NEW.id;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'application % cannot be born %; an application starts as a draft and every state after it is a move somebody caused', NEW.id, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER applications_intake_needs_a_borrower_write
  BEFORE INSERT OR UPDATE OF status ON "applications"
  FOR EACH ROW EXECUTE FUNCTION applications_intake_needs_a_borrower();

-- 2b. withdrawn is the borrower's act, and only a borrower on the application
-- can write it. docs/states.md and states.ts said "guarded on actor kind";
-- now it is. A trigger, not a CHECK, for the same reason facts_ai_may_not_verify
-- is one: the kind lives in another table.
--
-- The guard keys on the STATE, not only on the event name. Keying on the event
-- alone left the hole it was written to close: a member of staff moving a file
-- to WITHDRAWN under 'ops_canceled' wrote the borrower's own ending with no
-- borrower anywhere near it, and nothing else checks that a ledger row's event
-- implies the state it wrote. Borrower roles only — a non-borrowing spouse or
-- a guarantor is on the application but is not the person whose credit request
-- this is, and withdrawing it is not theirs to do.
CREATE OR REPLACE FUNCTION application_transitions_actor_kind() RETURNS trigger AS $$
DECLARE actor record;
BEGIN
  IF NEW.to_state = 'WITHDRAWN' OR NEW.event = 'borrower_withdrew' THEN
    IF NEW.event IS DISTINCT FROM 'borrower_withdrew' THEN
      RAISE EXCEPTION 'application % cannot be withdrawn under event %: withdrawal is recorded as borrower_withdrew or not at all',
        NEW.application_id, NEW.event;
    END IF;
    SELECT kind, party_id INTO actor FROM "principals" WHERE id = NEW.actor_principal_id;
    IF actor.kind IS DISTINCT FROM 'BORROWER'
       OR NOT EXISTS (
         SELECT 1 FROM "application_parties"
          WHERE application_id = NEW.application_id
            AND party_id = actor.party_id
            AND role IN ('PRIMARY_BORROWER', 'CO_BORROWER', 'NON_OCCUPANT_CO_BORROWER')
       ) THEN
      RAISE EXCEPTION 'borrower_withdrew on application % must be caused by a borrower on it, not principal %',
        NEW.application_id, NEW.actor_principal_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_transitions_actor_kind_insert
  BEFORE INSERT ON "application_transitions"
  FOR EACH ROW EXECUTE FUNCTION application_transitions_actor_kind();

-- ─── 3. The receipt counts one PRIMARY_BORROWER's three pieces ──────────────
--
-- CREATE OR REPLACE of trid_receipt_if_complete (20260908120000). The ONLY
-- change is the `pinned` query: it was count(DISTINCT predicate) across every
-- party on the application, so with two parties a co-borrower's SSN plus the
-- primary's name and income counted as one person's six pieces. TRID's pieces
-- are about the consumer applying. Everything else — the isolation refusal,
-- FOR UPDATE, the status <> DRAFT return, the scenario test, the GREATEST
-- stamp, the self-healing principal, the ledger row, the tolled LE clock,
-- reason_code 'six_pieces_received' — is kept verbatim.
CREATE OR REPLACE FUNCTION trid_receipt_if_complete(app_id uuid) RETURNS void AS $$
DECLARE
  app record;
  scenario record;
  pinned int;
  next_seq int;
  actor_id uuid;
  now_ts timestamptz := now();
BEGIN
  IF current_setting('transaction_isolation') = 'repeatable read' THEN
    RAISE EXCEPTION 'trid_receipt_if_complete cannot run under REPEATABLE READ: a concurrent pin would be counted as absent and the receipt silently missed';
  END IF;

  SELECT status, status_seq, status_entered_at INTO app FROM "applications" WHERE id = app_id FOR UPDATE;
  IF NOT FOUND OR app.status <> 'DRAFT' THEN
    RETURN;
  END IF;

  -- The three party-side pieces, as live pins on facts of ONE party who is a
  -- PRIMARY_BORROWER on this application. Vocabulary in @hm/shared/trid.ts.
  SELECT max(c) INTO pinned FROM (
    SELECT count(DISTINCT l.predicate) AS c
      FROM "application_evidence_links" l
      JOIN "facts" f ON f.id = l.fact_id
      JOIN "application_parties" ap
        ON ap.application_id = l.application_id
       AND ap.party_id = f.party_id
       AND ap.role = 'PRIMARY_BORROWER'
     WHERE l.application_id = app_id
       AND l.released_at IS NULL
       AND l.predicate IN ('legal_name', 'ssn_token', 'monthly_income')
     GROUP BY f.party_id
  ) per_party;
  IF coalesce(pinned, 0) < 3 THEN
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
  now_ts := GREATEST(now_ts, (app.status_entered_at AT TIME ZONE 'UTC') + interval '1 millisecond');

  INSERT INTO "principals" ("id", "kind", "subject", "created_at")
  VALUES ('00000000-0000-4000-8000-000000000001', 'SERVICE', 'trid_receipt', now_ts)
  ON CONFLICT ("kind", "subject") DO NOTHING;
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

-- Being a PRIMARY_BORROWER on the application is now one of the six
-- conditions, so it is one of the six that can be satisfied last. The pins
-- re-ask and the scenario re-asks; this is the third writer that has to, or a
-- person promoted from co-borrower to the one applying sits at draft with a
-- complete application and no Loan Estimate clock ever opened — which is the
-- shape of missed deadline the receipt exists to make impossible.
CREATE OR REPLACE FUNCTION application_parties_receipt() RETURNS trigger AS $$
BEGIN
  PERFORM trid_receipt_if_complete(NEW.application_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Only a PRIMARY_BORROWER write can be the piece that lands last, so only a
-- PRIMARY_BORROWER write asks. A co-borrower, a non-borrowing spouse or a
-- guarantor arriving cannot complete anybody's three pieces, and asking anyway
-- costs a FOR UPDATE on the application and inherits the function's refusal to
-- run under REPEATABLE READ — on every party write, including the ones that
-- could never have changed the answer.
CREATE TRIGGER application_parties_receipt_write
  AFTER INSERT OR UPDATE OF role ON "application_parties"
  FOR EACH ROW WHEN (NEW.role = 'PRIMARY_BORROWER')
  EXECUTE FUNCTION application_parties_receipt();

-- ─── 4. Entering adverse_action_pending opens its 30-day clock, tolled ──────
--
-- docs/states.md: adverse_action_pending means "a 30-day clock is running".
-- docs/decisions.md: a clock with no delivery channel opens tolled. On the
-- ledger row, the same structural choice the receipt made: the state and its
-- clock cannot be separated. Calendar days (Reg B counts days). It starts from
-- the intake_completed row's occurred_at, not the decision's: Reg B measures
-- from a completed application, which is at or after intake, so this errs
-- EARLY — the only direction a regulatory clock may err. Falls back to the
-- decision row's occurred_at only for an application with no intake row,
-- which the receipt path cannot produce.
CREATE OR REPLACE FUNCTION application_transitions_open_clocks() RETURNS trigger AS $$
DECLARE started timestamptz;
BEGIN
  IF NEW.to_state = 'ADVERSE_ACTION_PENDING' THEN
    SELECT occurred_at INTO started FROM "application_transitions"
     WHERE application_id = NEW.application_id AND event = 'intake_completed'
     ORDER BY seq LIMIT 1;
    started := coalesce(started, NEW.occurred_at);
    INSERT INTO "regulatory_clocks"
      (id, application_id, kind, statute_citation, started_at, due_at, tolled_from, tolling_reason, created_at)
    VALUES
      (gen_random_uuid(), NEW.application_id, 'ECOA_ADVERSE_ACTION_30D', '12 CFR 1002.9(a)(1)(i)',
       started, started + interval '30 days', started, 'no_delivery_channel_configured', NEW.recorded_at)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER application_transitions_open_clocks_insert
  AFTER INSERT ON "application_transitions"
  FOR EACH ROW EXECUTE FUNCTION application_transitions_open_clocks();

-- One ECOA clock per application. adverse_action_pending has exactly one exit
-- (denied, terminal), so one is exact; the ON CONFLICT above makes a re-entry
-- from counteroffer_lapsed/decided_decline on an already-declined file a no-op
-- rather than a failure.
CREATE UNIQUE INDEX "regulatory_clocks_one_aa_clock"
  ON "regulatory_clocks" ("application_id") WHERE "kind" = 'ECOA_ADVERSE_ACTION_30D';

-- ─── 5. Account deletion: the ledger goes before the principal it names ─────
--
-- application_transitions.actor_principal_id STAYS ON DELETE RESTRICT.
-- SET NULL is not merely undesirable, it is impossible: the RI action is an
-- UPDATE of the referencing row, and application_transitions_append_only_update
-- (20260904180000) RAISEs on every UPDATE, so the delete would fail exactly as
-- it does today, only later. Deleting ledger rows to satisfy a foreign key
-- would erase append-only history. Instead the application — and every ledger
-- row naming the party's BORROWER principal — goes with the file, before the
-- party does.
--
-- That order has to be MADE, not assumed. Deleting a user queues the cascade
-- to loan_files and the users_delete_takes_party trigger as two after-events,
-- in that order; the first removes the loan_files rows but appends ITS cascade
-- — applications, and so the ledger — to the tail of the same queue, behind
-- the second. So by the time users_delete_takes_party runs, the files are
-- already gone (nothing left for it to delete) while the applications and
-- their ledger rows are still there, and deleting the party takes the
-- principal a pending ledger row still names: the whole account deletion
-- fails on the foreign key, and the person's sign-in survives with it.
--
-- Removing the files from a BEFORE trigger runs their cascade to completion
-- while the user row is still standing, which is the only point at which the
-- ledger can be gone before the person. It is its own trigger rather than a
-- line inside users_delete_takes_party, because that one deletes the party —
-- and a BEFORE trigger that deletes the party makes parties -> users SET NULL
-- update the very row being deleted, which Postgres refuses outright with
-- "tuple to be deleted was already modified by an operation triggered by the
-- current command".
CREATE OR REPLACE FUNCTION users_delete_takes_files() RETURNS trigger AS $$
BEGIN
  DELETE FROM "loan_files" WHERE user_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_delete_takes_files_delete
  BEFORE DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_delete_takes_files();

-- ─── 6. The two service principals the routes act as ────────────────────────
--
-- application_flow: orchestration edges (borrower_owes, third_party_blocked,
-- underwriting_began). shadow_aus: decided_* edges, so the ledger names which
-- engine decided. Looked up by (kind, subject), never by the fixed id — the
-- test harness truncates principals and the TS service re-inserts them the
-- same way.
INSERT INTO "principals" ("id", "kind", "subject", "model_id", "model_version", "created_at") VALUES
  ('00000000-0000-4000-8000-000000000002', 'SERVICE', 'application_flow', NULL, NULL, now()),
  ('00000000-0000-4000-8000-000000000003', 'SERVICE', 'shadow_aus', 'shadow', NULL, now())
ON CONFLICT ("kind", "subject") DO NOTHING;
