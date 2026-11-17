import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { AdminApiKeyGuard } from '../../shared/http/admin-api-key.guard.js';
import { IssueInvoiceUseCase } from './application/issue-invoice.use-case.js';
import { DeadLetterStore } from './application/ports/dead-letter-store.js';
import { FiscalAuthority } from './application/ports/fiscal-authority.js';
import { InvoiceIssuanceRepository } from './application/ports/invoice-issuance-repository.js';
import { RetryDeadLetteredInvoiceUseCase } from './application/retry-dead-lettered-invoice.use-case.js';
import { BullDeadLetterStore } from './infrastructure/bull-dead-letter-store.js';
import { DeadLetterQuery } from './infrastructure/dead-letter.query.js';
import {
  AuthorizationRegistry,
  RedisAuthorizationRegistry,
} from './infrastructure/fiscal-simulator/authorization-registry.js';
import {
  FaultInjector,
  RandomFaultInjector,
} from './infrastructure/fiscal-simulator/fault-injector.js';
import { SimulatedFiscalAuthority } from './infrastructure/fiscal-simulator/simulated-fiscal-authority.js';
import { InvoiceWorker } from './infrastructure/invoice-worker.js';
import { PrismaInvoiceIssuanceRepository } from './infrastructure/prisma-invoice-issuance-repository.js';
import { FISCAL_INVOICE_DLQ, FISCAL_INVOICE_QUEUE } from './invoice-queue.js';
import { DeadLetterController } from './presentation/dead-letter.controller.js';

@Module({
  imports: [BullModule.registerQueue({ name: FISCAL_INVOICE_QUEUE }, { name: FISCAL_INVOICE_DLQ })],
  controllers: [DeadLetterController],
  providers: [
    AdminApiKeyGuard,
    DeadLetterQuery,
    InvoiceWorker,
    { provide: InvoiceIssuanceRepository, useClass: PrismaInvoiceIssuanceRepository },
    { provide: DeadLetterStore, useClass: BullDeadLetterStore },
    { provide: AuthorizationRegistry, useClass: RedisAuthorizationRegistry },
    {
      provide: FaultInjector,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): FaultInjector =>
        new RandomFaultInjector(config.get('FISCAL_SIMULATOR_FAILURE_RATE', { infer: true })),
    },
    {
      // The only place to change in order to integrate the real fiscal web service.
      provide: FiscalAuthority,
      inject: [AuthorizationRegistry, FaultInjector, ConfigService],
      useFactory: (
        registry: AuthorizationRegistry,
        faults: FaultInjector,
        config: ConfigService<Env, true>,
      ): FiscalAuthority =>
        new SimulatedFiscalAuthority(registry, faults, {
          minLatencyMs: config.get('FISCAL_SIMULATOR_MIN_LATENCY_MS', { infer: true }),
          maxLatencyMs: config.get('FISCAL_SIMULATOR_MAX_LATENCY_MS', { infer: true }),
        }),
    },
    {
      provide: IssueInvoiceUseCase,
      inject: [InvoiceIssuanceRepository, FiscalAuthority, ConfigService],
      useFactory: (
        invoices: InvoiceIssuanceRepository,
        authority: FiscalAuthority,
        config: ConfigService<Env, true>,
      ): IssueInvoiceUseCase =>
        new IssueInvoiceUseCase(invoices, authority, {
          requestTimeoutMs: config.get('FISCAL_REQUEST_TIMEOUT_MS', { infer: true }),
        }),
    },
    {
      provide: RetryDeadLetteredInvoiceUseCase,
      inject: [InvoiceIssuanceRepository, DeadLetterStore],
      useFactory: (
        invoices: InvoiceIssuanceRepository,
        deadLetters: DeadLetterStore,
      ): RetryDeadLetteredInvoiceUseCase =>
        new RetryDeadLetteredInvoiceUseCase(invoices, deadLetters),
    },
  ],
  exports: [BullModule, DeadLetterStore],
})
export class InvoicingModule {}
