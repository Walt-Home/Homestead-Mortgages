-- The natural key the persona seed is idempotent on, and the marker the
-- read-only session gate reads. A column on users rather than a table of
-- personas because the persona IS a user: sign-in mints a real session for it.
ALTER TABLE "users" ADD COLUMN "persona_key" TEXT;
CREATE UNIQUE INDEX "users_persona_key_key" ON "users"("persona_key");
ALTER TABLE "users" ADD CONSTRAINT "users_persona_key_shape"
  CHECK (persona_key IS NULL OR persona_key ~ '^[a-z][a-z0-9_]{1,40}$');
