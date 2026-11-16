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

/**
 * Resultado fallido de un intento de emisión, ya persistido en la bitácora. Le dice al
 * adaptador de la cola qué hacer: reintentar, o dar el job por terminado.
 */
export class InvoiceIssuanceFailedError extends Error {
  readonly errorCode: string;
  /** `false`: reintentar no sirve; el job debe fallar de forma definitiva de inmediato. */
  readonly retryable: boolean;
  /** `true`: la factura quedó en `DEAD_LETTERED` y debe publicarse en la DLQ. */
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
