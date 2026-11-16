import { execSync } from 'node:child_process';
import { resolveTestDatabaseUrl } from './test-database.mjs';

/** Crea la base de test si no existe y la lleva a la última migración. */
export default function globalSetup() {
  execSync('pnpm prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: resolveTestDatabaseUrl() },
    stdio: 'pipe',
  });
}
