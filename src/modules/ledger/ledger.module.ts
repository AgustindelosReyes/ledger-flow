import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from '../../shared/http/admin-api-key.guard.js';
import { LedgerBalancesQuery } from './infrastructure/ledger-balances.query.js';
import { LedgerController } from './presentation/ledger.controller.js';

@Module({
  controllers: [LedgerController],
  providers: [LedgerBalancesQuery, AdminApiKeyGuard],
})
export class LedgerModule {}
