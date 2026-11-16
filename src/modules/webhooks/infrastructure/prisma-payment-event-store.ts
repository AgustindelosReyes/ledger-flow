import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service.js';
import { INVOICE_REQUESTED_EVENT } from '../../invoicing/invoice-queue.js';
import { PaymentAlreadyRecordedError } from '../application/errors.js';
import {
  type ApprovedPaymentRecord,
  PaymentEventStore,
  type RecordOutcome,
  type WebhookEventRecord,
} from '../application/ports/payment-event-store.js';

const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class PrismaPaymentEventStore extends PaymentEventStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async record(
    event: WebhookEventRecord,
    payment: ApprovedPaymentRecord | null,
  ): Promise<RecordOutcome> {
    try {
      return await this.prisma.$transaction((tx) => this.recordInTransaction(tx, event, payment));
    } catch (error) {
      if (payment !== null && (await this.isPaymentConflict(error, event, payment))) {
        throw new PaymentAlreadyRecordedError(event.provider, payment.externalPaymentId);
      }
      throw error;
    }
  }

  private async recordInTransaction(
    tx: Prisma.TransactionClient,
    event: WebhookEventRecord,
    payment: ApprovedPaymentRecord | null,
  ): Promise<RecordOutcome> {
    // Punto de serialización de la idempotencia: `INSERT ... ON CONFLICT DO NOTHING` sobre
    // UNIQUE(provider, event_id). Si otra transacción ya insertó la misma clave y aún no
    // confirmó, este INSERT se bloquea hasta que termine: si confirma, aquí no se inserta
    // nada (duplicado); si aborta, este INSERT gana. No hay ventana check-then-act.
    const [insertedEvent] = await tx.webhookEvent.createManyAndReturn({
      data: [
        {
          provider: event.provider,
          eventId: event.eventId,
          eventType: event.eventType,
          payloadHash: event.payloadHash,
          payload: event.payload,
          status: payment === null ? 'IGNORED' : 'PROCESSED',
          correlationId: event.correlationId,
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });

    if (insertedEvent === undefined) {
      return this.loadDuplicate(tx, event);
    }
    if (payment === null) {
      return {
        kind: 'recorded',
        operation: {
          webhookEventId: insertedEvent.id,
          paymentId: null,
          ledgerTransactionId: null,
          invoiceId: null,
        },
      };
    }

    const { journalEntry, invoice } = payment;
    const accountIds = await this.resolveAccountIds(
      tx,
      journalEntry.lines.map((line) => line.accountCode),
    );

    const createdPayment = await tx.payment.create({
      data: {
        webhookEventId: insertedEvent.id,
        provider: event.provider,
        externalPaymentId: payment.externalPaymentId,
        status: 'APPROVED',
        amount: payment.amount.amount,
        currency: payment.amount.currency,
        payerName: payment.payerName ?? null,
        payerTaxId: payment.payerTaxId ?? null,
        description: payment.description ?? null,
      },
      select: { id: true },
    });

    const ledgerTransaction = await tx.ledgerTransaction.create({
      data: {
        paymentId: createdPayment.id,
        type: journalEntry.type,
        description: journalEntry.description,
        correlationId: event.correlationId,
        entries: {
          createMany: {
            data: journalEntry.lines.map((line) => ({
              accountId: accountIds(line.accountCode),
              direction: line.direction,
              amount: line.amount.amount,
              currency: line.amount.currency,
            })),
          },
        },
      },
      select: { id: true },
    });

    const createdInvoice = await tx.invoice.create({
      data: {
        paymentId: createdPayment.id,
        status: 'PENDING',
        type: invoice.type,
        pointOfSale: invoice.pointOfSale,
        netAmount: invoice.breakdown.net.amount,
        taxAmount: invoice.breakdown.tax.amount,
        totalAmount: invoice.breakdown.total.amount,
        currency: invoice.breakdown.total.currency,
        correlationId: event.correlationId,
      },
      select: { id: true },
    });

    // Outbox: la intención de encolar el job fiscal se confirma junto con el pago. El relay
    // la publica después en BullMQ.
    await tx.outboxEvent.create({
      data: {
        type: INVOICE_REQUESTED_EVENT,
        aggregateId: createdInvoice.id,
        payload: { invoiceId: createdInvoice.id, paymentId: createdPayment.id },
        correlationId: event.correlationId,
      },
    });

    return {
      kind: 'recorded',
      operation: {
        webhookEventId: insertedEvent.id,
        paymentId: createdPayment.id,
        ledgerTransactionId: ledgerTransaction.id,
        invoiceId: createdInvoice.id,
      },
    };
  }

  private async loadDuplicate(
    tx: Prisma.TransactionClient,
    event: WebhookEventRecord,
  ): Promise<RecordOutcome> {
    const existing = await tx.webhookEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: event.provider, eventId: event.eventId } },
      select: {
        id: true,
        payloadHash: true,
        payment: {
          select: {
            id: true,
            invoice: { select: { id: true } },
            ledgerTransactions: { where: { type: 'PAYMENT_CAPTURE' }, select: { id: true } },
          },
        },
      },
    });

    return {
      kind: 'duplicate',
      storedPayloadHash: existing.payloadHash,
      operation: {
        webhookEventId: existing.id,
        paymentId: existing.payment?.id ?? null,
        ledgerTransactionId: existing.payment?.ledgerTransactions[0]?.id ?? null,
        invoiceId: existing.payment?.invoice?.id ?? null,
      },
    };
  }

  private async resolveAccountIds(
    tx: Prisma.TransactionClient,
    codes: readonly string[],
  ): Promise<(code: string) => string> {
    const accounts = await tx.ledgerAccount.findMany({
      where: { code: { in: [...new Set(codes)] } },
      select: { id: true, code: true },
    });
    const idByCode = new Map(accounts.map((account) => [account.code, account.id]));

    return (code) => {
      const id = idByCode.get(code);
      if (id === undefined) {
        throw new Error(`Ledger account "${code}" is missing from the chart of accounts`);
      }
      return id;
    };
  }

  /**
   * Tras una violación de unicidad, la transacción ya hizo rollback. El evento no pudo
   * causarla (usa ON CONFLICT), así que se verifica si fue UNIQUE(provider,
   * external_payment_id): otro evento registró antes el mismo pago.
   */
  private async isPaymentConflict(
    error: unknown,
    event: WebhookEventRecord,
    payment: ApprovedPaymentRecord,
  ): Promise<boolean> {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== UNIQUE_VIOLATION
    ) {
      return false;
    }
    const existing = await this.prisma.payment.findUnique({
      where: {
        provider_externalPaymentId: {
          provider: event.provider,
          externalPaymentId: payment.externalPaymentId,
        },
      },
      select: { id: true },
    });
    return existing !== null;
  }
}
