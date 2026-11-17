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
 * Adapter between BullMQ and the issuance use case. It translates the outcome of the
 * attempt into the language of the queue:
 *
 *  - transient error   -> rethrown; BullMQ retries with exponential backoff.
 *  - permanent error   -> `UnrecoverableError`; fails for good without burning retries.
 *  - permanent failure -> the entry is also published to the Dead Letter Queue.
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
   * Graceful shutdown: stops taking jobs and waits for the ones in progress to finish. It
   * happens in the first shutdown phase, while Postgres and Redis are still available.
   */
  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }

  private handle(job: Job<IssueInvoiceJobData>): Promise<unknown> {
    const data = issueInvoiceJobDataSchema.safeParse(job.data);
    if (!data.success) {
      return Promise.reject(new UnrecoverableError('Malformed issue-invoice job payload'));
    }
    // Logging context of the job: every line emitted while it is processed, in any layer,
    // carries the correlationId of the webhook that started the operation.
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
        // Redelivery of a job whose invoice had already been given up on (the process died
        // between marking it and finishing the job): ensure the DLQ entry exists and close it.
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
