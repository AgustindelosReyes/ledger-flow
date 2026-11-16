import { describe, expect, it } from '@jest/globals';
import type { DeadLetterEntry } from '../invoice-queue.js';
import {
  InvalidFiscalCorrectionError,
  InvoiceNotDeadLetteredError,
  InvoiceNotFoundError,
} from './errors.js';
import { DeadLetterStore } from './ports/dead-letter-store.js';
import {
  InvoiceIssuanceRepository,
  type FiscalDataCorrection,
  type InvoiceSnapshot,
  type RequeueOutcome,
} from './ports/invoice-issuance-repository.js';
import { RetryDeadLetteredInvoiceUseCase } from './retry-dead-lettered-invoice.use-case.js';

class StubRepository extends InvoiceIssuanceRepository {
  readonly requeueCalls: { invoiceId: string; correction: FiscalDataCorrection | undefined }[] = [];

  constructor(private readonly outcome: RequeueOutcome) {
    super();
  }

  requeueDeadLettered(
    invoiceId: string,
    correction?: FiscalDataCorrection,
  ): Promise<RequeueOutcome> {
    this.requeueCalls.push({ invoiceId, correction });
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

const COMMAND = { invoiceId: 'invoice-1', requestCorrelationId: 'admin-request-1' };
const REQUEUED: RequeueOutcome = {
  kind: 'requeued',
  outboxEventId: 'outbox-9',
  correlationId: 'corr-original',
  correction: null,
};

describe('RetryDeadLetteredInvoiceUseCase', () => {
  const build = (
    outcome: RequeueOutcome = REQUEUED,
  ): {
    useCase: RetryDeadLetteredInvoiceUseCase;
    repository: StubRepository;
    deadLetters: RecordingDeadLetterStore;
  } => {
    const repository = new StubRepository(outcome);
    const deadLetters = new RecordingDeadLetterStore();
    return {
      useCase: new RetryDeadLetteredInvoiceUseCase(repository, deadLetters),
      repository,
      deadLetters,
    };
  };

  describe('plain requeue', () => {
    it('requeues through the outbox and clears the dead letter entry', async () => {
      const { useCase, repository, deadLetters } = build();

      await expect(useCase.execute(COMMAND)).resolves.toEqual({
        invoiceId: 'invoice-1',
        outboxEventId: 'outbox-9',
        correlationId: 'corr-original',
        correction: null,
      });
      expect(repository.requeueCalls).toEqual([{ invoiceId: 'invoice-1', correction: undefined }]);
      expect(deadLetters.removed).toEqual(['invoice-1']);
    });

    it('rejects an unknown invoice', async () => {
      const { useCase, deadLetters } = build({ kind: 'not_found' });

      await expect(useCase.execute(COMMAND)).rejects.toThrow(InvoiceNotFoundError);
      expect(deadLetters.removed).toHaveLength(0);
    });

    it.each(['PENDING', 'PROCESSING', 'ISSUED'] as const)(
      'rejects an invoice in status %s and leaves the DLQ untouched',
      async (status) => {
        const { useCase, deadLetters } = build({ kind: 'not_dead_lettered', status });

        await expect(useCase.execute(COMMAND)).rejects.toThrow(InvoiceNotDeadLetteredError);
        await expect(useCase.execute(COMMAND)).rejects.toThrow(status);
        expect(deadLetters.removed).toHaveLength(0);
      },
    );
  });

  describe('requeue with corrected fiscal data', () => {
    const withTaxId = (
      payerTaxId: string,
      reason?: string,
    ): Parameters<RetryDeadLetteredInvoiceUseCase['execute']>[0] => ({
      ...COMMAND,
      correction: { payerTaxId, reason },
    });

    it('passes a valid CUIT to the repository as a type A correction, with its audit context', async () => {
      const { useCase, repository } = build();

      await useCase.execute(withTaxId('30712345671', 'typo fixed by support'));

      expect(repository.requeueCalls[0]?.correction).toEqual({
        payerTaxId: '30712345671',
        invoiceType: 'A',
        reason: 'typo fixed by support',
        requestCorrelationId: 'admin-request-1',
      });
    });

    it.each(['30111222', '5111222'])(
      'turns the invoice into type B when corrected to the DNI %s',
      async (dni) => {
        const { useCase, repository } = build();

        await useCase.execute(withTaxId(dni));

        expect(repository.requeueCalls[0]?.correction).toMatchObject({
          payerTaxId: dni,
          invoiceType: 'B',
          reason: undefined,
        });
      },
    );

    it('returns the correction that the repository applied', async () => {
      const correction = {
        field: 'payerTaxId',
        previousValue: '30712345678',
        newValue: '30712345671',
        invoiceType: 'A',
      } as const;
      const { useCase } = build({ ...REQUEUED, correction });

      await expect(useCase.execute(withTaxId('30712345671'))).resolves.toMatchObject({
        correction,
      });
    });

    it.each([
      ['a CUIT with a wrong check digit', '30712345678', 'check digit'],
      ['a value with 9 digits', '123456789', 'neither a DNI'],
      ['a value with separators', '30-71234567-1', 'neither a DNI'],
      ['an empty value', '', 'neither a DNI'],
    ])(
      'rejects %s before touching the database or the queue',
      async (_case, payerTaxId, message) => {
        const { useCase, repository, deadLetters } = build();

        const attempt = useCase.execute(withTaxId(payerTaxId));

        await expect(attempt).rejects.toThrow(InvalidFiscalCorrectionError);
        await expect(attempt).rejects.toThrow(message);
        expect(repository.requeueCalls).toHaveLength(0);
        expect(deadLetters.removed).toHaveLength(0);
      },
    );

    it('does not clear the DLQ entry when the invoice turns out not to be dead-lettered', async () => {
      const { useCase, deadLetters } = build({ kind: 'not_dead_lettered', status: 'ISSUED' });

      await expect(useCase.execute(withTaxId('30712345671'))).rejects.toThrow(
        InvoiceNotDeadLetteredError,
      );
      expect(deadLetters.removed).toHaveLength(0);
    });
  });
});
