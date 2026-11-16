import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { validateEnv } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';
import { ProblemDetailsFilter } from './shared/http/problem-details.filter.js';
import { createValidationPipe } from './shared/http/validation.js';
import { PrismaModule } from './shared/infrastructure/prisma/prisma.module.js';
import { LoggingModule } from './shared/logging/logging.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    LoggingModule,
    PrismaModule,
    WebhooksModule,
    LedgerModule,
  ],
  controllers: [HealthController],
  providers: [
    // Registrados como providers (no en main.ts) para que los tests e2e, que arman la app
    // desde AppModule, ejerciten exactamente el mismo pipeline HTTP que producción.
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule {}
