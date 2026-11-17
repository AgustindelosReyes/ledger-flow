import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { acceptedAckOf, ackOf, balancesOf, problemOf } from './support/responses.js';
import { buildPaymentEvent, createTestApp, type TestApp } from './support/test-app.js';

const PROBLEM_JSON = /application\/problem\+json/;

describe('POST /webhooks/payments (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  /** Counts everything an event could have written, across the six transaction tables. */
  async function countRecords(eventId: string, paymentId: string): Promise<Record<string, number>> {
    const payment = { externalPaymentId: paymentId };
    const [events, payments, ledgerTransactions, ledgerEntries, invoices, outboxEvents] =
      await Promise.all([
        t.prisma.webhookEvent.count({ where: { eventId } }),
        t.prisma.payment.count({ where: payment }),
        t.prisma.ledgerTransaction.count({ where: { payment } }),
        t.prisma.ledgerEntry.count({ where: { transaction: { payment } } }),
        t.prisma.invoice.count({ where: { payment } }),
        t.prisma.outboxEvent.count({
          where: { aggregateId: { in: await invoiceIdsOf(paymentId) } },
        }),
      ]);
    return { events, payments, ledgerTransactions, ledgerEntries, invoices, outboxEvents };
  }

  async function invoiceIdsOf(paymentId: string): Promise<string[]> {
    const invoices = await t.prisma.invoice.findMany({
      where: { payment: { externalPaymentId: paymentId } },
      select: { id: true },
    });
    return invoices.map((invoice) => invoice.id);
  }

  const ONE_OF_EACH = {
    events: 1,
    payments: 1,
    ledgerTransactions: 1,
    ledgerEntries: 3,
    invoices: 1,
    outboxEvents: 1,
  };

  describe('approved payment', () => {
    it('records event, payment, balanced ledger entry, pending invoice and outbox message', async () => {
      const event = buildPaymentEvent();
      const correlationId = 'e2e-correlation-0001';

      const response = await t.sendWebhook(JSON.stringify(event), { correlationId }).expect(202);

      expect(response.headers['x-correlation-id']).toBe(correlationId);
      const ack = acceptedAckOf(response);
      expect(ack).toMatchObject({
        status: 'accepted',
        eventId: event.eventId,
        correlationId,
      });

      const stored = await t.prisma.webhookEvent.findFirstOrThrow({
        where: { eventId: event.eventId },
        include: {
          payment: {
            include: {
              invoice: true,
              ledgerTransactions: { include: { entries: { include: { account: true } } } },
            },
          },
        },
      });

      expect(stored.status).toBe('PROCESSED');
      expect(stored.correlationId).toBe(correlationId);
      expect(stored.payload).toEqual(event);

      const payment = stored.payment;
      expect(payment?.id).toBe(ack.paymentId);
      expect(payment?.amount.toFixed(2)).toBe('12100.00');

      const [ledgerTransaction] = payment?.ledgerTransactions ?? [];
      expect(ledgerTransaction?.id).toBe(ack.ledgerTransactionId);
      expect(ledgerTransaction?.type).toBe('PAYMENT_CAPTURE');
      expect(ledgerTransaction?.correlationId).toBe(correlationId);

      const lines = (ledgerTransaction?.entries ?? [])
        .map((entry) => `${entry.direction} ${entry.account.code} ${entry.amount.toFixed(2)}`)
        .sort();
      expect(lines).toEqual([
        'CREDIT SALES_REVENUE 10000.00',
        'CREDIT VAT_PAYABLE 2100.00',
        'DEBIT GATEWAY_RECEIVABLE_MERCADOPAGO 12100.00',
      ]);

      expect(payment?.invoice).toMatchObject({
        id: ack.invoiceId,
        status: 'PENDING',
        type: 'B',
        currency: 'ARS',
        cae: null,
        number: null,
      });
      expect(payment?.invoice?.netAmount.toFixed(2)).toBe('10000.00');
      expect(payment?.invoice?.taxAmount.toFixed(2)).toBe('2100.00');
      expect(payment?.invoice?.totalAmount.toFixed(2)).toBe('12100.00');

      const outbox = await t.prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: ack.invoiceId },
      });
      expect(outbox).toMatchObject({
        type: 'invoice.requested',
        status: 'PENDING',
        correlationId,
        payload: { invoiceId: ack.invoiceId, paymentId: ack.paymentId },
      });
    });

    it('issues a type A invoice when the payer is identified by CUIT', async () => {
      const event = buildPaymentEvent();
      event.data.payer = { name: 'ACME SA', taxId: '30712345678' };

      const response = await t.sendWebhook(JSON.stringify(event)).expect(202);

      const invoice = await t.prisma.invoice.findUniqueOrThrow({
        where: { id: acceptedAckOf(response).invoiceId },
      });
      expect(invoice.type).toBe('A');
    });
  });

  describe('idempotency', () => {
    it('processes exactly once when the same event arrives 5 times concurrently', async () => {
      const event = buildPaymentEvent();
      const rawBody = JSON.stringify(event);

      const responses = await Promise.all(Array.from({ length: 5 }, () => t.sendWebhook(rawBody)));

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 202]);

      const acks = responses.map(ackOf);
      const outcomes = acks.map((ack) => ack.status).sort();
      expect(outcomes).toEqual(['accepted', 'duplicate', 'duplicate', 'duplicate', 'duplicate']);

      // All five responses reference the same operation.
      const paymentIds = new Set(acks.map((ack) => ack.paymentId));
      const invoiceIds = new Set(acks.map((ack) => ack.invoiceId));
      expect(paymentIds.size).toBe(1);
      expect(invoiceIds.size).toBe(1);

      expect(await countRecords(event.eventId, event.data.paymentId)).toEqual(ONE_OF_EACH);
    });

    it('survives concurrent bursts of several distinct events without cross-talk', async () => {
      const events = Array.from({ length: 4 }, () => buildPaymentEvent());

      const responses = await Promise.all(
        events.flatMap((event) => {
          const rawBody = JSON.stringify(event);
          return Array.from({ length: 5 }, () => t.sendWebhook(rawBody));
        }),
      );

      expect(responses.filter((response) => response.status === 202)).toHaveLength(4);
      expect(responses.filter((response) => response.status === 200)).toHaveLength(16);
      for (const event of events) {
        expect(await countRecords(event.eventId, event.data.paymentId)).toEqual(ONE_OF_EACH);
      }
    });

    it('returns 200 with the original identifiers on a later redelivery', async () => {
      const event = buildPaymentEvent();
      const rawBody = JSON.stringify(event);

      const first = await t.sendWebhook(rawBody).expect(202);
      const second = await t.sendWebhook(rawBody).expect(200);

      expect(ackOf(second)).toEqual({
        ...acceptedAckOf(first),
        status: 'duplicate',
        correlationId: ackOf(second).correlationId,
      });
      expect(await countRecords(event.eventId, event.data.paymentId)).toEqual(ONE_OF_EACH);
    });

    it('rejects with 422 a known eventId that carries a different payload', async () => {
      const event = buildPaymentEvent();
      await t.sendWebhook(JSON.stringify(event)).expect(202);

      const tampered = { ...event, data: { ...event.data, amount: '99999.00' } };
      const response = await t
        .sendWebhook(JSON.stringify(tampered))
        .expect(422)
        .expect('content-type', PROBLEM_JSON);

      const problem = problemOf(response);
      expect(problem).toMatchObject({
        type: '/problems/idempotency-payload-mismatch',
        title: 'Idempotency key reused with a different payload',
        status: 422,
        instance: '/webhooks/payments',
      });
      expect(problem.detail).toContain(event.eventId);
      expect(problem.correlationId).toBe(response.headers['x-correlation-id']);

      // The original event is untouched and nothing was duplicated.
      expect(await countRecords(event.eventId, event.data.paymentId)).toEqual(ONE_OF_EACH);
      const payment = await t.prisma.payment.findFirstOrThrow({
        where: { externalPaymentId: event.data.paymentId },
      });
      expect(payment.amount.toFixed(2)).toBe('12100.00');
    });

    it('treats a byte-level difference (whitespace) under the same eventId as a mismatch', async () => {
      const event = buildPaymentEvent();
      await t.sendWebhook(JSON.stringify(event)).expect(202);

      await t.sendWebhook(JSON.stringify(event, null, 2)).expect(422);
    });

    it('rejects with 409 a different event that reports an already recorded payment', async () => {
      const original = buildPaymentEvent();
      await t.sendWebhook(JSON.stringify(original)).expect(202);

      const other = buildPaymentEvent();
      other.data.paymentId = original.data.paymentId;
      const response = await t
        .sendWebhook(JSON.stringify(other))
        .expect(409)
        .expect('content-type', PROBLEM_JSON);

      expect(problemOf(response).type).toBe('/problems/payment-already-recorded');
      // Atomicity: the rollback also discards the event that had been inserted first.
      expect(await t.prisma.webhookEvent.count({ where: { eventId: other.eventId } })).toBe(0);
      expect(await countRecords(original.eventId, original.data.paymentId)).toEqual(ONE_OF_EACH);
    });
  });

  describe('non-accounting events', () => {
    it('stores the event as IGNORED without ledger effects', async () => {
      const event = buildPaymentEvent({ type: 'payment.pending' });

      const response = await t.sendWebhook(JSON.stringify(event)).expect(200);

      expect(ackOf(response)).toMatchObject({
        status: 'ignored',
        paymentId: null,
        invoiceId: null,
      });
      const stored = await t.prisma.webhookEvent.findFirstOrThrow({
        where: { eventId: event.eventId },
      });
      expect(stored.status).toBe('IGNORED');
      expect(await countRecords(event.eventId, event.data.paymentId)).toEqual({
        events: 1,
        payments: 0,
        ledgerTransactions: 0,
        ledgerEntries: 0,
        invoices: 0,
        outboxEvents: 0,
      });
    });
  });

  describe('signature verification', () => {
    it('verifies the HMAC against the raw bytes, not a re-serialization of the JSON', async () => {
      const event = buildPaymentEvent();
      // Keys in a different order and irregular spacing: JSON.stringify(req.body) would not
      // reproduce these bytes, so only verifying against the rawBody can accept it.
      const rawBody = `{ "data" : ${JSON.stringify(event.data, null, 4)},\n\t"type":"${event.type}",   "provider": "${event.provider}", "eventId":"${event.eventId}" }`;

      await t.sendWebhook(rawBody).expect(202);
    });

    it('rejects a signature computed over semantically equal but different bytes', async () => {
      const event = buildPaymentEvent();
      const signature = t.sign(JSON.stringify(event));

      const response = await t
        .sendWebhook(JSON.stringify(event, null, 2), { signature })
        .expect(401)
        .expect('content-type', PROBLEM_JSON);

      expect(problemOf(response).type).toBe('/problems/invalid-webhook-signature');
      expect(await t.prisma.webhookEvent.count({ where: { eventId: event.eventId } })).toBe(0);
    });

    it.each([
      ['missing header', null],
      ['malformed header', 'not-a-signature'],
      ['wrong digest', `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`],
      ['digest of the wrong length', `t=${Math.floor(Date.now() / 1000)},v1=abcdef`],
    ])('rejects with 401: %s', async (_case, signature) => {
      const event = buildPaymentEvent();

      await t.sendWebhook(JSON.stringify(event), { signature }).expect(401);

      expect(await t.prisma.webhookEvent.count({ where: { eventId: event.eventId } })).toBe(0);
    });

    it('rejects a correctly signed request whose timestamp is outside the tolerance window', async () => {
      const event = buildPaymentEvent();
      const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

      await t.sendWebhook(JSON.stringify(event), { timestampSeconds: oneHourAgo }).expect(401);
    });

    it('authenticates before validating: an unsigned invalid body gets 401, not 400', async () => {
      await t.sendWebhook(JSON.stringify({ nonsense: true }), { signature: null }).expect(401);
    });
  });

  describe('payload validation', () => {
    it('rejects a numeric amount with a 400 problem listing the offending field', async () => {
      const event = buildPaymentEvent();
      event.data.amount = 12100.5;

      const response = await t
        .sendWebhook(JSON.stringify(event))
        .expect(400)
        .expect('content-type', PROBLEM_JSON);

      expect(problemOf(response).type).toBe('/problems/validation-failed');
      expect(problemOf(response).errors).toEqual([
        expect.objectContaining({ field: 'data.amount' }),
      ]);
    });

    it('rejects unknown properties (forbidNonWhitelisted)', async () => {
      const event = { ...buildPaymentEvent(), isAdmin: true };

      const response = await t.sendWebhook(JSON.stringify(event)).expect(400);

      expect(problemOf(response).errors).toEqual([expect.objectContaining({ field: 'isAdmin' })]);
    });

    it('rejects a zero amount with 422 from the domain, writing nothing', async () => {
      const event = buildPaymentEvent();
      event.data.amount = '0.00';

      const response = await t.sendWebhook(JSON.stringify(event)).expect(422);

      expect(problemOf(response).type).toBe('/problems/invalid-journal-entry');
      expect(await t.prisma.webhookEvent.count({ where: { eventId: event.eventId } })).toBe(0);
    });

    it('rejects malformed JSON with a 400 problem', async () => {
      await t.sendWebhook('{"eventId": ').expect(400).expect('content-type', PROBLEM_JSON);
    });
  });
});

