import { InvoiceNotDeadLetteredError, InvoiceNotFoundError } from './errors.js';
import type { DeadLetterStore } from './ports/dead-letter-store.js';
import type { InvoiceIssuanceRepository } from './ports/invoice-issuance-repository.js';

export interface RetryDeadLetteredInvoiceResult {
  readonly invoiceId: string;
  readonly outboxEventId: string;
  /** correlationId del webhook original: el reintento continúa la misma traza. */
  readonly correlationId: string;
}

/**
 * Reencolado manual de una factura en falla definitiva.
 *
 * No se encola directamente en Redis: se revive la factura y se escribe un mensaje de
 * outbox en una transacción, y el relay lo publica. Así el reencolado hereda las mismas
 * garantías que el flujo normal (sin dual-write) y repetir la llamada no duplica jobs: la
 * segunda encuentra la factura fuera de `DEAD_LETTERED` y es rechazada.
 */
export class RetryDeadLetteredInvoiceUseCase {
  constructor(
    private readonly invoices: InvoiceIssuanceRepository,
    private readonly deadLetters: DeadLetterStore,
  ) {}

  async execute(invoiceId: string): Promise<RetryDeadLetteredInvoiceResult> {
    const outcome = await this.invoices.requeueDeadLettered(invoiceId);

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
    };
  }
}
