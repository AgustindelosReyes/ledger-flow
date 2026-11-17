import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();
/** Explicit boolean: `z.coerce.boolean()` would treat the string "false" as true. */
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: port.default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

    REDIS_HOST: z.string().min(1),
    REDIS_PORT: port,
    REDIS_PASSWORD: z.string().min(1).optional(),
    REDIS_DB: z.coerce.number().int().min(0).max(15).default(0),

    WEBHOOK_SIGNING_SECRET: z.string().min(32),
    WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: positiveInt.default(300),
    ADMIN_API_KEY: z.string().min(24),

    FISCAL_POINT_OF_SALE: z.coerce.number().int().min(1).max(99999).default(1),
    FISCAL_REQUEST_TIMEOUT_MS: positiveInt.default(2000),

    FISCAL_SIMULATOR_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.3),
    FISCAL_SIMULATOR_MIN_LATENCY_MS: nonNegativeInt.default(50),
    FISCAL_SIMULATOR_MAX_LATENCY_MS: nonNegativeInt.default(800),

    INVOICE_JOB_ATTEMPTS: positiveInt.default(5),
    INVOICE_JOB_BACKOFF_MS: positiveInt.default(1000),
    INVOICE_WORKER_CONCURRENCY: positiveInt.default(5),

    INVOICE_WORKER_ENABLED: flag.default(true),

    OUTBOX_POLL_INTERVAL_MS: positiveInt.default(1000),
    OUTBOX_BATCH_SIZE: positiveInt.max(500).default(50),
    OUTBOX_MAX_ATTEMPTS: positiveInt.default(5),
    OUTBOX_RELAY_ENABLED: flag.default(true),
  })
  .refine((env) => env.FISCAL_SIMULATOR_MAX_LATENCY_MS >= env.FISCAL_SIMULATOR_MIN_LATENCY_MS, {
    path: ['FISCAL_SIMULATOR_MAX_LATENCY_MS'],
    message: 'must be greater than or equal to FISCAL_SIMULATOR_MIN_LATENCY_MS',
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the environment at startup (fail-fast). A variable that is defined but empty
 * (`FOO=`) is treated as absent, so that defaults and optional values apply.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const withoutBlanks = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));

  const result = envSchema.safeParse(withoutBlanks);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
