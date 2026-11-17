import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Variables already present in the environment (CI, Docker) take priority over `.env`.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate` needs no connection; `migrate` fails with a clear message if missing.
    url: process.env.DATABASE_URL ?? '',
  },
});
