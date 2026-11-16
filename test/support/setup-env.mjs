import { resolveTestDatabaseUrl, resolveTestRedisDb } from './test-database.mjs';

// Corre en cada worker antes de cargar la app. `process.env` tiene prioridad sobre `.env`.
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: resolveTestDatabaseUrl(),
  REDIS_DB: String(resolveTestRedisDb()),

  // Ciclos cortos: los escenarios de reintento y DLQ se resuelven en milisegundos.
  OUTBOX_POLL_INTERVAL_MS: '25',
  INVOICE_JOB_ATTEMPTS: '3',
  INVOICE_JOB_BACKOFF_MS: '20',
  FISCAL_REQUEST_TIMEOUT_MS: '250',

  // Sin azar: las fallas del ente fiscal las dicta cada test con un guion.
  FISCAL_SIMULATOR_FAILURE_RATE: '0',
  FISCAL_SIMULATOR_MIN_LATENCY_MS: '0',
  FISCAL_SIMULATOR_MAX_LATENCY_MS: '5',
});
