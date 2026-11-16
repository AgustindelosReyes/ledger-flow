import { describe, expect, it } from '@jest/globals';
import { validateEnv } from './env.js';

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/ledgerflow?schema=public',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  WEBHOOK_SIGNING_SECRET: 'a'.repeat(32),
  ADMIN_API_KEY: 'b'.repeat(24),
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = validateEnv(validEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.FISCAL_SIMULATOR_FAILURE_RATE).toBe(0.3);
    expect(env.INVOICE_JOB_ATTEMPTS).toBe(5);
    expect(env.OUTBOX_MAX_ATTEMPTS).toBe(5);
  });

  it('coerces numeric strings into numbers', () => {
    const env = validateEnv({ ...validEnv, PORT: '8080', FISCAL_SIMULATOR_FAILURE_RATE: '0.5' });

    expect(env.PORT).toBe(8080);
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.FISCAL_SIMULATOR_FAILURE_RATE).toBe(0.5);
  });

  it('treats blank variables as absent', () => {
    const env = validateEnv({ ...validEnv, REDIS_PASSWORD: '', PORT: '' });

    expect(env.REDIS_PASSWORD).toBeUndefined();
    expect(env.PORT).toBe(3000);
  });

  it.each(['DATABASE_URL', 'REDIS_HOST', 'WEBHOOK_SIGNING_SECRET', 'ADMIN_API_KEY'] as const)(
    'fails fast when %s is missing',
    (key) => {
      const { [key]: _omitted, ...incomplete } = validEnv;

      expect(() => validateEnv(incomplete)).toThrow(key);
    },
  );

  it('rejects a signing secret shorter than 32 characters', () => {
    expect(() => validateEnv({ ...validEnv, WEBHOOK_SIGNING_SECRET: 'too-short' })).toThrow(
      'WEBHOOK_SIGNING_SECRET',
    );
  });

  it('rejects a non-PostgreSQL database URL', () => {
    expect(() => validateEnv({ ...validEnv, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      'DATABASE_URL',
    );
  });

  it('rejects a failure rate outside [0, 1]', () => {
    expect(() => validateEnv({ ...validEnv, FISCAL_SIMULATOR_FAILURE_RATE: '1.5' })).toThrow(
      'FISCAL_SIMULATOR_FAILURE_RATE',
    );
  });

  it('enables the background roles by default and parses explicit flags strictly', () => {
    expect(validateEnv(validEnv)).toMatchObject({
      OUTBOX_RELAY_ENABLED: true,
      INVOICE_WORKER_ENABLED: true,
    });
    expect(
      validateEnv({ ...validEnv, OUTBOX_RELAY_ENABLED: 'false', INVOICE_WORKER_ENABLED: 'false' }),
    ).toMatchObject({ OUTBOX_RELAY_ENABLED: false, INVOICE_WORKER_ENABLED: false });
    // "0", "no" o "FALSE" no se interpretan en silencio como verdadero: son un error.
    expect(() => validateEnv({ ...validEnv, INVOICE_WORKER_ENABLED: '0' })).toThrow(
      'INVOICE_WORKER_ENABLED',
    );
  });

  it('rejects a Redis database index outside 0-15', () => {
    expect(validateEnv(validEnv).REDIS_DB).toBe(0);
    expect(() => validateEnv({ ...validEnv, REDIS_DB: '16' })).toThrow('REDIS_DB');
  });

  it('rejects a simulator latency range where max < min', () => {
    expect(() =>
      validateEnv({
        ...validEnv,
        FISCAL_SIMULATOR_MIN_LATENCY_MS: '500',
        FISCAL_SIMULATOR_MAX_LATENCY_MS: '100',
      }),
    ).toThrow('FISCAL_SIMULATOR_MAX_LATENCY_MS');
  });
});
