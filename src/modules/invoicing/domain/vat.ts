import { Decimal } from 'decimal.js';
import type { Money } from '../../../shared/domain/money.js';

/** Alícuota general de IVA. */
export const STANDARD_VAT_RATE = '0.21';

export interface VatBreakdown {
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
}

/**
 * Desglosa un importe final (IVA incluido) en neto e impuesto.
 *
 * Solo se redondea el neto; el impuesto se obtiene por diferencia. Así `net + tax = total`
 * vale siempre de forma exacta y no se pierde ni se crea un centavo por redondeo.
 */
export function splitVatInclusive(total: Money, rate: string = STANDARD_VAT_RATE): VatBreakdown {
  const net = total.divide(new Decimal(rate).plus(1).toString());
  return { net, tax: total.subtract(net), total };
}
