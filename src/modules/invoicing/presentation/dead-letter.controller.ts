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
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
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
import { CorrelationId } from '../../../shared/http/correlation-id.js';
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

class RetryDeadLetterDto {
  @ApiPropertyOptional({
    description:
      'Identificador fiscal corregido del receptor: DNI (7-8 dígitos) o CUIT (11 dígitos, ' +
      'con dígito verificador válido). Reemplaza al que provocó el rechazo del ente fiscal.',
    example: '30712345671',
  })
  @IsOptional()
  @Matches(/^(\d{7,8}|\d{11})$/, {
    message: 'payerTaxId must be a DNI (7-8 digits) or CUIT (11 digits)',
  })
  payerTaxId?: string;

  @ApiPropertyOptional({
    description: 'Motivo de la corrección, para la bitácora de auditoría',
    example: 'CUIT mal tipeado por el cliente; confirmado por soporte en el ticket #4821',
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

  @ApiProperty({ enum: ['A', 'B', 'C'], description: 'Clase de comprobante resultante' })
  invoiceType!: string;
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

  @ApiProperty({
    nullable: true,
    type: AppliedCorrectionDto,
    description: 'Corrección aplicada; null si se reencoló sin cambios',
  })
  correction!: AppliedCorrectionDto | null;
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
      'la factura ya no está en la DLQ. El cuerpo es opcional: permite corregir el dato ' +
      'fiscal que causó un rechazo permanente (400) del ente; la corrección se valida, se ' +
      'aplica y se registra en la bitácora de auditoría dentro de la misma transacción.',
  })
  @ApiBody({ type: RetryDeadLetterDto, required: false })
  @ApiAcceptedResponse({ type: RetryAcceptedDto })
  @ApiBadRequestResponse({ type: ProblemDetails, description: 'Cuerpo o identificador inválido' })
  @ApiNotFoundResponse({ type: ProblemDetails })
  @ApiConflictResponse({ type: ProblemDetails, description: 'La factura no está en la DLQ' })
  @ApiUnprocessableEntityResponse({
    type: ProblemDetails,
    description: 'La corrección no es válida (p. ej. CUIT con dígito verificador incorrecto)',
  })
  async retry(
    @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string,
    @CorrelationId() requestCorrelationId: string,
    // El tipo debe ser la clase (no una unión): es el metadato con el que el ValidationPipe
    // decide qué validar. Sin cuerpo en el request, el pipe entrega un DTO vacío.
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
