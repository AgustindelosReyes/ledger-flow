import { resolveTestDatabaseUrl, resolveTestRedisDb } from './test-database.mjs';

// Runs in every worker before the app is loaded. `process.env` takes priority over `.env`.
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: resolveTestDatabaseUrl(),
  REDIS_DB: String(resolveTestRedisDb()),

  // Short cycles: the retry and DLQ scenarios resolve in milliseconds.
  OUTBOX_POLL_INTERVAL_MS: '25',
  INVOICE_JOB_ATTEMPTS: '3',
  INVOICE_JOB_BACKOFF_MS: '20',
  FISCAL_REQUEST_TIMEOUT_MS: '250',

  // No randomness: each test dictates the fiscal authority faults with a script.
  FISCAL_SIMULATOR_FAILURE_RATE: '0',
  FISCAL_SIMULATOR_MIN_LATENCY_MS: '0',
  FISCAL_SIMULATOR_MAX_LATENCY_MS: '5',
});
