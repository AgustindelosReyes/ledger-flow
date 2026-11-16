import type { DeadLetterEntry } from '../../invoice-queue.js';

/** Dead Letter Queue: una entrada por factura en falla definitiva. */
export abstract class DeadLetterStore {
  /** Idempotente por `invoiceId`: reemplaza la entrada previa si existe. */
  abstract put(entry: DeadLetterEntry): Promise<void>;
  abstract get(invoiceId: string): Promise<DeadLetterEntry | null>;
  abstract list(limit: number): Promise<DeadLetterEntry[]>;
  abstract remove(invoiceId: string): Promise<void>;
}
