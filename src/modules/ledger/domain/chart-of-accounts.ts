import type { PaymentProvider } from '../../../shared/domain/payment-provider.js';

/** Chart of accounts codes. They must match the ones seeded by migration. */
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

/** Asset account that records what the gateway owes us in settlements. */
export function gatewayReceivableAccount(provider: PaymentProvider): AccountCode {
  return GATEWAY_RECEIVABLE_BY_PROVIDER[provider];
}
