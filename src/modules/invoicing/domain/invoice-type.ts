export type InvoiceType = 'A' | 'B' | 'C';

const CUIT_PATTERN = /^\d{11}$/;

/**
 * Regla simplificada de clase de comprobante: receptor identificado con CUIT -> Factura A;
 * consumidor final (sin identificación o con DNI) -> Factura B.
 */
export function resolveInvoiceType(payerTaxId: string | undefined): InvoiceType {
  return payerTaxId !== undefined && CUIT_PATTERN.test(payerTaxId) ? 'A' : 'B';
}
