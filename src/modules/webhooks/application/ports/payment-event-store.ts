import type { JsonObject } from '../../../../shared/domain/json.js';
import type { Money } from '../../../../shared/domain/money.js';
import type { PaymentProvider } from '../../../../shared/domain/payment-provider.js';
import type { InvoiceType } from '../../../invoicing/domain/invoice-type.js';
import type { VatBreakdown } from '../../../invoicing/domain/vat.js';
import type { JournalEntry } from '../../../ledger/domain/journal-entry.js';

export interface WebhookEventRecord {
  readonly provider: PaymentProvider;
  readonly eventId: string;
  readonly eventType: string;
  readonly payloadHash: string;
  readonly payload: JsonObject;
  readonly correlationId: string;
}

/** Efectos contables y fiscales de un pago aprobado, ya validados por el dominio. */
export interface ApprovedPaymentRecord {
  readonly externalPaymentId: string;
  readonly amount: Money;
  readonly payerName: string | undefined;
  readonly payerTaxId: string | undefined;
  readonly description: string | undefined;
  readonly journalEntry: JournalEntry;
  readonly invoice: {
    readonly type: InvoiceType;
    readonly pointOfSale: number;
    readonly breakdown: VatBreakdown;
  };
}

export interface RecordedOperation {
  readonly webhookEventId: string;
  readonly paymentId: string | null;
  readonly ledgerTransactionId: string | null;
  readonly invoiceId: string | null;
}

export type RecordOutcome =
  | { readonly kind: 'recorded'; readonly operation: RecordedOperation }
  | {
      /** El evento ya existía; se devuelve lo registrado originalmente, sin escribir nada. */
      readonly kind: 'duplicate';
      readonly operation: RecordedOperation;
      readonly storedPayloadHash: string;
    };

/**
 * Puerto de persistencia de la ingesta. Contrato:
 *
 *  - Atomicidad: evento, pago, asiento, factura pendiente y mensaje de outbox se confirman
 *    juntos o no se confirma ninguno.
 *  - Idempotencia: ante N llamadas concurrentes con el mismo `(provider, eventId)`,
 *    exactamente una obtiene `recorded`; el resto obtiene `duplicate`.
 *  - Lanza `PaymentAlreadyRecordedError` si otro evento ya registró el mismo pago.
 */
export abstract class PaymentEventStore {
  abstract record(
    event: WebhookEventRecord,
    payment: ApprovedPaymentRecord | null,
  ): Promise<RecordOutcome>;
}
