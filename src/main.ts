import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { APP_OPTIONS } from './app.options.js';
import type { Env } from './config/env.js';
import { ADMIN_API_KEY_HEADER } from './shared/http/admin-api-key.guard.js';

const app = await NestFactory.create(AppModule, APP_OPTIONS);

app.useLogger(app.get(Logger));
app.enableShutdownHooks();

const openApiConfig = new DocumentBuilder()
  .setTitle('LedgerFlow')
  .setDescription(
    'Asynchronous engine for electronic invoicing and payment reconciliation.\n\n' +
      'Every error is returned as `application/problem+json` (RFC 7807) and every response ' +
      'carries an `x-correlation-id` header that links the logs of the whole operation.',
  )
  .setVersion('0.1.0')
  .addTag('webhooks', 'Signed, idempotent ingestion of payment gateway events')
  .addTag('operations', 'End-to-end traceability for reconciliation')
  .addTag('ledger', 'Immutable double-entry ledger')
  .addTag('admin', 'Dead letter queue inspection and manual retries')
  .addTag('health', 'Probes')
  .addApiKey(
    {
      type: 'apiKey',
      in: 'header',
      name: ADMIN_API_KEY_HEADER,
      description:
        'Value of ADMIN_API_KEY. Required by the ledger, operations and admin endpoints.',
    },
    ADMIN_API_KEY_HEADER,
  )
  .build();
SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApiConfig));

const config = app.get<ConfigService<Env, true>>(ConfigService);
await app.listen(config.get('PORT', { infer: true }));
