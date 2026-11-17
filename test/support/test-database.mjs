import { existsSync } from 'node:fs';

const TEST_SUFFIX = '_test';

/**
 * The e2e tests never run against the development database: they use `TEST_DATABASE_URL`
 * if set or, otherwise, the `DATABASE_URL` database with a `_test` suffix on the same
 * server.
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
  // The global setup empties this database: the suffix is required so that no other
  // database can ever be wiped.
  if (!url.pathname.endsWith(TEST_SUFFIX)) {
    throw new Error(`Refusing to run e2e tests: database "${url.pathname}" must end in "_test"`);
  }
  return url.toString();
}

/** Redis logical database reserved for tests; the global setup flushes it. */
export function resolveTestRedisDb() {
  const db = Number(process.env.TEST_REDIS_DB ?? '15');
  if (!Number.isInteger(db) || db < 1 || db > 15) {
    throw new Error('TEST_REDIS_DB must be between 1 and 15 (0 is reserved for development)');
  }
  return db;
}
