import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { FISCAL_INVOICE_QUEUE, ISSUE_INVOICE_JOB } from '../src/modules/invoicing/invoice-queue.js';
import { OutboxRelay } from '../src/modules/outbox/outbox-relay.js';
import { acceptedAckOf, type AcceptedAck } from './support/responses.js';
import { buildPaymentEvent, createTestApp, type TestApp } from './support/test-app.js';

/**
 * The automatic relay and worker are off: the test invokes the relay by hand to control
 * the exact moment of each publication, and nobody consumes the jobs.
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

    // State left by a relay that died halfway: the job is already in Redis, but the
    // event is still PENDING in Postgres.
    await queue.add(
      ISSUE_INVOICE_JOB,
      { invoiceId: ack.invoiceId, paymentId: ack.paymentId, correlationId: 'relay-crash-0001' },
      { jobId: pending.id },
    );
    const jobsBefore = await queuedJobs();

    // On recovery, the relay republishes the event...
    expect(await relay.publishPending()).toBe(1);

    // ...but BullMQ drops the `add` with an existing jobId: there is still one job.
    expect(await queuedJobs()).toBe(jobsBefore);
    expect((await outboxOf(ack.invoiceId)).status).toBe('PUBLISHED');
  });

  it('publishes each event exactly once when several relays run concurrently', async () => {
    const acks = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) => pay(`relay-concurrent-${index}`)),
    );
    const jobsBefore = await queuedJobs();

    // Five simultaneous relays: FOR UPDATE SKIP LOCKED splits the events among them.
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

  describe('poison-pill protection', () => {
    const MAX_ATTEMPTS = 5;

    const createEvent = (type: string, payload: Record<string, string>): Promise<{ id: string }> =>
      t.prisma.outboxEvent.create({
        data: { type, aggregateId: randomUUID(), payload, correlationId: 'relay-poison-0001' },
        select: { id: true },
      });

    const stateOf = async (
      id: string,
    ): Promise<{ status: string; attempts: number; lastError: string | null }> => {
      const event = await t.prisma.outboxEvent.findUniqueOrThrow({ where: { id } });
      return { status: event.status, attempts: event.attempts, lastError: event.lastError };
    };

    it('marks an event of unknown type as FAILED after 5 attempts and stops retrying it', async () => {
      const poison = await createEvent('unknown.event', {});
      const ack = await pay('relay-poison-neighbour');

      // The poison event does not block the valid event that shares the batch.
      expect(await relay.publishPending()).toBe(1);
      expect((await outboxOf(ack.invoiceId)).status).toBe('PUBLISHED');
      expect(await stateOf(poison.id)).toMatchObject({ status: 'PENDING', attempts: 1 });

      for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt += 1) {
        await relay.publishPending();
        expect(await stateOf(poison.id)).toMatchObject({ status: 'PENDING', attempts: attempt });
      }

      await relay.publishPending();
      const failed = await stateOf(poison.id);
      expect(failed).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS });
      expect(failed.lastError).toContain('unknown.event');

      // It is no longer picked up: the counter does not move again.
      await relay.publishPending();
      expect(await stateOf(poison.id)).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS });
    });

    it('marks an event with a corrupt payload as FAILED after 5 attempts', async () => {
      const corrupt = await createEvent('invoice.requested', { invoiceId: 'not-a-uuid' });

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        await relay.publishPending();
      }

      const failed = await stateOf(corrupt.id);
      expect(failed).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS });
      expect(failed.lastError).toContain('Invalid payload');
    });

    it('never fails a valid event because of a broker outage: it stays PENDING until Redis is back', async () => {
      const ack = await pay('relay-outage-0001');
      const outage = jest.spyOn(queue, 'add').mockRejectedValue(new Error('Connection is closed'));

      for (let attempt = 1; attempt <= MAX_ATTEMPTS + 2; attempt += 1) {
        expect(await relay.publishPending()).toBe(0);
      }
      const during = await outboxOf(ack.invoiceId);
      expect(during).toMatchObject({ status: 'PENDING', attempts: MAX_ATTEMPTS + 2 });
      expect(during.lastError).toContain('Connection is closed');

      outage.mockRestore();
      expect(await relay.publishPending()).toBe(1);
      expect((await outboxOf(ack.invoiceId)).status).toBe('PUBLISHED');
      expect(await queue.getJob(during.id)).toBeDefined();
    });
  });
});
