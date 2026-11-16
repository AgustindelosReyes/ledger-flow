-- Vacía la base de TEST entre corridas. Los triggers de inmutabilidad se suspenden solo
-- para esta sesión; el plan de cuentas (datos de referencia) se conserva.
SET session_replication_role = replica;
TRUNCATE TABLE
  "invoice_attempts",
  "invoices",
  "ledger_entries",
  "ledger_transactions",
  "payments",
  "webhook_events",
  "outbox_events";
SET session_replication_role = DEFAULT;
