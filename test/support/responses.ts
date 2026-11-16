import type { Response } from 'supertest';
import { z } from 'zod';

// `response.body` de supertest es `any`. Estos parsers lo convierten en un valor tipado y,
// de paso, verifican el contrato de cada respuesta.

const ackSchema = z.strictObject({
  status: z.enum(['accepted', 'duplicate', 'ignored']),
  eventId: z.string(),
  webhookEventId: z.uuid(),
  paymentId: z.uuid().nullable(),
  ledgerTransactionId: z.uuid().nullable(),
  invoiceId: z.uuid().nullable(),
  correlationId: z.string(),
});

const problemSchema = z.strictObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  correlationId: z.string().optional(),
  errors: z.array(z.strictObject({ field: z.string(), messages: z.array(z.string()) })).optional(),
});

const balancesSchema = z.array(
  z.strictObject({
    accountCode: z.string(),
    accountName: z.string(),
    accountType: z.string(),
    normalBalance: z.enum(['DEBIT', 'CREDIT']),
    currency: z.string(),
    debits: z.string(),
    credits: z.string(),
    balance: z.string(),
  }),
);

export type Ack = z.infer<typeof ackSchema>;
export type AcceptedAck = Ack & {
  paymentId: string;
  ledgerTransactionId: string;
  invoiceId: string;
};
export type ProblemBody = z.infer<typeof problemSchema>;
export type BalanceRow = z.infer<typeof balancesSchema>[number];

export function ackOf(response: Response): Ack {
  return ackSchema.parse(response.body);
}

/** Ack de un pago contabilizado: todos los identificadores están presentes. */
export function acceptedAckOf(response: Response): AcceptedAck {
  const { paymentId, ledgerTransactionId, invoiceId, ...rest } = ackOf(response);
  if (paymentId === null || ledgerTransactionId === null || invoiceId === null) {
    throw new Error(`Expected an ack with payment identifiers, got status "${rest.status}"`);
  }
  return { ...rest, paymentId, ledgerTransactionId, invoiceId };
}

export function problemOf(response: Response): ProblemBody {
  return problemSchema.parse(response.body);
}

export function balancesOf(response: Response): BalanceRow[] {
  return balancesSchema.parse(response.body);
}

const traceSchema = z.strictObject({
  correlationId: z.string(),
  webhookEvent: z.strictObject({
    id: z.uuid(),
    provider: z.string(),
    eventId: z.string(),
    eventType: z.string(),
    status: z.string(),
    receivedAt: z.iso.datetime(),
  }),
  payment: z.strictObject({
    id: z.uuid(),
    externalPaymentId: z.string(),
    status: z.string(),
    amount: z.string(),
    currency: z.string(),
    createdAt: z.iso.datetime(),
  }),
  ledgerTransactions: z.array(
    z.strictObject({
      id: z.uuid(),
      type: z.string(),
      description: z.string(),
      postedAt: z.iso.datetime(),
      entries: z.array(
        z.strictObject({
          accountCode: z.string(),
          direction: z.enum(['DEBIT', 'CREDIT']),
          amount: z.string(),
          currency: z.string(),
        }),
      ),
    }),
  ),
  invoice: z
    .strictObject({
      id: z.uuid(),
      status: z.enum(['PENDING', 'PROCESSING', 'ISSUED', 'DEAD_LETTERED']),
      type: z.string(),
      pointOfSale: z.number().int(),
      number: z.number().int().nullable(),
      cae: z.string().nullable(),
      caeExpiresAt: z.iso.date().nullable(),
      netAmount: z.string(),
      taxAmount: z.string(),
      totalAmount: z.string(),
      currency: z.string(),
      attemptCount: z.number().int(),
      lastError: z.string().nullable(),
      issuedAt: z.iso.datetime().nullable(),
      attempts: z.array(
        z.strictObject({
          attemptNumber: z.number().int(),
          jobId: z.string(),
          outcome: z.enum(['SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE']),
          httpStatus: z.number().int().nullable(),
          errorCode: z.string().nullable(),
          errorMessage: z.string().nullable(),
          response: z.record(z.string(), z.unknown()).nullable(),
          durationMs: z.number().int().nonnegative(),
          createdAt: z.iso.datetime(),
        }),
      ),
      corrections: z.array(
        z.strictObject({
          field: z.string(),
          previousValue: z.string().nullable(),
          newValue: z.string(),
          reason: z.string().nullable(),
          correlationId: z.string(),
          createdAt: z.iso.datetime(),
        }),
      ),
    })
    .nullable(),
  queue: z.strictObject({
    jobs: z.array(
      z.strictObject({
        outboxEventId: z.uuid(),
        outboxStatus: z.enum(['PENDING', 'PUBLISHED', 'FAILED']),
        requestedAt: z.iso.datetime(),
        publishedAt: z.iso.datetime().nullable(),
        jobState: z.string().nullable(),
        attemptsMade: z.number().int().nullable(),
        failedReason: z.string().nullable(),
      }),
    ),
    deadLetter: z
      .strictObject({ errorCode: z.string(), reason: z.string(), deadLetteredAt: z.iso.datetime() })
      .nullable(),
  }),
});

const deadLettersSchema = z.array(
  z.strictObject({
    invoiceId: z.uuid(),
    paymentId: z.uuid(),
    correlationId: z.string(),
    sourceJobId: z.string(),
    errorCode: z.string(),
    reason: z.string(),
    attemptCount: z.number().int(),
    deadLetteredAt: z.iso.datetime(),
    lastError: z.string().nullable(),
  }),
);

const retryAcceptedSchema = z.strictObject({
  status: z.literal('requeued'),
  invoiceId: z.uuid(),
  outboxEventId: z.uuid(),
  correlationId: z.string(),
  correction: z
    .strictObject({
      field: z.literal('payerTaxId'),
      previousValue: z.string().nullable(),
      newValue: z.string(),
      invoiceType: z.enum(['A', 'B', 'C']),
    })
    .nullable(),
});

export type OperationTrace = z.infer<typeof traceSchema>;
export type DeadLetter = z.infer<typeof deadLettersSchema>[number];

export function traceOf(response: Response): OperationTrace {
  return traceSchema.parse(response.body);
}

export function deadLettersOf(response: Response): DeadLetter[] {
  return deadLettersSchema.parse(response.body);
}

export function retryAcceptedOf(response: Response): z.infer<typeof retryAcceptedSchema> {
  return retryAcceptedSchema.parse(response.body);
}
