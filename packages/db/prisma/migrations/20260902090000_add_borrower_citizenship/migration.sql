-- Residency status, asked on screen 2 of the four-screen flow.
--
-- Nullable with no default: every borrower recorded before this column existed
-- genuinely has no stated citizenship, and defaulting them to "us_citizen"
-- would assert eligibility nobody claimed. The application read path treats
-- null as "not asked yet", which is what it is.
ALTER TABLE "borrowers" ADD COLUMN "citizenship" TEXT;
