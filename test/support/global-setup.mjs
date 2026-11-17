import { execSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { resolveTestDatabaseUrl, resolveTestRedisDb } from './test-database.mjs';

/** Leaves the test infrastructure in a known state before each run. */
export default async function globalSetup() {
  const env = { ...process.env, DATABASE_URL: resolveTestDatabaseUrl() };

  // Creates the database if missing, migrates it to the latest version and empties it.
  execSync('pnpm prisma migrate deploy', { env, stdio: 'pipe' });
  execSync('pnpm prisma db execute --file test/support/reset-test-database.sql', {
    env,
    stdio: 'pipe',
  });

  // BullMQ queues and fiscal simulator state from previous runs.
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD || undefined,
    db: resolveTestRedisDb(),
  });
  await redis.flushdb();
  await redis.quit();
}
