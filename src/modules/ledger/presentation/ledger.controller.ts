import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  ADMIN_API_KEY_HEADER,
  AdminApiKeyGuard,
} from '../../../shared/http/admin-api-key.guard.js';
import { ApiProblemResponse } from '../../../shared/http/api-problem-response.js';
import {
  LedgerBalancesQuery,
  type AccountBalance,
} from '../infrastructure/ledger-balances.query.js';

class AccountBalanceDto implements AccountBalance {
  @ApiProperty({ example: 'SALES_REVENUE' })
  accountCode!: string;

  @ApiProperty({ example: 'Ingresos por ventas' })
  accountName!: string;

  @ApiProperty({ enum: ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] })
  accountType!: string;

  @ApiProperty({ enum: ['DEBIT', 'CREDIT'], description: 'Side on which the account increases' })
  normalBalance!: string;

  @ApiProperty({ example: 'ARS' })
  currency!: string;

  @ApiProperty({ example: '0.00', description: 'Sum of debit entries, as a decimal string' })
  debits!: string;

  @ApiProperty({ example: '10000.00', description: 'Sum of credit entries, as a decimal string' })
  credits!: string;

  @ApiProperty({
    example: '10000.00',
    description: 'Balance according to the normal side of the account',
  })
  balance!: string;
}

@ApiTags('ledger')
@ApiSecurity(ADMIN_API_KEY_HEADER)
@Controller('ledger')
@UseGuards(AdminApiKeyGuard)
export class LedgerController {
  constructor(private readonly balances: LedgerBalancesQuery) {}

  @Get('balances')
  @ApiOperation({
    summary: 'Trial balance per account and currency',
    description:
      'Computed on demand by aggregating immutable ledger entries; no balance is ever stored ' +
      'or updated. For every currency, total debits equal total credits.',
  })
  @ApiOkResponse({ type: [AccountBalanceDto] })
  @ApiProblemResponse(401, 'Missing or invalid API key')
  getBalances(): Promise<AccountBalance[]> {
    return this.balances.execute();
  }
}
