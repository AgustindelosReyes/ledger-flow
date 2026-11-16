import type { InvoiceType } from '../../domain/invoice-type.js';

export interface FiscalAuthorizationRequest {
  /** Clave de idempotencia ante el ente: reintentar con el mismo id no emite otro comprobante. */
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
  /** Número correlativo asignado por el ente para (punto de venta, tipo). */
  readonly number: number;
  /** Código de Autorización Electrónico: 14 dígitos. */
  readonly cae: string;
  /** Vencimiento del CAE, `YYYY-MM-DD`. */
  readonly caeExpiresAt: string;
}

/**
 * Falla al tramitar ante el ente fiscal. `retryable` es la clasificación que gobierna la
 * resiliencia: un error transitorio se reintenta con backoff; uno permanente va directo a
 * la DLQ, porque repetir la misma solicitud daría el mismo rechazo.
 */
export abstract class FiscalAuthorityError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
  /** Código HTTP de la respuesta; `null` si no hubo respuesta. */
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

/** Puerto de salida hacia el ente fiscal (ARCA/AFIP). */
export abstract class FiscalAuthority {
  /**
   * @param signal se aborta cuando vence el timeout del cliente; la implementación debe
   *   dejar de esperar y liberar recursos.
   */
  abstract authorize(
    request: FiscalAuthorizationRequest,
    signal: AbortSignal,
  ): Promise<FiscalAuthorization>;
}
