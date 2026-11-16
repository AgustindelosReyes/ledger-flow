import { describe, expect, it } from '@jest/globals';
import { Money } from '../../../shared/domain/money.js';
import { resolveInvoiceType } from './invoice-type.js';
import { splitVatInclusive } from './vat.js';

describe('splitVatInclusive', () => {
  it.each([
    ['12100.00', '10000.00', '2100.00'],
    ['121.00', '100.00', '21.00'],
    ['100.00', '82.64', '17.36'],
    ['999.99', '826.44', '173.55'],
    ['0.01', '0.01', '0.00'],
  ])('splits %s into net %s + tax %s at 21%%', (total, net, tax) => {
    const breakdown = splitVatInclusive(Money.of(total, 'ARS'));

    expect(breakdown.net.amount).toBe(net);
    expect(breakdown.tax.amount).toBe(tax);
  });

  it('never creates or loses a cent: net + tax equals the total for every amount', () => {
    for (let cents = 1; cents <= 5000; cents += 1) {
      const total = Money.of(
        `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`,
        'ARS',
      );

      const { net, tax } = splitVatInclusive(total);

      expect(net.add(tax).equals(total)).toBe(true);
    }
  });

  it('supports other rates', () => {
    const breakdown = splitVatInclusive(Money.of('110.50', 'ARS'), '0.105');

    expect(breakdown.net.amount).toBe('100.00');
    expect(breakdown.tax.amount).toBe('10.50');
  });
});

describe('resolveInvoiceType', () => {
  it('issues type A to a payer identified by CUIT', () => {
    expect(resolveInvoiceType('30712345678')).toBe('A');
  });

  it.each([undefined, '30111222', ''])('issues type B to a final consumer (%s)', (taxId) => {
    expect(resolveInvoiceType(taxId)).toBe('B');
  });
});
