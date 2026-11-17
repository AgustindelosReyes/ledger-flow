import { isValidCuit } from '../domain/cuit.js';
import { resolveInvoiceType } from '../domain/invoice-type.js';
import {
  InvalidFiscalCorrectionError,
  InvoiceNotDeadLetteredError,
  InvoiceNotFoundError,
} from './errors.js';
import type { DeadLetterStore } from './ports/dead-letter-store.js';
import type {
  AppliedCorrection,
  FiscalDataCorrection,
  InvoiceIssuanceRepository,
} from './ports/invoice-issuance-repository.js';

export interface RetryDeadLetteredInvoiceCommand {
  readonly invoiceId: string;
  /** correlationId of the admin request. */
  readonly requestCorrelationId: string;
  /** Corrected fiscal data; without it, the invoice is requeued as it is. */
  readonly correction?: {
    readonly payerTaxId: string;
    readonly reason: string | undefined;
  };
}

export interface RetryDeadLetteredInvoiceResult {
  readonly invoiceId: string;
  readonly outboxEventId: string;
  /** correlationId of the original webhook: the retry continues the same trace. */
  readonly correlationId: string;
  readonly correction: AppliedCorrection | null;
}

const DNI_PATTERN = /^\d{7,8}$/;
const CUIT_LENGTH = 11;

/**
 * Manual requeue of an invoice that failed permanently.
 *
 * It does not enqueue directly in Redis: the invoice is revived and an outbox message is
 * written in one transaction, and the relay publishes it. The requeue thus inherits the
 * guarantees of the normal flow (no dual write) and repeating the call does not duplicate
 * jobs: the second call finds the invoice out of `DEAD_LETTERED` and is rejected.
 *
 * Optionally it corrects the fiscal data that caused a permanent rejection (e.g. an
 * invalid CUIT): retrying without correcting it would fail in the same way.
 */
export class RetryDeadLetteredInvoiceUseCase {
  constructor(
    private readonly invoices: InvoiceIssuanceRepository,
    private readonly deadLetters: DeadLetterStore,
  ) {}

  async execute(command: RetryDeadLetteredInvoiceCommand): Promise<RetryDeadLetteredInvoiceResult> {
    const { invoiceId } = command;
    // The correction is validated before touching the database: a value the authority would
    // reject again must neither replace the previous one nor consume a retry.
    const correction = this.validateCorrection(command);

    const outcome = await this.invoices.requeueDeadLettered(invoiceId, correction);

    if (outcome.kind === 'not_found') {
      throw new InvoiceNotFoundError(invoiceId);
    }
    if (outcome.kind === 'not_dead_lettered') {
      throw new InvoiceNotDeadLetteredError(invoiceId, outcome.status);
    }

    // Postgres is the source of truth; the DLQ entry is a projection. If this removal failed,
    // the listing would discard the entry anyway, since it is no longer DEAD_LETTERED.
    await this.deadLetters.remove(invoiceId);

    return {
      invoiceId,
      outboxEventId: outcome.outboxEventId,
      correlationId: outcome.correlationId,
      correction: outcome.correction,
    };
  }

  private validateCorrection(
    command: RetryDeadLetteredInvoiceCommand,
  ): FiscalDataCorrection | undefined {
    if (command.correction === undefined) {
      return undefined;
    }
    const { payerTaxId, reason } = command.correction;

    if (payerTaxId.length === CUIT_LENGTH) {
      if (!isValidCuit(payerTaxId)) {
        throw new InvalidFiscalCorrectionError(
          `"${payerTaxId}" is not a valid CUIT: the check digit does not match`,
        );
      }
    } else if (!DNI_PATTERN.test(payerTaxId)) {
      throw new InvalidFiscalCorrectionError(
        `"${payerTaxId}" is neither a DNI (7-8 digits) nor a CUIT (11 digits)`,
      );
    }

    return {
      payerTaxId,
      // The invoice type depends on the tax id: it is recomputed with the same rule as at
      // ingestion (CUIT -> A, final consumer -> B).
      invoiceType: resolveInvoiceType(payerTaxId),
      reason,
      requestCorrelationId: command.requestCorrelationId,
    };
  }
}
