import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  PAYMENT_PROVIDERS,
  type PaymentProvider,
} from '../../../shared/domain/payment-provider.js';
import {
  PAYMENT_EVENT_TYPES,
  type PaymentEventType,
} from '../application/ingest-payment-webhook.use-case.js';

export class PayerDto {
  @ApiPropertyOptional({ example: 'Juan Pérez', maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    description:
      'DNI (7-8 digits) or CUIT (11 digits), without separators. A CUIT yields a type A ' +
      'invoice; anything else, a type B invoice (final consumer).',
    example: '30712345671',
  })
  @IsOptional()
  @Matches(/^(\d{7,8}|\d{11})$/, {
    message: 'taxId must be a DNI (7-8 digits) or CUIT (11 digits)',
  })
  taxId?: string;
}

export class PaymentDataDto {
  @ApiProperty({ description: 'Payment identifier in the gateway', example: 'pay_8f3a21' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  paymentId!: string;

  @ApiProperty({
    description:
      'Gross amount (VAT included) as a decimal string with up to 2 decimal places. It is ' +
      'transported as a string so that no precision is lost when the JSON is parsed.',
    example: '12100.00',
  })
  @Matches(/^\d{1,13}(\.\d{1,2})?$/, {
    message: 'amount must be a decimal string with up to 2 decimal places, e.g. "12100.00"',
  })
  amount!: string;

  @ApiProperty({ description: 'ISO 4217 currency code', example: 'ARS' })
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code, e.g. "ARS"' })
  currency!: string;

  @ApiPropertyOptional({ type: PayerDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PayerDto)
  payer?: PayerDto;

  @ApiPropertyOptional({ example: 'Pro plan subscription - November', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class PaymentWebhookDto {
  @ApiProperty({
    description: 'Idempotency key: unique identifier of the event in the gateway',
    example: 'evt_01JCD3K9Q2',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  eventId!: string;

  @ApiProperty({ enum: PAYMENT_PROVIDERS })
  @IsIn(PAYMENT_PROVIDERS)
  provider!: PaymentProvider;

  @ApiProperty({
    enum: PAYMENT_EVENT_TYPES,
    description: 'Only `payment.approved` produces a journal entry and an invoice',
  })
  @IsIn(PAYMENT_EVENT_TYPES)
  type!: PaymentEventType;

  @ApiPropertyOptional({ example: '2026-11-16T19:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  occurredAt?: string;

  @ApiProperty({ type: PaymentDataDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => PaymentDataDto)
  data!: PaymentDataDto;
}

export class WebhookAckDto {
  @ApiProperty({
    enum: ['accepted', 'duplicate', 'ignored'],
    description:
      '`accepted`: first delivery, payment booked. `duplicate`: redelivery with no effects. ' +
      '`ignored`: event type with no accounting effect, stored for audit only.',
  })
  status!: 'accepted' | 'duplicate' | 'ignored';

  @ApiProperty()
  eventId!: string;

  @ApiProperty({ format: 'uuid' })
  webhookEventId!: string;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Use it to query `GET /operations/{paymentId}`',
  })
  paymentId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  ledgerTransactionId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  invoiceId!: string | null;

  @ApiProperty()
  correlationId!: string;
}
