import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  ADMIN_API_KEY_HEADER,
  AdminApiKeyGuard,
} from '../../../shared/http/admin-api-key.guard.js';
import { ProblemDetails } from '../../../shared/http/problem-details.js';
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

  @ApiProperty({ enum: ['DEBIT', 'CREDIT'] })
  normalBalance!: string;

  @ApiProperty({ example: 'ARS' })
  currency!: string;

  @ApiProperty({ example: '0.00' })
  debits!: string;

  @ApiProperty({ example: '10000.00' })
  credits!: string;

  @ApiProperty({ example: '10000.00', description: 'Saldo según la naturaleza de la cuenta' })
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
    summary: 'Balance de sumas y saldos por cuenta y moneda',
    description: 'Calculado en el momento a partir de los asientos; no existe un saldo guardado.',
  })
  @ApiOkResponse({ type: [AccountBalanceDto] })
  @ApiUnauthorizedResponse({ type: ProblemDetails })
  getBalances(): Promise<AccountBalance[]> {
    return this.balances.execute();
  }
}
