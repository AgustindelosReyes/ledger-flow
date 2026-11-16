import type { JsonObject } from '../../../../shared/domain/json.js';
import type { InvoiceType } from '../../domain/invoice-type.js';
import type { FiscalAuthorization } from './fiscal-authority.js';

export type InvoiceStatus = 'PENDING' | 'PROCESSING' | 'ISSUED' | 'DEAD_LETTERED';

export interface InvoiceSnapshot {
  readonly id: string;
  readonly paymentId: string;
  readonly status: InvoiceStatus;
  /** Versión leída: toda escritura posterior la exige (bloqueo optimista). */
  readonly version: number;
  readonly attemptCount: number;
  readonly type: InvoiceType;
  readonly pointOfSale: number;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly totalAmount: string;
  readonly currency: string;
  readonly payerTaxId: string | null;
  readonly correlationId: string;
}

export interface AttemptRecord {
  readonly jobId: string;
  readonly durationMs: number;
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly response: JsonObject | null;
}

/** Corrección de datos fiscales ya validada, a aplicar junto con el reencolado. */
export interface FiscalDataCorrection {
  readonly payerTaxId: string;
  /** Clase de comprobante que corresponde al nuevo identificador fiscal. */
  readonly invoiceType: InvoiceType;
  readonly reason: string | undefined;
  /** correlationId del request administrativo, para la bitácora de auditoría. */
  readonly requestCorrelationId: string;
}

export interface AppliedCorrection {
  readonly field: 'payerTaxId';
  readonly previousValue: string | null;
  readonly newValue: string;
  readonly invoiceType: InvoiceType;
}

export type RequeueOutcome =
  | {
      readonly kind: 'requeued';
      readonly outboxEventId: string;
      readonly correlationId: string;
      readonly correction: AppliedCorrection | null;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_dead_lettered'; readonly status: InvoiceStatus };

/**
 * Persistencia de la emisión. Todas las transiciones de estado son condicionales a la
 * versión leída: devuelven `null`/`false` si otro proceso modificó la factura entretanto.
 */
export abstract class InvoiceIssuanceRepository {
  abstract find(invoiceId: string): Promise<InvoiceSnapshot | null>;

  /**
   * Toma la factura para un intento: `PENDING|PROCESSING -> PROCESSING`, incrementando
   * `version` y `attemptCount`. Devuelve el nuevo snapshot, o `null` si perdió la carrera.
   */
  abstract claim(invoice: InvoiceSnapshot): Promise<InvoiceSnapshot | null>;

  /** Registra el intento exitoso y pasa a `ISSUED` con número y CAE. */
  abstract recordSuccess(
    claimed: InvoiceSnapshot,
    attempt: AttemptRecord,
    authorization: FiscalAuthorization,
  ): Promise<boolean>;

  /** Registra el intento fallido y pasa a `PENDING` (se reintentará) o `DEAD_LETTERED`. */
  abstract recordFailure(
    claimed: InvoiceSnapshot,
    attempt: AttemptRecord,
    params: { readonly retryable: boolean; readonly nextStatus: 'PENDING' | 'DEAD_LETTERED' },
  ): Promise<boolean>;

  /**
   * Reencolado manual: `DEAD_LETTERED -> PENDING` y un nuevo mensaje de outbox, en una
   * única transacción. Dos llamadas concurrentes no pueden reencolar dos veces.
   *
   * Si se indica una corrección, en la misma transacción se actualiza el dato fiscal y se
   * deja constancia en la bitácora de correcciones: o se aplica todo, o nada.
   */
  abstract requeueDeadLettered(
    invoiceId: string,
    correction?: FiscalDataCorrection,
  ): Promise<RequeueOutcome>;
}
