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
    description: 'DNI (7-8 dígitos) o CUIT (11 dígitos), sin separadores',
    example: '20304050607',
  })
  @IsOptional()
  @Matches(/^(\d{7,8}|\d{11})$/, {
    message: 'taxId must be a DNI (7-8 digits) or CUIT (11 digits)',
  })
  taxId?: string;
}

export class PaymentDataDto {
  @ApiProperty({ description: 'Identificador del pago en la pasarela', example: 'pay_8f3a21' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  paymentId!: string;

  @ApiProperty({
    description:
      'Importe total (IVA incluido) como string decimal con hasta 2 decimales. ' +
      'Se transporta como string para no perder precisión en el parseo de JSON.',
    example: '12100.00',
  })
  @Matches(/^\d{1,13}(\.\d{1,2})?$/, {
    message: 'amount must be a decimal string with up to 2 decimal places, e.g. "12100.00"',
  })
  amount!: string;

  @ApiProperty({ description: 'Código ISO 4217', example: 'ARS' })
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO 4217 code, e.g. "ARS"' })
  currency!: string;

  @ApiPropertyOptional({ type: PayerDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PayerDto)
  payer?: PayerDto;

  @ApiPropertyOptional({ example: 'Suscripción plan Pro — noviembre', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class PaymentWebhookDto {
  @ApiProperty({
    description: 'Clave de idempotencia: identificador único del evento en la pasarela',
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
    description: 'Solo `payment.approved` genera asiento contable y factura',
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
      '`accepted`: primera recepción, pago contabilizado. `duplicate`: reentrega sin efectos. ' +
      '`ignored`: tipo de evento sin efecto contable.',
  })
  status!: 'accepted' | 'duplicate' | 'ignored';

  @ApiProperty()
  eventId!: string;

  @ApiProperty({ format: 'uuid' })
  webhookEventId!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  paymentId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  ledgerTransactionId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  invoiceId!: string | null;

  @ApiProperty()
  correlationId!: string;
}
