import { DomainError } from '../../../shared/domain/domain-error.js';
import type { PaymentProvider } from '../../../shared/domain/payment-provider.js';
import type { SignatureFailureReason } from '../domain/webhook-signature.js';

export class InvalidWebhookSignatureError extends DomainError {
  readonly code = 'INVALID_WEBHOOK_SIGNATURE';

  constructor(readonly reason: SignatureFailureReason) {
    super('Webhook signature verification failed');
  }
}

export class InvalidWebhookPayloadError extends DomainError {
  readonly code = 'INVALID_WEBHOOK_PAYLOAD';
}

/** La clave de idempotencia ya fue usada con un cuerpo distinto: no es un reintento legítimo. */
export class IdempotencyPayloadMismatchError extends DomainError {
  readonly code = 'IDEMPOTENCY_PAYLOAD_MISMATCH';

  constructor(provider: PaymentProvider, eventId: string) {
    super(
      `Event "${eventId}" from ${provider} was already received with a different payload. ` +
        'An idempotency key must always identify the same payload.',
    );
  }
}

/** Un evento distinto intenta registrar un pago que ya fue contabilizado. */
export class PaymentAlreadyRecordedError extends DomainError {
  readonly code = 'PAYMENT_ALREADY_RECORDED';

  constructor(provider: PaymentProvider, externalPaymentId: string) {
    super(`Payment "${externalPaymentId}" from ${provider} was already recorded by another event`);
  }
}
