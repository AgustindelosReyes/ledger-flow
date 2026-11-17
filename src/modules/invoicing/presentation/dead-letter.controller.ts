import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ADMIN_API_KEY_HEADER,
  AdminApiKeyGuard,
} from '../../../shared/http/admin-api-key.guard.js';
import { ApiProblemResponse } from '../../../shared/http/api-problem-response.js';
import { CorrelationId } from '../../../shared/http/correlation-id.js';
import { RetryDeadLetteredInvoiceUseCase } from '../application/retry-dead-lettered-invoice.use-case.js';
import { DeadLetterQuery, type DeadLetterView } from '../infrastructure/dead-letter.query.js';

class ListDeadLettersQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;
}

class DeadLetterDto implements DeadLetterView {
  @ApiProperty({ format: 'uuid' })
  invoiceId!: string;

  @ApiProperty({ format: 'uuid' })
  paymentId!: string;

  @ApiProperty({ description: 'Correlation id of the webhook that started the operation' })
  correlationId!: string;

  @ApiProperty({ description: 'BullMQ job whose last attempt failed' })
  sourceJobId!: string;

  @ApiProperty({
    example: 'HTTP_503',
    description:
      '`HTTP_503` / `TIMEOUT`: retries exhausted on a transient failure. `HTTP_400`: permanent ' +
      'rejection by the fiscal authority.',
  })
  errorCode!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ description: 'Attempts accumulated by the invoice across all its jobs' })
  attemptCount!: number;

  @ApiProperty({ format: 'date-time' })
  deadLetteredAt!: string;

  @ApiProperty({ nullable: true, type: String })
  lastError!: string | null;
}

class RetryDeadLetterDto {
  @ApiPropertyOptional({
    description:
      'Corrected tax id of the payer: DNI (7-8 digits) or CUIT (11 digits with a valid check ' +
      'digit). It replaces the one that made the fiscal authority reject the invoice.',
    example: '30712345671',
  })
  @IsOptional()
  @Matches(/^(\d{7,8}|\d{11})$/, {
    message: 'payerTaxId must be a DNI (7-8 digits) or CUIT (11 digits)',
  })
  payerTaxId?: string;

  @ApiPropertyOptional({
    description: 'Why the data is being corrected; stored in the audit log with `payerTaxId`',
    example: 'CUIT mistyped by the customer; confirmed by support in ticket #4821',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}

class AppliedCorrectionDto {
  @ApiProperty({ enum: ['payerTaxId'] })
  field!: 'payerTaxId';

  @ApiProperty({ nullable: true, type: String })
  previousValue!: string | null;

  @ApiProperty()
  newValue!: string;

  @ApiProperty({ enum: ['A', 'B', 'C'], description: 'Resulting invoice type' })
  invoiceType!: string;
}

class RetryAcceptedDto {
  @ApiProperty({ enum: ['requeued'] })
  status!: 'requeued';

  @ApiProperty({ format: 'uuid' })
  invoiceId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Outbox message created by the retry; its id becomes the id of the new job',
  })
  outboxEventId!: string;

  @ApiProperty({ description: 'Correlation id of the original webhook: the trace continues' })
  correlationId!: string;

  @ApiProperty({
    nullable: true,
    type: AppliedCorrectionDto,
    description: 'Correction applied; null when the invoice was requeued unchanged',
  })
  correction!: AppliedCorrectionDto | null;
}

@ApiTags('admin')
@ApiSecurity(ADMIN_API_KEY_HEADER)
@ApiProblemResponse(401, 'Missing or invalid API key')
@Controller('admin/dlq')
@UseGuards(AdminApiKeyGuard)
export class DeadLetterController {
  private readonly logger = new Logger(DeadLetterController.name);

  constructor(
    private readonly deadLetters: DeadLetterQuery,
    private readonly retryDeadLetteredInvoice: RetryDeadLetteredInvoiceUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List invoices in the dead letter queue',
    description:
      'Invoices that failed permanently: either the retries were exhausted on transient ' +
      'failures, or the fiscal authority rejected the data.',
  })
  @ApiOkResponse({ type: [DeadLetterDto] })
  @ApiProblemResponse(400, 'Invalid `limit`')
  list(@Query() query: ListDeadLettersQueryDto): Promise<DeadLetterView[]> {
    return this.deadLetters.list(query.limit);
  }

  @Post(':invoiceId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Manually requeue a dead-lettered invoice',
    description:
      'Idempotent: the invoice goes back to `PENDING` and an outbox message is created in a ' +
      'single transaction. Repeating the call cannot create a second job: it returns 409 ' +
      'because the invoice is no longer dead-lettered.\n\n' +
      'The body is optional. It lets an operator fix the fiscal data that caused a permanent ' +
      'rejection (400): the correction is validated first, then applied and written to an ' +
      'append-only audit log in the same transaction as the requeue.',
  })
  @ApiBody({ type: RetryDeadLetterDto, required: false })
  @ApiAcceptedResponse({ type: RetryAcceptedDto })
  @ApiProblemResponse(400, 'Malformed invoice id or body')
  @ApiProblemResponse(404, 'The invoice does not exist')
  @ApiProblemResponse(409, 'The invoice is not in the dead letter queue')
  @ApiProblemResponse(422, 'Invalid correction, e.g. a CUIT with a wrong check digit')
  async retry(
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @CorrelationId() requestCorrelationId: string,
    // The type must be the class (not a union): it is the metadata the ValidationPipe uses to
    // decide what to validate. With no request body, the pipe hands over an empty DTO.
    @Body() body: RetryDeadLetterDto,
  ): Promise<RetryAcceptedDto> {
    const result = await this.retryDeadLetteredInvoice.execute({
      invoiceId,
      requestCorrelationId,
      ...(body.payerTaxId === undefined
        ? {}
        : { correction: { payerTaxId: body.payerTaxId, reason: body.reason } }),
    });
    this.logger.log(
      {
        invoiceId,
        outboxEventId: result.outboxEventId,
        originalCorrelationId: result.correlationId,
        correction: result.correction,
      },
      'Dead-lettered invoice requeued manually',
    );
    return { status: 'requeued', ...result };
  }
}
