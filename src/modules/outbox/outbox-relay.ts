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
  readonly type: string;
  readonly payload: unknown;
  readonly correlationId: string;
}

const MAX_ERROR_LENGTH = 1000;
const TRANSACTION_TIMEOUT_MS = 30_000;
const COMPLETED_JOB_RETENTION_SECONDS = 24 * 3600;
const FAILED_JOB_RETENTION_SECONDS = 7 * 24 * 3600;

/**
 * Publica en BullMQ los mensajes escritos en `outbox_events` (Transactional Outbox).
 *
 * Garantía: entrega at-least-once hacia la cola, con duplicados neutralizados.
 *
 *  - `FOR UPDATE SKIP LOCKED`: varias instancias del relay se reparten los eventos sin
 *    bloquearse ni publicar el mismo dos veces.
 *  - `jobId = outboxEvent.id`: si el proceso muere entre `queue.add()` y el UPDATE, el
 *    evento sigue PENDING y se republica, pero BullMQ ignora un `add` con un id existente.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
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
    this.jobAttempts = config.get('INVOICE_JOB_ATTEMPTS', { infer: true });
    this.jobBackoffMs = config.get('INVOICE_JOB_BACKOFF_MS', { infer: true });
  }

  onApplicationBootstrap(): void {
    if (this.roles.outboxRelay) {
      this.schedule(0);
    }
  }

  /** Detiene el sondeo y espera la iteración en curso, antes de que se cierren las conexiones. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.inFlight;
  }

  /**
   * Publica un lote de eventos pendientes y devuelve cuántos publicó. Es seguro invocarlo
   * en paralelo, desde este u otros procesos.
   */
  async publishPending(): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const events = await tx.$queryRaw<PendingOutboxEvent[]>`
          SELECT "id", "type", "payload", "correlation_id" AS "correlationId"
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
            // El evento queda PENDING y se reintenta en la próxima iteración.
            const message = error instanceof Error ? error.message : 'Unknown error';
            await tx.outboxEvent.update({
              where: { id: event.id },
              data: { attempts: { increment: 1 }, lastError: message.slice(0, MAX_ERROR_LENGTH) },
            });
            this.logger.error({ ...log, err: error }, 'Failed to publish outbox event');
          }
        }
        return published;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  }

  private async publish(event: PendingOutboxEvent): Promise<void> {
    if (event.type !== INVOICE_REQUESTED_EVENT) {
      throw new Error(`No publisher registered for outbox event type "${event.type}"`);
    }
    const payload = invoiceRequestedPayloadSchema.parse(event.payload);

    await this.queue.add(
      ISSUE_INVOICE_JOB,
      { ...payload, correlationId: event.correlationId },
      {
        jobId: event.id,
        attempts: this.jobAttempts,
        // Espera antes del reintento n: base * 2^(n-1). El jitter evita que los reintentos
        // de muchos jobs que fallaron juntos vuelvan a golpear al ente al mismo tiempo.
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
    // Con un lote lleno probablemente hay más pendientes: se continúa sin esperar.
    this.schedule(published >= this.batchSize ? 0 : this.pollIntervalMs);
  }
}
