import { ApiProperty } from '@nestjs/swagger';

const nullable = { nullable: true } as const;

export class TraceWebhookEventDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  provider!: string;

  @ApiProperty({ description: 'Clave de idempotencia recibida de la pasarela' })
  eventId!: string;

  @ApiProperty()
  eventType!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ format: 'date-time' })
  receivedAt!: string;
}

export class TracePaymentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  externalPaymentId!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ example: '12100.00' })
  amount!: string;

  @ApiProperty({ example: 'ARS' })
  currency!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class TraceLedgerEntryDto {
  @ApiProperty({ example: 'SALES_REVENUE' })
  accountCode!: string;

  @ApiProperty({ enum: ['DEBIT', 'CREDIT'] })
  direction!: string;

  @ApiProperty({ example: '10000.00' })
  amount!: string;

  @ApiProperty()
  currency!: string;
}

export class TraceLedgerTransactionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  type!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ format: 'date-time' })
  postedAt!: string;

  @ApiProperty({ type: [TraceLedgerEntryDto] })
  entries!: TraceLedgerEntryDto[];
}

export class TraceInvoiceAttemptDto {
  @ApiProperty()
  attemptNumber!: number;

  @ApiProperty({ description: 'Job de BullMQ que ejecutó el intento' })
  jobId!: string;

  @ApiProperty({ enum: ['SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE'] })
  outcome!: string;

  @ApiProperty({ ...nullable, type: Number, description: 'null si no hubo respuesta (timeout)' })
  httpStatus!: number | null;

  @ApiProperty({ ...nullable, type: String })
  errorCode!: string | null;

  @ApiProperty({ ...nullable, type: String })
  errorMessage!: string | null;

  @ApiProperty({ ...nullable, type: Object, description: 'Respuesta del ente fiscal' })
  response!: unknown;

  @ApiProperty({ description: 'Latencia del intento en milisegundos' })
  durationMs!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class TraceInvoiceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['PENDING', 'PROCESSING', 'ISSUED', 'DEAD_LETTERED'] })
  status!: string;

  @ApiProperty({ enum: ['A', 'B', 'C'] })
  type!: string;

  @ApiProperty()
  pointOfSale!: number;

  @ApiProperty({ ...nullable, type: Number })
  number!: number | null;

  @ApiProperty({ ...nullable, type: String, description: 'CAE: presente solo si fue emitida' })
  cae!: string | null;

  @ApiProperty({ ...nullable, type: String, format: 'date' })
  caeExpiresAt!: string | null;

  @ApiProperty()
  netAmount!: string;

  @ApiProperty()
  taxAmount!: string;

  @ApiProperty()
  totalAmount!: string;

  @ApiProperty()
  currency!: string;

  @ApiProperty()
  attemptCount!: number;

  @ApiProperty({ ...nullable, type: String })
  lastError!: string | null;

  @ApiProperty({ ...nullable, type: String, format: 'date-time' })
  issuedAt!: string | null;

  @ApiProperty({ type: [TraceInvoiceAttemptDto] })
  attempts!: TraceInvoiceAttemptDto[];
}

export class TraceQueueJobDto {
  @ApiProperty({ format: 'uuid', description: 'Mensaje de outbox; su id es también el jobId' })
  outboxEventId!: string;

  @ApiProperty({ enum: ['PENDING', 'PUBLISHED', 'FAILED'] })
  outboxStatus!: string;

  @ApiProperty({ format: 'date-time' })
  requestedAt!: string;

  @ApiProperty({ ...nullable, type: String, format: 'date-time' })
  publishedAt!: string | null;

  @ApiProperty({
    ...nullable,
    type: String,
    description:
      'Estado del job en BullMQ (waiting, active, delayed, completed, failed); null si aún ' +
      'no se publicó o si ya venció su retención',
  })
  jobState!: string | null;

  @ApiProperty({ ...nullable, type: Number })
  attemptsMade!: number | null;

  @ApiProperty({ ...nullable, type: String })
  failedReason!: string | null;
}

export class TraceDeadLetterDto {
  @ApiProperty()
  errorCode!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ format: 'date-time' })
  deadLetteredAt!: string;
}

export class TraceQueueDto {
  @ApiProperty({ type: [TraceQueueJobDto] })
  jobs!: TraceQueueJobDto[];

  @ApiProperty({ ...nullable, type: TraceDeadLetterDto })
  deadLetter!: TraceDeadLetterDto | null;
}

export class OperationTraceDto {
  @ApiProperty({ description: 'Enlaza los logs de toda la operación, del webhook al worker' })
  correlationId!: string;

  @ApiProperty({ type: TraceWebhookEventDto })
  webhookEvent!: TraceWebhookEventDto;

  @ApiProperty({ type: TracePaymentDto })
  payment!: TracePaymentDto;

  @ApiProperty({ type: [TraceLedgerTransactionDto] })
  ledgerTransactions!: TraceLedgerTransactionDto[];

  @ApiProperty({ ...nullable, type: TraceInvoiceDto })
  invoice!: TraceInvoiceDto | null;

  @ApiProperty({ type: TraceQueueDto })
  queue!: TraceQueueDto;
}
