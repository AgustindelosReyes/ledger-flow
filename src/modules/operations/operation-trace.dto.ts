import { ApiProperty } from '@nestjs/swagger';

const nullable = { nullable: true } as const;

export class TraceWebhookEventDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  provider!: string;

  @ApiProperty({ description: 'Idempotency key received from the gateway' })
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

  @ApiProperty({ description: 'BullMQ job that ran the attempt' })
  jobId!: string;

  @ApiProperty({ enum: ['SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE'] })
  outcome!: string;

  @ApiProperty({
    ...nullable,
    type: Number,
    description: 'null when there was no response (timeout)',
  })
  httpStatus!: number | null;

  @ApiProperty({ ...nullable, type: String })
  errorCode!: string | null;

  @ApiProperty({ ...nullable, type: String })
  errorMessage!: string | null;

  @ApiProperty({ ...nullable, type: Object, description: 'Response of the fiscal authority' })
  response!: unknown;

  @ApiProperty({ description: 'Latency of the attempt in milliseconds' })
  durationMs!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class TraceInvoiceCorrectionDto {
  @ApiProperty({ example: 'payerTaxId' })
  field!: string;

  @ApiProperty({ ...nullable, type: String })
  previousValue!: string | null;

  @ApiProperty()
  newValue!: string;

  @ApiProperty({ ...nullable, type: String })
  reason!: string | null;

  @ApiProperty({ description: 'Correlation id of the admin request that applied it' })
  correlationId!: string;

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

  @ApiProperty({
    ...nullable,
    type: String,
    description: 'Authorization code (CAE): present only once issued',
  })
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

  @ApiProperty({
    type: [TraceInvoiceCorrectionDto],
    description: 'Manual corrections of fiscal data applied when retrying from the DLQ',
  })
  corrections!: TraceInvoiceCorrectionDto[];
}

export class TraceQueueJobDto {
  @ApiProperty({ format: 'uuid', description: 'Outbox message; its id is also the BullMQ job id' })
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
      'Job state in BullMQ (waiting, active, delayed, completed, failed); null if it has ' +
      'not been published yet or its retention expired',
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
  @ApiProperty({
    description: 'Links every log line of the operation, from the webhook to the worker',
  })
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
