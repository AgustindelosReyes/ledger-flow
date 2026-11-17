import { Decimal } from 'decimal.js';
import type { Money } from '../../../shared/domain/money.js';

/** Standard VAT rate. */
export const STANDARD_VAT_RATE = '0.21';

export interface VatBreakdown {
  readonly net: Money;
  readonly tax: Money;
  readonly total: Money;
}

/**
 * Splits a gross amount (VAT included) into net and tax.
 *
 * Only the net amount is rounded; the tax is obtained by subtraction. This way
 * `net + tax = total` always holds exactly and no cent is lost or created by rounding.
 */
export function splitVatInclusive(total: Money, rate: string = STANDARD_VAT_RATE): VatBreakdown {
  const net = total.divide(new Decimal(rate).plus(1).toString());
  return { net, tax: total.subtract(net), total };
}
