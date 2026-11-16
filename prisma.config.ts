import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Las variables ya presentes en el entorno (CI, Docker) tienen prioridad sobre `.env`.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate` no necesita conexión; `migrate` falla con un mensaje claro si falta.
    url: process.env.DATABASE_URL ?? '',
  },
});
