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
  .setDescription('Motor asíncrono de facturación electrónica y conciliación de pagos')
  .setVersion('0.1.0')
  .addApiKey({ type: 'apiKey', in: 'header', name: ADMIN_API_KEY_HEADER }, ADMIN_API_KEY_HEADER)
  .build();
SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApiConfig));

const config = app.get<ConfigService<Env, true>>(ConfigService);
await app.listen(config.get('PORT', { infer: true }));
