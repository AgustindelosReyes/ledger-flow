import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { FISCAL_INVOICE_QUEUE, ISSUE_INVOICE_JOB } from '../src/modules/invoicing/invoice-queue.js';
import { OutboxRelay } from '../src/modules/outbox/outbox-relay.js';
import { acceptedAckOf, type AcceptedAck } from './support/responses.js';
import { buildPaymentEvent, createTestApp, type TestApp } from './support/test-app.js';

/**
 * El relay y el worker automáticos están apagados: el test invoca al relay a mano para
 * controlar el momento exacto de cada publicación, y nadie consume los jobs.
 */
describe('Outbox relay (e2e)', () => {
  let t: TestApp;
  let relay: OutboxRelay;
  let queue: Queue;

  beforeAll(async () => {
    t = await createTestApp({ background: false });
    await t.discardPendingOutbox();
    relay = t.app.get(OutboxRelay);
    queue = t.app.get<Queue>(getQueueToken(FISCAL_INVOICE_QUEUE));
  });

  afterAll(async () => {
    await t.close();
  });

  async function pay(correlationId: string): Promise<AcceptedAck> {
    const event = buildPaymentEvent();
    return acceptedAckOf(await t.sendWebhook(JSON.stringify(event), { correlationId }).expect(202));
  }

  const outboxOf = (invoiceId: string): ReturnType<typeof t.prisma.outboxEvent.findFirstOrThrow> =>
    t.prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: invoiceId } });

  const queuedJobs = async (): Promise<number> => {
    const counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed');
    return Object.values(counts).reduce((total, count) => total + count, 0);
  };

  it('publishes a pending event as a job whose id is the outbox event id', async () => {
    const ack = await pay('relay-publish-0001');
    const pending = await outboxOf(ack.invoiceId);
    expect(pending.status).toBe('PENDING');

    expect(await relay.publishPending()).toBe(1);

    const published = await outboxOf(ack.invoiceId);
    expect(published.status).toBe('PUBLISHED');
    expect(published.publishedAt).not.toBeNull();
    expect(published.attempts).toBe(1);

    const job = await queue.getJob(pending.id);
    expect(job?.name).toBe(ISSUE_INVOICE_JOB);
    expect(job?.data).toEqual({
      invoiceId: ack.invoiceId,
      paymentId: ack.paymentId,
      correlationId: 'relay-publish-0001',
    });
    expect(job?.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 20 },
    });
  });

  it('does nothing when there are no pending events', async () => {
    expect(await relay.publishPending()).toBe(0);
  });

  it('does not duplicate the job if the relay crashed after queue.add() but before the UPDATE', async () => {
    const ack = await pay('relay-crash-0001');
    const pending = await outboxOf(ack.invoiceId);

    // Estado que deja un relay que murió a mitad de camino: el job ya está en Redis, pero
    // el evento sigue PENDING en Postgres.
    await queue.add(
      ISSUE_INVOICE_JOB,
      { invoiceId: ack.invoiceId, paymentId: ack.paymentId, correlationId: 'relay-crash-0001' },
      { jobId: pending.id },
    );
    const jobsBefore = await queuedJobs();

    // Al recuperarse, el relay republica el evento...
    expect(await relay.publishPending()).toBe(1);

    // ...pero BullMQ descarta el `add` con un jobId existente: sigue habiendo un solo job.
    expect(await queuedJobs()).toBe(jobsBefore);
    expect((await outboxOf(ack.invoiceId)).status).toBe('PUBLISHED');
  });

  it('publishes each event exactly once when several relays run concurrently', async () => {
    const acks = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => pay(`relay-concurrent-${index}`)),
    );
    const jobsBefore = await queuedJobs();

    // Cinco relays simultáneos: FOR UPDATE SKIP LOCKED reparte los eventos entre ellos.
    const published = await Promise.all(Array.from({ length: 5 }, () => relay.publishPending()));

    expect(published.reduce((total, count) => total + count, 0)).toBe(8);
    expect(await queuedJobs()).toBe(jobsBefore + 8);
    const events = await t.prisma.outboxEvent.findMany({
      where: { aggregateId: { in: acks.map((ack) => ack.invoiceId) } },
    });
    expect(events).toHaveLength(8);
    expect(events.every((event) => event.status === 'PUBLISHED' && event.attempts === 1)).toBe(
      true,
    );
  });

  it('keeps an unpublishable event pending, records the error and still publishes the rest', async () => {
    const ack = await pay('relay-poison-0001');
    const poison = await t.prisma.outboxEvent.create({
      data: {
        type: 'unknown.event',
        aggregateId: ack.invoiceId,
        payload: {},
        correlationId: 'relay-poison-0001',
      },
    });

    expect(await relay.publishPending()).toBe(1);

    const stored = await t.prisma.outboxEvent.findUniqueOrThrow({ where: { id: poison.id } });
    expect(stored.status).toBe('PENDING');
    expect(stored.attempts).toBe(1);
    expect(stored.lastError).toContain('unknown.event');

    // Se retira para no dejar un evento envenenado a los demás archivos de test.
    await t.prisma.outboxEvent.delete({ where: { id: poison.id } });
  });
});
