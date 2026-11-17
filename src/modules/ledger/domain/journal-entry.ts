import { DomainError } from '../../../shared/domain/domain-error.js';
import { Money } from '../../../shared/domain/money.js';
import type { AccountCode } from './chart-of-accounts.js';

export type EntryDirection = 'DEBIT' | 'CREDIT';
export type LedgerTransactionType = 'PAYMENT_CAPTURE' | 'PAYMENT_REFUND';

export interface JournalLine {
  readonly accountCode: AccountCode;
  readonly direction: EntryDirection;
  readonly amount: Money;
}

export class InvalidJournalEntryError extends DomainError {
  readonly code = 'INVALID_JOURNAL_ENTRY';
}

export class UnbalancedJournalEntryError extends DomainError {
  readonly code = 'UNBALANCED_JOURNAL_ENTRY';

  constructor(debits: Money, credits: Money) {
    super(
      `Journal entry is unbalanced: debits ${debits.toString()}, credits ${credits.toString()}`,
    );
  }
}

interface JournalEntryParams {
  readonly type: LedgerTransactionType;
  readonly description: string;
  readonly lines: readonly JournalLine[];
}

/**
 * Double-entry journal entry, valid by construction: an unbalanced instance cannot exist.
 * The database repeats the check at COMMIT as the last line of defense.
 */
export class JournalEntry {
  private constructor(
    readonly type: LedgerTransactionType,
    readonly description: string,
    readonly lines: readonly JournalLine[],
    readonly currency: string,
    readonly total: Money,
  ) {}

  static create({ type, description, lines }: JournalEntryParams): JournalEntry {
    const [first] = lines;
    if (first === undefined || lines.length < 2) {
      throw new InvalidJournalEntryError('A journal entry requires at least two lines');
    }
    if (lines.some((line) => !line.amount.isPositive())) {
      throw new InvalidJournalEntryError('Every journal line amount must be greater than zero');
    }

    // `Money.add` rejects mixed currencies, so summing also validates that invariant.
    const { currency } = first.amount;
    const sum = (direction: EntryDirection): Money =>
      lines
        .filter((line) => line.direction === direction)
        .reduce((total, line) => total.add(line.amount), Money.zero(currency));

    const debits = sum('DEBIT');
    const credits = sum('CREDIT');
    if (!debits.equals(credits)) {
      throw new UnbalancedJournalEntryError(debits, credits);
    }

    return new JournalEntry(type, description, [...lines], currency, debits);
  }
}
