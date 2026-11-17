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

/** Accounting and fiscal effects of an approved payment, already validated by the domain. */
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
      /** The event already existed; what was originally recorded is returned, nothing written. */
      readonly kind: 'duplicate';
      readonly operation: RecordedOperation;
      readonly storedPayloadHash: string;
    };

/**
 * Persistence port of the ingestion. Contract:
 *
 *  - Atomicity: event, payment, journal entry, pending invoice and outbox message are
 *    committed together, or none of them is.
 *  - Idempotency: given N concurrent calls with the same `(provider, eventId)`, exactly
 *    one gets `recorded`; the rest get `duplicate`.
 *  - Throws `PaymentAlreadyRecordedError` if another event already recorded the payment.
 */
export abstract class PaymentEventStore {
  abstract record(
    event: WebhookEventRecord,
    payment: ApprovedPaymentRecord | null,
  ): Promise<RecordOutcome>;
}
