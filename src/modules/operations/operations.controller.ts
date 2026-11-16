import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ADMIN_API_KEY_HEADER, AdminApiKeyGuard } from '../../shared/http/admin-api-key.guard.js';
import { ProblemDetails } from '../../shared/http/problem-details.js';
import { OperationTraceDto } from './operation-trace.dto.js';
import { OperationTraceQuery } from './operation-trace.query.js';

@ApiTags('operations')
@ApiSecurity(ADMIN_API_KEY_HEADER)
@Controller('operations')
@UseGuards(AdminApiKeyGuard)
export class OperationsController {
  constructor(private readonly trace: OperationTraceQuery) {}

  @Get(':paymentId')
  @ApiOperation({
    summary: 'Trazabilidad completa de una operación',
    description:
      'Webhook -> pago -> asientos contables -> factura -> intentos ante el ente fiscal -> ' +
      'estado del job en la cola y en la DLQ.',
  })
  @ApiOkResponse({ type: OperationTraceDto })
  @ApiUnauthorizedResponse({ type: ProblemDetails })
  @ApiNotFoundResponse({ type: ProblemDetails })
  getTrace(@Param('paymentId', new ParseUUIDPipe()) paymentId: string): Promise<OperationTraceDto> {
    return this.trace.execute(paymentId);
  }
}
