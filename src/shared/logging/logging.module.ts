import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule, type Params } from 'nestjs-pino';
import type { Env } from '../../config/env.js';
import { assignCorrelationId } from '../http/correlation-id.js';

/**
 * Structured JSON logs (Pino). Every line emitted during a request carries its
 * `correlationId`, propagated by AsyncLocalStorage instead of being passed between layers.
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
          // Only the correlationId in application logs; the full request is logged
          // once, in the "request completed" line.
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
