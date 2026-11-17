import { z } from 'zod';

/** Main queue: issuance of invoices against the fiscal authority. */
export const FISCAL_INVOICE_QUEUE = 'fiscal-invoices';
/** Dead Letter Queue: invoices that failed permanently, awaiting a manual requeue. */
export const FISCAL_INVOICE_DLQ = 'fiscal-invoices-dlq';

export const ISSUE_INVOICE_JOB = 'issue-invoice';
export const DEAD_LETTER_JOB = 'dead-letter';

/** Outbox message type that the relay turns into an `issue-invoice` job. */
export const INVOICE_REQUESTED_EVENT = 'invoice.requested';

export const invoiceRequestedPayloadSchema = z.object({
  invoiceId: z.uuid(),
  paymentId: z.uuid(),
});

/** The `correlationId` of the original webhook travels in the job to link the logs. */
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
