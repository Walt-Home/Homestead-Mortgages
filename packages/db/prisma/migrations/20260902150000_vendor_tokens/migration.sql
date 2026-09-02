
-- CreateTable
CREATE TABLE "vendor_tokens" (
    "id" UUID NOT NULL,
    "loan_file_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_tokens_loan_file_id_key_key" ON "vendor_tokens"("loan_file_id", "key");

-- AddForeignKey
ALTER TABLE "vendor_tokens" ADD CONSTRAINT "vendor_tokens_loan_file_id_fkey" FOREIGN KEY ("loan_file_id") REFERENCES "loan_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

