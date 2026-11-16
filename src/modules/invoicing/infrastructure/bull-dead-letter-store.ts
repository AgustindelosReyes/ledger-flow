import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { DeadLetterStore } from '../application/ports/dead-letter-store.js';
import {
  DEAD_LETTER_JOB,
  FISCAL_INVOICE_DLQ,
  deadLetterEntrySchema,
  type DeadLetterEntry,
} from '../invoice-queue.js';

/**
 * DLQ como cola de BullMQ sin consumidor: los jobs permanecen en espera hasta que un
 * operador los reencola. El `jobId` es el `invoiceId`, por lo que hay a lo sumo una entrada
 * por factura.
 */
@Injectable()
export class BullDeadLetterStore extends DeadLetterStore {
  private readonly logger = new Logger(BullDeadLetterStore.name);

  constructor(@InjectQueue(FISCAL_INVOICE_DLQ) private readonly queue: Queue<DeadLetterEntry>) {
    super();
  }

  async put(entry: DeadLetterEntry): Promise<void> {
    // Una entrada vieja con el mismo id haría que `add` se ignore y quede el motivo anterior.
    await this.queue.remove(entry.invoiceId);
    await this.queue.add(DEAD_LETTER_JOB, entry, { jobId: entry.invoiceId });
  }

  async get(invoiceId: string): Promise<DeadLetterEntry | null> {
    const job = await this.queue.getJob(invoiceId);
    return job === undefined ? null : this.parse(job.data);
  }

  async list(limit: number): Promise<DeadLetterEntry[]> {
    const jobs = await this.queue.getJobs('waiting', 0, limit - 1, true);
    return jobs.flatMap((job) => {
      const entry = this.parse(job.data);
      return entry === null ? [] : [entry];
    });
  }

  async remove(invoiceId: string): Promise<void> {
    await this.queue.remove(invoiceId);
  }

  private parse(data: unknown): DeadLetterEntry | null {
    const result = deadLetterEntrySchema.safeParse(data);
    if (!result.success) {
      this.logger.error({ issues: result.error.issues }, 'Malformed dead letter entry skipped');
      return null;
    }
    return result.data;
  }
}
