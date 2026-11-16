import { z } from 'zod';

/** Cola principal: emisión de comprobantes ante el ente fiscal. */
export const FISCAL_INVOICE_QUEUE = 'fiscal-invoices';
/** Dead Letter Queue: comprobantes en falla definitiva, a la espera de reencolado manual. */
export const FISCAL_INVOICE_DLQ = 'fiscal-invoices-dlq';

export const ISSUE_INVOICE_JOB = 'issue-invoice';
export const DEAD_LETTER_JOB = 'dead-letter';

/** Tipo de mensaje de outbox que el relay traduce en un job `issue-invoice`. */
export const INVOICE_REQUESTED_EVENT = 'invoice.requested';

export const invoiceRequestedPayloadSchema = z.object({
  invoiceId: z.uuid(),
  paymentId: z.uuid(),
});

/** El `correlationId` del webhook original viaja en el job para enlazar los logs. */
export const issueInvoiceJobDataSchema = invoiceRequestedPayloadSchema.extend({
  correlationId: z.string().min(1),
});

export type IssueInvoiceJobData = z.infer<typeof issueInvoiceJobDataSchema>;

export const deadLetterEntrySchema = issueInvoiceJobDataSchema.extend({
  sourceJobId: z.string(),
  errorCode: z.string(),
  reason: z.string(),
  attemptCount: z.number().int(),
  deadLetteredAt: z.iso.datetime(),
});

export type DeadLetterEntry = z.infer<typeof deadLetterEntrySchema>;
