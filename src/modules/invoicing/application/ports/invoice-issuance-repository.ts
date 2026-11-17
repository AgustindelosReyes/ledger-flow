import type { JsonObject } from '../../../../shared/domain/json.js';
import type { InvoiceType } from '../../domain/invoice-type.js';
import type { FiscalAuthorization } from './fiscal-authority.js';

export type InvoiceStatus = 'PENDING' | 'PROCESSING' | 'ISSUED' | 'DEAD_LETTERED';

export interface InvoiceSnapshot {
  readonly id: string;
  readonly paymentId: string;
  readonly status: InvoiceStatus;
  /** Version that was read: every later write requires it (optimistic locking). */
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

/** Already validated correction of fiscal data, to apply together with the requeue. */
export interface FiscalDataCorrection {
  readonly payerTaxId: string;
  /** Invoice type that corresponds to the new tax id. */
  readonly invoiceType: InvoiceType;
  readonly reason: string | undefined;
  /** correlationId of the admin request, for the audit log. */
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
 * Persistence of the issuance. Every state transition is conditional on the version that
 * was read: it returns `null`/`false` if another process modified the invoice meanwhile.
 */
export abstract class InvoiceIssuanceRepository {
  abstract find(invoiceId: string): Promise<InvoiceSnapshot | null>;

  /**
   * Takes the invoice for an attempt: `PENDING|PROCESSING -> PROCESSING`, incrementing
   * `version` and `attemptCount`. Returns the new snapshot, or `null` if it lost the race.
   */
  abstract claim(invoice: InvoiceSnapshot): Promise<InvoiceSnapshot | null>;

  /** Records the successful attempt and moves to `ISSUED` with number and CAE. */
  abstract recordSuccess(
    claimed: InvoiceSnapshot,
    attempt: AttemptRecord,
    authorization: FiscalAuthorization,
  ): Promise<boolean>;

  /**
   * Records the failed attempt and moves to `PENDING` (it will be retried) or
   * `DEAD_LETTERED`.
   */
  abstract recordFailure(
    claimed: InvoiceSnapshot,
    attempt: AttemptRecord,
    params: { readonly retryable: boolean; readonly nextStatus: 'PENDING' | 'DEAD_LETTERED' },
  ): Promise<boolean>;

  /**
   * Manual requeue: `DEAD_LETTERED -> PENDING` plus a new outbox message, in a single
   * transaction. Two concurrent calls cannot requeue twice.
   *
   * If a correction is given, the fiscal data is updated and the change is written to the
   * correction log in that same transaction: either everything is applied, or nothing.
   */
  abstract requeueDeadLettered(
    invoiceId: string,
    correction?: FiscalDataCorrection,
  ): Promise<RequeueOutcome>;
}
