import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { DomainError } from '../../shared/domain/domain-error.js';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service.js';
import { DeadLetterStore } from '../invoicing/application/ports/dead-letter-store.js';
import { FISCAL_INVOICE_QUEUE } from '../invoicing/invoice-queue.js';
import type { OperationTraceDto, TraceQueueDto, TraceQueueJobDto } from './operation-trace.dto.js';

export class OperationNotFoundError extends DomainError {
  readonly code = 'OPERATION_NOT_FOUND';

  constructor(paymentId: string) {
    super(`No operation found for payment "${paymentId}"`);
  }
}

/**
 * Reconstruye la traza completa de una operación combinando sus dos fuentes: PostgreSQL
 * (evento, pago, asientos, factura, intentos, outbox) y Redis (estado vivo de los jobs).
 */
@Injectable()
export class OperationTraceQuery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deadLetters: DeadLetterStore,
    @InjectQueue(FISCAL_INVOICE_QUEUE) private readonly queue: Queue,
  ) {}

  async execute(paymentId: string): Promise<OperationTraceDto> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        webhookEvent: true,
        ledgerTransactions: {
          orderBy: { postedAt: 'asc' },
          include: {
            entries: { orderBy: { id: 'asc' }, include: { account: { select: { code: true } } } },
          },
        },
        invoice: { include: { attempts: { orderBy: { attemptNumber: 'asc' } } } },
      },
    });
    if (payment === null) {
      throw new OperationNotFoundError(paymentId);
    }
    const { webhookEvent, invoice } = payment;

    return {
      correlationId: webhookEvent.correlationId,
      webhookEvent: {
        id: webhookEvent.id,
        provider: webhookEvent.provider,
        eventId: webhookEvent.eventId,
        eventType: webhookEvent.eventType,
        status: webhookEvent.status,
        receivedAt: webhookEvent.receivedAt.toISOString(),
      },
      payment: {
        id: payment.id,
        externalPaymentId: payment.externalPaymentId,
        status: payment.status,
        amount: payment.amount.toFixed(2),
        currency: payment.currency,
        createdAt: payment.createdAt.toISOString(),
      },
      ledgerTransactions: payment.ledgerTransactions.map((transaction) => ({
        id: transaction.id,
        type: transaction.type,
        description: transaction.description,
        postedAt: transaction.postedAt.toISOString(),
        entries: transaction.entries.map((entry) => ({
          accountCode: entry.account.code,
          direction: entry.direction,
          amount: entry.amount.toFixed(2),
          currency: entry.currency,
        })),
      })),
      invoice:
        invoice === null
          ? null
          : {
              id: invoice.id,
              status: invoice.status,
              type: invoice.type,
              pointOfSale: invoice.pointOfSale,
              number: invoice.number,
              cae: invoice.cae,
              caeExpiresAt: invoice.caeExpiresAt?.toISOString().slice(0, 10) ?? null,
              netAmount: invoice.netAmount.toFixed(2),
              taxAmount: invoice.taxAmount.toFixed(2),
              totalAmount: invoice.totalAmount.toFixed(2),
              currency: invoice.currency,
              attemptCount: invoice.attemptCount,
              lastError: invoice.lastError,
              issuedAt: invoice.issuedAt?.toISOString() ?? null,
              attempts: invoice.attempts.map((attempt) => ({
                attemptNumber: attempt.attemptNumber,
                jobId: attempt.jobId,
                outcome: attempt.outcome,
                httpStatus: attempt.httpStatus,
                errorCode: attempt.errorCode,
                errorMessage: attempt.errorMessage,
                response: attempt.response,
                durationMs: attempt.durationMs,
                createdAt: attempt.createdAt.toISOString(),
              })),
            },
      queue: invoice === null ? { jobs: [], deadLetter: null } : await this.queueState(invoice.id),
    };
  }

  private async queueState(invoiceId: string): Promise<TraceQueueDto> {
    const [outboxEvents, deadLetter] = await Promise.all([
      this.prisma.outboxEvent.findMany({
        where: { aggregateId: invoiceId },
        orderBy: { createdAt: 'asc' },
      }),
      this.deadLetters.get(invoiceId),
    ]);

    const jobs = await Promise.all(
      outboxEvents.map(async (event): Promise<TraceQueueJobDto> => {
        // El relay publica cada mensaje de outbox con `jobId = outboxEvent.id`.
        const job = await this.queue.getJob(event.id);
        return {
          outboxEventId: event.id,
          outboxStatus: event.status,
          requestedAt: event.createdAt.toISOString(),
          publishedAt: event.publishedAt?.toISOString() ?? null,
          jobState: job === undefined ? null : await job.getState(),
          attemptsMade: job?.attemptsMade ?? null,
          failedReason: job?.failedReason ?? null,
        };
      }),
    );

    return {
      jobs,
      deadLetter:
        deadLetter === null
          ? null
          : {
              errorCode: deadLetter.errorCode,
              reason: deadLetter.reason,
              deadLetteredAt: deadLetter.deadLetteredAt,
            },
    };
  }
}
