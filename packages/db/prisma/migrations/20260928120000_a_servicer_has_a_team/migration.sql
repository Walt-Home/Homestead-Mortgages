-- A servicer has a team, and each of them a sign-in of their own.
--
-- Ops loads the tape on the servicer's behalf and invites their people from
-- the desk; each takes a mailed link, sets a password, and signs in from
-- then on with a code to that address and the password — two factors,
-- never one. The invitation token lives in the link and nowhere here: the
-- row holds its hash. One address belongs to one servicer, and there are
-- no roles yet. See docs/decisions.md, "A servicer's team signs in with a
-- code and a password".
CREATE TABLE "servicer_users" (
    "id" UUID NOT NULL,
    "servicer_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT,
    "invited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invited_by" TEXT,
    "invite_token_hash" TEXT,
    "invite_expires_at" TIMESTAMP(3),
    "invite_delivered_to" TEXT,
    "invite_delivered_at" TIMESTAMP(3),
    "invite_delivery" JSONB,
    "accepted_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "failed_password_count" INTEGER NOT NULL DEFAULT 0,
    "failed_password_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),
    "last_signed_in_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "servicer_users_pkey" PRIMARY KEY ("id")
);

-- One six-digit code, mailed, good for ten minutes and one sign-in.
CREATE TABLE "servicer_signin_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "servicer_signin_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "servicer_users_email_key" ON "servicer_users"("email");
CREATE UNIQUE INDEX "servicer_users_invite_token_hash_key" ON "servicer_users"("invite_token_hash");
CREATE INDEX "servicer_users_servicer" ON "servicer_users"("servicer_id");
CREATE INDEX "servicer_signin_codes_user" ON "servicer_signin_codes"("user_id");

ALTER TABLE "servicer_users" ADD CONSTRAINT "servicer_users_servicer_id_fkey" FOREIGN KEY ("servicer_id") REFERENCES "servicers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "servicer_signin_codes" ADD CONSTRAINT "servicer_signin_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "servicer_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
