import type { PaymentProvider } from '../../../shared/domain/payment-provider.js';

/** Códigos del plan de cuentas. Deben coincidir con los sembrados por migración. */
export const AccountCode = {
  GATEWAY_RECEIVABLE_MERCADOPAGO: 'GATEWAY_RECEIVABLE_MERCADOPAGO',
  GATEWAY_RECEIVABLE_STRIPE: 'GATEWAY_RECEIVABLE_STRIPE',
  SALES_REVENUE: 'SALES_REVENUE',
  VAT_PAYABLE: 'VAT_PAYABLE',
} as const;

export type AccountCode = (typeof AccountCode)[keyof typeof AccountCode];

const GATEWAY_RECEIVABLE_BY_PROVIDER: Record<PaymentProvider, AccountCode> = {
  MERCADOPAGO: AccountCode.GATEWAY_RECEIVABLE_MERCADOPAGO,
  STRIPE: AccountCode.GATEWAY_RECEIVABLE_STRIPE,
};

/** Cuenta de activo donde se registra lo que la pasarela nos debe liquidar. */
export function gatewayReceivableAccount(provider: PaymentProvider): AccountCode {
  return GATEWAY_RECEIVABLE_BY_PROVIDER[provider];
}
