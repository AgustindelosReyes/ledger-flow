import { resolveTestDatabaseUrl } from './test-database.mjs';

// Corre en cada worker antes de cargar la app. `process.env` tiene prioridad sobre `.env`.
process.env.DATABASE_URL = resolveTestDatabaseUrl();
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
