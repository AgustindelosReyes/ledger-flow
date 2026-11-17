-- Empties the TEST database between runs. The immutability triggers are suspended for
-- this session only; the chart of accounts (reference data) is preserved.
SET session_replication_role = replica;
TRUNCATE TABLE
  "invoice_corrections",
  "invoice_attempts",
  "invoices",
  "ledger_entries",
  "ledger_transactions",
  "payments",
  "webhook_events",
  "outbox_events";
SET session_replication_role = DEFAULT;
