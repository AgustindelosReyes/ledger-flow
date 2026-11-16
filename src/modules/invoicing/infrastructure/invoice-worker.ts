import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../../../config/env.js';
import { redisConnectionOptions } from '../../../shared/infrastructure/redis/redis-connection.js';
import { RuntimeRoles } from '../../../shared/runtime/runtime-roles.js';
import { InvoiceIssuanceFailedError } from '../application/errors.js';
import { IssueInvoiceUseCase } from '../application/issue-invoice.use-case.js';
import { DeadLetterStore } from '../application/ports/dead-letter-store.js';
import {
  FISCAL_INVOICE_QUEUE,
  issueInvoiceJobDataSchema,
  type IssueInvoiceJobData,
} from '../invoice-queue.js';

/**
 * Adaptador entre BullMQ y el caso de uso de emisión. Traduce el resultado del intento al
 * lenguaje de la cola:
 *
 *  - error transitorio  -> se relanza; BullMQ reintenta con backoff exponencial.
 *  - error permanente   -> `UnrecoverableError`; falla definitiva sin gastar reintentos.
 *  - falla definitiva   -> además se publica la entrada en la Dead Letter Queue.
 */
@Injectable()
export class InvoiceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InvoiceWorker.name);
  private worker: Worker<IssueInvoiceJobData> | undefined;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly roles: RuntimeRoles,
    private readonly issueInvoice: IssueInvoiceUseCase,
    private readonly deadLetters: DeadLetterStore,
    private readonly pino: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.roles.invoiceWorker) {
      return;
    }
    this.worker = new Worker<IssueInvoiceJobData>(FISCAL_INVOICE_QUEUE, (job) => this.handle(job), {
      connection: redisConnectionOptions(this.config),
      concurrency: this.config.get('INVOICE_WORKER_CONCURRENCY', { infer: true }),
    });
    this.worker.on('error', (error) => {
      this.logger.error({ err: error }, 'Invoice worker error');
    });
  }

  /**
   * Apagado ordenado: deja de tomar jobs y espera a que terminen los que están en curso.
   * Ocurre en la primera fase del apagado, cuando Postgres y Redis siguen disponibles.
   */
  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private handle(job: Job<IssueInvoiceJobData>): Promise<unknown> {
    const data = issueInvoiceJobDataSchema.safeParse(job.data);
    if (!data.success) {
      return Promise.reject(new UnrecoverableError('Malformed issue-invoice job payload'));
    }
    // Contexto de logging del job: toda línea emitida mientras se procesa, en cualquier
    // capa, lleva el correlationId del webhook que originó la operación.
    return this.pino.runInContext(() => this.process(job, data.data), {
      bindings: {
        correlationId: data.data.correlationId,
        jobId: job.id,
        invoiceId: data.data.invoiceId,
      },
    });
  }

  private async process(
    job: Job<IssueInvoiceJobData>,
    data: IssueInvoiceJobData,
  ): Promise<unknown> {
    const jobId = job.id ?? data.invoiceId;
    const maxAttempts = job.opts.attempts ?? 1;
    const attempt = job.attemptsMade + 1;

    try {
      const result = await this.issueInvoice.execute({
        invoiceId: data.invoiceId,
        jobId,
        isFinalAttempt: attempt >= maxAttempts,
      });

      if (result.outcome === 'dead_lettered') {
        // Reentrega de un job cuya factura ya había sido dada por perdida (el proceso murió
        // entre marcarla y terminar el job): se asegura la entrada en la DLQ y se cierra.
        await this.deadLetters.put({
          ...data,
          sourceJobId: jobId,
          errorCode: 'DEAD_LETTERED',
          reason: 'Invoice was already dead-lettered',
          attemptCount: result.invoice.attemptCount,
          deadLetteredAt: new Date().toISOString(),
        });
        throw new UnrecoverableError('Invoice is already dead-lettered');
      }

      this.logger.log({ outcome: result.outcome, attempt, maxAttempts }, 'Invoice job completed');
      return result;
    } catch (error) {
      if (!(error instanceof InvoiceIssuanceFailedError)) {
        throw error;
      }

      if (error.deadLettered) {
        await this.deadLetters.put({
          ...data,
          sourceJobId: jobId,
          errorCode: error.errorCode,
          reason: error.message,
          attemptCount: error.attemptCount,
          deadLetteredAt: new Date().toISOString(),
        });
        this.logger.error(
          { errorCode: error.errorCode, attempt, maxAttempts, reason: error.message },
          'Invoice moved to the dead letter queue',
        );
      } else {
        this.logger.warn(
          { errorCode: error.errorCode, attempt, maxAttempts, reason: error.message },
          'Invoice attempt failed; it will be retried with backoff',
        );
      }

      if (!error.retryable) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  }
}
