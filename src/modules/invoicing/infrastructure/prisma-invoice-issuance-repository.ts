import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service.js';
import type { FiscalAuthorization } from '../application/ports/fiscal-authority.js';
import {
  InvoiceIssuanceRepository,
  type AppliedCorrection,
  type AttemptRecord,
  type FiscalDataCorrection,
  type InvoiceSnapshot,
  type RequeueOutcome,
} from '../application/ports/invoice-issuance-repository.js';
import { INVOICE_REQUESTED_EVENT } from '../invoice-queue.js';

const MAX_ERROR_LENGTH = 1000;

@Injectable()
export class PrismaInvoiceIssuanceRepository extends InvoiceIssuanceRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async find(invoiceId: string): Promise<InvoiceSnapshot | null> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { payment: { select: { payerTaxId: true } } },
    });
    if (invoice === null) {
      return null;
    }
    return {
      id: invoice.id,
      paymentId: invoice.paymentId,
      status: invoice.status,
      version: invoice.version,
      attemptCount: invoice.attemptCount,
      type: invoice.type,
      pointOfSale: invoice.pointOfSale,
      netAmount: invoice.netAmount.toFixed(2),
      taxAmount: invoice.taxAmount.toFixed(2),
      totalAmount: invoice.totalAmount.toFixed(2),
      currency: invoice.currency,
      payerTaxId: invoice.payment.payerTaxId,
      correlationId: invoice.correlationId,
    };
  }

  async claim(invoice: InvoiceSnapshot): Promise<InvoiceSnapshot | null> {
    // Optimistic locking: the UPDATE only applies if nobody changed the row since it was read.
    // PROCESSING can also be claimed: it is the state an invoice is left in when the process
    // holding it died, and BullMQ redelivers that job ("stalled").
    const { count } = await this.prisma.invoice.updateMany({
      where: {
        id: invoice.id,
        version: invoice.version,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
      data: {
        status: 'PROCESSING',
        version: { increment: 1 },
        attemptCount: { increment: 1 },
      },
    });
    if (count === 0) {
      return null;
    }
    return {
      ...invoice,
      status: 'PROCESSING',
      version: invoice.version + 1,
      attemptCount: invoice.attemptCount + 1,
    };
  }

  recordSuccess(
    claimed: InvoiceSnapshot,
    attempt: AttemptRecord,
    authorization: FiscalAuthorization,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.invoiceAttempt.create({
        data: { ...this.attemptData(claimed, attempt), outcome: 'SUCCEEDED' },
      });
      const { count } = await tx.invoice.updateMany({
        where: { id: claimed.id, version: claimed.version },
        data: {
          status: 'ISSUED',
          number: authorization.number,
          cae: authorization.cae,
          caeExpiresAt: new Date(`${authorization.caeExpiresAt}T00:00:00.000Z`),
          issuedAt: new Date(),
          lastError: null,
          version: { increment: 1 },
        },
      });
      // If the race was lost, the attempt still stays in the log.
      return count === 1;
    });
  }

  recordFailure(
    claimed: InvoiceSnapshot,
    attempt: AttemptRecord,
    params: { readonly retryable: boolean; readonly nextStatus: 'PENDING' | 'DEAD_LETTERED' },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.invoiceAttempt.create({
        data: {
          ...this.attemptData(claimed, attempt),
          outcome: params.retryable ? 'RETRYABLE_FAILURE' : 'PERMANENT_FAILURE',
        },
      });
      const { count } = await tx.invoice.updateMany({
        where: { id: claimed.id, version: claimed.version },
        data: {
          status: params.nextStatus,
          lastError: attempt.errorMessage?.slice(0, MAX_ERROR_LENGTH) ?? null,
          version: { increment: 1 },
        },
      });
      return count === 1;
    });
  }

  requeueDeadLettered(
    invoiceId: string,
    correction?: FiscalDataCorrection,
  ): Promise<RequeueOutcome> {
    return this.prisma.$transaction(async (tx): Promise<RequeueOutcome> => {
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: {
          id: true,
          paymentId: true,
          status: true,
          version: true,
          correlationId: true,
          payment: { select: { payerTaxId: true } },
        },
      });
      if (invoice === null) {
        return { kind: 'not_found' };
      }
      if (invoice.status !== 'DEAD_LETTERED') {
        return { kind: 'not_dead_lettered', status: invoice.status };
      }

      const { count } = await tx.invoice.updateMany({
        where: { id: invoice.id, status: 'DEAD_LETTERED', version: invoice.version },
        data: {
          status: 'PENDING',
          version: { increment: 1 },
          ...(correction === undefined ? {} : { type: correction.invoiceType }),
        },
      });
      if (count === 0) {
        // Another requeue request won the race between the read and the UPDATE.
        return { kind: 'not_dead_lettered', status: 'PENDING' };
      }

      let applied: AppliedCorrection | null = null;
      if (correction !== undefined) {
        // The payment is the projection the worker reads; the original webhook payload stays
        // untouched in `webhook_events` as evidence of what the gateway sent.
        await tx.payment.update({
          where: { id: invoice.paymentId },
          data: { payerTaxId: correction.payerTaxId },
        });
        await tx.invoiceCorrection.create({
          data: {
            invoiceId: invoice.id,
            field: 'payerTaxId',
            previousValue: invoice.payment.payerTaxId,
            newValue: correction.payerTaxId,
            reason: correction.reason ?? null,
            correlationId: correction.requestCorrelationId,
          },
        });
        applied = {
          field: 'payerTaxId',
          previousValue: invoice.payment.payerTaxId,
          newValue: correction.payerTaxId,
          invoiceType: correction.invoiceType,
        };
      }

      const outboxEvent = await tx.outboxEvent.create({
        data: {
          type: INVOICE_REQUESTED_EVENT,
          aggregateId: invoice.id,
          payload: { invoiceId: invoice.id, paymentId: invoice.paymentId },
          correlationId: invoice.correlationId,
        },
        select: { id: true },
      });
      return {
        kind: 'requeued',
        outboxEventId: outboxEvent.id,
        correlationId: invoice.correlationId,
        correction: applied,
      };
    });
  }

  private attemptData(
    claimed: InvoiceSnapshot,
    attempt: AttemptRecord,
  ): {
    invoiceId: string;
    jobId: string;
    attemptNumber: number;
    durationMs: number;
    httpStatus: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    response?: NonNullable<AttemptRecord['response']>;
  } {
    return {
      invoiceId: claimed.id,
      jobId: attempt.jobId,
      // Numbering owned by the invoice: it keeps growing across manual requeues.
      attemptNumber: claimed.attemptCount,
      durationMs: attempt.durationMs,
      httpStatus: attempt.httpStatus,
      errorCode: attempt.errorCode,
      errorMessage: attempt.errorMessage?.slice(0, MAX_ERROR_LENGTH) ?? null,
      ...(attempt.response === null ? {} : { response: attempt.response }),
    };
  }
}
