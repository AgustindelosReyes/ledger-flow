import { describe, expect, it } from '@jest/globals';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './money.js';

describe('Money', () => {
  describe('of', () => {
    it.each([
      ['100', '100.00'],
      ['100.5', '100.50'],
      ['0.01', '0.01'],
      ['9999999999999.99', '9999999999999.99'],
    ])('normalizes "%s" to "%s"', (input, expected) => {
      expect(Money.of(input, 'ARS').amount).toBe(expected);
    });

    it.each(['', 'abc', '-1', '+1', '1e3', '1,50', '.5', '1.', ' 1', 'NaN', 'Infinity'])(
      'rejects the malformed amount "%s"',
      (input) => {
        expect(() => Money.of(input, 'ARS')).toThrow(InvalidMoneyError);
      },
    );

    it('rejects sub-cent precision instead of silently rounding it', () => {
      expect(() => Money.of('10.001', 'ARS')).toThrow(InvalidMoneyError);
    });

    it.each(['ars', 'AR', 'ARSS', '', '123'])('rejects the currency code "%s"', (currency) => {
      expect(() => Money.of('1', currency)).toThrow(InvalidMoneyError);
    });
  });

  describe('arithmetic', () => {
    it('adds exactly where binary floating point does not (0.1 + 0.2)', () => {
      const sum = Money.of('0.10', 'ARS').add(Money.of('0.20', 'ARS'));

      expect(sum.amount).toBe('0.30');
      expect(sum.equals(Money.of('0.3', 'ARS'))).toBe(true);
    });

    it('keeps full precision on amounts beyond Number.MAX_SAFE_INTEGER cents', () => {
      const sum = Money.of('90071992547409.93', 'ARS').add(Money.of('0.01', 'ARS'));

      expect(sum.amount).toBe('90071992547409.94');
    });

    it('subtracts', () => {
      expect(Money.of('121', 'ARS').subtract(Money.of('100', 'ARS')).amount).toBe('21.00');
    });

    it('never produces a negative amount', () => {
      expect(() => Money.of('1', 'ARS').subtract(Money.of('2', 'ARS'))).toThrow(InvalidMoneyError);
    });

    it('refuses to mix currencies', () => {
      const ars = Money.of('1', 'ARS');
      const usd = Money.of('1', 'USD');

      expect(() => ars.add(usd)).toThrow(CurrencyMismatchError);
      expect(() => ars.subtract(usd)).toThrow(CurrencyMismatchError);
      expect(ars.equals(usd)).toBe(false);
    });
  });

  describe('divide', () => {
    it.each([
      ['121.00', '1.21', '100.00'],
      ['100.00', '3', '33.33'],
      ['200.00', '3', '66.67'],
      // Empates exactos: half-even redondea al dígito par más cercano.
      ['0.05', '2', '0.02'],
      ['0.15', '2', '0.08'],
      ['0.25', '2', '0.12'],
    ])('%s / %s = %s (banker’s rounding)', (amount, divisor, expected) => {
      expect(Money.of(amount, 'ARS').divide(divisor).amount).toBe(expected);
    });

    it.each(['0', '0.00', '-1', 'x'])('rejects the divisor "%s"', (divisor) => {
      expect(() => Money.of('10', 'ARS').divide(divisor)).toThrow(InvalidMoneyError);
    });
  });

  it('reports zero and positive amounts', () => {
    expect(Money.zero('ARS').isZero()).toBe(true);
    expect(Money.zero('ARS').isPositive()).toBe(false);
    expect(Money.of('0.01', 'ARS').isPositive()).toBe(true);
  });
});
