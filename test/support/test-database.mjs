import { existsSync } from 'node:fs';

const TEST_SUFFIX = '_test';

/**
 * Los tests e2e nunca corren contra la base de desarrollo: usan `TEST_DATABASE_URL` si está
 * definida o, si no, la base de `DATABASE_URL` con sufijo `_test` en el mismo servidor.
 */
export function resolveTestDatabaseUrl() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const source = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!source) {
    throw new Error('Set DATABASE_URL or TEST_DATABASE_URL to run the e2e tests');
  }

  const url = new URL(source);
  if (!process.env.TEST_DATABASE_URL && !url.pathname.endsWith(TEST_SUFFIX)) {
    url.pathname += TEST_SUFFIX;
  }
  // El setup global vacía esta base: se exige el sufijo para no borrar nunca otra.
  if (!url.pathname.endsWith(TEST_SUFFIX)) {
    throw new Error(`Refusing to run e2e tests: database "${url.pathname}" must end in "_test"`);
  }
  return url.toString();
}

/** Base lógica de Redis reservada para tests; el setup global la vacía. */
export function resolveTestRedisDb() {
  const db = Number(process.env.TEST_REDIS_DB ?? '15');
  if (!Number.isInteger(db) || db < 1 || db > 15) {
    throw new Error('TEST_REDIS_DB must be between 1 and 15 (0 is reserved for development)');
  }
  return db;
}
