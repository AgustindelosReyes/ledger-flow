import {
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
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  ADMIN_API_KEY_HEADER,
  AdminApiKeyGuard,
} from '../../../shared/http/admin-api-key.guard.js';
import { ProblemDetails } from '../../../shared/http/problem-details.js';
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

  @ApiProperty({ description: 'correlationId del webhook que originó la operación' })
  correlationId!: string;

  @ApiProperty({ description: 'Job de BullMQ cuyo último intento falló' })
  sourceJobId!: string;

  @ApiProperty({ example: 'HTTP_503', description: 'HTTP_503 | TIMEOUT | HTTP_400 | ...' })
  errorCode!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ description: 'Intentos acumulados de la factura' })
  attemptCount!: number;

  @ApiProperty({ format: 'date-time' })
  deadLetteredAt!: string;

  @ApiProperty({ nullable: true, type: String })
  lastError!: string | null;
}

class RetryAcceptedDto {
  @ApiProperty({ enum: ['requeued'] })
  status!: 'requeued';

  @ApiProperty({ format: 'uuid' })
  invoiceId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Mensaje de outbox creado; su id será el jobId del nuevo job',
  })
  outboxEventId!: string;

  @ApiProperty()
  correlationId!: string;
}

@ApiTags('admin')
@ApiSecurity(ADMIN_API_KEY_HEADER)
@ApiUnauthorizedResponse({ type: ProblemDetails })
@Controller('admin/dlq')
@UseGuards(AdminApiKeyGuard)
export class DeadLetterController {
  private readonly logger = new Logger(DeadLetterController.name);

  constructor(
    private readonly deadLetters: DeadLetterQuery,
    private readonly retryDeadLetteredInvoice: RetryDeadLetteredInvoiceUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Lista las facturas en falla definitiva (Dead Letter Queue)' })
  @ApiOkResponse({ type: [DeadLetterDto] })
  list(@Query() query: ListDeadLettersQueryDto): Promise<DeadLetterView[]> {
    return this.deadLetters.list(query.limit);
  }

  @Post(':invoiceId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Reencola manualmente una factura de la DLQ',
    description:
      'Idempotente: la factura vuelve a `PENDING` y se crea un mensaje de outbox en una ' +
      'única transacción. Repetir la llamada no genera un segundo job: devuelve 409 porque ' +
      'la factura ya no está en la DLQ.',
  })
  @ApiAcceptedResponse({ type: RetryAcceptedDto })
  @ApiNotFoundResponse({ type: ProblemDetails })
  @ApiConflictResponse({ type: ProblemDetails, description: 'La factura no está en la DLQ' })
  async retry(
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
  ): Promise<RetryAcceptedDto> {
    const result = await this.retryDeadLetteredInvoice.execute(invoiceId);
    this.logger.log(
      {
        invoiceId,
        outboxEventId: result.outboxEventId,
        originalCorrelationId: result.correlationId,
      },
      'Dead-lettered invoice requeued manually',
    );
    return { status: 'requeued', ...result };
  }
}
