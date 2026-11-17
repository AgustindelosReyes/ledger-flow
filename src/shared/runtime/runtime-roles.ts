import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';

/**
 * Background processes that this instance runs. The same image can be deployed as a pure
 * API, as a worker, or as both, and scaled separately.
 */
export abstract class RuntimeRoles {
  abstract readonly outboxRelay: boolean;
  abstract readonly invoiceWorker: boolean;
}

@Global()
@Module({
  providers: [
    {
      provide: RuntimeRoles,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): RuntimeRoles => ({
        outboxRelay: config.get('OUTBOX_RELAY_ENABLED', { infer: true }),
        invoiceWorker: config.get('INVOICE_WORKER_ENABLED', { infer: true }),
      }),
    },
  ],
  exports: [RuntimeRoles],
})
export class RuntimeRolesModule {}
