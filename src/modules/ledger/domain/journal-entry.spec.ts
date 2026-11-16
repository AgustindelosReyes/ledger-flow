import { describe, expect, it } from '@jest/globals';
import { CurrencyMismatchError, Money } from '../../../shared/domain/money.js';
import { splitVatInclusive } from '../../invoicing/domain/vat.js';
import { AccountCode } from './chart-of-accounts.js';
import {
  InvalidJournalEntryError,
  JournalEntry,
  UnbalancedJournalEntryError,
  type JournalLine,
} from './journal-entry.js';
import { buildPaymentCaptureEntry } from './payment-capture-posting.js';

const debit = (amount: string, currency = 'ARS'): JournalLine => ({
  accountCode: AccountCode.GATEWAY_RECEIVABLE_STRIPE,
  direction: 'DEBIT',
  amount: Money.of(amount, currency),
});

const credit = (amount: string, currency = 'ARS'): JournalLine => ({
  accountCode: AccountCode.SALES_REVENUE,
  direction: 'CREDIT',
  amount: Money.of(amount, currency),
});

const create = (lines: JournalLine[]): JournalEntry =>
  JournalEntry.create({ type: 'PAYMENT_CAPTURE', description: 'test', lines });

describe('JournalEntry', () => {
  it('accepts a balanced entry and exposes its total', () => {
    const entry = create([debit('121.00'), credit('100.00'), credit('21.00')]);

    expect(entry.lines).toHaveLength(3);
    expect(entry.currency).toBe('ARS');
    expect(entry.total.amount).toBe('121.00');
  });

  it.each([
    ['debits exceed credits', [debit('121.00'), credit('100.00')]],
    ['credits exceed debits', [debit('100.00'), credit('100.01')]],
    ['only debits', [debit('50.00'), debit('50.00')]],
    ['only credits', [credit('50.00'), credit('50.00')]],
  ])('rejects an unbalanced entry: %s', (_case, lines) => {
    expect(() => create(lines)).toThrow(UnbalancedJournalEntryError);
  });

  it.each([
    ['no lines', []],
    ['a single line', [debit('10.00')]],
  ])('rejects an entry with %s', (_case, lines) => {
    expect(() => create(lines)).toThrow(InvalidJournalEntryError);
  });

  it('rejects zero-amount lines even when the entry would balance', () => {
    expect(() => create([debit('0.00'), credit('0.00')])).toThrow(InvalidJournalEntryError);
  });

  it('rejects lines in different currencies', () => {
    expect(() => create([debit('100.00', 'ARS'), credit('100.00', 'USD')])).toThrow(
      CurrencyMismatchError,
    );
  });

  it('does not let later mutation of the input array alter the entry', () => {
    const lines = [debit('10.00'), credit('10.00')];
    const entry = create(lines);

    lines.push(debit('999.00'));

    expect(entry.lines).toHaveLength(2);
  });
});

describe('buildPaymentCaptureEntry', () => {
  const describeLines = (entry: JournalEntry): string[] =>
    entry.lines.map((line) => `${line.direction} ${line.accountCode} ${line.amount.amount}`);

  it('debits the gateway receivable and credits revenue and VAT', () => {
    const entry = buildPaymentCaptureEntry({
      provider: 'MERCADOPAGO',
      externalPaymentId: 'pay_1',
      breakdown: splitVatInclusive(Money.of('12100.00', 'ARS')),
    });

    expect(entry.type).toBe('PAYMENT_CAPTURE');
    expect(entry.description).toBe('Payment capture MERCADOPAGO:pay_1');
    expect(describeLines(entry)).toEqual([
      'DEBIT GATEWAY_RECEIVABLE_MERCADOPAGO 12100.00',
      'CREDIT SALES_REVENUE 10000.00',
      'CREDIT VAT_PAYABLE 2100.00',
    ]);
  });

  it('posts to the receivable account of the originating gateway', () => {
    const entry = buildPaymentCaptureEntry({
      provider: 'STRIPE',
      externalPaymentId: 'pi_1',
      breakdown: splitVatInclusive(Money.of('121.00', 'USD')),
    });

    expect(entry.lines[0]?.accountCode).toBe(AccountCode.GATEWAY_RECEIVABLE_STRIPE);
    expect(entry.currency).toBe('USD');
  });

  it('omits the VAT line when the tax rounds to zero', () => {
    const entry = buildPaymentCaptureEntry({
      provider: 'STRIPE',
      externalPaymentId: 'pi_2',
      breakdown: splitVatInclusive(Money.of('0.01', 'ARS')),
    });

    expect(describeLines(entry)).toEqual([
      'DEBIT GATEWAY_RECEIVABLE_STRIPE 0.01',
      'CREDIT SALES_REVENUE 0.01',
    ]);
  });

  it('rejects a zero-amount payment', () => {
    expect(() =>
      buildPaymentCaptureEntry({
        provider: 'STRIPE',
        externalPaymentId: 'pi_3',
        breakdown: splitVatInclusive(Money.zero('ARS')),
      }),
    ).toThrow(InvalidJournalEntryError);
  });
});
