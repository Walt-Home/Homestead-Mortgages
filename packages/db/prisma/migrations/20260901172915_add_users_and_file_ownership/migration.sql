-- AlterTable
ALTER TABLE "loan_files" ADD COLUMN     "is_demo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "user_id" UUID;

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "google_sub" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "picture_url" TEXT,
    "hosted_domain" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "loan_files_user_id_created_at_idx" ON "loan_files"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "loan_files_is_demo_idx" ON "loan_files"("is_demo");

-- AddForeignKey
ALTER TABLE "loan_files" ADD CONSTRAINT "loan_files_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
