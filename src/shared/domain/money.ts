import { Decimal } from 'decimal.js';
import { DomainError } from './domain-error.js';

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(left: string, right: string) {
    super(`Cannot operate on amounts in different currencies: ${left} and ${right}`);
  }
}

/** Decimal places of the minor unit. Every supported currency uses cents. */
const MINOR_UNIT_SCALE = 2;
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Non-negative monetary amount with exact decimal arithmetic.
 *
 * It can only be built from strings: that makes it impossible for a JavaScript `number`
 * (binary, with representation error) to enter a money calculation.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {}

  static of(amount: string, currency: string): Money {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid ISO 4217 currency code: "${currency}"`);
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`Invalid monetary amount: "${amount}"`);
    }
    const value = new Decimal(amount);
    if (value.decimalPlaces() > MINOR_UNIT_SCALE) {
      throw new InvalidMoneyError(
        `Amount "${amount}" has more than ${MINOR_UNIT_SCALE} decimal places`,
      );
    }
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return Money.of('0', currency);
  }

  /** Canonical representation with a fixed scale, e.g. `"1210.50"`. */
  get amount(): string {
    return this.value.toFixed(MINOR_UNIT_SCALE);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.value.minus(other.value);
    if (result.isNegative()) {
      throw new InvalidMoneyError(
        `Subtracting ${other.toString()} from ${this.toString()} yields a negative amount`,
      );
    }
    return new Money(result, this.currency);
  }

  /**
   * Divides by a positive decimal factor and rounds to the minor unit with banker's
   * rounding (half-even), which introduces no cumulative bias.
   */
  divide(divisor: string): Money {
    if (!AMOUNT_PATTERN.test(divisor) || new Decimal(divisor).isZero()) {
      throw new InvalidMoneyError(`Invalid divisor: "${divisor}"`);
    }
    const result = this.value
      .dividedBy(divisor)
      .toDecimalPlaces(MINOR_UNIT_SCALE, Decimal.ROUND_HALF_EVEN);
    return new Money(result, this.currency);
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
