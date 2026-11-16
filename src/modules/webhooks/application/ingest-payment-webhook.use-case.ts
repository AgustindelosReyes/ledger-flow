import { createHash } from 'node:crypto';
import { isJsonObject, type JsonObject } from '../../../shared/domain/json.js';
import { Money } from '../../../shared/domain/money.js';
import type { PaymentProvider } from '../../../shared/domain/payment-provider.js';
import { resolveInvoiceType } from '../../invoicing/domain/invoice-type.js';
import { splitVatInclusive } from '../../invoicing/domain/vat.js';
import { buildPaymentCaptureEntry } from '../../ledger/domain/payment-capture-posting.js';
import { IdempotencyPayloadMismatchError, InvalidWebhookPayloadError } from './errors.js';
import type {
  ApprovedPaymentRecord,
  PaymentEventStore,
  RecordedOperation,
} from './ports/payment-event-store.js';

export const PAYMENT_EVENT_TYPES = [
  'payment.approved',
  'payment.pending',
  'payment.rejected',
] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export interface PaymentEvent {
  readonly eventId: string;
  readonly provider: PaymentProvider;
  readonly type: PaymentEventType;
  readonly payment: {
    readonly externalPaymentId: string;
    readonly amount: string;
    readonly currency: string;
    readonly payerName: string | undefined;
    readonly payerTaxId: string | undefined;
    readonly description: string | undefined;
  };
}

export interface IngestPaymentWebhookCommand {
  /** Bytes exactos del request: de aquí salen el hash de idempotencia y el payload auditado. */
  readonly rawBody: Buffer;
  readonly correlationId: string;
  readonly event: PaymentEvent;
}

export type IngestStatus =
  /** Primera recepción: pago contabilizado y factura solicitada. */
  | 'accepted'
  /** Reentrega de un evento ya registrado: sin efectos. */
  | 'duplicate'
  /** Evento válido sin efecto contable; se registra solo para auditoría. */
  | 'ignored';

export interface IngestPaymentWebhookResult extends RecordedOperation {
  readonly status: IngestStatus;
  readonly eventId: string;
}

export interface InvoicingSettings {
  readonly pointOfSale: number;
}

export class IngestPaymentWebhookUseCase {
  constructor(
    private readonly store: PaymentEventStore,
    private readonly settings: InvoicingSettings,
  ) {}

  async execute(command: IngestPaymentWebhookCommand): Promise<IngestPaymentWebhookResult> {
    const { event, rawBody, correlationId } = command;
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');

    // Todas las reglas de negocio se evalúan antes de abrir la transacción: el dominio
    // rechaza importes o asientos inválidos sin haber tocado la base.
    const payment = event.type === 'payment.approved' ? this.buildApprovedPayment(event) : null;

    const outcome = await this.store.record(
      {
        provider: event.provider,
        eventId: event.eventId,
        eventType: event.type,
        payloadHash,
        payload: parsePayload(rawBody),
        correlationId,
      },
      payment,
    );

    if (outcome.kind === 'duplicate') {
      if (outcome.storedPayloadHash !== payloadHash) {
        throw new IdempotencyPayloadMismatchError(event.provider, event.eventId);
      }
      return { status: 'duplicate', eventId: event.eventId, ...outcome.operation };
    }

    return {
      status: payment === null ? 'ignored' : 'accepted',
      eventId: event.eventId,
      ...outcome.operation,
    };
  }

  private buildApprovedPayment(event: PaymentEvent): ApprovedPaymentRecord {
    const { payment, provider } = event;
    const breakdown = splitVatInclusive(Money.of(payment.amount, payment.currency));

    return {
      externalPaymentId: payment.externalPaymentId,
      amount: breakdown.total,
      payerName: payment.payerName,
      payerTaxId: payment.payerTaxId,
      description: payment.description,
      journalEntry: buildPaymentCaptureEntry({
        provider,
        externalPaymentId: payment.externalPaymentId,
        breakdown,
      }),
      invoice: {
        type: resolveInvoiceType(payment.payerTaxId),
        pointOfSale: this.settings.pointOfSale,
        breakdown,
      },
    };
  }
}

function parsePayload(rawBody: Buffer): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new InvalidWebhookPayloadError('Webhook body is not valid JSON');
  }
  if (!isJsonObject(parsed)) {
    throw new InvalidWebhookPayloadError('Webhook body must be a JSON object');
  }
  return parsed;
}
