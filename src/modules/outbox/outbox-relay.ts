import { InjectQueue } from '@nestjs/bullmq';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service.js';
import { RuntimeRoles } from '../../shared/runtime/runtime-roles.js';
import {
  FISCAL_INVOICE_QUEUE,
  INVOICE_REQUESTED_EVENT,
  ISSUE_INVOICE_JOB,
  invoiceRequestedPayloadSchema,
  type IssueInvoiceJobData,
} from '../invoicing/invoice-queue.js';

interface PendingOutboxEvent {
  readonly id: string;
  readonly attempts: number;
  readonly type: string;
  readonly payload: unknown;
  readonly correlationId: string;
}

/**
 * The event cannot be published no matter how many times it is retried: its type has no
 * publisher or its payload breaks the contract. Unlike a Redis outage, it is not
 * transient.
 */
export class UnpublishableOutboxEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnpublishableOutboxEventError';
  }
}

const MAX_ERROR_LENGTH = 1000;
const TRANSACTION_TIMEOUT_MS = 30_000;
const COMPLETED_JOB_RETENTION_SECONDS = 24 * 3600;
const FAILED_JOB_RETENTION_SECONDS = 7 * 24 * 3600;

/**
 * Publishes to BullMQ the messages written to `outbox_events` (Transactional Outbox).
 *
 * Guarantee: at-least-once delivery to the queue, with duplicates neutralized.
 *
 *  - `FOR UPDATE SKIP LOCKED`: several relay instances share the events without blocking
 *    each other or publishing the same one twice.
 *  - `jobId = outboxEvent.id`: if the process dies between `queue.add()` and the UPDATE,
 *    the event stays PENDING and is republished, but BullMQ ignores an `add` whose id
 *    already exists.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly jobAttempts: number;
  private readonly jobBackoffMs: number;

  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly roles: RuntimeRoles,
    private readonly prisma: PrismaService,
    @InjectQueue(FISCAL_INVOICE_QUEUE) private readonly queue: Queue<IssueInvoiceJobData>,
  ) {
    this.pollIntervalMs = config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });
    this.maxAttempts = config.get('OUTBOX_MAX_ATTEMPTS', { infer: true });
    this.jobAttempts = config.get('INVOICE_JOB_ATTEMPTS', { infer: true });
    this.jobBackoffMs = config.get('INVOICE_JOB_BACKOFF_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (this.roles.outboxRelay) {
      this.schedule(0);
    }
  }

  /** Stops polling and waits for the iteration in progress, before connections close. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.inFlight;
  }

  /**
   * Publishes a batch of pending events and returns how many it published. It is safe to
   * call in parallel, from this process or from others.
   */
  async publishPending(): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const events = await tx.$queryRaw<PendingOutboxEvent[]>`
          SELECT "id", "type", "payload", "attempts", "correlation_id" AS "correlationId"
          FROM "outbox_events"
          WHERE "status" = 'PENDING'
          ORDER BY "created_at"
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED
        `;

        let published = 0;
        for (const event of events) {
          const log = { correlationId: event.correlationId, outboxEventId: event.id };
          try {
            await this.publish(event);
            await tx.outboxEvent.update({
              where: { id: event.id },
              data: { status: 'PUBLISHED', publishedAt: new Date(), attempts: { increment: 1 } },
            });
            published += 1;
            this.logger.log({ ...log, type: event.type }, 'Outbox event published to the queue');
          } catch (error) {
            const attempts = event.attempts + 1;
            // Poison-pill protection: an unpublishable event must not stay in an infinite
            // loop or clog the batch. Only this kind of error exhausts attempts; an
            // infrastructure failure leaves the event PENDING so valid messages are not lost.
            const failed =
              error instanceof UnpublishableOutboxEventError && attempts >= this.maxAttempts;
            const message = error instanceof Error ? error.message : 'Unknown error';

            await tx.outboxEvent.update({
              where: { id: event.id },
              data: {
                attempts,
                lastError: message.slice(0, MAX_ERROR_LENGTH),
                ...(failed ? { status: 'FAILED' } : {}),
              },
            });
            this.logger.error(
              { ...log, type: event.type, attempts, maxAttempts: this.maxAttempts, err: error },
              failed
                ? 'Outbox event marked as FAILED: it cannot be published'
                : 'Failed to publish outbox event; it will be retried',
            );
          }
        }
        return published;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  private async publish(event: PendingOutboxEvent): Promise<void> {
    if (event.type !== INVOICE_REQUESTED_EVENT) {
      throw new UnpublishableOutboxEventError(
        `No publisher registered for outbox event type "${event.type}"`,
      );
    }
    const parsed = invoiceRequestedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      throw new UnpublishableOutboxEventError(
        `Invalid payload for outbox event type "${event.type}": ${parsed.error.message}`,
      );
    }
    const payload = parsed.data;

    await this.queue.add(
      ISSUE_INVOICE_JOB,
      { ...payload, correlationId: event.correlationId },
      {
        jobId: event.id,
        attempts: this.jobAttempts,
        // Delay before retry n: base * 2^(n-1). Jitter keeps the retries of many jobs
        // that failed together from hitting the authority again at the same time.
        backoff: { type: 'exponential', delay: this.jobBackoffMs, jitter: 0.2 },
        removeOnComplete: { age: COMPLETED_JOB_RETENTION_SECONDS },
        removeOnFail: { age: FAILED_JOB_RETENTION_SECONDS },
      },
    );
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let published = 0;
    try {
      published = await this.publishPending();
    } catch (error) {
      this.logger.error({ err: error }, 'Outbox relay iteration failed');
    }
    // A full batch probably means more are pending: continue without waiting.
    this.schedule(published >= this.batchSize ? 0 : this.pollIntervalMs);
  }
}
