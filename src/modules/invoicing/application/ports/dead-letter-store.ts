import type { DeadLetterEntry } from '../../invoice-queue.js';

/** Dead Letter Queue: one entry per invoice that failed permanently. */
export abstract class DeadLetterStore {
  /** Idempotent by `invoiceId`: replaces the previous entry if there is one. */
  abstract put(entry: DeadLetterEntry): Promise<void>;
  abstract get(invoiceId: string): Promise<DeadLetterEntry | null>;
  abstract list(limit: number): Promise<DeadLetterEntry[]>;
  abstract remove(invoiceId: string): Promise<void>;
}
