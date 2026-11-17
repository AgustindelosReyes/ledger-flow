import { DomainError } from '../../../shared/domain/domain-error.js';

export class InvoiceNotFoundError extends DomainError {
  readonly code = 'INVOICE_NOT_FOUND';

  constructor(invoiceId: string) {
    super(`Invoice "${invoiceId}" does not exist`);
  }
}

export class InvoiceNotDeadLetteredError extends DomainError {
  readonly code = 'INVOICE_NOT_DEAD_LETTERED';

  constructor(invoiceId: string, status: string) {
    super(
      `Invoice "${invoiceId}" is not in the dead letter queue (current status: ${status}); ` +
        'only dead-lettered invoices can be requeued',
    );
  }
}

export class InvalidFiscalCorrectionError extends DomainError {
  readonly code = 'INVALID_FISCAL_CORRECTION';
}

/**
 * Failed outcome of an issuance attempt, already persisted in the attempt log. It tells
 * the queue adapter what to do: retry, or consider the job finished.
 */
export class InvoiceIssuanceFailedError extends Error {
  readonly errorCode: string;
  /** `false`: retrying is pointless; the job must fail permanently right away. */
  readonly retryable: boolean;
  /** `true`: the invoice is now `DEAD_LETTERED` and must be published to the DLQ. */
  readonly deadLettered: boolean;
  readonly attemptCount: number;

  constructor(params: {
    message: string;
    errorCode: string;
    retryable: boolean;
    deadLettered: boolean;
    attemptCount: number;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'InvoiceIssuanceFailedError';
    this.errorCode = params.errorCode;
    this.retryable = params.retryable;
    this.deadLettered = params.deadLettered;
    this.attemptCount = params.attemptCount;
  }
}
