import { beforeEach, describe, expect, it } from '@jest/globals';
import { InvoiceIssuanceFailedError } from './errors.js';
import { IssueInvoiceUseCase } from './issue-invoice.use-case.js';
import {
  FiscalAuthority,
  FiscalRejectionError,
  FiscalServiceUnavailableError,
  type FiscalAuthorization,
  type FiscalAuthorizationRequest,
} from './ports/fiscal-authority.js';
import {
  InvoiceIssuanceRepository,
  type AttemptRecord,
  type InvoiceSnapshot,
  type RequeueOutcome,
} from './ports/invoice-issuance-repository.js';

const AUTHORIZATION: FiscalAuthorization = {
  number: 42,
  cae: '12345678901234',
  caeExpiresAt: '2026-12-01',
};

function invoiceFixture(overrides: Partial<InvoiceSnapshot> = {}): InvoiceSnapshot {
  return {
    id: 'invoice-1',
    paymentId: 'payment-1',
    status: 'PENDING',
    version: 0,
    attemptCount: 0,
    type: 'B',
    pointOfSale: 1,
    netAmount: '100.00',
    taxAmount: '21.00',
    totalAmount: '121.00',
    currency: 'ARS',
    payerTaxId: null,
    correlationId: 'corr-1',
    ...overrides,
  };
}

interface LoggedAttempt extends AttemptRecord {
  readonly attemptNumber: number;
  readonly outcome: 'SUCCEEDED' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE';
}

/** In-memory repository with the same optimistic locking as the real implementation. */
class InMemoryInvoiceRepository extends InvoiceIssuanceRepository {
  readonly attempts: LoggedAttempt[] = [];
  issued: FiscalAuthorization | undefined;
  /** Simulates another process modifying the invoice right after it is read. */
  interfereAfterFind = false;
  /** Simulates another process modifying the invoice while waiting for the authority. */
  interfereAfterClaim = false;

  constructor(private invoice: InvoiceSnapshot | null) {
    super();
  }

  get current(): InvoiceSnapshot {
    if (this.invoice === null) {
      throw new Error('No invoice stored');
    }
    return this.invoice;
  }

  find(): Promise<InvoiceSnapshot | null> {
    const snapshot = this.invoice;
    if (this.interfereAfterFind) {
      this.bumpVersion();
    }
    return Promise.resolve(snapshot);
  }

  claim(invoice: InvoiceSnapshot): Promise<InvoiceSnapshot | null> {
    if (!this.matches(invoice)) {
      return Promise.resolve(null);
    }
    this.invoice = {
      ...this.current,
      status: 'PROCESSING',
      version: invoice.version + 1,
      attemptCount: invoice.attemptCount + 1,
    };
    const claimed = this.invoice;
    if (this.interfereAfterClaim) {
      this.bumpVersion();
    }
    return Promise.resolve(claimed);
  }

  recordSuccess(
    claimed: InvoiceSnapshot,
    attempt: AttemptRecord,
    authorization: FiscalAuthorization,
  ): Promise<boolean> {
    this.attempts.push({ ...attempt, attemptNumber: claimed.attemptCount, outcome: 'SUCCEEDED' });
    if (!this.matches(claimed)) {
      return Promise.resolve(false);
    }
    this.invoice = { ...this.current, status: 'ISSUED', version: claimed.version + 1 };
    this.issued = authorization;
    return Promise.resolve(true);
  }

  recordFailure(
    claimed: InvoiceSnapshot,
    attempt: AttemptRecord,
    params: { readonly retryable: boolean; readonly nextStatus: 'PENDING' | 'DEAD_LETTERED' },
  ): Promise<boolean> {
    this.attempts.push({
      ...attempt,
      attemptNumber: claimed.attemptCount,
      outcome: params.retryable ? 'RETRYABLE_FAILURE' : 'PERMANENT_FAILURE',
    });
    if (!this.matches(claimed)) {
      return Promise.resolve(false);
    }
    this.invoice = { ...this.current, status: params.nextStatus, version: claimed.version + 1 };
    return Promise.resolve(true);
  }

  requeueDeadLettered(): Promise<RequeueOutcome> {
    return Promise.reject(new Error('Not used by this use case'));
  }

  private matches(snapshot: InvoiceSnapshot): boolean {
    return this.invoice !== null && this.invoice.version === snapshot.version;
  }

  private bumpVersion(): void {
    this.invoice = { ...this.current, version: this.current.version + 1 };
  }
}

type Behaviour = (signal: AbortSignal) => Promise<FiscalAuthorization>;

class StubFiscalAuthority extends FiscalAuthority {
  readonly requests: FiscalAuthorizationRequest[] = [];

