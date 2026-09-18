-- Sign-in has a second step. Google says who somebody is; a code from an
-- authenticator app says they are holding the phone they enrolled, and the
-- gate over everything past /api/auth now wants both.
--
-- One row per person. The secret is AES-256-GCM ciphertext under
-- VENDOR_TOKEN_KEY, the same key and for the same reason as vendor_tokens: a
-- row that read plainly would let whoever read it mint every code from here
-- on. last_used_step is what makes a code good once; failed_attempts and
-- locked_until are what make guessing expensive, and they sit on the row
-- rather than in the session so a fresh sign-in does not buy five more.
CREATE TABLE "user_authenticators" (
    "user_id" UUID NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "last_used_step" INTEGER,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_authenticators_pkey" PRIMARY KEY ("user_id")
);

-- The eight codes handed over at enrollment, for the day the phone is gone.
-- Only a SHA-256 lands here, like an invitation token: the code itself is
-- shown once and held nowhere. used_at rather than a delete, so "how many are
-- left" and "when was one spent" both stay answerable. They hang off the
-- authenticator and not the user, so replacing the authenticator takes them
-- with it.
CREATE TABLE "user_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_recovery_codes_user_id_code_hash_key" ON "user_recovery_codes"("user_id", "code_hash");

ALTER TABLE "user_authenticators" ADD CONSTRAINT "user_authenticators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "user_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user_authenticators"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
