import { Body, Controller, HttpStatus, Post, RawBody, Res, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiProblemResponse } from '../../../shared/http/api-problem-response.js';
import { CORRELATION_ID_HEADER, CorrelationId } from '../../../shared/http/correlation-id.js';
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
    summary: 'Receive a payment event from a payment gateway',
    description:
      'Idempotent by `(provider, eventId)`: redeliveries of the same event, even concurrent ' +
      'ones, are booked exactly once. An approved payment writes the event, the payment, the ' +
      'double-entry journal entry, the pending invoice and the outbox message that triggers ' +
      'asynchronous fiscal issuance, all in a single database transaction.',
  })
  @ApiHeader({
    name: SIGNATURE_HEADER,
    required: true,
    description:
      '`t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>." + raw request body)`. ' +
      'The signature is verified against the exact bytes received, in constant time, and ' +
      'the timestamp must fall within the tolerance window (replay protection).',
    example: 't=1794857064,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd',
  })
  @ApiHeader({
    name: CORRELATION_ID_HEADER,
    required: false,
    description:
      'Optional correlation id (8-64 chars of `[A-Za-z0-9._-]`). Generated when absent, echoed ' +
      'in the response and attached to every log line of the operation, including the ' +
      'asynchronous worker.',
  })
  @ApiAcceptedResponse({
    type: WebhookAckDto,
    description: 'Event accepted for the first time; the invoice will be issued asynchronously',
  })
  @ApiOkResponse({
    type: WebhookAckDto,
    description: 'Duplicate delivery (no effects) or an event type with no accounting effect',
  })
  @ApiProblemResponse(400, 'Malformed JSON or a body that fails validation')
  @ApiProblemResponse(401, 'Missing, malformed, expired or mismatching signature')
  @ApiProblemResponse(409, 'The payment was already recorded by a different event')
  @ApiProblemResponse(
    422,
    'The `eventId` was already received with a different payload, or the amount is invalid',
  )
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

    // 202: the payment is booked, but the invoice is issued asynchronously.
    response.status(result.status === 'accepted' ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return { ...result, correlationId };
  }
}
