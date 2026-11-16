import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';

/**
 * Procesos en segundo plano que esta instancia ejecuta. La misma imagen puede desplegarse
 * como API pura, como worker, o como ambos, y escalarse por separado.
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
