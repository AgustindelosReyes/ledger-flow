import { execSync } from 'node:child_process';
import { Redis } from 'ioredis';
import { resolveTestDatabaseUrl, resolveTestRedisDb } from './test-database.mjs';

/** Deja la infraestructura de test en un estado conocido antes de cada corrida. */
export default async function globalSetup() {
  const env = { ...process.env, DATABASE_URL: resolveTestDatabaseUrl() };

  // Crea la base si no existe, la lleva a la última migración y la vacía.
  execSync('pnpm prisma migrate deploy', { env, stdio: 'pipe' });
  execSync('pnpm prisma db execute --file test/support/reset-test-database.sql', {
    env,
    stdio: 'pipe',
  });

  // Colas de BullMQ y estado del simulador fiscal de corridas anteriores.
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD || undefined,
    db: resolveTestRedisDb(),
  });
  await redis.flushdb();
  await redis.quit();
}
