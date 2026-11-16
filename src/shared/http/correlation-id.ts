import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Se acepta el id del cliente solo si es un token inocuo: va a parar a logs y a la base. */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * `genReqId` de pino-http: reutiliza el `x-correlation-id` entrante o genera uno, y lo
 * devuelve en la respuesta. Al ser el id del request, pino lo incluye en cada línea de log.
 */
export function assignCorrelationId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  const correlationId =
    typeof incoming === 'string' && SAFE_CORRELATION_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  return correlationId;
}

export function correlationIdOf(req: IncomingMessage): string | undefined {
  return typeof req.id === 'string' ? req.id : undefined;
}

/** Inyecta el correlationId del request en un handler. */
export const CorrelationId = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const correlationId = correlationIdOf(context.switchToHttp().getRequest<IncomingMessage>());
  if (correlationId === undefined) {
    throw new Error('Request has no correlation id: the logging middleware did not run');
  }
  return correlationId;
});
