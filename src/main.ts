import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

const app = await NestFactory.create(AppModule);

app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
);
app.enableShutdownHooks();

const openApiConfig = new DocumentBuilder()
  .setTitle('LedgerFlow')
  .setDescription('Motor asíncrono de facturación electrónica y conciliación de pagos')
  .setVersion('0.1.0')
  .build();
SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApiConfig));

const config = app.get<ConfigService<Env, true>>(ConfigService);
await app.listen(config.get('PORT', { infer: true }));
