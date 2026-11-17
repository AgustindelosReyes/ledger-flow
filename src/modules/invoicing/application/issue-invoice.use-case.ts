import { InvoiceIssuanceFailedError } from './errors.js';
import {
  FiscalAuthorityError,
  FiscalTimeoutError,
  type FiscalAuthority,
  type FiscalAuthorization,
} from './ports/fiscal-authority.js';
import type {
  AttemptRecord,
  InvoiceIssuanceRepository,
  InvoiceSnapshot,
} from './ports/invoice-issuance-repository.js';

export interface IssueInvoiceCommand {
  readonly invoiceId: string;
  readonly jobId: string;
  /** Last attempt the queue will grant this job: if it fails, the failure is permanent. */
  readonly isFinalAttempt: boolean;
}

export type IssueInvoiceResult =
  | { readonly outcome: 'issued'; readonly number: number; readonly cae: string }
  /** Idempotency guard: the invoice already had a CAE; the authority was not called. */
  | { readonly outcome: 'already_issued' }
  /** The invoice already failed permanently; only a manual requeue reactivates it. */
  | { readonly outcome: 'dead_lettered'; readonly invoice: InvoiceSnapshot };

export interface IssuanceSettings {
  readonly requestTimeoutMs: number;
}

interface Clock {
  now(): number;
}

const CONCURRENT_MODIFICATION = 'CONCURRENT_MODIFICATION';
const UNEXPECTED_ERROR = 'UNEXPECTED_ERROR';

export class IssueInvoiceUseCase {
  constructor(
    private readonly invoices: InvoiceIssuanceRepository,
    private readonly authority: FiscalAuthority,
    private readonly settings: IssuanceSettings,
    private readonly clock: Clock = { now: () => performance.now() },
  ) {}

  async execute(command: IssueInvoiceCommand): Promise<IssueInvoiceResult> {
    const invoice = await this.invoices.find(command.invoiceId);
    if (invoice === null) {
      throw new InvoiceIssuanceFailedError({
        message: `Invoice "${command.invoiceId}" does not exist`,
        errorCode: 'INVOICE_NOT_FOUND',
        retryable: false,
        deadLettered: false,
        attemptCount: 0,
      });
    }

    // Guards that run before any external effect. A job can arrive more than once (BullMQ is
    // at-least-once; a "stalled" job is redelivered): a second CAE must never be requested.
    if (invoice.status === 'ISSUED') {
      return { outcome: 'already_issued' };
    }
    if (invoice.status === 'DEAD_LETTERED') {
      return { outcome: 'dead_lettered', invoice };
    }

    const claimed = await this.invoices.claim(invoice);
    if (claimed === null) {
      throw this.concurrentModification(invoice);
    }

    const startedAt = this.clock.now();
    const elapsed = (): number => Math.round(this.clock.now() - startedAt);

    let authorization: FiscalAuthorization;
    try {
      authorization = await this.authorizeWithTimeout(claimed);
    } catch (error) {
      throw await this.handleFailure(claimed, command, error, elapsed());
    }

    const recorded = await this.invoices.recordSuccess(
      claimed,
      {
        jobId: command.jobId,
        durationMs: elapsed(),
        httpStatus: 200,
        errorCode: null,
        errorMessage: null,
        response: { ...authorization },
      },
      authorization,
    );
    if (!recorded) {
      // Another process moved the invoice forward while waiting for the authority. The
      // authority is idempotent by `invoiceId`, so the retry will get this same authorization.
      throw this.concurrentModification(claimed);
    }

    return { outcome: 'issued', number: authorization.number, cae: authorization.cae };
  }

  /**
   * The timeout is enforced here rather than delegated to the adapter: even if an
   * implementation ignores the signal, the attempt ends on time and frees the worker slot.
   */
  private authorizeWithTimeout(invoice: InvoiceSnapshot): Promise<FiscalAuthorization> {
    const { requestTimeoutMs } = this.settings;
    const signal = AbortSignal.timeout(requestTimeoutMs);
    const timeout = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(new FiscalTimeoutError(requestTimeoutMs));
        },
        { once: true },
      );
    });

    const response = this.authority
      .authorize(
        {
          invoiceId: invoice.id,
          type: invoice.type,
          pointOfSale: invoice.pointOfSale,
          netAmount: invoice.netAmount,
          taxAmount: invoice.taxAmount,
          totalAmount: invoice.totalAmount,
          currency: invoice.currency,
          payerTaxId: invoice.payerTaxId,
        },
        signal,
      )
      .catch((error: unknown) => {
        // An adapter that aborts when the deadline expires fails with its own error (AbortError,
        // socket closed...): it is normalized to a timeout so it is always classified the same.
        if (signal.aborted && !(error instanceof FiscalAuthorityError)) {
          throw new FiscalTimeoutError(requestTimeoutMs);
        }
        throw error;
      });

    return Promise.race([response, timeout]);
  }

  private async handleFailure(
    claimed: InvoiceSnapshot,
    command: IssueInvoiceCommand,
    error: unknown,
    durationMs: number,
  ): Promise<InvoiceIssuanceFailedError> {
    const failure = classify(error);
    const deadLettered = !failure.retryable || command.isFinalAttempt;

    const attempt: AttemptRecord = {
      jobId: command.jobId,
      durationMs,
      httpStatus: failure.httpStatus,
      errorCode: failure.errorCode,
      errorMessage: failure.message,
      response:
        failure.httpStatus === null
          ? null
          : { status: failure.httpStatus, error: failure.errorCode, message: failure.message },
    };

    const recorded = await this.invoices.recordFailure(claimed, attempt, {
      retryable: failure.retryable,
      nextStatus: deadLettered ? 'DEAD_LETTERED' : 'PENDING',
    });
    if (!recorded) {
      return this.concurrentModification(claimed);
    }

    return new InvoiceIssuanceFailedError({
      message: failure.message,
      errorCode: failure.errorCode,
      retryable: failure.retryable,
      deadLettered,
      attemptCount: claimed.attemptCount,
      cause: error,
    });
  }

  /** Transient: on the next attempt the state is read again and the guards decide. */
  private concurrentModification(invoice: InvoiceSnapshot): InvoiceIssuanceFailedError {
    return new InvoiceIssuanceFailedError({
      message: `Invoice "${invoice.id}" was modified concurrently by another process`,
      errorCode: CONCURRENT_MODIFICATION,
      retryable: true,
      deadLettered: false,
      attemptCount: invoice.attemptCount,
    });
  }
}

interface ClassifiedFailure {
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
}

function classify(error: unknown): ClassifiedFailure {
  if (error instanceof FiscalAuthorityError) {
    return {
      errorCode: error.code,
      message: error.message,
      retryable: error.retryable,
      httpStatus: error.httpStatus,
    };
  }
  // Unforeseen failure (network, adapter bug): assumed to be transient. If it persists,
  // the attempt limit sends it to the DLQ anyway.
  return {
    errorCode: UNEXPECTED_ERROR,
    message: error instanceof Error ? error.message : 'Unknown error',
    retryable: true,
    httpStatus: null,
  };
}
