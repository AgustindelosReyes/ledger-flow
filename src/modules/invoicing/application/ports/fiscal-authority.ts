import type { InvoiceType } from '../../domain/invoice-type.js';

export interface FiscalAuthorizationRequest {
  /**
   * Idempotency key for the authority: retrying with the same id does not issue another
   * invoice.
   */
  readonly invoiceId: string;
  readonly type: InvoiceType;
  readonly pointOfSale: number;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly totalAmount: string;
  readonly currency: string;
  readonly payerTaxId: string | null;
}

export interface FiscalAuthorization {
  /** Consecutive number assigned by the authority for (point of sale, type). */
  readonly number: number;
  /** Electronic authorization code (CAE): 14 digits. */
  readonly cae: string;
  /** CAE expiry date, `YYYY-MM-DD`. */
  readonly caeExpiresAt: string;
}

/**
 * Failure while dealing with the fiscal authority. `retryable` is the classification that
 * drives resilience: a transient error is retried with backoff; a permanent one goes
 * straight to the DLQ, because repeating the same request would get the same rejection.
 */
export abstract class FiscalAuthorityError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
  /** HTTP status of the response; `null` if there was no response. */
  abstract readonly httpStatus: number | null;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class FiscalServiceUnavailableError extends FiscalAuthorityError {
  readonly code = 'HTTP_503';
  readonly retryable = true;
  readonly httpStatus = 503;

  constructor() {
    super('Fiscal authority responded 503 Service Unavailable');
  }
}

export class FiscalTimeoutError extends FiscalAuthorityError {
  readonly code = 'TIMEOUT';
  readonly retryable = true;
  readonly httpStatus = null;

  constructor(timeoutMs: number) {
    super(`Fiscal authority did not respond within ${timeoutMs} ms`);
  }
}

export class FiscalRejectionError extends FiscalAuthorityError {
  readonly code = 'HTTP_400';
  readonly retryable = false;
  readonly httpStatus = 400;

  constructor(readonly rejectionReason: string) {
    super(`Fiscal authority rejected the invoice: ${rejectionReason}`);
  }
}

/** Outbound port to the fiscal authority (ARCA/AFIP). */
export abstract class FiscalAuthority {
  /**
   * @param signal aborted when the client timeout expires; the implementation must stop
   *   waiting and release its resources.
   */
  abstract authorize(
    request: FiscalAuthorizationRequest,
    signal: AbortSignal,
  ): Promise<FiscalAuthorization>;
}
