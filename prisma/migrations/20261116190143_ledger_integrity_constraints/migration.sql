-- Invariantes que el schema de Prisma no puede expresar. Se aplican en la base para que
-- valgan frente a cualquier cliente (app, scripts, psql), no solo frente al código de la app.

-- ─────────────────────────── 1. CHECK constraints ───────────────────────────

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "payments_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_amount_positive_check" CHECK ("amount" > 0),
  ADD CONSTRAINT "ledger_entries_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "ledger_transactions_no_self_reversal_check" CHECK ("reverses_id" <> "id");

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "invoices_amounts_check" CHECK (
    "net_amount" >= 0 AND "tax_amount" >= 0 AND "total_amount" > 0
    AND "total_amount" = "net_amount" + "tax_amount"
  ),
  ADD CONSTRAINT "invoices_point_of_sale_range_check" CHECK ("point_of_sale" BETWEEN 1 AND 99999),
  ADD CONSTRAINT "invoices_number_positive_check" CHECK ("number" > 0),
  ADD CONSTRAINT "invoices_cae_format_check" CHECK ("cae" ~ '^[0-9]{14}$'),
  ADD CONSTRAINT "invoices_attempt_count_check" CHECK ("attempt_count" >= 0),
  -- Los datos de autorización fiscal existen si y solo si el comprobante está emitido.
  ADD CONSTRAINT "invoices_issued_consistency_check" CHECK (
    (
      "status" = 'ISSUED'
      AND "number" IS NOT NULL AND "cae" IS NOT NULL
      AND "cae_expires_at" IS NOT NULL AND "issued_at" IS NOT NULL
    ) OR (
      "status" <> 'ISSUED'
      AND "number" IS NULL AND "cae" IS NULL
      AND "cae_expires_at" IS NULL AND "issued_at" IS NULL
    )
  );

ALTER TABLE "invoice_attempts"
  ADD CONSTRAINT "invoice_attempts_attempt_number_check" CHECK ("attempt_number" >= 1),
  ADD CONSTRAINT "invoice_attempts_duration_check" CHECK ("duration_ms" >= 0);

-- ─────────────────────── 2. Inmutabilidad (append-only) ───────────────────────

CREATE FUNCTION "reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table "%" is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "ledger_transactions_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_transactions"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();

CREATE TRIGGER "ledger_transactions_no_truncate"
  BEFORE TRUNCATE ON "ledger_transactions"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();

CREATE TRIGGER "ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();

CREATE TRIGGER "ledger_entries_no_truncate"
  BEFORE TRUNCATE ON "ledger_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_mutation"();

CREATE TRIGGER "webhook_events_append_only"
  BEFORE UPDATE OR DELETE ON "webhook_events"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();

CREATE TRIGGER "invoice_attempts_append_only"
  BEFORE UPDATE OR DELETE ON "invoice_attempts"
  FOR EACH ROW EXECUTE FUNCTION "reject_mutation"();

-- ─────────────────── 3. Balance de doble partida al COMMIT ───────────────────
-- Trigger diferido: se evalúa al confirmar la transacción, cuando ya están todas las
-- líneas insertadas. Un asiento debe tener líneas y, por moneda, Σ débitos = Σ créditos.

CREATE FUNCTION "assert_ledger_transaction_balanced"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_transaction_id uuid;
  v_unbalanced_currency text;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    v_transaction_id := NEW."id";
  ELSE
    v_transaction_id := NEW."transaction_id";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "ledger_entries" WHERE "transaction_id" = v_transaction_id
  ) THEN
    RAISE EXCEPTION 'ledger transaction % has no entries', v_transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT "currency" INTO v_unbalanced_currency
  FROM "ledger_entries"
  WHERE "transaction_id" = v_transaction_id
  GROUP BY "currency"
  HAVING SUM(CASE WHEN "direction" = 'DEBIT' THEN "amount" ELSE -"amount" END) <> 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced for currency %',
      v_transaction_id, v_unbalanced_currency
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ledger_transactions_balanced"
  AFTER INSERT ON "ledger_transactions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_ledger_transaction_balanced"();

CREATE CONSTRAINT TRIGGER "ledger_entries_balanced"
  AFTER INSERT ON "ledger_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_ledger_transaction_balanced"();

-- ─────────────────────────── 4. Plan de cuentas ───────────────────────────
-- Datos de referencia: deben existir en todo entorno, por eso van en la migración.

INSERT INTO "ledger_accounts" ("id", "code", "name", "type", "normal_balance") VALUES
  (gen_random_uuid(), 'GATEWAY_RECEIVABLE_MERCADOPAGO', 'Créditos a cobrar — MercadoPago', 'ASSET', 'DEBIT'),
  (gen_random_uuid(), 'GATEWAY_RECEIVABLE_STRIPE', 'Créditos a cobrar — Stripe', 'ASSET', 'DEBIT'),
  (gen_random_uuid(), 'SALES_REVENUE', 'Ingresos por ventas', 'REVENUE', 'CREDIT'),
  (gen_random_uuid(), 'VAT_PAYABLE', 'IVA débito fiscal', 'LIABILITY', 'CREDIT');
