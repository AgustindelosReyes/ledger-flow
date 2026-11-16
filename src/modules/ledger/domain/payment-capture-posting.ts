import type { PaymentProvider } from '../../../shared/domain/payment-provider.js';
import type { VatBreakdown } from '../../invoicing/domain/vat.js';
import { AccountCode, gatewayReceivableAccount } from './chart-of-accounts.js';
import { JournalEntry, type JournalLine } from './journal-entry.js';

interface PaymentCaptureParams {
  readonly provider: PaymentProvider;
  readonly externalPaymentId: string;
  readonly breakdown: VatBreakdown;
}

/**
 * Regla de imputación de un cobro aprobado:
 *
 *   DEBE   Créditos a cobrar (pasarela)   total
 *   HABER  Ingresos por ventas            neto
 *   HABER  IVA débito fiscal              impuesto
 */
export function buildPaymentCaptureEntry({
  provider,
  externalPaymentId,
  breakdown,
}: PaymentCaptureParams): JournalEntry {
  const lines: JournalLine[] = [
    {
      accountCode: gatewayReceivableAccount(provider),
      direction: 'DEBIT',
      amount: breakdown.total,
    },
    { accountCode: AccountCode.SALES_REVENUE, direction: 'CREDIT', amount: breakdown.net },
  ];
  // En importes mínimos el impuesto puede redondear a cero; una línea en cero no es válida.
  if (breakdown.tax.isPositive()) {
    lines.push({
      accountCode: AccountCode.VAT_PAYABLE,
      direction: 'CREDIT',
      amount: breakdown.tax,
    });
  }

  return JournalEntry.create({
    type: 'PAYMENT_CAPTURE',
    description: `Payment capture ${provider}:${externalPaymentId}`,
    lines,
  });
}
