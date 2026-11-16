import {
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
  type RawBodyRequest,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Env } from '../../../config/env.js';
import { InvalidWebhookSignatureError } from '../application/errors.js';
import { SIGNATURE_HEADER, verifyWebhookSignature } from '../domain/webhook-signature.js';

/**
 * Autentica el webhook antes de validar o procesar el cuerpo. La firma se calcula sobre
 * `req.rawBody` (los bytes recibidos), no sobre el objeto ya parseado.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);
  private readonly secret: string;
  private readonly toleranceSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    this.secret = config.get('WEBHOOK_SIGNING_SECRET', { infer: true });
    this.toleranceSeconds = config.get('WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RawBodyRequest<Request>>();

    const verification = verifyWebhookSignature({
      header: request.header(SIGNATURE_HEADER),
      // Sin cuerpo crudo (p. ej. content-type no JSON) la firma no puede coincidir.
      rawBody: request.rawBody ?? Buffer.alloc(0),
      secret: this.secret,
      toleranceSeconds: this.toleranceSeconds,
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    if (!verification.valid) {
      // El motivo queda en logs para operaciones; al emisor se le responde un 401 genérico.
      this.logger.warn({ reason: verification.reason }, 'Webhook signature rejected');
      throw new InvalidWebhookSignatureError(verification.reason);
    }
    return true;
  }
}
