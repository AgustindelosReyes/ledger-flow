import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule, type Params } from 'nestjs-pino';
import type { Env } from '../../config/env.js';
import { assignCorrelationId } from '../http/correlation-id.js';

/**
 * Logs JSON estructurados (Pino). Cada línea emitida durante un request lleva su
 * `correlationId`, propagado por AsyncLocalStorage sin pasarlo a mano entre capas.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Params => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          genReqId: assignCorrelationId,
          customAttributeKeys: { reqId: 'correlationId' },
          // Solo el correlationId en los logs de aplicación; el request completo se
          // registra una vez, en la línea de "request completed".
          quietReqLogger: true,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-signature"]',
              'req.headers["x-api-key"]',
            ],
            censor: '[REDACTED]',
          },
          autoLogging: { ignore: (req) => req.url === '/health' },
          ...(config.get('NODE_ENV', { infer: true }) === 'development'
            ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
            : {}),
        },
      }),
    }),
  ],
})
export class LoggingModule {}
