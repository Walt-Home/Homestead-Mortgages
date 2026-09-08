-- A borrower row is a record ABOUT a person, and holds nothing that identifies one.
--
-- The strangler's last move for identity. Every field that identifies somebody
-- — name, date of birth, the SSN vault handle, contact, address, marital
-- status, citizenship, language, military service, first-time-buyer — becomes
-- a fact on the party and ONLY a fact on the party. The columns that held them
-- are dropped, and party_id becomes NOT NULL.
--
-- Nothing is dropped until every existing row has been carried across. The
-- backfill below builds a party, a principal and the facts for each borrower
-- that has none, links the file's user to that party, and mirrors every
-- existing consent to an authorization — the trigger that mirrors new ones
-- only fires on INSERT. There are no users yet; the rows that exist are demo
-- files and developer sign-ins, and they survive this intact.

-- ─── 0. Blank means what JavaScript means ───────────────────────────────────
-- The projection (services/borrower-projection.ts) and zod's .trim() decide
-- whether a value is present with String.prototype.trim, which strips every
-- Unicode WhiteSpace and LineTerminator. btrim() strips ASCII space and nothing
-- else, so a legacy first_name of a single tab or a no-break space was blank
-- to the code and present to the migration: it passed the guard below, its
-- column was dropped, and every load of the file threw. One rule, defined
-- once, used everywhere this file asks "is anything there". The class is
-- spelled out because [[:space:]] is whatever the database's locale says it is
-- and this has to match a language runtime, not a locale. It is a plain
-- function and stays after the migration; nothing depends on it going away.
CREATE OR REPLACE FUNCTION js_trim(s text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT regexp_replace(s,
    '^[\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
    || '|[\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
    '', 'g')
$$;

-- ─── 1. Every borrower gets a party, a principal, and its facts ─────────────
DO $$
DECLARE
  b record;
  pid uuid;
  prin uuid;
  addr jsonb;
BEGIN
  -- Most recently edited row first, so when one user has several files the
  -- values they most recently confirmed become the live facts.
  FOR b IN
    SELECT bo.*, lf.user_id
      FROM "borrowers" bo
      JOIN "loan_files" lf ON lf.id = bo.loan_file_id
     WHERE bo.party_id IS NULL
     ORDER BY bo.updated_at DESC
  LOOP
    pid := NULL;
    IF b.user_id IS NOT NULL THEN
      SELECT party_id INTO pid FROM "users" WHERE id = b.user_id;
    END IF;
    IF pid IS NULL THEN
      INSERT INTO "parties" (id, kind, claim_status, source_first_seen, created_at, updated_at)
      VALUES (gen_random_uuid(), 'PERSON', 'CLAIMED',
              CASE WHEN b.user_id IS NULL THEN 'demo_seed' ELSE 'backfill' END, now(), now())
      RETURNING id INTO pid;
      IF b.user_id IS NOT NULL THEN
        UPDATE "users" SET party_id = pid WHERE id = b.user_id;
      END IF;
    END IF;

    SELECT id INTO prin FROM "principals" WHERE kind = 'BORROWER' AND party_id = pid;
    IF prin IS NULL THEN
      INSERT INTO "principals" (id, kind, subject, party_id, created_at)
      VALUES (gen_random_uuid(), 'BORROWER', 'party:' || pid::text, pid, now())
      RETURNING id INTO prin;
    END IF;

    -- What screen 2 would have stored: zod trims every text field before it
    -- is written, and a value that is blank after trimming is not a value.
    -- Writing the untrimmed column verbatim would carry a difference between
    -- the two eras into the facts table; writing a blank one would carry a
    -- row the projection refuses. The guard in 2b names anything absent.
    addr := NULLIF(jsonb_strip_nulls(jsonb_build_object(
      'line1', NULLIF(js_trim(b.address_line1), ''),
      'line2', NULLIF(js_trim(b.address_line2), ''),
      'city', NULLIF(js_trim(b.address_city), ''),
      'state', NULLIF(js_trim(b.address_state), ''),
      'postalCode', NULLIF(js_trim(b.address_postal_code), ''))), '{}'::jsonb);

    -- One fact per predicate, only where the party does not already hold a
    -- live one — a second file for the same person does not overwrite the
    -- first loop iteration's (more recent) values.
    INSERT INTO "facts" (id, subject_type, subject_id, party_id, predicate, subject_key, value,
                         source_kind, confidence, asserted_by_principal_id, observed_at, recorded_at)
    SELECT gen_random_uuid(), 'PARTY', pid, pid, v.predicate, '', v.value,
           'SELF_ATTESTED', 'ATTESTED', prin, b.updated_at, now()
      FROM (VALUES
        ('legal_name',           NULLIF(jsonb_strip_nulls(jsonb_build_object(
                                   'first', NULLIF(js_trim(b.first_name), ''),
                                   'last', NULLIF(js_trim(b.last_name), ''))), '{}'::jsonb)),
        ('date_of_birth',        to_jsonb(to_char(b.date_of_birth, 'YYYY-MM-DD'))),
        -- The vault handle is opaque and zod does not trim it; blank is still
        -- absent, but a handle with something in it is written as it is.
        ('ssn_token',            to_jsonb(CASE WHEN js_trim(b.ssn_vault_handle) = '' THEN NULL
                                              ELSE b.ssn_vault_handle END)),
        ('email',                to_jsonb(NULLIF(js_trim(b.email), ''))),
        ('phone',                to_jsonb(NULLIF(js_trim(b.phone), ''))),
        ('current_address',      addr),
        ('marital_status',       to_jsonb(b.marital_status)),
        ('citizenship',          to_jsonb(b.citizenship)),
        ('preferred_language',   to_jsonb(b.preferred_language)),
        ('is_military',          to_jsonb(b.is_military)),
        ('first_time_homebuyer', to_jsonb(b.first_time_homebuyer))
      ) AS v(predicate, value)
     WHERE v.value IS NOT NULL
       AND jsonb_typeof(v.value) <> 'null'
       AND NOT EXISTS (
         SELECT 1 FROM "facts" f
          WHERE f.party_id = pid AND f.predicate = v.predicate AND f.subject_key = ''
            AND f.superseded_by_id IS NULL AND f.retracted_at IS NULL);

    UPDATE "borrowers" SET party_id = pid WHERE id = b.id;
  END LOOP;
END $$;

-- ─── 2a. A new signature retires a lapsed grant ─────────────────────────────
-- The unique index keeps one UNREVOKED grant per (party, purpose) and
-- deliberately ignores expiry; renewal is revoke-then-grant. Nothing revoked,
-- so a lapsed grant held the slot forever and every later signature was a
-- DO NOTHING — and with the consents fallback gone from tokenFor, that was a
-- party no route could get out. A still-live grant is left standing and the
-- new consent is a no-op, as before. Redefined here (same trigger binding
-- from 20260908150000) so the rule is in force before the backfill replays it.
--
-- A consent that arrives already revoked mirrors as already revoked. The
-- earlier definition never copied revoked_at on INSERT, so such a row became
-- a LIVE grant for a permission the person had withdrawn before it was
-- recorded — and the revocation trigger only fires on UPDATE, so nothing
-- would ever have caught up with it. Same three columns the backfill writes;
-- the CHECK that a revocation is complete refuses the row if the party has
-- no principal to attribute it to, which is the loud outcome that case wants.
-- And a consent that arrives already revoked retires nothing: it was never a
-- signature the person is standing behind, so it has no business closing a
-- lapsed grant either. The backfill below applies exactly this rule.
CREATE OR REPLACE FUNCTION consents_mirror_to_authorizations() RETURNS trigger AS $$
DECLARE
  pid uuid;
  actor uuid;
  purpose_ "AuthorizationPurpose";
  cats "DataCategory"[];
BEGIN
  SELECT party_id INTO pid FROM "borrowers" WHERE id = NEW.borrower_id;
  IF pid IS NULL THEN RETURN NULL; END IF;

  CASE NEW.kind
    WHEN 'verification_authorization' THEN
      purpose_ := 'FCRA_WRITTEN_INSTRUCTION';
      cats := ARRAY['CREDIT_REPORT','BANK_TRANSACTIONS','PAYROLL_INCOME','SANCTIONS_SCREENING','PUBLIC_RECORD_LIENS']::"DataCategory"[];
    WHEN 'form_4506c' THEN
      purpose_ := 'IRS_4506C';
      cats := ARRAY['TAX_TRANSCRIPT']::"DataCategory"[];
    WHEN 'persistent_monitoring' THEN
      purpose_ := 'FCRA_ACCOUNT_REVIEW';
      cats := ARRAY['CREDIT_REPORT','BANK_TRANSACTIONS']::"DataCategory"[];
    ELSE
      RETURN NULL;
  END CASE;

  SELECT id INTO actor FROM "principals" WHERE kind = 'BORROWER' AND party_id = pid LIMIT 1;
  IF NEW.revoked_at IS NULL AND actor IS NOT NULL THEN
    UPDATE "authorizations"
       SET revoked_at = NEW.granted_at,
           revoked_by_principal_id = actor,
           revocation_reason = 'lapsed; renewed by a new consent'
     WHERE party_id = pid AND purpose = purpose_
       AND revoked_at IS NULL AND expires_at <= NEW.granted_at;
  END IF;

  INSERT INTO "authorizations"
    (id, party_id, purpose, data_categories, granted_at, expires_at,
     revoked_at, revoked_by_principal_id, revocation_reason,
     signature_envelope_id, ip_address, user_agent, created_at)
  VALUES
    (gen_random_uuid(), pid, purpose_, cats, NEW.granted_at, NEW.granted_at + interval '120 days',
     NEW.revoked_at,
     CASE WHEN NEW.revoked_at IS NULL THEN NULL ELSE actor END,
     CASE WHEN NEW.revoked_at IS NULL THEN NULL ELSE 'consent revoked' END,
     NEW.envelope_id, NEW.ip_address, NEW.user_agent, now())
  ON CONFLICT DO NOTHING;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ─── 2. Every existing consent gets its mirror ──────────────────────────────
-- Replayed in the order the signatures happened, under exactly the rule the
-- trigger applies from now on: a live signature retires a lapsed grant of the
-- same purpose and then inserts; a still-live grant is left standing; a
-- consent that is itself revoked retires nothing. A consent the
-- bridge trigger already mirrored is skipped — by the time this runs step 1
-- has set party_id on EVERY borrower, so the WHERE alone would re-mirror
-- bridge-era rows, and a revoked one is outside the unique index and would
-- land twice. A revoked consent arrives already revoked by the party's own
-- principal, same 120-day expiry.
DO $$
DECLARE
  c record;
  actor uuid;
  purpose_ "AuthorizationPurpose";
  cats "DataCategory"[];
BEGIN
  FOR c IN
    SELECT co.*, bo.party_id
      FROM "consents" co
      JOIN "borrowers" bo ON bo.id = co.borrower_id
     WHERE co.kind IN ('verification_authorization', 'form_4506c', 'persistent_monitoring')
       AND bo.party_id IS NOT NULL
     ORDER BY co.granted_at
  LOOP
    purpose_ := CASE c.kind
      WHEN 'verification_authorization' THEN 'FCRA_WRITTEN_INSTRUCTION'::"AuthorizationPurpose"
      WHEN 'form_4506c'                 THEN 'IRS_4506C'::"AuthorizationPurpose"
      ELSE                                   'FCRA_ACCOUNT_REVIEW'::"AuthorizationPurpose" END;
    cats := CASE c.kind
      WHEN 'verification_authorization' THEN ARRAY['CREDIT_REPORT','BANK_TRANSACTIONS','PAYROLL_INCOME','SANCTIONS_SCREENING','PUBLIC_RECORD_LIENS']::"DataCategory"[]
      WHEN 'form_4506c'                 THEN ARRAY['TAX_TRANSCRIPT']::"DataCategory"[]
      ELSE                                   ARRAY['CREDIT_REPORT','BANK_TRANSACTIONS']::"DataCategory"[] END;
    SELECT id INTO actor FROM "principals" WHERE kind = 'BORROWER' AND party_id = c.party_id LIMIT 1;

    IF EXISTS (
      SELECT 1 FROM "authorizations" a
       WHERE a.party_id = c.party_id AND a.purpose = purpose_
         AND a.granted_at = c.granted_at
         AND a.signature_envelope_id IS NOT DISTINCT FROM c.envelope_id
    ) THEN
      CONTINUE;  -- the bridge trigger already mirrored this one
    END IF;

    IF c.revoked_at IS NULL AND actor IS NOT NULL THEN
      UPDATE "authorizations"
         SET revoked_at = c.granted_at,
             revoked_by_principal_id = actor,
             revocation_reason = 'lapsed; renewed by a new consent'
       WHERE party_id = c.party_id AND purpose = purpose_
         AND revoked_at IS NULL AND expires_at <= c.granted_at;
    END IF;

    INSERT INTO "authorizations"
      (id, party_id, purpose, data_categories, granted_at, expires_at,
       revoked_at, revoked_by_principal_id, revocation_reason,
       signature_envelope_id, ip_address, user_agent, created_at)
    VALUES
      (gen_random_uuid(), c.party_id, purpose_, cats, c.granted_at, c.granted_at + interval '120 days',
       c.revoked_at,
       CASE WHEN c.revoked_at IS NULL THEN NULL ELSE actor END,
       CASE WHEN c.revoked_at IS NULL THEN NULL ELSE 'consent revoked' END,
       c.envelope_id, c.ip_address, c.user_agent, now())
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- ─── 2b. Nothing is dropped that would not project ──────────────────────────
-- Same required set and the same trim rule as requireIdentity in
-- services/borrower-projection.ts — js_trim above, not btrim, because the
-- projection's idea of blank is JavaScript's and the two only agree on ASCII
-- space. A blank column was legal on the old row (NOT NULL text, no CHECK,
-- and zod's min(1) admits ' '); the projection refuses it, and the column
-- that held it is about to go. A row that will not project aborts here, with
-- the columns still in place. Note for whoever
-- hits it: prisma migrate records the failure, so after fixing the row run
-- `prisma migrate resolve --rolled-back 20260908170000_borrowers_are_records_about_parties`.
DO $$
DECLARE bad record;
BEGIN
  FOR bad IN
    SELECT b.id AS borrower_id, p.predicate
      FROM "borrowers" b
      CROSS JOIN (VALUES ('legal_name'),('date_of_birth'),('ssn_token'),('email'),('phone'),
                         ('current_address'),('marital_status'),('citizenship')) AS p(predicate)
     WHERE NOT EXISTS (
       SELECT 1 FROM "facts" f
        WHERE f.party_id = b.party_id AND f.predicate = p.predicate AND f.subject_key = ''
          AND f.superseded_by_id IS NULL AND f.retracted_at IS NULL
          AND CASE p.predicate
                WHEN 'legal_name'      THEN js_trim(f.value->>'first') <> '' AND js_trim(f.value->>'last') <> ''
                WHEN 'current_address' THEN js_trim(f.value->>'line1') <> '' AND js_trim(f.value->>'city') <> ''
                                        AND js_trim(f.value->>'state') <> '' AND js_trim(f.value->>'postalCode') <> ''
                WHEN 'marital_status'  THEN f.value #>> '{}' IN ('married','unmarried','separated')
                WHEN 'citizenship'     THEN f.value #>> '{}' IN ('us_citizen','permanent_resident','non_permanent_resident')
                ELSE jsonb_typeof(f.value) = 'string' AND js_trim(f.value #>> '{}') <> ''
              END)
  LOOP
    RAISE EXCEPTION 'borrower % has no usable % fact after backfill; fix the row before its columns are dropped',
      bad.borrower_id, bad.predicate;
  END LOOP;
END $$;
-- js_trim is STRICT, so js_trim(NULL) <> '' is NULL and a missing key fails
-- the CASE as intended.

-- ─── 3. Only now: the columns go, and the party is required ─────────────────
-- DropForeignKey
ALTER TABLE "borrowers" DROP CONSTRAINT "borrowers_party_id_fkey";

-- AlterTable
ALTER TABLE "borrowers" DROP COLUMN "address_city",
DROP COLUMN "address_line1",
DROP COLUMN "address_line2",
DROP COLUMN "address_postal_code",
DROP COLUMN "address_state",
DROP COLUMN "citizenship",
DROP COLUMN "date_of_birth",
DROP COLUMN "email",
DROP COLUMN "first_name",
DROP COLUMN "first_time_homebuyer",
DROP COLUMN "is_military",
DROP COLUMN "last_name",
DROP COLUMN "marital_status",
DROP COLUMN "phone",
DROP COLUMN "preferred_language",
DROP COLUMN "ssn_vault_handle",
ALTER COLUMN "party_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "borrowers_party_id_idx" ON "borrowers"("party_id");

-- AddForeignKey
ALTER TABLE "borrowers" ADD CONSTRAINT "borrowers_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 4. Deleting the sign-in deletes the person ─────────────────────────────
-- users.party_id is SET NULL and nothing cascades INTO parties, so without
-- this the privacy page's "for good" would leave the SSN vault handle, the
-- date of birth and every other identity fact behind. Facts go first and
-- explicitly: facts.asserted_by_principal_id is RESTRICT and the party's own
-- BORROWER principal is about to go with the party; relying on the order in
-- which the two cascades happen to fire is not a guarantee. Two kinds of fact
-- go, and the invariant is that after this trigger no fact anywhere is about
-- this party or was asserted by one of its principals: the facts ON the
-- party (party_id set), and the facts its principals asserted about anything
-- else — a property, a loan — which carry no party_id and would otherwise
-- hold the principal, and so the person, in place through the RESTRICT.
-- Nothing writes the second kind today; the trigger does not get to assume
-- that. The party cascade also removes this party's borrower rows on the
-- user's OTHER files, which is correct — partyForUser shares one party
-- across all of them.
-- Known gap, deliberately not papered over here: application_transitions.
-- actor_principal_id is also RESTRICT. No route records a borrower-caused
-- transition today; the first one that does must make that FK SET NULL or
-- handle it here, or account deletion will fail with an FK error.
CREATE OR REPLACE FUNCTION users_delete_takes_party() RETURNS trigger AS $$
BEGIN
  IF OLD.party_id IS NOT NULL THEN
    DELETE FROM "facts"
     WHERE party_id = OLD.party_id
        OR asserted_by_principal_id IN
           (SELECT id FROM "principals" WHERE party_id = OLD.party_id);
    DELETE FROM "parties" WHERE id = OLD.party_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_delete_takes_party_delete
  AFTER DELETE ON "users"
  FOR EACH ROW EXECUTE FUNCTION users_delete_takes_party();
