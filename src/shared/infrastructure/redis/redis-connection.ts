import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.js';

export interface RedisConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly db: number;
  readonly password?: string;
}

/** Opciones de conexión compartidas por las colas, el worker y el simulador fiscal. */
export function redisConnectionOptions(config: ConfigService<Env, true>): RedisConnectionOptions {
  const password = config.get('REDIS_PASSWORD', { infer: true });
  return {
    host: config.get('REDIS_HOST', { infer: true }),
    port: config.get('REDIS_PORT', { infer: true }),
    db: config.get('REDIS_DB', { infer: true }),
    ...(password === undefined ? {} : { password }),
  };
}
