import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service.js';

export interface AccountBalance {
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly normalBalance: string;
  readonly currency: string;
  readonly debits: string;
  readonly credits: string;
  readonly balance: string;
}

/**
 * Los saldos no se almacenan: se derivan sumando asientos inmutables. La agregación corre
 * en PostgreSQL sobre NUMERIC y viaja como texto, sin pasar por `number` de JavaScript.
 */
@Injectable()
export class LedgerBalancesQuery {
  constructor(private readonly prisma: PrismaService) {}

  async execute(): Promise<AccountBalance[]> {
    return this.prisma.$queryRaw<AccountBalance[]>`
      SELECT
        a."code"                 AS "accountCode",
        a."name"                 AS "accountName",
        a."type"::text           AS "accountType",
        a."normal_balance"::text AS "normalBalance",
        e."currency"::text       AS "currency",
        SUM(CASE WHEN e."direction" = 'DEBIT' THEN e."amount" ELSE 0 END)::numeric(19, 2)::text
          AS "debits",
        SUM(CASE WHEN e."direction" = 'CREDIT' THEN e."amount" ELSE 0 END)::numeric(19, 2)::text
          AS "credits",
        SUM(CASE WHEN e."direction" = a."normal_balance" THEN e."amount" ELSE -e."amount" END)
          ::numeric(19, 2)::text AS "balance"
      FROM "ledger_accounts" a
      JOIN "ledger_entries" e ON e."account_id" = a."id"
      GROUP BY a."id", e."currency"
      ORDER BY a."code", e."currency"
    `;
  }
}
