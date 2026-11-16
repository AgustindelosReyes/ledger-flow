import { Body, Controller, HttpStatus, Post, RawBody, Res, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CorrelationId } from '../../../shared/http/correlation-id.js';
import { ProblemDetails } from '../../../shared/http/problem-details.js';
import { InvalidWebhookPayloadError } from '../application/errors.js';
import { IngestPaymentWebhookUseCase } from '../application/ingest-payment-webhook.use-case.js';
import { SIGNATURE_HEADER } from '../domain/webhook-signature.js';
import { PaymentWebhookDto, WebhookAckDto } from './payment-webhook.dto.js';
import { WebhookSignatureGuard } from './webhook-signature.guard.js';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly ingestPaymentWebhook: IngestPaymentWebhookUseCase) {}

  @Post('payments')
  @UseGuards(WebhookSignatureGuard)
  @ApiOperation({
    summary: 'Recibe un evento de pago de una pasarela',
    description:
      'Idempotente por `(provider, eventId)`: reentregas del mismo evento, incluso ' +
      'concurrentes, se contabilizan una sola vez. Un pago aprobado registra en una única ' +
      'transacción el evento, el pago, el asiento de doble partida, la factura pendiente y ' +
      'el mensaje de outbox que dispara la emisión fiscal asíncrona.',
  })
  @ApiHeader({
    name: SIGNATURE_HEADER,
    required: true,
    description:
      '`t=<unix seconds>,v1=<hex>` donde `v1 = HMAC-SHA256(secret, "<t>." + cuerpo crudo)`',
  })
  @ApiAcceptedResponse({ type: WebhookAckDto, description: 'Evento aceptado por primera vez' })
  @ApiOkResponse({
    type: WebhookAckDto,
    description: 'Evento duplicado (sin efectos) o de un tipo sin efecto contable',
  })
  @ApiBadRequestResponse({ type: ProblemDetails, description: 'Cuerpo inválido' })
  @ApiUnauthorizedResponse({ type: ProblemDetails, description: 'Firma ausente o inválida' })
  @ApiConflictResponse({
    type: ProblemDetails,
    description: 'El pago ya fue registrado por otro evento',
  })
  @ApiUnprocessableEntityResponse({
    type: ProblemDetails,
    description: 'El `eventId` ya fue recibido con un payload distinto, o importe inválido',
  })
  async receivePaymentEvent(
    @Body() body: PaymentWebhookDto,
    @RawBody() rawBody: Buffer | undefined,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WebhookAckDto> {
    if (rawBody === undefined) {
      throw new InvalidWebhookPayloadError('Webhook body must be sent as application/json');
    }

    const result = await this.ingestPaymentWebhook.execute({
      rawBody,
      correlationId,
      event: {
        eventId: body.eventId,
        provider: body.provider,
        type: body.type,
        payment: {
          externalPaymentId: body.data.paymentId,
          amount: body.data.amount,
          currency: body.data.currency,
          payerName: body.data.payer?.name,
          payerTaxId: body.data.payer?.taxId,
          description: body.data.description,
        },
      },
    });

    // 202: el pago quedó contabilizado, pero la factura se emite de forma asíncrona.
    response.status(result.status === 'accepted' ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return { ...result, correlationId };
  }
}
