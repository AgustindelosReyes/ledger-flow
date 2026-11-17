import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { Env } from '../../../../config/env.js';
import { redisConnectionOptions } from '../../../../shared/infrastructure/redis/redis-connection.js';
import type { FiscalAuthorization } from '../../application/ports/fiscal-authority.js';
import type { InvoiceType } from '../../domain/invoice-type.js';

export interface AuthorizationProposal {
  readonly invoiceId: string;
  readonly pointOfSale: number;
  readonly type: InvoiceType;
  readonly cae: string;
  readonly caeExpiresAt: string;
}

/**
 * State owned by the simulated fiscal authority: consecutive numbering per (point of
 * sale, type) and a record of what was already authorized. `authorize` is idempotent by
 * `invoiceId`: a second call returns the original authorization instead of issuing
 * another invoice.
 */
export abstract class AuthorizationRegistry {
  abstract authorize(proposal: AuthorizationProposal): Promise<FiscalAuthorization>;
}

const authorizationSchema = z.object({
  number: z.number().int().positive(),
  cae: z.string().regex(/^\d{14}$/),
  caeExpiresAt: z.iso.date(),
});

// Atomic in Redis: look up the previous authorization, or number and store a new one.
const AUTHORIZE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return existing
end
local number = redis.call('INCR', KEYS[2])
local authorization = cjson.encode({ number = number, cae = ARGV[1], caeExpiresAt = ARGV[2] })
redis.call('SET', KEYS[1], authorization)
return authorization
`;

const KEY_PREFIX = 'fiscal-simulator';

@Injectable()
export class RedisAuthorizationRegistry
  extends AuthorizationRegistry
  implements OnApplicationShutdown
{
  private readonly redis: Redis;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.redis = new Redis(redisConnectionOptions(config));
  }

  async authorize(proposal: AuthorizationProposal): Promise<FiscalAuthorization> {
    const raw: unknown = await this.redis.eval(
      AUTHORIZE_SCRIPT,
      2,
      `${KEY_PREFIX}:authorization:${proposal.invoiceId}`,
      `${KEY_PREFIX}:sequence:${proposal.pointOfSale}:${proposal.type}`,
      proposal.cae,
      proposal.caeExpiresAt,
    );
    if (typeof raw !== 'string') {
      throw new Error('Fiscal simulator registry returned an unexpected reply');
    }
    const parsed: unknown = JSON.parse(raw);
    return authorizationSchema.parse(parsed);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}
