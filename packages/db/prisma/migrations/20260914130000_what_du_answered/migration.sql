-- What Desktop Underwriter answered.
--
-- `applications.du_casefile_id` has been sitting empty since the migration that
-- added it, because nothing had ever asked DU for a casefile. These are the
-- tables that fill it: a response carries the identifier DU minted, and writing
-- it here is the only thing that ever writes that column.
--
-- APPEND-ONLY, like `connector_snapshots` and `decisions` and for the same
-- reason. A loan goes back to DU three to six times; each answer is a row, and
-- "your situation changed" is a diff between two of them, which you cannot take
-- against a row you overwrote. The UPDATE trigger below is what makes that a
-- property of the database rather than a habit of whoever writes the service.
--
-- A RECOMMENDATION IS NOT A DECISION OF OURS. What DU returns is Fannie Mae's
-- assessment of a loan they might buy. The creditor is Grander and an extension
-- of credit is theirs, so there is no outcome column here, no adverse-action
-- reasons, and nothing that touches `applications.status`. A file moves because
-- a person or our own engine moved it, with an actor and a ledger row; a
-- response is evidence they may cite in `application_transitions.caused_by` and
-- never an actor itself.
--
-- There is no `du_submissions` table. The emitted casefile is not retained
-- anywhere — whether it ever should be is open, and it carries up to four
-- cleartext social security numbers — so the durable facts about a submission
-- are the ones on the answer to it.

-- ─── The enumerated types ──────────────────────────────────────────────────
-- Neither is derived from the specification corpus, and both say so in
-- `DU_DATA_POINT_FOR_ENUM` with `local: true`. That corpus specifies the
-- casefile we SEND: `AutomatedUnderwritingRecommendationDescription` is a
-- free-text `MISMOString` in the schema chain, and the workbook names a
-- recommendation only in prose. So there is nothing for `du:verify` to diff
-- these against, which is exactly why the closed set is written down twice —
-- here, and in `parseDuRecommendation` at the boundary.
CREATE TYPE "DuResponseStatus" AS ENUM ('ANSWERED', 'ERRORED');

-- Verbatim, in DU's own spelling, which is why the Prisma members carry an
-- `@map`. Our engine's `AusRecommendation` spells three of these the same way
-- in lowercase and means something else by them: DU's `Refer` is "DU evaluated
-- the whole case and a human must underwrite it", ours is "we could not
-- evaluate it". A column that could hold either would let one be read as the
-- other, and the eligibility half of "Refer/Ineligible" has no member of ours
-- to land on at all.
CREATE TYPE "DuRecommendation" AS ENUM ('Approve/Eligible', 'Approve/Ineligible', 'Refer/Eligible', 'Refer/Ineligible', 'Refer with Caution', 'Out of Scope');

-- ─── 1. One answer ─────────────────────────────────────────────────────────
CREATE TABLE "du_responses" (
    "id" UUID NOT NULL,
    "application_id" UUID NOT NULL,

    -- 1, 2, 3 … in arrival order. What makes "the latest" and "the one before
    -- it" answerable without leaning on a timestamp two deliveries can share.
    "seq" INTEGER NOT NULL,

    "status" "DuResponseStatus" NOT NULL,
    "recommendation" "DuRecommendation",

    -- What DU called this case. Null on an error raised before DU opened one.
    "du_casefile_id" VARCHAR(30),

    -- Ours, as the submission carried it. Copied rather than joined: this row
    -- is evidence of one exchange, and a helpful read-through would rewrite
    -- what every earlier row says about itself.
    "aus_casefile_id" TEXT NOT NULL,

    -- Which adapter answered. "fixture-du" is not Desktop Underwriter, and a
    -- findings report nobody can tell apart from a real one is worse than none.
    "provider" TEXT NOT NULL,

    "submitted_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "du_responses_pkey" PRIMARY KEY ("id")
);

-- The two shapes an answer comes in, and nothing in between. A row claiming to
-- be answered with no recommendation on it reads downstream as a case DU
-- declined to approve, which is not what happened; a row claiming to be errored
-- while carrying one hides a verdict somebody needs to see.
ALTER TABLE "du_responses"
  ADD CONSTRAINT "du_responses_says_whether_du_evaluated_it" CHECK (
    ("status" = 'ANSWERED' AND "recommendation" IS NOT NULL AND "du_casefile_id" IS NOT NULL)
    OR ("status" = 'ERRORED' AND "recommendation" IS NULL)
  );

ALTER TABLE "du_responses"
  ADD CONSTRAINT "du_responses_seq_starts_at_one" CHECK ("seq" >= 1);

-- NOT NULL alone admits the empty string, which says nothing about which
-- submission this answered.
ALTER TABLE "du_responses"
  ADD CONSTRAINT "du_responses_aus_casefile_is_not_blank" CHECK (btrim("aus_casefile_id") <> '');
ALTER TABLE "du_responses"
  ADD CONSTRAINT "du_responses_provider_is_not_blank" CHECK (btrim("provider") <> '');

