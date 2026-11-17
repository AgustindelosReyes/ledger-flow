export type InvoiceType = 'A' | 'B' | 'C';

const CUIT_PATTERN = /^\d{11}$/;

/**
 * Simplified rule for the invoice type: payer identified by a CUIT -> type A invoice;
 * final consumer (no identification, or a DNI) -> type B invoice.
 */
export function resolveInvoiceType(payerTaxId: string | undefined): InvoiceType {
  return payerTaxId !== undefined && CUIT_PATTERN.test(payerTaxId) ? 'A' : 'B';
}
