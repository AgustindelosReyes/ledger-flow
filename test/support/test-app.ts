import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { APP_OPTIONS } from '../../src/app.options.js';
import { FaultInjector } from '../../src/modules/invoicing/infrastructure/fiscal-simulator/fault-injector.js';
import type { Env } from '../../src/config/env.js';
import {
  SIGNATURE_HEADER,
  signWebhookPayload,
} from '../../src/modules/webhooks/domain/webhook-signature.js';
import { ADMIN_API_KEY_HEADER } from '../../src/shared/http/admin-api-key.guard.js';
import { PrismaService } from '../../src/shared/infrastructure/prisma/prisma.service.js';
import { RuntimeRoles } from '../../src/shared/runtime/runtime-roles.js';

export interface PaymentEventBody {
  eventId: string;
  provider: 'MERCADOPAGO' | 'STRIPE';
  type: string;
  data: {
    paymentId: string;
    amount: unknown;
    currency: string;
    payer?: { name?: string; taxId?: string };
    description?: string;
  };
}

interface SendOptions {
  /** Signature to send. By default, a valid signature over the exact bytes of the body. */
  readonly signature?: string | null;
  readonly timestampSeconds?: number;
  readonly correlationId?: string;
}

export interface TestAppOptions {
  /**
   * Runs the outbox relay and the fiscal worker. Off by default: the ingestion tests
   * observe the exact state left by the webhook transaction.
   */
  readonly background?: boolean;
  /** Fault script for the simulated fiscal authority. */
  readonly faults?: FaultInjector;
}

export interface TestApp {
  readonly app: INestApplication<App>;
  readonly prisma: PrismaService;
  readonly adminHeaders: Record<string, string>;
  sign(rawBody: string, timestampSeconds?: number): string;
  /** Sends `rawBody` as is, byte for byte, to `POST /webhooks/payments`. */
  sendWebhook(rawBody: string, options?: SendOptions): request.Test;
  /**
   * Marks as published the outbox messages left by other test files, so that this one
   * only sees its own.
   */
  discardPendingOutbox(): Promise<void>;
  close(): Promise<void>;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Approved payment event with unique identifiers: tests share no state. */
export function buildPaymentEvent(overrides: Partial<PaymentEventBody> = {}): PaymentEventBody {
  return {
    eventId: `evt_${randomUUID()}`,
    provider: 'MERCADOPAGO',
    type: 'payment.approved',
    data: {
      paymentId: `pay_${randomUUID()}`,
      amount: '12100.00',
      currency: 'ARS',
      payer: { name: 'Juan Pérez', taxId: '30111222' },
      description: 'Plan Pro',
    },
    ...overrides,
  };
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const background = options.background ?? false;
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RuntimeRoles)
    .useValue({ outboxRelay: background, invoiceWorker: background });
  if (options.faults !== undefined) {
    builder = builder.overrideProvider(FaultInjector).useValue(options.faults);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>(APP_OPTIONS);
  app.useLogger(app.get(Logger));
  // Real port: concurrent requests must arrive through independent sockets.
  await app.listen(0);

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const secret = config.get('WEBHOOK_SIGNING_SECRET', { infer: true });

  const sign = (rawBody: string, timestampSeconds = nowSeconds()): string =>
    signWebhookPayload(secret, timestampSeconds, Buffer.from(rawBody, 'utf8'));

  const prisma = app.get(PrismaService);

  return {
    app,
    prisma,
    adminHeaders: { [ADMIN_API_KEY_HEADER]: config.get('ADMIN_API_KEY', { infer: true }) },
    sign,
    sendWebhook(rawBody, sendOptions = {}) {
      const signature =
        sendOptions.signature === undefined
          ? sign(rawBody, sendOptions.timestampSeconds)
          : sendOptions.signature;

      let call = request(app.getHttpServer())
        .post('/webhooks/payments')
        .set('content-type', 'application/json');
      if (signature !== null) {
        call = call.set(SIGNATURE_HEADER, signature);
      }
      if (sendOptions.correlationId !== undefined) {
        call = call.set('x-correlation-id', sendOptions.correlationId);
      }
      return call.send(rawBody);
    },
    async discardPendingOutbox() {
      await prisma.outboxEvent.updateMany({
        where: { status: 'PENDING' },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    },
    close: () => app.close(),
  };
}
