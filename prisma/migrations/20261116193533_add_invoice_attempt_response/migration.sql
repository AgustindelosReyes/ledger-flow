-- AlterTable
ALTER TABLE "invoice_attempts" ADD COLUMN     "http_status" INTEGER,
ADD COLUMN     "response" JSONB;
