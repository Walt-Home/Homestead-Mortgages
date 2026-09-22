-- A loan remembers the servicing platform's id for it, and which platform said so.
--
-- The `servicing` connector port finds a loan on the platform by the number
-- the servicer put on the tape, which on the real adapter means walking the
-- platform's imports until one carries it: fine for a page, wrong for a
-- batch. The first successful read hands back the platform's own id, and
-- the row keeps it beside the provider's name so a later read — and a sweep
-- over every monitored loan — goes straight there.
--
-- The provider is stored with the id because the id is only meaningful to
-- the platform that minted it: an id the fixture answered is not one Doug's
-- runtime knows, and a registry switched from one to the other must not
-- present the wrong platform's id as its own. A reader compares the stored
-- provider with the registry's before it uses the id, and both columns are
-- set or cleared together.
ALTER TABLE "loans" ADD COLUMN "servicing_provider" TEXT;
ALTER TABLE "loans" ADD COLUMN "servicing_external_id" TEXT;

ALTER TABLE "loans" ADD CONSTRAINT "loans_platform_id_names_its_provider"
  CHECK (("servicing_provider" IS NULL) = ("servicing_external_id" IS NULL));