  constructor(private readonly behaviour: Behaviour) {
    super();
  }

  authorize(
    request: FiscalAuthorizationRequest,
    signal: AbortSignal,
  ): Promise<FiscalAuthorization> {
    this.requests.push(request);
    return this.behaviour(signal);
  }
}

const succeed: Behaviour = () => Promise.resolve(AUTHORIZATION);
const failWith =
  (error: Error): Behaviour =>
  () =>
    Promise.reject(error);
/** Authority that never responds and, on top of that, ignores the abort signal. */
const neverRespond: Behaviour = () => new Promise<FiscalAuthorization>(() => undefined);
/** Authority that aborts when signalled, with a transport-specific error. */
const abortOnSignal: Behaviour = (signal) =>
  new Promise<FiscalAuthorization>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new Error('socket hang up'));
    });
  });

const COMMAND = { invoiceId: 'invoice-1', jobId: 'job-1', isFinalAttempt: false };

describe('IssueInvoiceUseCase', () => {
  let repository: InMemoryInvoiceRepository;

  beforeEach(() => {
    repository = new InMemoryInvoiceRepository(invoiceFixture());
  });

  const build = (behaviour: Behaviour): [IssueInvoiceUseCase, StubFiscalAuthority] => {
    const authority = new StubFiscalAuthority(behaviour);
    return [new IssueInvoiceUseCase(repository, authority, { requestTimeoutMs: 40 }), authority];
  };

  const failure = async (
    useCase: IssueInvoiceUseCase,
    command = COMMAND,
  ): Promise<InvoiceIssuanceFailedError> => {
    try {
      await useCase.execute(command);
    } catch (error) {
      if (error instanceof InvoiceIssuanceFailedError) {
        return error;
      }
      throw error;
    }
    throw new Error('Expected the use case to fail');
  };

  describe('success', () => {
    it('authorizes the invoice, stores number and CAE, and logs the attempt', async () => {
      const [useCase, authority] = build(succeed);

      const result = await useCase.execute(COMMAND);

      expect(result).toEqual({ outcome: 'issued', number: 42, cae: '12345678901234' });
      expect(repository.current).toMatchObject({ status: 'ISSUED', attemptCount: 1, version: 2 });
      expect(repository.issued).toEqual(AUTHORIZATION);
      expect(repository.attempts).toEqual([
        {
          attemptNumber: 1,
          outcome: 'SUCCEEDED',
          jobId: 'job-1',
          httpStatus: 200,
          errorCode: null,
          errorMessage: null,
          response: AUTHORIZATION,
          durationMs: expect.any(Number),
        },
      ]);
      expect(authority.requests).toEqual([
        {
          invoiceId: 'invoice-1',
          type: 'B',
          pointOfSale: 1,
          netAmount: '100.00',
          taxAmount: '21.00',
          totalAmount: '121.00',
          currency: 'ARS',
          payerTaxId: null,
        },
      ]);
    });

    it('resumes an invoice left in PROCESSING by a worker that died', async () => {
      repository = new InMemoryInvoiceRepository(
        invoiceFixture({ status: 'PROCESSING', version: 1, attemptCount: 1 }),
      );
      const [useCase] = build(succeed);

      await expect(useCase.execute(COMMAND)).resolves.toMatchObject({ outcome: 'issued' });
      expect(repository.attempts[0]?.attemptNumber).toBe(2);
    });
  });

  describe('guards: no external call when there is nothing to do', () => {
    it('skips an invoice that is already ISSUED', async () => {
      repository = new InMemoryInvoiceRepository(invoiceFixture({ status: 'ISSUED', version: 2 }));
      const [useCase, authority] = build(succeed);

      await expect(useCase.execute(COMMAND)).resolves.toEqual({ outcome: 'already_issued' });
      expect(authority.requests).toHaveLength(0);
      expect(repository.attempts).toHaveLength(0);
      expect(repository.current.version).toBe(2);
    });

    it('skips an invoice that is DEAD_LETTERED until it is requeued manually', async () => {
      repository = new InMemoryInvoiceRepository(invoiceFixture({ status: 'DEAD_LETTERED' }));
      const [useCase, authority] = build(succeed);

      await expect(useCase.execute(COMMAND)).resolves.toMatchObject({ outcome: 'dead_lettered' });
      expect(authority.requests).toHaveLength(0);
    });

    it('fails permanently when the invoice does not exist', async () => {
      repository = new InMemoryInvoiceRepository(null);
      const [useCase, authority] = build(succeed);

      const error = await failure(useCase);

      expect(error).toMatchObject({
        errorCode: 'INVOICE_NOT_FOUND',
        retryable: false,
        deadLettered: false,
      });
      expect(authority.requests).toHaveLength(0);
    });
  });

  describe('error classification', () => {
    it('treats a 503 as transient: logs it and leaves the invoice PENDING for the retry', async () => {
      const [useCase] = build(failWith(new FiscalServiceUnavailableError()));

      const error = await failure(useCase);

      expect(error).toMatchObject({ errorCode: 'HTTP_503', retryable: true, deadLettered: false });
      expect(repository.current).toMatchObject({ status: 'PENDING', attemptCount: 1 });
      expect(repository.attempts[0]).toMatchObject({
        outcome: 'RETRYABLE_FAILURE',
        httpStatus: 503,
        errorCode: 'HTTP_503',
        response: { status: 503, error: 'HTTP_503' },
      });
    });

    it('dead-letters a transient failure when it happens on the final attempt', async () => {
      const [useCase] = build(failWith(new FiscalServiceUnavailableError()));

      const error = await failure(useCase, { ...COMMAND, isFinalAttempt: true });

      expect(error).toMatchObject({ retryable: true, deadLettered: true, attemptCount: 1 });
      expect(repository.current.status).toBe('DEAD_LETTERED');
      expect(repository.attempts[0]?.outcome).toBe('RETRYABLE_FAILURE');
    });

    it('treats a 400 rejection as permanent and dead-letters on the first attempt', async () => {
      const [useCase] = build(failWith(new FiscalRejectionError('invalid CUIT')));

      const error = await failure(useCase);

      expect(error).toMatchObject({ errorCode: 'HTTP_400', retryable: false, deadLettered: true });
      expect(repository.current.status).toBe('DEAD_LETTERED');
      expect(repository.attempts[0]).toMatchObject({
        outcome: 'PERMANENT_FAILURE',
        httpStatus: 400,
        errorMessage: expect.stringContaining('invalid CUIT'),
      });
    });

    it('treats an unexpected adapter error as transient', async () => {
      const [useCase] = build(failWith(new TypeError('fetch failed')));

      const error = await failure(useCase);

      expect(error).toMatchObject({ errorCode: 'UNEXPECTED_ERROR', retryable: true });
      expect(repository.attempts[0]).toMatchObject({ httpStatus: null, response: null });
    });
  });

  describe('timeout', () => {
    it('gives up after the configured timeout even if the adapter ignores the abort signal', async () => {
      const [useCase] = build(neverRespond);
      const startedAt = Date.now();

      const error = await failure(useCase);

      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(error).toMatchObject({ errorCode: 'TIMEOUT', retryable: true });
      expect(repository.attempts[0]).toMatchObject({
        outcome: 'RETRYABLE_FAILURE',
        errorCode: 'TIMEOUT',
        httpStatus: null,
        response: null,
      });
      expect(repository.attempts[0]?.durationMs).toBeGreaterThanOrEqual(30);
    });

    it('classifies as TIMEOUT whatever error the adapter raises when aborted', async () => {
      const [useCase] = build(abortOnSignal);

      await expect(failure(useCase)).resolves.toMatchObject({ errorCode: 'TIMEOUT' });
    });
  });

  describe('optimistic locking', () => {
    it('does not call the authority when another process claimed the invoice first', async () => {
      repository.interfereAfterFind = true;
      const [useCase, authority] = build(succeed);

      const error = await failure(useCase);

      expect(error).toMatchObject({
        errorCode: 'CONCURRENT_MODIFICATION',
        retryable: true,
        deadLettered: false,
      });
      expect(authority.requests).toHaveLength(0);
      expect(repository.attempts).toHaveLength(0);
    });

    it('does not overwrite the invoice when it changed while waiting for the authority', async () => {
      repository.interfereAfterClaim = true;
      const [useCase] = build(succeed);

      const error = await failure(useCase);

      expect(error.errorCode).toBe('CONCURRENT_MODIFICATION');
      expect(repository.current.status).toBe('PROCESSING');
      expect(repository.issued).toBeUndefined();
      // The attempt did happen: it stays in the log even though the status did not change.
      expect(repository.attempts).toHaveLength(1);
    });

    it('never dead-letters on a lost race, even on the final attempt', async () => {
      repository.interfereAfterClaim = true;
      const [useCase] = build(failWith(new FiscalServiceUnavailableError()));

      const error = await failure(useCase, { ...COMMAND, isFinalAttempt: true });

      expect(error).toMatchObject({ errorCode: 'CONCURRENT_MODIFICATION', deadLettered: false });
    });
  });
});
