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
  /** correlationId del request administrativo. */
  readonly requestCorrelationId: string;
  /** Datos fiscales corregidos; sin ellos, la factura se reencola tal como está. */
  readonly correction?: {
    readonly payerTaxId: string;
    readonly reason: string | undefined;
  };
}

export interface RetryDeadLetteredInvoiceResult {
  readonly invoiceId: string;
  readonly outboxEventId: string;
  /** correlationId del webhook original: el reintento continúa la misma traza. */
  readonly correlationId: string;
  readonly correction: AppliedCorrection | null;
}

const DNI_PATTERN = /^\d{7,8}$/;
const CUIT_LENGTH = 11;

/**
 * Reencolado manual de una factura en falla definitiva.
 *
 * No se encola directamente en Redis: se revive la factura y se escribe un mensaje de
 * outbox en una transacción, y el relay lo publica. Así el reencolado hereda las mismas
 * garantías que el flujo normal (sin dual-write) y repetir la llamada no duplica jobs: la
 * segunda encuentra la factura fuera de `DEAD_LETTERED` y es rechazada.
 *
 * Opcionalmente corrige el dato fiscal que provocó un rechazo permanente (p. ej. un CUIT
 * inválido): reintentar sin corregirlo volvería a fallar igual.
 */
export class RetryDeadLetteredInvoiceUseCase {
  constructor(
    private readonly invoices: InvoiceIssuanceRepository,
    private readonly deadLetters: DeadLetterStore,
  ) {}

  async execute(command: RetryDeadLetteredInvoiceCommand): Promise<RetryDeadLetteredInvoiceResult> {
    const { invoiceId } = command;
    // La corrección se valida antes de tocar la base: un dato que el ente volvería a
    // rechazar no debe reemplazar al anterior ni consumir un reintento.
    const correction = this.validateCorrection(command);

    const outcome = await this.invoices.requeueDeadLettered(invoiceId, correction);

    if (outcome.kind === 'not_found') {
      throw new InvoiceNotFoundError(invoiceId);
    }
    if (outcome.kind === 'not_dead_lettered') {
      throw new InvoiceNotDeadLetteredError(invoiceId, outcome.status);
    }

    // Postgres es la fuente de verdad; la entrada en la DLQ es una proyección. Si este
    // borrado fallara, el listado igualmente la descarta por no estar ya DEAD_LETTERED.
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
      // El tipo de comprobante depende del identificador: se recalcula con la misma regla
      // que en la ingesta (CUIT -> A, consumidor final -> B).
      invoiceType: resolveInvoiceType(payerTaxId),
      reason,
      requestCorrelationId: command.requestCorrelationId,
    };
  }
}
