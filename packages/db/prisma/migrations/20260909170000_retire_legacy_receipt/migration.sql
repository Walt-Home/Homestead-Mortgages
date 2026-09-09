-- The legacy TRID stamp. Its last reader (services/application.ts) was deleted
-- in commit 4 and its last writer (seed-demo.ts) in commit 8. Dropping the
-- columns means stampApplicationIfComplete cannot be revived by a caller: there
-- is ONE receipt, the SQL trigger. Staging holds only demo and tester rows;
-- their stamped values are not evidence of anything and are not migrated.
ALTER TABLE "loan_files" DROP COLUMN "application_received_at", DROP COLUMN "application_six_pieces";
