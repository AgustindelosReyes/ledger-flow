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
   * Entradas de la DLQ cruzadas contra Postgres, que es la fuente de verdad: solo se
   * muestran las facturas que siguen en `DEAD_LETTERED`.
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
