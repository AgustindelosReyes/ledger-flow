import { describe, expect, it } from '@jest/globals';
import type { DeadLetterEntry } from '../invoice-queue.js';
import { InvoiceNotDeadLetteredError, InvoiceNotFoundError } from './errors.js';
import { DeadLetterStore } from './ports/dead-letter-store.js';
import {
  InvoiceIssuanceRepository,
  type InvoiceSnapshot,
  type RequeueOutcome,
} from './ports/invoice-issuance-repository.js';
import { RetryDeadLetteredInvoiceUseCase } from './retry-dead-lettered-invoice.use-case.js';

class StubRepository extends InvoiceIssuanceRepository {
  constructor(private readonly outcome: RequeueOutcome) {
    super();
  }

  requeueDeadLettered(): Promise<RequeueOutcome> {
    return Promise.resolve(this.outcome);
  }

  find(): Promise<InvoiceSnapshot | null> {
    return Promise.reject(new Error('Not used by this use case'));
  }

  claim(): Promise<InvoiceSnapshot | null> {
    return Promise.reject(new Error('Not used by this use case'));
  }

  recordSuccess(): Promise<boolean> {
    return Promise.reject(new Error('Not used by this use case'));
  }

  recordFailure(): Promise<boolean> {
    return Promise.reject(new Error('Not used by this use case'));
  }
}

class RecordingDeadLetterStore extends DeadLetterStore {
  readonly removed: string[] = [];

  remove(invoiceId: string): Promise<void> {
    this.removed.push(invoiceId);
    return Promise.resolve();
  }

  put(): Promise<void> {
    return Promise.resolve();
  }

  get(): Promise<DeadLetterEntry | null> {
    return Promise.resolve(null);
  }

  list(): Promise<DeadLetterEntry[]> {
    return Promise.resolve([]);
  }
}

describe('RetryDeadLetteredInvoiceUseCase', () => {
  const build = (
    outcome: RequeueOutcome,
  ): [RetryDeadLetteredInvoiceUseCase, RecordingDeadLetterStore] => {
    const deadLetters = new RecordingDeadLetterStore();
    return [
      new RetryDeadLetteredInvoiceUseCase(new StubRepository(outcome), deadLetters),
      deadLetters,
    ];
  };

  it('requeues through the outbox and clears the dead letter entry', async () => {
    const [useCase, deadLetters] = build({
      kind: 'requeued',
      outboxEventId: 'outbox-9',
      correlationId: 'corr-original',
    });

    await expect(useCase.execute('invoice-1')).resolves.toEqual({
      invoiceId: 'invoice-1',
      outboxEventId: 'outbox-9',
      correlationId: 'corr-original',
    });
    expect(deadLetters.removed).toEqual(['invoice-1']);
  });

  it('rejects an unknown invoice', async () => {
    const [useCase, deadLetters] = build({ kind: 'not_found' });

    await expect(useCase.execute('invoice-1')).rejects.toThrow(InvoiceNotFoundError);
    expect(deadLetters.removed).toHaveLength(0);
  });

  it.each(['PENDING', 'PROCESSING', 'ISSUED'] as const)(
    'rejects an invoice in status %s and leaves the DLQ untouched',
    async (status) => {
      const [useCase, deadLetters] = build({ kind: 'not_dead_lettered', status });

      await expect(useCase.execute('invoice-1')).rejects.toThrow(InvoiceNotDeadLetteredError);
      await expect(useCase.execute('invoice-1')).rejects.toThrow(status);
      expect(deadLetters.removed).toHaveLength(0);
    },
  );
});
