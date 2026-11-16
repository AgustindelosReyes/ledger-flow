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