CREATE UNIQUE INDEX "du_responses_application_id_seq_key" ON "du_responses"("application_id", "seq");
CREATE INDEX "du_responses_application_id_received_at_idx" ON "du_responses"("application_id", "received_at");

ALTER TABLE "du_responses" ADD CONSTRAINT "du_responses_application_id_fkey"
  FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 2. The findings report ────────────────────────────────────────────────
CREATE TABLE "du_response_messages" (
    "id" UUID NOT NULL,
    "response_id" UUID NOT NULL,

    -- Position in the report as it arrived. The order is part of what was said.
    "ordinal" INTEGER NOT NULL,

    -- Free text, and deliberately not an enum — the opposite call from the
    -- recommendation above. We hold the specification for what we send and not
    -- for what comes back, so a closed set here would be built from the few
    -- category names somebody has happened to see, and the first real message
    -- filed under another would be refused at the door. The rule is to refuse a
    -- value we ACT on: we act on the recommendation, and we display these.
    "category" TEXT NOT NULL,
    "code" TEXT,
    "text" TEXT NOT NULL,

    CONSTRAINT "du_response_messages_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "du_response_messages"
  ADD CONSTRAINT "du_response_messages_ordinal_starts_at_one" CHECK ("ordinal" >= 1);
-- A message with no words in it is a line in the findings report that says
-- nothing, and UW-003 turns every one of these into a condition somebody has to
-- clear.
ALTER TABLE "du_response_messages"
  ADD CONSTRAINT "du_response_messages_text_is_not_blank" CHECK (btrim("text") <> '');
ALTER TABLE "du_response_messages"
  ADD CONSTRAINT "du_response_messages_category_is_not_blank" CHECK (btrim("category") <> '');

CREATE UNIQUE INDEX "du_response_messages_response_id_ordinal_key" ON "du_response_messages"("response_id", "ordinal");

ALTER TABLE "du_response_messages" ADD CONSTRAINT "du_response_messages_response_id_fkey"
  FOREIGN KEY ("response_id") REFERENCES "du_responses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 3. Append-only, enforced ──────────────────────────────────────────────
-- UPDATE only. DELETE stays open on purpose: these rows cascade off the
-- application, and "we remove your data for good" has to reach them. The
-- promise this trigger keeps is narrower and is the one that matters — a
-- response may not be rewritten in place, because the diff between two of them
-- is the whole reason both are kept.
CREATE OR REPLACE FUNCTION "du_responses_are_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'du_responses row % may not be updated; a new answer from DU is a new row, because a resubmission is read as the difference between two of them',
        OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "du_responses_are_append_only_update"
    BEFORE UPDATE ON "du_responses"
    FOR EACH ROW
    EXECUTE FUNCTION "du_responses_are_append_only"();

CREATE OR REPLACE FUNCTION "du_response_messages_are_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'du_response_messages row % may not be updated; it is what DU said, not a note we keep',
        OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "du_response_messages_are_append_only_update"
    BEFORE UPDATE ON "du_response_messages"
    FOR EACH ROW
    EXECUTE FUNCTION "du_response_messages_are_append_only"();

-- ─── 4. One case, agreed on by both tables ─────────────────────────────────
-- `applications.du_casefile_id` is write-once: DU names a case, and every
-- resubmission carries that name. This is the other half of it. A response
-- filed under a casefile the application does not carry is either another
-- loan's answer landing on this file or a second case opened at Fannie while
-- our own records still say one, and both look exactly like an ordinary row
-- until somebody resubmits.
--
-- So the write order is forced rather than suggested: the application takes
-- DU's identifier first, and the response is recorded against it. A service can
-- do that in either order; this makes only one of them commit.
CREATE OR REPLACE FUNCTION "du_responses_carry_the_applications_casefile"()
RETURNS TRIGGER AS $$
DECLARE
    on_application VARCHAR(30);
BEGIN
    IF NEW."du_casefile_id" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT "du_casefile_id" INTO on_application
      FROM "applications" WHERE "id" = NEW."application_id";

    IF on_application IS NULL THEN
        RAISE EXCEPTION
            'application % does not carry DU casefile %; the application takes the identifier DU minted before a response is recorded under it',
            NEW."application_id", NEW."du_casefile_id";
    END IF;

    IF on_application <> NEW."du_casefile_id" THEN
        RAISE EXCEPTION
            'application % carries DU casefile %, so a response for casefile % is about a different case',
            NEW."application_id", on_application, NEW."du_casefile_id";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "du_responses_carry_the_applications_casefile_insert"
    BEFORE INSERT ON "du_responses"
    FOR EACH ROW
    EXECUTE FUNCTION "du_responses_carry_the_applications_casefile"();

COMMENT ON TABLE "du_responses" IS
    'What DU answered, append-only. A recommendation here is Fannie Maes assessment and not a decision of ours; nothing in this table moves an application.';
COMMENT ON TABLE "du_response_messages" IS
    'The findings report, one message per row, in the order it arrived.';
