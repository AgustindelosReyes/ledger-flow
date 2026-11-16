import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { FISCAL_INVOICE_QUEUE, ISSUE_INVOICE_JOB } from '../src/modules/invoicing/invoice-queue.js';
import {
  acceptedAckOf,
  deadLettersOf,
  problemOf,
  retryAcceptedOf,
  traceOf,
  type AcceptedAck,
  type OperationTrace,
} from './support/responses.js';
import { ScriptedFaultInjector } from './support/scripted-fault-injector.js';
import { buildPaymentEvent, createTestApp, type TestApp } from './support/test-app.js';
import { waitFor } from './support/wait-for.js';

/** CUIT con dígito verificador incorrecto: el ente fiscal lo rechaza con 400. */
const INVALID_CUIT = '30712345678';
const VALID_CUIT = '30712345671';

describe('Asynchronous fiscal invoicing (e2e)', () => {
  const faults = new ScriptedFaultInjector();
  let t: TestApp;
  let queue: Queue;

  beforeAll(async () => {
    t = await createTestApp({ background: true, faults });
    await t.discardPendingOutbox();
    queue = t.app.get<Queue>(getQueueToken(FISCAL_INVOICE_QUEUE));
  });

  afterAll(async () => {
    await t.close();
  });

  /** Cada test usa un importe propio: es la clave de su guion de fallas. */
  async function pay(
    amount: string,
    payer?: { name?: string; taxId?: string },
    correlationId?: string,
  ): Promise<AcceptedAck> {
    const event = buildPaymentEvent();
    event.data.amount = amount;
    if (payer !== undefined) {
      event.data.payer = payer;
    }
    const response = await t
      .sendWebhook(JSON.stringify(event), correlationId === undefined ? {} : { correlationId })
      .expect(202);
    return acceptedAckOf(response);
  }

  async function getTrace(paymentId: string): Promise<OperationTrace> {
    const response = await request(t.app.getHttpServer())
      .get(`/operations/${paymentId}`)
      .set(t.adminHeaders)
      .expect(200);
    return traceOf(response);
  }

  /** Espera a que la factura llegue a un estado terminal y devuelve la traza. */
  function waitForInvoice(
    paymentId: string,
    status: 'ISSUED' | 'DEAD_LETTERED',
  ): Promise<OperationTrace> {
    return waitFor(`invoice of payment ${paymentId} to be ${status}`, async () => {
      const trace = await getTrace(paymentId);
      return trace.invoice?.status === status ? trace : null;
    });
  }

  const listDeadLetters = async (): Promise<ReturnType<typeof deadLettersOf>> =>
    deadLettersOf(
      await request(t.app.getHttpServer())
        .get('/admin/dlq?limit=200')
        .set(t.adminHeaders)
        .expect(200),
    );

  const retry = (invoiceId: string): request.Test =>
    request(t.app.getHttpServer()).post(`/admin/dlq/${invoiceId}/retry`).set(t.adminHeaders);

  describe('happy path', () => {
    it('issues the invoice and exposes the full trace: webhook -> ledger -> job -> CAE', async () => {
      const correlationId = `e2e-trace-${randomUUID()}`;
      const ack = await pay('2420.00', undefined, correlationId);

      const trace = await waitForInvoice(ack.paymentId, 'ISSUED');

      expect(trace.correlationId).toBe(correlationId);
      expect(trace.webhookEvent).toMatchObject({ id: ack.webhookEventId, status: 'PROCESSED' });
      expect(trace.payment).toMatchObject({ id: ack.paymentId, amount: '2420.00' });

      expect(trace.ledgerTransactions).toHaveLength(1);
      expect(trace.ledgerTransactions[0]).toMatchObject({
        id: ack.ledgerTransactionId,
        type: 'PAYMENT_CAPTURE',
      });
      expect(trace.ledgerTransactions[0]?.entries).toHaveLength(3);

      expect(trace.invoice).toMatchObject({
        id: ack.invoiceId,
        status: 'ISSUED',
        type: 'B',
        netAmount: '2000.00',
        taxAmount: '420.00',
        totalAmount: '2420.00',
        attemptCount: 1,
        lastError: null,
      });
      expect(trace.invoice?.cae).toMatch(/^\d{14}$/);
      expect(trace.invoice?.number).toBeGreaterThan(0);
      expect(trace.invoice?.caeExpiresAt).not.toBeNull();
      expect(trace.invoice?.issuedAt).not.toBeNull();

      expect(trace.invoice?.attempts).toHaveLength(1);
      expect(trace.invoice?.attempts[0]).toMatchObject({
        attemptNumber: 1,
        outcome: 'SUCCEEDED',
        httpStatus: 200,
        errorCode: null,
        response: { cae: trace.invoice?.cae, number: trace.invoice?.number },
      });

      // El job lleva como id el del mensaje de outbox y quedó completado.
      expect(trace.queue.deadLetter).toBeNull();
      expect(trace.queue.jobs).toHaveLength(1);
      const [job] = trace.queue.jobs;
      expect(job?.outboxStatus).toBe('PUBLISHED');
      expect(trace.invoice?.attempts[0]?.jobId).toBe(job?.outboxEventId);
      await waitFor('job to be completed', async () =>
        (await getTrace(ack.paymentId)).queue.jobs[0]?.jobState === 'completed' ? true : null,
      );
    });

    it('propagates the webhook correlationId into the job payload', async () => {
      const correlationId = `e2e-propagation-${randomUUID()}`;
      const ack = await pay('2421.00', undefined, correlationId);

      const trace = await waitForInvoice(ack.paymentId, 'ISSUED');
      const job = await queue.getJob(trace.queue.jobs[0]?.outboxEventId ?? '');

      expect(job?.data).toEqual({
        invoiceId: ack.invoiceId,
        paymentId: ack.paymentId,
        correlationId,
      });
    });

    it('assigns distinct invoice numbers to invoices issued concurrently', async () => {
      const acks = await Promise.all(
        ['2430.00', '2431.00', '2432.00', '2433.00'].map((a) => pay(a)),
      );

      const traces = await Promise.all(acks.map((ack) => waitForInvoice(ack.paymentId, 'ISSUED')));

      const numbers = traces.map((trace) => trace.invoice?.number);
      expect(new Set(numbers).size).toBe(4);
      expect(new Set(traces.map((trace) => trace.invoice?.cae)).size).toBe(4);
    });

    it('issues a type A invoice for a payer with a valid CUIT', async () => {
      const ack = await pay('2440.00', { name: 'ACME SA', taxId: VALID_CUIT });

      const trace = await waitForInvoice(ack.paymentId, 'ISSUED');

      expect(trace.invoice?.type).toBe('A');
    });
  });

  describe('transient failures', () => {
    it('retries with backoff after a 503 and a timeout, logging every attempt', async () => {
      faults.script('3630.00', ['unavailable', 'timeout_before_processing']);
      const ack = await pay('3630.00');

      const trace = await waitForInvoice(ack.paymentId, 'ISSUED');

      expect(trace.invoice?.attemptCount).toBe(3);
      expect(
        trace.invoice?.attempts.map((attempt) => ({
          n: attempt.attemptNumber,
          outcome: attempt.outcome,
          code: attempt.errorCode,
          http: attempt.httpStatus,
        })),
      ).toEqual([
        { n: 1, outcome: 'RETRYABLE_FAILURE', code: 'HTTP_503', http: 503 },
        { n: 2, outcome: 'RETRYABLE_FAILURE', code: 'TIMEOUT', http: null },
        { n: 3, outcome: 'SUCCEEDED', code: null, http: 200 },
      ]);
      // El intento con timeout esperó, como mínimo, el plazo configurado (250 ms).
      expect(trace.invoice?.attempts[1]?.durationMs).toBeGreaterThanOrEqual(240);
      // Los tres intentos pertenecen al mismo job: fueron reintentos de BullMQ.
      expect(new Set(trace.invoice?.attempts.map((attempt) => attempt.jobId)).size).toBe(1);
      expect(trace.queue.deadLetter).toBeNull();
    });

    it('does not issue a second invoice when the authority processed a request that timed out', async () => {
      faults.script('3640.00', ['timeout_after_processing']);
      const ack = await pay('3640.00');

      const trace = await waitForInvoice(ack.paymentId, 'ISSUED');

      expect(trace.invoice?.attempts.map((attempt) => attempt.outcome)).toEqual([
        'RETRYABLE_FAILURE',
        'SUCCEEDED',
      ]);
      // El ente recibió dos solicitudes, pero numeró una sola vez: el reintento obtuvo la
      // autorización original. Lo confirma un pago posterior, que recibe el número siguiente.
      expect(faults.callsFor(ack.invoiceId)).toBe(2);
      const next = await waitForInvoice((await pay('3641.00')).paymentId, 'ISSUED');
      expect(next.invoice?.number).toBe((trace.invoice?.number ?? 0) + 1);
    });
  });

  describe('dead letter queue', () => {
    it('dead-letters after exhausting retries, then issues the invoice on manual retry', async () => {
      faults.script('4840.00', ['unavailable', 'unavailable', 'unavailable']);
      const correlationId = `e2e-dlq-${randomUUID()}`;
      const ack = await pay('4840.00', undefined, correlationId);

      const failed = await waitForInvoice(ack.paymentId, 'DEAD_LETTERED');

      // Exactamente INVOICE_JOB_ATTEMPTS (3) intentos, ni uno más.
      expect(failed.invoice?.attemptCount).toBe(3);
      expect(failed.invoice?.attempts.map((attempt) => attempt.outcome)).toEqual([
        'RETRYABLE_FAILURE',
        'RETRYABLE_FAILURE',
        'RETRYABLE_FAILURE',
      ]);
      expect(failed.invoice?.cae).toBeNull();
      expect(failed.invoice?.lastError).toContain('503');
      expect(failed.queue.deadLetter).toMatchObject({ errorCode: 'HTTP_503' });
      await waitFor('job to be failed', async () =>
        (await getTrace(ack.paymentId)).queue.jobs[0]?.jobState === 'failed' ? true : null,
      );

      const entry = (await listDeadLetters()).find((item) => item.invoiceId === ack.invoiceId);
      expect(entry).toMatchObject({
        paymentId: ack.paymentId,
        correlationId,
        errorCode: 'HTTP_503',
        attemptCount: 3,
      });

      // Reencolado manual: el guion se agotó, así que ahora el ente responde bien.
      const retried = retryAcceptedOf(await retry(ack.invoiceId).expect(202));
      expect(retried).toMatchObject({ invoiceId: ack.invoiceId, correlationId });

      const issued = await waitForInvoice(ack.paymentId, 'ISSUED');
      expect(issued.invoice?.attemptCount).toBe(4);
      expect(issued.invoice?.attempts[3]).toMatchObject({
        attemptNumber: 4,
        outcome: 'SUCCEEDED',
        jobId: retried.outboxEventId,
      });
      // Dos jobs en la historia: el original (fallido) y el del reencolado.
      expect(issued.queue.jobs.map((job) => job.outboxEventId)).toEqual([
        failed.queue.jobs[0]?.outboxEventId,
        retried.outboxEventId,
      ]);
      expect(issued.queue.deadLetter).toBeNull();
      expect((await listDeadLetters()).map((item) => item.invoiceId)).not.toContain(ack.invoiceId);

      // Idempotencia del reencolado: repetirlo no crea otro job.
      const again = await retry(ack.invoiceId).expect(409);
      expect(problemOf(again).type).toBe('/problems/invoice-not-dead-lettered');
      expect(await t.prisma.outboxEvent.count({ where: { aggregateId: ack.invoiceId } })).toBe(2);
    });

    it('accepts only one of several concurrent manual retries', async () => {
      faults.script('4850.00', ['unavailable', 'unavailable', 'unavailable']);
      const ack = await pay('4850.00');
      await waitForInvoice(ack.paymentId, 'DEAD_LETTERED');

      const responses = await Promise.all(Array.from({ length: 5 }, () => retry(ack.invoiceId)));

      expect(responses.map((response) => response.status).sort()).toEqual([
        202, 409, 409, 409, 409,
      ]);
      const issued = await waitForInvoice(ack.paymentId, 'ISSUED');
      expect(issued.queue.jobs).toHaveLength(2);
      expect(issued.invoice?.attemptCount).toBe(4);
    });

    it('sends a permanent rejection (400) straight to the DLQ without burning retries', async () => {
      const ack = await pay('4860.00', { name: 'ACME SA', taxId: INVALID_CUIT });

      const trace = await waitForInvoice(ack.paymentId, 'DEAD_LETTERED');

      expect(trace.invoice?.attemptCount).toBe(1);
      expect(trace.invoice?.attempts).toHaveLength(1);
      expect(trace.invoice?.attempts[0]).toMatchObject({
        outcome: 'PERMANENT_FAILURE',
        httpStatus: 400,
        errorCode: 'HTTP_400',
        response: { status: 400, error: 'HTTP_400' },
      });
      expect(trace.invoice?.lastError).toContain(INVALID_CUIT);
      expect(trace.queue.deadLetter).toMatchObject({ errorCode: 'HTTP_400' });
      expect(faults.callsFor(ack.invoiceId)).toBe(1);

      // BullMQ lo dio por fallido en el primer intento, pese a tener 3 disponibles.
      const job = await waitFor('job to be failed', async () => {
        const [state] = (await getTrace(ack.paymentId)).queue.jobs;
        return state?.jobState === 'failed' ? state : null;
      });
      expect(job.attemptsMade).toBe(1);
    });
  });

  describe('dead letter retry with corrected fiscal data', () => {
    /** Pago cuya factura A cae en la DLQ porque el ente rechaza el CUIT (400). */
    async function deadLetterByInvalidCuit(amount: string): Promise<AcceptedAck> {
      const ack = await pay(amount, { name: 'ACME SA', taxId: INVALID_CUIT });
      await waitForInvoice(ack.paymentId, 'DEAD_LETTERED');
      return ack;
    }

    const correctionsOf = (invoiceId: string): Promise<number> =>
      t.prisma.invoiceCorrection.count({ where: { invoiceId } });

    it('rescues an invoice rejected for an invalid CUIT, recording the correction', async () => {
      const ack = await deadLetterByInvalidCuit('7260.00');
      const adminCorrelationId = `e2e-admin-${randomUUID()}`;

      const response = await retry(ack.invoiceId)
        .set('x-correlation-id', adminCorrelationId)
        .send({ payerTaxId: VALID_CUIT, reason: 'Typo confirmed by support, ticket #4821' })
        .expect(202);

      expect(retryAcceptedOf(response).correction).toEqual({
        field: 'payerTaxId',
        previousValue: INVALID_CUIT,
        newValue: VALID_CUIT,
        invoiceType: 'A',
      });

      const trace = await waitForInvoice(ack.paymentId, 'ISSUED');
      expect(trace.invoice?.type).toBe('A');
      expect(trace.invoice?.cae).toMatch(/^\d{14}$/);
      expect(trace.invoice?.attempts.map((attempt) => attempt.outcome)).toEqual([
        'PERMANENT_FAILURE',
        'SUCCEEDED',
      ]);

      // Auditoría: qué cambió, por qué y qué request administrativo lo hizo.
      expect(trace.invoice?.corrections).toHaveLength(1);
      expect(trace.invoice?.corrections[0]).toMatchObject({
        field: 'payerTaxId',
        previousValue: INVALID_CUIT,
        newValue: VALID_CUIT,
        reason: 'Typo confirmed by support, ticket #4821',
        correlationId: adminCorrelationId,
      });

      // El pago refleja el dato corregido; el payload original del webhook no se altera.
      const payment = await t.prisma.payment.findUniqueOrThrow({
        where: { id: ack.paymentId },
        include: { webhookEvent: true },
      });
      expect(payment.payerTaxId).toBe(VALID_CUIT);
      expect(JSON.stringify(payment.webhookEvent.payload)).toContain(INVALID_CUIT);
    });

    it('converts the invoice to type B when the payer is corrected to a DNI', async () => {
      const ack = await deadLetterByInvalidCuit('7270.00');

      const response = await retry(ack.invoiceId).send({ payerTaxId: '30111222' }).expect(202);

      expect(retryAcceptedOf(response).correction).toMatchObject({ invoiceType: 'B' });
      const trace = await waitForInvoice(ack.paymentId, 'ISSUED');
      expect(trace.invoice?.type).toBe('B');
      expect(trace.invoice?.corrections[0]?.reason).toBeNull();
    });

    it('rejects with 422 a correction whose CUIT has a wrong check digit, changing nothing', async () => {
      const ack = await deadLetterByInvalidCuit('7280.00');

      const response = await retry(ack.invoiceId).send({ payerTaxId: '20123456789' }).expect(422);

      expect(problemOf(response)).toMatchObject({
        type: '/problems/invalid-fiscal-correction',
        status: 422,
      });
      const trace = await getTrace(ack.paymentId);
      expect(trace.invoice?.status).toBe('DEAD_LETTERED');
      expect(trace.queue.jobs).toHaveLength(1);
      expect(await correctionsOf(ack.invoiceId)).toBe(0);
      const payment = await t.prisma.payment.findUniqueOrThrow({ where: { id: ack.paymentId } });
      expect(payment.payerTaxId).toBe(INVALID_CUIT);
      // Sigue en la DLQ, disponible para un nuevo intento de corrección.
      expect((await listDeadLetters()).map((item) => item.invoiceId)).toContain(ack.invoiceId);
    });

    it.each([
      ['a malformed tax id', { payerTaxId: '30-71234567-1' }, 'payerTaxId'],
      ['an unknown property', { payerTaxId: VALID_CUIT, status: 'ISSUED' }, 'status'],
      ['an empty reason', { payerTaxId: VALID_CUIT, reason: '' }, 'reason'],
    ])('rejects with 400 a body with %s', async (_case, body, field) => {
      const ack = await deadLetterByInvalidCuit(
        `73${String(Math.floor(Math.random() * 90) + 10)}.${String(Math.floor(Math.random() * 90) + 10)}`,
      );

      const response = await retry(ack.invoiceId).send(body).expect(400);

      expect(problemOf(response).errors).toEqual([expect.objectContaining({ field })]);
      expect((await getTrace(ack.paymentId)).invoice?.status).toBe('DEAD_LETTERED');
      expect(await correctionsOf(ack.invoiceId)).toBe(0);
    });

    it('applies neither the correction nor the requeue when the invoice is not dead-lettered', async () => {
      const ack = await pay('7290.00', { name: 'ACME SA', taxId: VALID_CUIT });
      await waitForInvoice(ack.paymentId, 'ISSUED');

      await retry(ack.invoiceId).send({ payerTaxId: '30111222' }).expect(409);

      const trace = await getTrace(ack.paymentId);
      expect(trace.invoice).toMatchObject({ status: 'ISSUED', type: 'A', corrections: [] });
      const payment = await t.prisma.payment.findUniqueOrThrow({ where: { id: ack.paymentId } });
      expect(payment.payerTaxId).toBe(VALID_CUIT);
    });

    it('applies a single correction when the same retry is sent concurrently', async () => {
      const ack = await deadLetterByInvalidCuit('7295.00');

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => retry(ack.invoiceId).send({ payerTaxId: VALID_CUIT })),
      );

      expect(responses.map((response) => response.status).sort()).toEqual([
        202, 409, 409, 409, 409,
      ]);
      await waitForInvoice(ack.paymentId, 'ISSUED');
      expect(await correctionsOf(ack.invoiceId)).toBe(1);
    });

    it('keeps the correction log append-only at the database level', async () => {
      const ack = await deadLetterByInvalidCuit('7297.00');
      await retry(ack.invoiceId).send({ payerTaxId: VALID_CUIT }).expect(202);

      await expect(
        t.prisma.invoiceCorrection.updateMany({
          where: { invoiceId: ack.invoiceId },
          data: { newValue: 'tampered' },
        }),
      ).rejects.toThrow(/append-only/);
      await expect(
        t.prisma.invoiceCorrection.deleteMany({ where: { invoiceId: ack.invoiceId } }),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('worker guards', () => {
    it('does not call the fiscal authority again for an invoice that is already issued', async () => {
      const ack = await pay('6050.00');
      const issued = await waitForInvoice(ack.paymentId, 'ISSUED');
      expect(faults.callsFor(ack.invoiceId)).toBe(1);

      // Un job duplicado para la misma factura (p. ej. una republicación del relay).
      const duplicate = await queue.add(
        ISSUE_INVOICE_JOB,
        { invoiceId: ack.invoiceId, paymentId: ack.paymentId, correlationId: 'duplicate-job' },
        { jobId: randomUUID() },
      );
      await waitFor('duplicate job to complete', async () =>
        (await duplicate.getState()) === 'completed' ? true : null,
      );

      const after = await getTrace(ack.paymentId);
      expect(faults.callsFor(ack.invoiceId)).toBe(1);
      expect(after.invoice?.attemptCount).toBe(1);
      expect(after.invoice?.attempts).toHaveLength(1);
      expect(after.invoice?.cae).toBe(issued.invoice?.cae);
      expect(after.invoice?.number).toBe(issued.invoice?.number);
    });
  });

  describe('admin endpoints', () => {
    it.each([
      ['GET', '/admin/dlq'],
      ['POST', `/admin/dlq/${randomUUID()}/retry`],
      ['GET', `/operations/${randomUUID()}`],
    ])('%s %s requires the admin API key', async (method, path) => {
      const server = request(t.app.getHttpServer());
      const call = method === 'GET' ? server.get(path) : server.post(path);

      const response = await call.expect(401);

      expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    });

    it('returns 404 for an unknown operation or invoice', async () => {
      const trace = await request(t.app.getHttpServer())
        .get(`/operations/${randomUUID()}`)
        .set(t.adminHeaders)
        .expect(404);
      expect(problemOf(trace).type).toBe('/problems/operation-not-found');

      const retried = await retry(randomUUID()).expect(404);
      expect(problemOf(retried).type).toBe('/problems/invoice-not-found');
    });

    it('rejects a malformed identifier with 400', async () => {
      await request(t.app.getHttpServer())
        .get('/operations/not-a-uuid')
        .set(t.adminHeaders)
        .expect(400);
    });

    it('refuses to requeue an invoice that is not dead-lettered', async () => {
      const ack = await pay('6060.00');
      await waitForInvoice(ack.paymentId, 'ISSUED');

      const response = await retry(ack.invoiceId).expect(409);

      expect(problemOf(response).detail).toContain('ISSUED');
    });
  });
});
