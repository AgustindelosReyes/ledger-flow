import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service.js';
import { DeadLetterStore } from '../application/ports/dead-letter-store.js';
import type { DeadLetterEntry } from '../invoice-queue.js';

export interface DeadLetterView extends DeadLetterEntry {
  readonly lastError: string | null;
}

@Injectable()
export class DeadLetterQuery {
  constructor(
    private readonly deadLetters: DeadLetterStore,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * DLQ entries cross-checked against Postgres, which is the source of truth: only the
   * invoices that are still `DEAD_LETTERED` are shown.
   */
  async list(limit: number): Promise<DeadLetterView[]> {
    const entries = await this.deadLetters.list(limit);
    if (entries.length === 0) {
      return [];
    }
    const invoices = await this.prisma.invoice.findMany({
      where: { id: { in: entries.map((entry) => entry.invoiceId) }, status: 'DEAD_LETTERED' },
      select: { id: true, lastError: true },
    });
    const lastErrorById = new Map(invoices.map((invoice) => [invoice.id, invoice.lastError]));

    return entries.flatMap((entry) => {
      const lastError = lastErrorById.get(entry.invoiceId);
      return lastError === undefined ? [] : [{ ...entry, lastError }];
    });
  }
}
