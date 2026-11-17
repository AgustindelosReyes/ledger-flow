import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { IngestPaymentWebhookUseCase } from './application/ingest-payment-webhook.use-case.js';
import { PaymentEventStore } from './application/ports/payment-event-store.js';
import { PrismaPaymentEventStore } from './infrastructure/prisma-payment-event-store.js';
import { WebhookSignatureGuard } from './presentation/webhook-signature.guard.js';
import { WebhooksController } from './presentation/webhooks.controller.js';

@Module({
  controllers: [WebhooksController],
  providers: [
    WebhookSignatureGuard,
    { provide: PaymentEventStore, useClass: PrismaPaymentEventStore },
    {
      // The use case is a plain class with no framework decorators: it is wired here.
      provide: IngestPaymentWebhookUseCase,
      inject: [PaymentEventStore, ConfigService],
      useFactory: (
        store: PaymentEventStore,
        config: ConfigService<Env, true>,
      ): IngestPaymentWebhookUseCase =>
        new IngestPaymentWebhookUseCase(store, {
          pointOfSale: config.get('FISCAL_POINT_OF_SALE', { infer: true }),
        }),
    },
  ],
})
export class WebhooksModule {}
