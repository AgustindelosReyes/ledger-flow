import { beforeEach, describe, expect, it } from '@jest/globals';
import { InvalidMoneyError } from '../../../shared/domain/money.js';
import { InvalidJournalEntryError } from '../../ledger/domain/journal-entry.js';
import { IdempotencyPayloadMismatchError, InvalidWebhookPayloadError } from './errors.js';
import {
  IngestPaymentWebhookUseCase,
  type IngestPaymentWebhookCommand,
  type PaymentEvent,
} from './ingest-payment-webhook.use-case.js';
import {
  PaymentEventStore,
  type ApprovedPaymentRecord,
  type RecordOutcome,
  type RecordedOperation,
  type WebhookEventRecord,
} from './ports/payment-event-store.js';

/** Doble en memoria que cumple el contrato de idempotencia del puerto. */
class InMemoryPaymentEventStore extends PaymentEventStore {
  readonly calls: { event: WebhookEventRecord; payment: ApprovedPaymentRecord | null }[] = [];
  private readonly stored = new Map<string, { hash: string; operation: RecordedOperation }>();

  record(event: WebhookEventRecord, payment: ApprovedPaymentRecord | null): Promise<RecordOutcome> {
    this.calls.push({ event, payment });
    const key = `${event.provider}:${event.eventId}`;

    const existing = this.stored.get(key);
    if (existing !== undefined) {
      return Promise.resolve({
        kind: 'duplicate',
        operation: existing.operation,
        storedPayloadHash: existing.hash,
      });
    }

    const sequence = this.stored.size + 1;
    const operation: RecordedOperation = {
      webhookEventId: `event-${sequence}`,
      paymentId: payment === null ? null : `payment-${sequence}`,
      ledgerTransactionId: payment === null ? null : `ledger-${sequence}`,
      invoiceId: payment === null ? null : `invoice-${sequence}`,
    };
    this.stored.set(key, { hash: event.payloadHash, operation });
    return Promise.resolve({ kind: 'recorded', operation });
  }
}

const baseEvent: PaymentEvent = {
  eventId: 'evt_1',
  provider: 'MERCADOPAGO',
  type: 'payment.approved',
  payment: {
    externalPaymentId: 'pay_1',
    amount: '12100.00',
    currency: 'ARS',
    payerName: 'Juan Pérez',
    payerTaxId: '30111222',
    description: 'Plan Pro',
  },
};

function commandFor(
  event: PaymentEvent = baseEvent,
  rawBody = JSON.stringify(event),
): IngestPaymentWebhookCommand {
  return { event, rawBody: Buffer.from(rawBody, 'utf8'), correlationId: 'corr-1' };
}

describe('IngestPaymentWebhookUseCase', () => {
  let store: InMemoryPaymentEventStore;
  let useCase: IngestPaymentWebhookUseCase;

  beforeEach(() => {
    store = new InMemoryPaymentEventStore();
    useCase = new IngestPaymentWebhookUseCase(store, { pointOfSale: 7 });
  });

  describe('approved payment', () => {
    it('returns "accepted" with the identifiers of everything recorded', async () => {
      const result = await useCase.execute(commandFor());

      expect(result).toEqual({
        status: 'accepted',
        eventId: 'evt_1',
        webhookEventId: 'event-1',
        paymentId: 'payment-1',
        ledgerTransactionId: 'ledger-1',
        invoiceId: 'invoice-1',
      });
    });

    it('hands the store an auditable event: SHA-256 of the raw bytes, payload and correlation id', async () => {
      await useCase.execute(commandFor(baseEvent, '{"a":1}'));

      expect(store.calls[0]?.event).toEqual({
        provider: 'MERCADOPAGO',
        eventId: 'evt_1',
        eventType: 'payment.approved',
        // sha256('{"a":1}')
        payloadHash: '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
        payload: { a: 1 },
        correlationId: 'corr-1',
      });
    });

    it('builds a balanced journal entry and the invoice breakdown from the gross amount', async () => {
      await useCase.execute(commandFor());

      const payment = store.calls[0]?.payment;
      expect(payment?.amount.amount).toBe('12100.00');
      expect(
        payment?.journalEntry.lines.map(
          (line) => `${line.direction} ${line.accountCode} ${line.amount.amount}`,
        ),
      ).toEqual([
        'DEBIT GATEWAY_RECEIVABLE_MERCADOPAGO 12100.00',
        'CREDIT SALES_REVENUE 10000.00',
        'CREDIT VAT_PAYABLE 2100.00',
      ]);
      expect(payment?.invoice.type).toBe('B');
      expect(payment?.invoice.pointOfSale).toBe(7);
      expect(payment?.invoice.breakdown.net.amount).toBe('10000.00');
      expect(payment?.invoice.breakdown.tax.amount).toBe('2100.00');
    });

    it.each([
      ['a zero amount', '0.00', InvalidJournalEntryError],
      ['sub-cent precision', '10.001', InvalidMoneyError],
      ['a negative amount', '-5.00', InvalidMoneyError],
    ])('rejects %s before touching the store', async (_case, amount, expectedError) => {
      const event = { ...baseEvent, payment: { ...baseEvent.payment, amount } };

      await expect(useCase.execute(commandFor(event))).rejects.toThrow(expectedError);
      expect(store.calls).toHaveLength(0);
    });
  });

  describe('idempotency', () => {
    it('returns "duplicate" with the original identifiers when the same bytes are redelivered', async () => {
      const first = await useCase.execute(commandFor());
      const second = await useCase.execute(commandFor());

      expect(second).toEqual({ ...first, status: 'duplicate' });
    });

    it('throws a payload mismatch when the eventId is reused with a different body', async () => {
      await useCase.execute(commandFor());
      const tampered = { ...baseEvent, payment: { ...baseEvent.payment, amount: '1.00' } };

      await expect(useCase.execute(commandFor(tampered))).rejects.toThrow(
        IdempotencyPayloadMismatchError,
      );
    });

    it('compares bytes, not meaning: re-serialized JSON under the same eventId is a mismatch', async () => {
      await useCase.execute(commandFor());

      await expect(
        useCase.execute(commandFor(baseEvent, JSON.stringify(baseEvent, null, 2))),
      ).rejects.toThrow(IdempotencyPayloadMismatchError);
    });

    it('scopes the idempotency key by provider', async () => {
      await useCase.execute(commandFor());

      const result = await useCase.execute(commandFor({ ...baseEvent, provider: 'STRIPE' }));

      expect(result.status).toBe('accepted');
    });
  });

  describe('non-accounting events', () => {
    it.each(['payment.pending', 'payment.rejected'] as const)(
      'records %s for audit only and returns "ignored"',
      async (type) => {
        const result = await useCase.execute(commandFor({ ...baseEvent, type }));

        expect(result).toMatchObject({ status: 'ignored', paymentId: null, invoiceId: null });
        expect(store.calls[0]?.payment).toBeNull();
      },
    );
  });

  it.each([
    ['malformed JSON', '{"eventId": '],
    ['a JSON array', '[1,2,3]'],
    ['a JSON scalar', '"text"'],
  ])('rejects a raw body that is %s', async (_case, rawBody) => {
    await expect(useCase.execute(commandFor(baseEvent, rawBody))).rejects.toThrow(
      InvalidWebhookPayloadError,
    );
  });
});
