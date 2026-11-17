import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { validateEnv, type Env } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { InvoicingModule } from './modules/invoicing/invoicing.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { OperationsModule } from './modules/operations/operations.module.js';
import { OutboxModule } from './modules/outbox/outbox.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';
import { ProblemDetailsFilter } from './shared/http/problem-details.filter.js';
import { createValidationPipe } from './shared/http/validation.js';
import { PrismaModule } from './shared/infrastructure/prisma/prisma.module.js';
import { redisConnectionOptions } from './shared/infrastructure/redis/redis-connection.js';
import { LoggingModule } from './shared/logging/logging.module.js';
import { RuntimeRolesModule } from './shared/runtime/runtime-roles.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    LoggingModule,
    RuntimeRolesModule,
    PrismaModule,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: redisConnectionOptions(config),
      }),
    }),
    WebhooksModule,
    LedgerModule,
    InvoicingModule,
    OutboxModule,
    OperationsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Registered as providers (not in main.ts) so that the e2e tests, which build the app
    // from AppModule, exercise exactly the same HTTP pipeline as production.
    { provide: APP_PIPE, useFactory: createValidationPipe },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule {}
