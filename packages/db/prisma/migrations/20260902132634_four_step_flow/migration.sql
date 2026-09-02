-- AlterTable
ALTER TABLE "borrowers" ADD COLUMN     "citizenship" TEXT NOT NULL DEFAULT 'us_citizen',
ADD COLUMN     "identity_verification_id" TEXT,
ADD COLUMN     "identity_verification_status" TEXT,
ADD COLUMN     "identity_verified_at" TIMESTAMP(3);
