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
  if (process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL or TEST_DATABASE_URL to run the e2e tests');
  }

  const url = new URL(process.env.DATABASE_URL);
  if (!url.pathname.endsWith(TEST_SUFFIX)) {
    url.pathname += TEST_SUFFIX;
  }
  return url.toString();
}