describe('GET /ledger/balances (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('requires the admin API key', async () => {
    await request(t.app.getHttpServer())
      .get('/ledger/balances')
      .expect(401)
      .expect('content-type', PROBLEM_JSON);
  });

  it('derives balances from entries, with total debits equal to total credits', async () => {
    // XTS is the ISO 4217 code reserved for testing: it isolates these balances.
    const event = buildPaymentEvent({ provider: 'STRIPE' });
    event.data.amount = '121.00';
    event.data.currency = 'XTS';
    await t.sendWebhook(JSON.stringify(event)).expect(202);

    const response = await request(t.app.getHttpServer())
      .get('/ledger/balances')
      .set(t.adminHeaders)
      .expect(200);

    const xts = balancesOf(response).filter((row) => row.currency === 'XTS');

    expect(xts.map((row) => row.accountCode)).toEqual([
      'GATEWAY_RECEIVABLE_STRIPE',
      'SALES_REVENUE',
      'VAT_PAYABLE',
    ]);

    // Cents as BigInt: the check does not use floating-point arithmetic either.
    const cents = (amount: string): bigint => BigInt(amount.replace('.', ''));
    const total = (column: 'debits' | 'credits'): bigint =>
      xts.reduce((sum, row) => sum + cents(row[column]), 0n);

    expect(total('debits')).toBe(total('credits'));
    expect(total('debits') % 12100n).toBe(0n);
  });
});
