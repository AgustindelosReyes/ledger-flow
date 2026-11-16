import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ADMIN_API_KEY_HEADER, AdminApiKeyGuard } from '../../shared/http/admin-api-key.guard.js';
import { ApiProblemResponse } from '../../shared/http/api-problem-response.js';
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
    summary: 'End-to-end trace of an operation',
    description:
      'Webhook event -> payment -> journal entries -> invoice -> every attempt against the ' +
      'fiscal authority -> live state of the job in the queue and in the dead letter queue. ' +
      'Combines PostgreSQL (source of truth) with Redis (live job state).',
  })
  @ApiOkResponse({ type: OperationTraceDto })
  @ApiProblemResponse(400, 'Malformed payment id')
  @ApiProblemResponse(401, 'Missing or invalid API key')
  @ApiProblemResponse(404, 'No operation exists for that payment id')
  getTrace(@Param('paymentId', new ParseUUIDPipe()) paymentId: string): Promise<OperationTraceDto> {
    return this.trace.execute(paymentId);
  }
}
