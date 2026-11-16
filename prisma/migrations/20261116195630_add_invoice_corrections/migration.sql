-- CreateTable
CREATE TABLE "invoice_corrections" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "field" VARCHAR(64) NOT NULL,
    "previous_value" VARCHAR(200),
    "new_value" VARCHAR(200) NOT NULL,
    "reason" VARCHAR(500),
    "correlation_id" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_corrections_invoice_id_created_at_idx" ON "invoice_corrections"("invoice_id", "created_at");

-- AddForeignKey
ALTER TABLE "invoice_corrections" ADD CONSTRAINT "invoice_corrections_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- La bitácora de correcciones es evidencia de auditoría: append-only, como el ledger.
CREATE TRIGGER "invoice_corrections_append_only"
  BEFORE UPDATE OR DELETE ON "invoice_corrections"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();
