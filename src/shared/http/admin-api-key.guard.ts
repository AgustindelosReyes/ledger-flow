import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Env } from '../../config/env.js';

export const ADMIN_API_KEY_HEADER = 'x-api-key';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Protege los endpoints operativos (consulta del ledger, DLQ) con una API key estática. */
@Injectable()
export class AdminApiKeyGuard implements CanActivate {
  private readonly expectedDigest: Buffer;

  constructor(config: ConfigService<Env, true>) {
    this.expectedDigest = sha256(config.get('ADMIN_API_KEY', { infer: true }));
  }

  canActivate(context: ExecutionContext): boolean {
    const provided = context.switchToHttp().getRequest<Request>().header(ADMIN_API_KEY_HEADER);

    // Se comparan digests: tienen longitud fija (requisito de `timingSafeEqual`) y no se
    // filtra por timing ni el contenido ni el largo de la clave.
    if (provided === undefined || !timingSafeEqual(sha256(provided), this.expectedDigest)) {
      throw new UnauthorizedException('A valid API key is required');
    }
    return true;
  }
}
